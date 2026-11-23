//! VNC pane (RFB 3.3 – 3.8 through vnc-rs): None / VNC authentication, and Apple Remote
//! Desktop when the session has a user name. Encodings ZRLE, Tight (without JPEG),
//! CopyRect and Raw, plus server cursor and desktop size changes.

use std::collections::HashMap;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use tokio::sync::mpsc::UnboundedReceiver;
use vnc::{ClientKeyEvent, ClientMouseEvent, PixelFormat, VncClient, VncConnector, VncEncoding, VncError, VncEvent, X11Event};

use super::frame::{Rect, WINDOW};
use super::{keymap, BoxFuture, Control, InputEvent, SessionCtx};

/// How often to ask for the next incremental update while the pane keeps up.
const REFRESH: Duration = Duration::from_millis(33);

fn friendly(err: VncError) -> anyhow::Error {
    match err {
        VncError::WrongPassword => anyhow!("VNC 密码错误"),
        VncError::NoPassword => anyhow!("服务器要求密码，请在会话里填写 VNC 密码"),
        VncError::ArdAuthFailed(m) => anyhow!("macOS 屏幕共享登录失败：{m}"),
        VncError::ClientNotRunning => anyhow!("VNC 连接已断开"),
        other => anyhow!("{other}"),
    }
}

/// Mouse button bit in the RFB pointer mask (`MouseEvent.button` numbering in). Bits 3–6
/// are the wheel; "forward" (button 9) has no bit in the 8-bit mask.
fn button_bit(button: u8) -> u8 {
    match button {
        0 => 1,
        1 => 2,
        2 => 4,
        3 => 1 << 7,
        _ => 0,
    }
}

// vnc-rs futures boxed as `dyn Future + Send`: without it rustc cannot prove the
// spawned session future `Send` ("Send is not general enough").
fn recv(client: &VncClient) -> BoxFuture<'_, Result<VncEvent, VncError>> {
    Box::pin(client.recv_event())
}

fn poll(client: &VncClient) -> BoxFuture<'_, Result<Option<VncEvent>, VncError>> {
    Box::pin(client.poll_event())
}

fn input(client: &VncClient, event: X11Event) -> BoxFuture<'_, Result<(), VncError>> {
    Box::pin(client.input(event))
}

pub(super) async fn run(ctx: &SessionCtx, mut rx: UnboundedReceiver<Control>) -> Result<()> {
    let (stream, _jump) = super::open_stream(ctx).await?;
    let password = ctx.session.password.clone().unwrap_or_default();
    let auth_password = password.clone();
    let mut connector = VncConnector::new(stream)
        .set_auth_method(async move { Ok(auth_password) })
        .add_encoding(VncEncoding::Zrle)
        .add_encoding(VncEncoding::Tight)
        .add_encoding(VncEncoding::CopyRect)
        .add_encoding(VncEncoding::Raw)
        .add_encoding(VncEncoding::CursorPseudo)
        .add_encoding(VncEncoding::DesktopSizePseudo)
        .add_encoding(VncEncoding::ExtendedDesktopSizePseudo)
        .add_encoding(VncEncoding::LastRectPseudo)
        .allow_shared(true)
        .set_pixel_format(PixelFormat::rgba());
    let user = ctx.session.username.trim();
    if !user.is_empty() {
        // macOS screen sharing signs in with the account; other servers ignore it.
        connector = connector.set_ard_credentials(user, password);
    }
    let client = tokio::time::timeout(Duration::from_secs(30), async {
        connector.build()?.try_start().await?.finish()
    })
    .await
    .map_err(|_| anyhow!("VNC 握手超时"))?
    .map_err(friendly)?;
    ctx.state("connected", None);

    let view_only = ctx.desktop.view_only;
    let follow_pane = ctx.desktop.resize != "fixed";
    let mut refresh = tokio::time::interval(REFRESH);
    refresh.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut mask: u8 = 0;
    let mut pos = (0u16, 0u16);
    // Keysym sent for each held key, so its release matches even if Shift changed.
    let mut held: HashMap<String, u32> = HashMap::new();

    loop {
        tokio::select! {
            event = recv(&client) => {
                handle(ctx, event.map_err(friendly)?)?;
                while let Some(event) = poll(&client).await.map_err(friendly)? {
                    handle(ctx, event)?;
                }
                ctx.frames.flush();
            }
            _ = refresh.tick() => {
                // Pacing by the pane: no new update requests while it is behind.
                if ctx.frames.in_flight() < WINDOW {
                    input(&client, X11Event::Refresh).await.map_err(friendly)?;
                }
            }
            control = rx.recv() => match control {
                None | Some(Control::Close) => {
                    let _ = client.close().await;
                    return Ok(());
                }
                Some(Control::Resize { width, height, .. }) => {
                    if follow_pane && client.desktop_layout().is_some() {
                        let c = client.clone();
                        // Waits for the server's answer while events keep flowing here.
                        tokio::spawn(async move {
                            let _ = c.resize_desktop(width, height).await;
                        });
                    }
                }
                Some(Control::Input(events)) => {
                    if view_only {
                        continue;
                    }
                    for x in to_x11(events, &mut mask, &mut pos, &mut held) {
                        input(&client, x).await.map_err(friendly)?;
                    }
                }
            },
        }
    }
}

fn handle(ctx: &SessionCtx, event: VncEvent) -> Result<()> {
    match event {
        VncEvent::SetResolution(screen) => ctx.frames.resize(u32::from(screen.width), u32::from(screen.height)),
        VncEvent::RawImage(r, data) => {
            let rect = Rect::new(u32::from(r.x), u32::from(r.y), u32::from(r.width), u32::from(r.height));
            ctx.frames.put(rect, &data, usize::from(r.width) * 4, rect.x, rect.y);
        }
        VncEvent::Copy(dst, src) => {
            let src = Rect::new(u32::from(src.x), u32::from(src.y), u32::from(src.width), u32::from(src.height));
            ctx.frames.copy_within(src, u32::from(dst.x), u32::from(dst.y));
        }
        VncEvent::SetCursor(r, data) => {
            if data.is_empty() {
                ctx.frames.cursor_hidden();
            } else {
                ctx.frames.cursor(u32::from(r.x), u32::from(r.y), u32::from(r.width), u32::from(r.height), &data);
            }
        }
        VncEvent::Text(text) => {
            if ctx.desktop.clipboard {
                ctx.sink.emit_event(
                    "desktop-clipboard",
                    serde_json::json!({ "instanceId": ctx.instance_id, "text": text }),
                );
            }
        }
        VncEvent::Error(message) => return Err(anyhow!("{message}")).context("VNC 服务器报错"),
        // JPEG is never offered (no quality pseudo-encoding), the rest needs nothing.
        _ => {}
    }
    Ok(())
}

/// Pane input as RFB key / pointer events.
fn to_x11(events: Vec<InputEvent>, mask: &mut u8, pos: &mut (u16, u16), held: &mut HashMap<String, u32>) -> Vec<X11Event> {
    let key = |keycode: u32, down: bool| X11Event::KeyEvent(ClientKeyEvent { keycode, down });
    let pointer = |x: u16, y: u16, mask: u8| X11Event::PointerEvent(ClientMouseEvent { position_x: x, position_y: y, bottons: mask });
    let mut out = Vec::new();
    for event in events {
        match event {
            InputEvent::Key { code, key: k, down } => {
                if down {
                    if let Some(sym) = keymap::keysym(&code, &k) {
                        held.insert(code, sym);
                        out.push(key(sym, true));
                    }
                } else if let Some(sym) = held.remove(&code).or_else(|| keymap::keysym(&code, &k)) {
                    out.push(key(sym, false));
                }
            }
            InputEvent::Text { text } => {
                for c in text.chars() {
                    let sym = keymap::char_keysym(c);
                    out.push(key(sym, true));
                    out.push(key(sym, false));
                }
            }
            InputEvent::Move { x, y } => {
                *pos = (x, y);
                out.push(pointer(x, y, *mask));
            }
            InputEvent::Button { x, y, button, down } => {
                *pos = (x, y);
                let bit = button_bit(button);
                if down {
                    *mask |= bit;
                } else {
                    *mask &= !bit;
                }
                out.push(pointer(x, y, *mask));
            }
            InputEvent::Wheel { x, y, dx, dy } => {
                *pos = (x, y);
                // Buttons 4 / 5 (up / down) and 6 / 7 (left / right), one click per notch.
                let mut clicks = |units: i16, plus: u8, minus: u8| {
                    if units == 0 {
                        return;
                    }
                    let bit = if units > 0 { plus } else { minus };
                    let n = (i32::from(units).abs() / 120).clamp(1, 10);
                    for _ in 0..n {
                        out.push(pointer(x, y, *mask | bit));
                        out.push(pointer(x, y, *mask));
                    }
                };
                clicks(dy, 1 << 3, 1 << 4);
                clicks(dx, 1 << 6, 1 << 5);
            }
            InputEvent::ReleaseAll => {
                for (_, sym) in held.drain() {
                    out.push(key(sym, false));
                }
                if *mask != 0 {
                    *mask = 0;
                    out.push(pointer(pos.0, pos.1, 0));
                }
            }
            InputEvent::CtrlAltDel => {
                for (sym, down) in [
                    (keymap::KEYSYM_CONTROL_L, true),
                    (keymap::KEYSYM_ALT_L, true),
                    (keymap::KEYSYM_DELETE, true),
                    (keymap::KEYSYM_DELETE, false),
                    (keymap::KEYSYM_ALT_L, false),
                    (keymap::KEYSYM_CONTROL_L, false),
                ] {
                    out.push(key(sym, down));
                }
            }
            InputEvent::Clipboard { text } => {
                // RFB cut text is Latin-1.
                if text.chars().all(|c| (c as u32) < 0x100) {
                    out.push(X11Event::CopyText(text));
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(events: &[X11Event]) -> Vec<(u32, bool)> {
        events
            .iter()
            .filter_map(|e| match e {
                X11Event::KeyEvent(k) => Some((k.keycode, k.down)),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn key_release_matches_the_pressed_keysym() {
        let (mut mask, mut pos, mut held) = (0, (0, 0), HashMap::new());
        let down = to_x11(vec![InputEvent::Key { code: "KeyA".into(), key: "A".into(), down: true }], &mut mask, &mut pos, &mut held);
        // Shift was released before the letter: the page now reports "a".
        let up = to_x11(vec![InputEvent::Key { code: "KeyA".into(), key: "a".into(), down: false }], &mut mask, &mut pos, &mut held);
        assert_eq!(keys(&down), vec![(0x41, true)]);
        assert_eq!(keys(&up), vec![(0x41, false)]);
    }

    #[test]
    fn buttons_wheel_and_release_all() {
        let (mut mask, mut pos, mut held) = (0, (0, 0), HashMap::new());
        to_x11(vec![InputEvent::Button { x: 1, y: 2, button: 2, down: true }], &mut mask, &mut pos, &mut held);
        assert_eq!(mask, 4);
        let wheel = to_x11(vec![InputEvent::Wheel { x: 1, y: 2, dx: 0, dy: -240 }], &mut mask, &mut pos, &mut held);
        assert_eq!(wheel.len(), 4, "two notches down: press + release each");
        assert!(matches!(&wheel[0], X11Event::PointerEvent(p) if p.bottons == 4 | 16));
        let released = to_x11(vec![InputEvent::ReleaseAll], &mut mask, &mut pos, &mut held);
        assert_eq!(mask, 0);
        assert!(matches!(&released[0], X11Event::PointerEvent(p) if p.bottons == 0 && p.position_x == 1));
    }

    #[test]
    fn clipboard_text_must_be_latin1() {
        let (mut mask, mut pos, mut held) = (0, (0, 0), HashMap::new());
        let ok = to_x11(vec![InputEvent::Clipboard { text: "café".into() }], &mut mask, &mut pos, &mut held);
        let skipped = to_x11(vec![InputEvent::Clipboard { text: "中文".into() }], &mut mask, &mut pos, &mut held);
        assert_eq!(ok.len(), 1);
        assert!(skipped.is_empty());
    }
}
