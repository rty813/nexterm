//! RDP pane: IronRDP's connector and session state machines driven over our own stream
//! (direct, proxy or SSH jump host), modelled on `ironrdp-client`'s event loop.
//!
//! - Security: TLS, or TLS + NLA (CredSSP / NTLM) when the session asks for it. The server
//!   certificate is trusted on first use (`certs.rs`).
//! - Picture: decoded into IronRDP's RGBA image, changed rectangles copied to `FrameOut`.
//! - Resize: "fit-window" sessions follow the pane through the display control channel.
//! - Clipboard: IronRDP's Windows backend syncs the system clipboard (text, images, ...).
//! - Audio: played locally through WASAPI (`ironrdp-rdpsnd-native`) when asked for.

use std::net::SocketAddr;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use ironrdp_cliprdr::backend::{ClipboardMessage, CliprdrBackendFactory};
use ironrdp_connector::connection_activation::ConnectionActivationState;
use ironrdp_connector::sspi::generator::NetworkRequest;
use ironrdp_connector::{ConnectionResult, ConnectorResult, Credentials, DesktopSize, ServerName};
use ironrdp_core::WriteBuf;
use ironrdp_displaycontrol::client::DisplayControlClient;
use ironrdp_graphics::image_processing::PixelFormat;
use ironrdp_input::{Database, MouseButton, MousePosition, Operation, Scancode, WheelRotations};
use ironrdp_pdu::input::fast_path::FastPathInputEvent;
use ironrdp_pdu::rdp::capability_sets::{client_codecs_capabilities, MajorPlatformType};
use ironrdp_pdu::rdp::client_info::{CompressionType, PerformanceFlags, TimezoneInfo};
use ironrdp_session::image::DecodedImage;
use ironrdp_session::{ActiveStage, ActiveStageBuilder, ActiveStageOutput};
use ironrdp_tokio::{single_sequence_step_read, split_tokio_framed, FramedWrite as _, TokioFramed};
use smallvec::SmallVec;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};
use tokio::time::Instant;

use super::frame::Rect;
use super::{certs, keymap, Control, InputEvent, SessionCtx, SyncStream};

trait AsyncReadWrite: AsyncRead + AsyncWrite {}
impl<T: AsyncRead + AsyncWrite> AsyncReadWrite for T {}
type Upgraded = TokioFramed<Box<dyn AsyncReadWrite + Unpin + Send + Sync>>;

/// Kerberos needs a KDC round trip; without a KDC configured CredSSP stays on NTLM and
/// never calls this.
struct NoNetwork;

impl ironrdp_tokio::NetworkClient for NoNetwork {
    async fn send(&mut self, _request: &NetworkRequest) -> ConnectorResult<Vec<u8>> {
        Err(ironrdp_connector::general_err!("Kerberos (KDC) is not supported"))
    }
}

/// The whole error chain: IronRDP's own `Display` only names the category ("CredSSP"),
/// the actual reason (sspi's error and NTSTATUS) is in `source()`.
fn chain(err: &dyn std::error::Error) -> String {
    let mut parts = vec![err.to_string()];
    let mut next = err.source();
    while let Some(e) = next {
        let text = e.to_string();
        if !parts.iter().any(|p| p.contains(&text)) {
            parts.push(text);
        }
        next = e.source();
    }
    parts.join(": ")
}

/// A plain-language hint for the failures people actually hit, matched on the error text
/// (NTSTATUS / SSPI codes as sspi prints them, or connector wording).
pub(crate) fn hint(text: &str) -> Option<&'static str> {
    let lower = text.to_ascii_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|n| lower.contains(n));
    Some(if has(&["0xc000006d", "0xc000006a", "0xc0000064", "logondenied", "0x8009030c", "logon failure"]) {
        "用户名或密码错误。使用 Microsoft 账户登录的电脑请填写账户邮箱和账户密码（不是 PIN）；域账户可写成 域\\用户名"
    } else if has(&["0xc0000072"]) {
        "该账户已被禁用"
    } else if has(&["0xc000006f", "0xc0000070"]) {
        "该账户当前不允许在这台电脑上登录（登录时间或工作站限制）"
    } else if has(&["0xc0000071", "0xc0000224"]) {
        "账户密码已过期或需要修改，请先在本机登录修改密码"
    } else if has(&["0xc0000234"]) {
        "账户已被锁定"
    } else if has(&["0xc0000413", "0xc0000015b", "0xc000015b"]) {
        "该账户没有远程桌面登录权限（需要在远程桌面用户组中）"
    } else if has(&["0x80090302"]) {
        "远程电脑不接受这种身份验证方式。Microsoft 账户请写成 MicrosoftAccount\\邮箱；仍然不行可以在会话设置里关闭 NLA"
    } else if has(&["hybrid_required", "hybridrequired", "requires enhanced rdp security with tls or credssp"]) {
        "服务器要求网络级别身份验证 (NLA)，请在会话设置里开启"
    } else if has(&["ssl_not_allowed", "only supports standard rdp security"]) {
        "服务器只支持旧的 RDP 标准安全，Nexterm 不支持"
    } else if has(&["credssp"]) {
        "网络级别身份验证 (NLA) 失败。请检查用户名、密码和域；仍然不行可以在会话设置里关闭 NLA，改用远程电脑自己的登录界面"
    } else {
        return None;
    })
}

fn friendly<E: std::error::Error>(err: E) -> anyhow::Error {
    let text = chain(&err);
    match hint(&text) {
        Some(h) => anyhow!("{h}\n{text}"),
        None => anyhow!("{text}"),
    }
}

pub(super) async fn run(ctx: &SessionCtx, mut rx: UnboundedReceiver<Control>) -> Result<()> {
    let (clip_tx, mut clip_rx) = mpsc::unbounded_channel::<ClipboardMessage>();
    #[cfg(windows)]
    let clipboard = if ctx.desktop.clipboard {
        match clip::start(clip_tx.clone()) {
            Ok(c) => Some(c),
            Err(err) => {
                eprintln!("[rdp] clipboard unavailable: {err:#}");
                None
            }
        }
    } else {
        None
    };
    #[cfg(not(windows))]
    let clipboard: Option<()> = None;
    drop(clip_tx);

    let (mut width, mut height) = (ctx.width, ctx.height);
    // A Microsoft account typed as a bare e-mail: NTLM needs it as `MicrosoftAccount\e-mail`
    // (mstsc gets there through Negotiate). Tried as typed first, so AD users who log on with
    // their UPN (alice@corp.example) keep working.
    let mut ms_account = false;
    loop {
        let (stream, _jump) = super::open_stream(ctx).await?;
        // Borrowed only while building (the factory is not Sync, so no reference may live
        // across an await).
        #[cfg(windows)]
        let connector = build_connector(ctx, width, height, ms_account, clipboard.as_ref().map(|c| c.factory.as_ref()));
        #[cfg(not(windows))]
        let connector = build_connector(ctx, width, height, ms_account, clipboard.and(None));
        let (result, framed) = match boxed(connect(ctx, stream, connector)).await {
            Ok(ok) => ok,
            Err(err) if !ms_account && may_be_ms_account(ctx, &format!("{err:#}")) => {
                ms_account = true;
                continue;
            }
            Err(err) => return Err(err),
        };
        ctx.state("connected", None);
        match boxed(active(ctx, framed, result, &mut rx, &mut clip_rx)).await? {
            Flow::Closed => return Ok(()),
            // The server could not resize in place (no display control): log on again
            // at the new size, as mstsc does.
            Flow::Reconnect { width: w, height: h } => {
                width = w;
                height = h;
                ctx.state("connecting", None);
            }
        }
    }
}

/// NLA failed for an e-mail style user name with no domain: worth one more try as a
/// Microsoft account.
fn may_be_ms_account(ctx: &SessionCtx, error: &str) -> bool {
    let user = ctx.session.username.trim();
    ctx.desktop.nla
        && error.contains("CredSSP")
        && ctx.desktop.domain.trim().is_empty()
        && !user.contains('\\')
        && user.contains('@')
}

fn build_connector(
    ctx: &SessionCtx,
    width: u16,
    height: u16,
    ms_account: bool,
    clipboard: Option<&(dyn CliprdrBackendFactory + Send)>,
) -> ironrdp_connector::ClientConnector {
    let s = &ctx.session;
    let d = &ctx.desktop;
    let color_depth = if d.color_depth == 16 { 16 } else { 32 };
    let codecs = client_codecs_capabilities(&[]).unwrap_or_default();
    let local_audio = d.audio == "local";
    let client_name: String = std::env::var("COMPUTERNAME")
        .unwrap_or_else(|_| "NEXTERM".into())
        .chars()
        .take(15)
        .collect();
    let (username, mut domain) = split_user(&s.username, &d.domain);
    if ms_account && domain.is_none() {
        domain = Some("MicrosoftAccount".to_string());
    }
    let config = ironrdp_connector::Config {
        credentials: Credentials::UsernamePassword {
            username,
            password: s.password.clone().unwrap_or_default(),
        },
        domain,
        // With NLA off the server shows its own logon screen over plain TLS.
        enable_tls: true,
        enable_credssp: d.nla,
        keyboard_type: ironrdp_pdu::gcc::KeyboardType::IBM_ENHANCED,
        keyboard_subtype: 0,
        keyboard_layout: 0,
        keyboard_functional_keys_count: 12,
        ime_file_name: String::new(),
        dig_product_id: String::new(),
        desktop_size: DesktopSize { width, height },
        monitor_layout: None,
        desktop_scale_factor: if ctx.desktop.resize == "fixed" { 0 } else { ctx.scale },
        desktop_physical_size: None,
        desktop_orientation: None,
        device_scale_factor: None,
        monitor_extended_layout: None,
        relative_mouse_input: false,
        enable_standard_rdp_security: false,
        connection_type: ironrdp_pdu::gcc::ConnectionType::Lan,
        remote_application_mode: false,
        rail_support_level: ironrdp_pdu::rdp::capability_sets::RailSupportLevel::empty(),
        enable_audio_capture: false,
        support_dyn_vc_gfx_protocol: false,
        bitmap: Some(ironrdp_connector::BitmapConfig { lossy_compression: true, color_depth, codecs }),
        client_build: 0,
        client_name,
        client_dir: "C:\\Windows\\System32\\mstscax.dll".into(),
        platform: MajorPlatformType::WINDOWS,
        hardware_id: None,
        license_cache: None,
        enable_server_pointer: true,
        autologon: d.nla || !s.password.as_deref().unwrap_or_default().is_empty(),
        enable_audio_playback: local_audio,
        request_data: None,
        pointer_software_rendering: false,
        multitransport_flags: None,
        compression_type: Some(CompressionType::K64),
        performance_flags: PerformanceFlags::default(),
        timezone_info: TimezoneInfo::default(),
        alternate_shell: String::new(),
        work_dir: String::new(),
    };
    let drdynvc = ironrdp_dvc::DrdynvcClient::new().with_dynamic_channel(DisplayControlClient::new(|_| Ok(Vec::new())));
    let client_addr: SocketAddr = ([0, 0, 0, 0], 0).into();
    let mut connector = ironrdp_connector::ClientConnector::new(config, client_addr).with_static_channel(drdynvc);
    if local_audio {
        connector = connector.with_static_channel(ironrdp_rdpsnd::client::Rdpsnd::new(Box::new(
            ironrdp_rdpsnd_native::cpal::RdpsndBackend::new(),
        )));
    }
    if let Some(factory) = clipboard {
        connector.attach_static_channel(ironrdp_cliprdr::Cliprdr::new(factory.build_cliprdr_backend()));
    }
    connector
}

/// `DOMAIN\user` and `user@domain` in the user name win over the separate domain field.
fn split_user(user: &str, domain: &str) -> (String, Option<String>) {
    let user = user.trim();
    if let Some((d, u)) = user.split_once('\\') {
        return (u.to_string(), Some(d.to_string()).filter(|d| !d.is_empty()));
    }
    let domain = domain.trim();
    (user.to_string(), Some(domain.to_string()).filter(|d| !d.is_empty()))
}

async fn connect(
    ctx: &SessionCtx,
    stream: SyncStream,
    mut connector: ironrdp_connector::ClientConnector,
) -> Result<(ConnectionResult, Upgraded)> {
    let host = ctx.session.host.trim().to_string();
    let mut framed = TokioFramed::new(stream);
    let should_upgrade = tokio::time::timeout(Duration::from_secs(30), boxed(ironrdp_tokio::connect_begin(&mut framed, &mut connector)))
        .await
        .map_err(|_| anyhow!("RDP 协商超时"))?
        .map_err(friendly)?;
    let (initial, leftover) = framed.into_inner();
    let (tls, cert) = boxed(ironrdp_tls::upgrade(initial, &host)).await.context("TLS 握手失败")?;
    {
        use x509_cert::der::Encode as _;
        let der = cert.to_der().context("无法读取服务器证书")?;
        let verify: super::BoxFuture<'_, Result<()>> = Box::pin(certs::verify(ctx, &der));
        verify.await?;
    }
    let server_public_key = ironrdp_tls::extract_tls_server_public_key(&cert)
        .ok_or_else(|| anyhow!("无法读取服务器证书的公钥"))?
        .to_owned();
    let upgraded = ironrdp_tokio::mark_as_upgraded(should_upgrade, &mut connector);
    let erased: Box<dyn AsyncReadWrite + Unpin + Send + Sync> = Box::new(super::SyncIo::new(tls));
    let mut framed = TokioFramed::new_with_leftover(erased, leftover);
    let mut network = NoNetwork;
    // Boxed as `dyn Future + Send` (see `super::open_stream`).
    let finalize: super::BoxFuture<'_, _> = Box::pin(ironrdp_tokio::connect_finalize(
        upgraded,
        connector,
        &mut framed,
        &mut network,
        ServerName::new(host),
        server_public_key,
        None,
    ));
    let result = tokio::time::timeout(Duration::from_secs(60), finalize)
    .await
    .map_err(|_| anyhow!("RDP 登录超时"))?
    .and_then(|outcome| outcome.into_connected())
    .map_err(friendly)?;
    Ok((result, framed))
}

/// See `super::open_stream`: boxing pins the `Send` proof to each call.
fn boxed<'a, T>(f: impl std::future::Future<Output = T> + Send + 'a) -> super::BoxFuture<'a, T> {
    Box::pin(f)
}

enum Flow {
    Closed,
    Reconnect { width: u16, height: u16 },
}

/// A pane size waiting to be applied (resizing is debounced).
struct PendingResize {
    width: u16,
    height: u16,
    scale: u32,
    at: Instant,
    attempts: u8,
}

const RESIZE_DEBOUNCE: Duration = Duration::from_millis(400);

async fn active(
    ctx: &SessionCtx,
    framed: Upgraded,
    result: ConnectionResult,
    rx: &mut UnboundedReceiver<Control>,
    clip_rx: &mut UnboundedReceiver<ClipboardMessage>,
) -> Result<Flow> {
    let (mut reader, mut writer) = split_tokio_framed(framed);
    let size = result.desktop_size;
    let mut image = DecodedImage::new(PixelFormat::RgbA32, size.width, size.height);
    ctx.frames.resize(u32::from(size.width), u32::from(size.height));
    let activation_factory = result.activation_factory;
    let mut stage = ActiveStageBuilder {
        static_channels: result.static_channels,
        user_channel_id: result.user_channel_id,
        io_channel_id: result.io_channel_id,
        message_channel_id: result.message_channel_id,
        share_id: result.share_id,
        compression_type: result.compression_type,
        enable_server_pointer: result.enable_server_pointer,
        pointer_software_rendering: result.pointer_software_rendering,
    }
    .build();
    let mut input = Database::new();
    let mut pending: Option<PendingResize> = None;
    let mut timeouts = tokio::time::interval(Duration::from_secs(5));
    let follow_pane = ctx.desktop.resize != "fixed";

    loop {
        let resize_at = pending.as_ref().map(|p| p.at);
        let outputs: Vec<ActiveStageOutput> = tokio::select! {
            frame = boxed(reader.read_pdu()) => {
                let (action, payload) = frame.context("RDP 连接已断开")?;
                stage.process(&mut image, action, &payload, None).map_err(friendly)?
            }
            control = rx.recv() => match control {
                None | Some(Control::Close) => {
                    if let Ok(outs) = stage.graceful_shutdown() {
                        for out in outs {
                            if let ActiveStageOutput::ResponseFrame(frame) = out {
                                let _ = boxed(writer.write_all(&frame)).await;
                            }
                        }
                    }
                    return Ok(Flow::Closed);
                }
                Some(Control::Input(events)) => {
                    let fast = to_fast_path(&mut input, events);
                    if fast.is_empty() {
                        Vec::new()
                    } else {
                        stage.process_fastpath_input(&mut image, &fast).map_err(friendly)?
                    }
                }
                Some(Control::Resize { width, height, scale }) => {
                    if follow_pane {
                        pending = Some(PendingResize { width, height, scale, at: Instant::now() + RESIZE_DEBOUNCE, attempts: 0 });
                    }
                    Vec::new()
                }
            },
            Some(message) = clip_rx.recv() => clipboard_message(&mut stage, message)?,
            _ = async {
                match resize_at {
                    Some(at) => tokio::time::sleep_until(at).await,
                    None => std::future::pending().await,
                }
            } => {
                let p = pending.take().expect("pending resize");
                if (u32::from(p.width), u32::from(p.height)) == ctx.frames.size() {
                    Vec::new()
                } else {
                    let (w, h) = ironrdp_displaycontrol::pdu::MonitorLayoutEntry::adjust_display_size(u32::from(p.width), u32::from(p.height));
                    match stage.encode_resize(w, h, Some(p.scale), None) {
                        Some(frame) => vec![ActiveStageOutput::ResponseFrame(frame.map_err(friendly)?)],
                        // Display control not open yet: try again shortly; servers
                        // without it get a new logon at the new size.
                        None if p.attempts < 5 => {
                            pending = Some(PendingResize { at: Instant::now() + Duration::from_secs(1), attempts: p.attempts + 1, ..p });
                            Vec::new()
                        }
                        None => return Ok(Flow::Reconnect { width: w as u16, height: h as u16 }),
                    }
                }
            }
            _ = timeouts.tick() => {
                match stage.get_svc_processor_mut::<ironrdp_cliprdr::CliprdrClient>() {
                    Some(clip) => match clip.drive_timeouts() {
                        Ok(messages) => {
                            let frame = stage.process_svc_processor_messages(messages).map_err(friendly)?;
                            if frame.is_empty() { Vec::new() } else { vec![ActiveStageOutput::ResponseFrame(frame)] }
                        }
                        Err(_) => Vec::new(),
                    },
                    None => Vec::new(),
                }
            }
        };

        let mut painted = false;
        for out in outputs {
            match out {
                ActiveStageOutput::ResponseFrame(frame) => {
                    boxed(writer.write_all(&frame)).await.context("RDP 写入失败")?;
                }
                ActiveStageOutput::GraphicsUpdate(r) => {
                    let rect = Rect::new(
                        u32::from(r.left),
                        u32::from(r.top),
                        u32::from(r.right.saturating_sub(r.left)) + 1,
                        u32::from(r.bottom.saturating_sub(r.top)) + 1,
                    );
                    ctx.frames.put(rect, image.data(), usize::from(image.width()) * 4, 0, 0);
                    painted = true;
                }
                ActiveStageOutput::PointerDefault => ctx.frames.cursor_default(),
                ActiveStageOutput::PointerHidden => ctx.frames.cursor_hidden(),
                ActiveStageOutput::PointerPosition { .. } => {}
                ActiveStageOutput::PointerBitmap(p) => ctx.frames.cursor(
                    u32::from(p.hotspot_x),
                    u32::from(p.hotspot_y),
                    u32::from(p.width),
                    u32::from(p.height),
                    &p.bitmap_data,
                ),
                ActiveStageOutput::DeactivateAll => {
                    // Deactivation-reactivation (e.g. after a resize): new desktop size.
                    let mut activation = activation_factory.create();
                    let mut buf = WriteBuf::new();
                    loop {
                        let written = boxed(single_sequence_step_read(&mut reader, &mut activation, &mut buf))
                            .await
                            .map_err(friendly)?;
                        if written.size().is_some() {
                            boxed(writer.write_all(buf.filled())).await.context("RDP 写入失败")?;
                        }
                        if let ConnectionActivationState::Finalized {
                            desktop_size,
                            share_id,
                            static_channel_chunk_size,
                            enable_server_pointer,
                            pointer_software_rendering,
                            ..
                        } = activation.connection_activation_state()
                        {
                            image = DecodedImage::new(PixelFormat::RgbA32, desktop_size.width, desktop_size.height);
                            ctx.frames.resize(u32::from(desktop_size.width), u32::from(desktop_size.height));
                            if !stage.reactivate(
                                activation.io_channel_id(),
                                activation.user_channel_id(),
                                share_id,
                                enable_server_pointer,
                                pointer_software_rendering,
                                static_channel_chunk_size,
                            ) {
                                return Err(anyhow!("服务器重新激活会话时给出了无效的通道参数"));
                            }
                            break;
                        }
                    }
                }
                ActiveStageOutput::Terminate(reason) => {
                    return Err(anyhow!("远程会话已结束：{reason}"));
                }
                _ => {}
            }
        }
        if painted {
            ctx.frames.flush();
        }
    }
}

fn clipboard_message(stage: &mut ActiveStage, message: ClipboardMessage) -> Result<Vec<ActiveStageOutput>> {
    let Some(clip) = stage.get_svc_processor_mut::<ironrdp_cliprdr::CliprdrClient>() else {
        return Ok(Vec::new());
    };
    let messages = match message {
        ClipboardMessage::SendInitiateCopy(formats) => clip.initiate_copy(&formats),
        ClipboardMessage::SendFormatData(response) => clip.submit_format_data(response),
        ClipboardMessage::SendInitiatePaste(format) => clip.initiate_paste(format),
        ClipboardMessage::SendFileContentsRequest(request) => clip.request_file_contents(request),
        ClipboardMessage::SendFileContentsResponse(response) => clip.submit_file_contents(response),
        ClipboardMessage::Error(err) => {
            eprintln!("[rdp] clipboard: {err}");
            return Ok(Vec::new());
        }
        #[allow(unreachable_patterns)]
        _ => return Ok(Vec::new()),
    }
    .map_err(friendly)?;
    let frame = stage.process_svc_processor_messages(messages).map_err(friendly)?;
    Ok(vec![ActiveStageOutput::ResponseFrame(frame)])
}

fn mouse_button(button: u8) -> Option<MouseButton> {
    Some(match button {
        0 => MouseButton::Left,
        1 => MouseButton::Middle,
        2 => MouseButton::Right,
        3 => MouseButton::X1,
        4 => MouseButton::X2,
        _ => return None,
    })
}

/// Pane input as fast-path events; `Database` tracks what is held so releases are exact.
fn to_fast_path(db: &mut Database, events: Vec<InputEvent>) -> SmallVec<[FastPathInputEvent; 2]> {
    let mut ops: Vec<Operation> = Vec::new();
    let mut out: SmallVec<[FastPathInputEvent; 2]> = SmallVec::new();
    for event in events {
        match event {
            InputEvent::Key { code, down, .. } => {
                if let Some((extended, sc)) = keymap::scancode(&code) {
                    let sc = Scancode::from_u8(extended, sc);
                    ops.push(if down { Operation::KeyPressed(sc) } else { Operation::KeyReleased(sc) });
                }
            }
            InputEvent::Text { text } => {
                for c in text.chars() {
                    ops.push(Operation::UnicodeKeyPressed(c));
                    ops.push(Operation::UnicodeKeyReleased(c));
                }
            }
            InputEvent::Move { x, y } => ops.push(Operation::MouseMove(MousePosition { x, y })),
            InputEvent::Button { x, y, button, down } => {
                ops.push(Operation::MouseMove(MousePosition { x, y }));
                if let Some(b) = mouse_button(button) {
                    ops.push(if down { Operation::MouseButtonPressed(b) } else { Operation::MouseButtonReleased(b) });
                }
            }
            InputEvent::Wheel { x, y, dx, dy } => {
                ops.push(Operation::MouseMove(MousePosition { x, y }));
                if dy != 0 {
                    ops.push(Operation::WheelRotations(WheelRotations { is_vertical: true, rotation_units: dy.clamp(-255, 255) }));
                }
                if dx != 0 {
                    ops.push(Operation::WheelRotations(WheelRotations { is_vertical: false, rotation_units: dx.clamp(-255, 255) }));
                }
            }
            InputEvent::ReleaseAll => {
                out.extend(db.apply(ops.drain(..)));
                out.extend(db.release_all());
            }
            InputEvent::CtrlAltDel => {
                let ctrl = Scancode::from_u8(false, 0x1D);
                let alt = Scancode::from_u8(false, 0x38);
                let del = Scancode::from_u8(true, 0x53);
                ops.extend([
                    Operation::KeyPressed(ctrl),
                    Operation::KeyPressed(alt),
                    Operation::KeyPressed(del),
                    Operation::KeyReleased(del),
                    Operation::KeyReleased(alt),
                    Operation::KeyReleased(ctrl),
                ]);
            }
            // RDP shares the system clipboard through CLIPRDR instead.
            InputEvent::Clipboard { .. } => {}
        }
    }
    out.extend(db.apply(ops));
    out
}

/// IronRDP's Windows clipboard backend needs a thread with a message loop (it watches the
/// clipboard through a hidden window). One per session; stopped when dropped.
#[cfg(windows)]
mod clip {
    use super::*;
    use ironrdp_cliprdr::backend::ClipboardMessageProxy;
    use windows_sys::Win32::System::Threading::GetCurrentThreadId;
    use windows_sys::Win32::UI::WindowsAndMessaging::{DispatchMessageW, GetMessageW, PostThreadMessageW, TranslateMessage, MSG, WM_QUIT};

    #[derive(Debug, Clone)]
    struct Proxy(UnboundedSender<ClipboardMessage>);

    impl ClipboardMessageProxy for Proxy {
        fn send_clipboard_message(&self, message: ClipboardMessage) {
            let _ = self.0.send(message);
        }
    }

    pub struct ClipThread {
        pub factory: Box<dyn CliprdrBackendFactory + Send>,
        thread_id: u32,
    }

    impl Drop for ClipThread {
        fn drop(&mut self) {
            // SAFETY: posting to a thread id; harmless if the thread already ended.
            unsafe {
                PostThreadMessageW(self.thread_id, WM_QUIT, 0, 0);
            }
        }
    }

    pub fn start(tx: UnboundedSender<ClipboardMessage>) -> Result<ClipThread> {
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        std::thread::Builder::new()
            .name("rdp-clipboard".into())
            .spawn(move || {
                let clipboard = match ironrdp_cliprdr_native::WinClipboard::new(Proxy(tx)) {
                    Ok(c) => c,
                    Err(err) => {
                        let _ = ready_tx.send(Err(anyhow!("{err}")));
                        return;
                    }
                };
                // SAFETY: plain Win32 calls on this thread's own message queue.
                let thread_id = unsafe { GetCurrentThreadId() };
                let _ = ready_tx.send(Ok((clipboard.backend_factory(), thread_id)));
                let mut msg: MSG = unsafe { std::mem::zeroed() };
                unsafe {
                    while GetMessageW(&mut msg, 0, 0, 0) > 0 {
                        TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }
                }
                drop(clipboard);
            })
            .context("无法启动剪贴板线程")?;
        let (factory, thread_id) = ready_rx.recv().context("剪贴板线程未启动")??;
        Ok(ClipThread { factory, thread_id })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credssp_failures_get_a_hint() {
        let wrong = "CredSSP: InternalError: logon failed; status is 0xC000006D";
        assert!(hint(wrong).unwrap().contains("密码错误"));
        assert!(hint("CredSSP").unwrap().contains("NLA"));
        assert!(hint("read frame: connection reset").is_none());
        assert!(hint("CredSSP: InvalidToken: x; status is NSTATUS code 0x80090302").unwrap().contains("MicrosoftAccount"));
    }

    #[test]
    fn user_names_carry_their_domain() {
        assert_eq!(split_user("CORP\\alice", "other"), ("alice".into(), Some("CORP".into())));
        assert_eq!(split_user("alice", " CORP "), ("alice".into(), Some("CORP".into())));
        assert_eq!(split_user("alice@corp.example", ""), ("alice@corp.example".into(), None));
        assert_eq!(split_user("bob", ""), ("bob".into(), None));
    }

    #[test]
    fn keys_buttons_and_releases_become_fast_path_events() {
        let mut db = Database::new();
        let events = to_fast_path(
            &mut db,
            vec![
                InputEvent::Key { code: "KeyA".into(), key: "a".into(), down: true },
                InputEvent::Button { x: 5, y: 6, button: 0, down: true },
                InputEvent::Key { code: "Unidentified".into(), key: String::new(), down: true },
            ],
        );
        // key down, mouse move, button down
        assert_eq!(events.len(), 3);
        assert!(db.is_key_pressed(Scancode::from_u8(false, 0x1E)));
        let released = to_fast_path(&mut db, vec![InputEvent::ReleaseAll]);
        assert_eq!(released.len(), 2, "the key and the button are lifted");
        assert!(!db.is_key_pressed(Scancode::from_u8(false, 0x1E)));
        let sas = to_fast_path(&mut db, vec![InputEvent::CtrlAltDel]);
        assert_eq!(sas.len(), 6);
    }
}
