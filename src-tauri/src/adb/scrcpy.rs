//! Screen mirror: scrcpy's server (Apache-2.0, `resources/scrcpy/scrcpy-server`, updated with
//! `scripts/update-scrcpy.mjs`) runs on the device, encodes the screen as H.264 and takes
//! input events. We push it with sync, start it through the shell, then open its two
//! sockets (`localabstract:scrcpy_<scid>`): video first, then control.
//!
//! Video packets go to the panel as they are (12-byte header + Annex B data) over a
//! `Channel`, decoded there with WebCodecs. Flow control is by acknowledgement, like the
//! desktop panes (`desktop/frame.rs`): the panel acks each packet it has decoded; when more
//! than `MAX_UNACKED` are outstanding (panel hidden, window minimised) we stop sending,
//! drop packets until the next keyframe, and ask the encoder for one (RESET_VIDEO) once
//! the panel catches up. Nothing depends on timers in the webview.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::Emitter;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, Notify};

use super::AdbDevice;

const REMOTE_JAR: &str = "/data/local/tmp/nexterm-scrcpy.jar";
const MAX_UNACKED: u32 = 3;

/// Packet header flags (top bits of the 64-bit pts).
/// scrcpy 4+: a 12-byte session packet (new capture size) has the top bit of its first byte
/// set; media packets carry these flags in their 64-bit pts.
const FLAG_SESSION_BYTE: u8 = 0x80;
const FLAG_CONFIG: u64 = 1 << 62;
const FLAG_KEY_FRAME: u64 = 1 << 61;

// ---------------------------------------------------------------------------------------
// Control messages (scrcpy 3.x)

pub const TYPE_INJECT_KEYCODE: u8 = 0;
pub const TYPE_INJECT_TEXT: u8 = 1;
pub const TYPE_INJECT_TOUCH: u8 = 2;
pub const TYPE_INJECT_SCROLL: u8 = 3;
pub const TYPE_BACK_OR_SCREEN_ON: u8 = 4;
pub const TYPE_EXPAND_NOTIFICATION_PANEL: u8 = 5;
pub const TYPE_EXPAND_SETTINGS_PANEL: u8 = 6;
pub const TYPE_COLLAPSE_PANELS: u8 = 7;
pub const TYPE_GET_CLIPBOARD: u8 = 8;
pub const TYPE_SET_CLIPBOARD: u8 = 9;
pub const TYPE_SET_DISPLAY_POWER: u8 = 10;
pub const TYPE_ROTATE_DEVICE: u8 = 11;
pub const TYPE_RESET_VIDEO: u8 = 17;

/// A finger (not the mouse pointer, which Android draws as a cursor).
const POINTER_ID_FINGER: u64 = u64::MAX - 1;

/// Input from the mirror panel. Coordinates are in video pixels; `w`/`h` the video size
/// they refer to (the server ignores events for a stale size after rotation).
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MirrorInput {
    /// Android KeyEvent keycode; `down` true / false.
    Key { keycode: i32, down: bool, #[serde(default)] meta: i32, #[serde(default)] repeat: i32 },
    Text { text: String },
    /// action: 0 down, 1 up, 2 move.
    Touch { action: u8, x: i32, y: i32, w: u16, h: u16, #[serde(default)] pointer: Option<u64> },
    /// Scroll in notches (positive vscroll = up).
    Scroll { x: i32, y: i32, w: u16, h: u16, hscroll: f32, vscroll: f32 },
    BackOrScreenOn,
    ExpandNotifications,
    ExpandSettings,
    CollapsePanels,
    /// Ask for the device clipboard (arrives as `adb-mirror-clipboard`).
    GetClipboard,
    SetClipboard { text: String, paste: bool },
    /// Turn the device screen off (mirroring continues) or back on.
    DisplayPower { on: bool },
    Rotate,
}

/// 1.0 -> 0xffff (u16 fixed point).
pub fn u16_fp(v: f32) -> u16 {
    let v = v.clamp(0.0, 1.0);
    if v >= 1.0 {
        0xffff
    } else {
        (v * 65536.0) as u16
    }
}

/// [-1, 1] -> i16 fixed point.
pub fn i16_fp(v: f32) -> i16 {
    let v = v.clamp(-1.0, 1.0);
    if v >= 1.0 {
        0x7fff
    } else {
        (v * 32768.0) as i16
    }
}

pub fn encode(input: &MirrorInput) -> Vec<u8> {
    let mut b = Vec::with_capacity(32);
    match input {
        MirrorInput::Key { keycode, down, meta, repeat } => {
            b.push(TYPE_INJECT_KEYCODE);
            b.push(if *down { 0 } else { 1 });
            b.extend(keycode.to_be_bytes());
            b.extend(repeat.to_be_bytes());
            b.extend(meta.to_be_bytes());
        }
        MirrorInput::Text { text } => {
            // The server caps text at 300 bytes; cut on a char boundary.
            let mut end = text.len().min(300);
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            b.push(TYPE_INJECT_TEXT);
            b.extend((end as u32).to_be_bytes());
            b.extend(&text.as_bytes()[..end]);
        }
        MirrorInput::Touch { action, x, y, w, h, pointer } => {
            b.push(TYPE_INJECT_TOUCH);
            b.push(*action);
            b.extend(pointer.unwrap_or(POINTER_ID_FINGER).to_be_bytes());
            b.extend(x.to_be_bytes());
            b.extend(y.to_be_bytes());
            b.extend(w.to_be_bytes());
            b.extend(h.to_be_bytes());
            b.extend(u16_fp(if *action == 1 { 0.0 } else { 1.0 }).to_be_bytes());
            b.extend(0i32.to_be_bytes()); // action button
            b.extend(0i32.to_be_bytes()); // buttons (a finger has none)
        }
        MirrorInput::Scroll { x, y, w, h, hscroll, vscroll } => {
            b.push(TYPE_INJECT_SCROLL);
            b.extend(x.to_be_bytes());
            b.extend(y.to_be_bytes());
            b.extend(w.to_be_bytes());
            b.extend(h.to_be_bytes());
            // Values in [-16, 16] travel normalized to [-1, 1].
            b.extend(i16_fp(hscroll / 16.0).to_be_bytes());
            b.extend(i16_fp(vscroll / 16.0).to_be_bytes());
            b.extend(0i32.to_be_bytes());
        }
        MirrorInput::BackOrScreenOn => {
            // Down then up are separate messages; callers send this once per press.
            b.push(TYPE_BACK_OR_SCREEN_ON);
            b.push(0);
            b.push(TYPE_BACK_OR_SCREEN_ON);
            b.push(1);
        }
        MirrorInput::ExpandNotifications => b.push(TYPE_EXPAND_NOTIFICATION_PANEL),
        MirrorInput::ExpandSettings => b.push(TYPE_EXPAND_SETTINGS_PANEL),
        MirrorInput::CollapsePanels => b.push(TYPE_COLLAPSE_PANELS),
        MirrorInput::GetClipboard => {
            b.push(TYPE_GET_CLIPBOARD);
            b.push(0); // copy key: none
        }
        MirrorInput::SetClipboard { text, paste } => {
            b.push(TYPE_SET_CLIPBOARD);
            b.extend(0u64.to_be_bytes()); // sequence: no ack wanted
            b.push(u8::from(*paste));
            b.extend((text.len() as u32).to_be_bytes());
            b.extend(text.as_bytes());
        }
        MirrorInput::DisplayPower { on } => {
            b.push(TYPE_SET_DISPLAY_POWER);
            b.push(u8::from(*on));
        }
        MirrorInput::Rotate => b.push(TYPE_ROTATE_DEVICE),
    }
    b
}

// ---------------------------------------------------------------------------------------
// Sessions

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorOptions {
    /// Longest side in pixels (0: device resolution).
    #[serde(default = "default_max_size")]
    pub max_size: u32,
    #[serde(default = "default_bit_rate")]
    pub bit_rate: u32,
    #[serde(default = "default_fps")]
    pub max_fps: u32,
    /// Keep the device awake while mirroring.
    #[serde(default = "yes")]
    pub stay_awake: bool,
    /// Turn the device screen off when mirroring starts.
    #[serde(default)]
    pub screen_off: bool,
}

fn default_max_size() -> u32 {
    1280
}
fn default_bit_rate() -> u32 {
    8_000_000
}
fn default_fps() -> u32 {
    60
}
fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorInfo {
    pub device_name: String,
    pub width: u32,
    pub height: u32,
}

struct Mirror {
    control: mpsc::UnboundedSender<Vec<u8>>,
    acked: Arc<AtomicU32>,
    stop: Arc<Notify>,
}

fn mirrors() -> &'static Mutex<HashMap<String, Mirror>> {
    static M: OnceLock<Mutex<HashMap<String, Mirror>>> = OnceLock::new();
    M.get_or_init(Default::default)
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn server_path() -> std::path::PathBuf {
    crate::app_paths::resource("scrcpy").join("scrcpy-server")
}

/// The version the bundled server was built as (it refuses a client that says otherwise).
pub fn server_version() -> Result<String> {
    let v = std::fs::read_to_string(crate::app_paths::resource("scrcpy").join("version.txt"))
        .context("缺少 scrcpy-server（resources/scrcpy），请运行 node scripts/update-scrcpy.mjs")?;
    Ok(v.trim().to_string())
}

pub fn server_args(version: &str, scid: u32, o: &MirrorOptions) -> String {
    format!(
        "CLASSPATH={REMOTE_JAR} app_process / com.genymobile.scrcpy.Server {version} scid={scid:08x} log_level=info \
         tunnel_forward=true audio=false control=true video_codec=h264 max_size={} video_bit_rate={} max_fps={} \
         stay_awake={} power_off_on_close=false clipboard_autosync=true send_device_meta=true send_dummy_byte=true",
        o.max_size, o.bit_rate, o.max_fps, o.stay_awake
    )
}

/// Start mirroring `device` into `channel`. Returns once the video stream is up.
pub async fn start(
    app: tauri::AppHandle,
    mirror_id: String,
    device: AdbDevice,
    opts: MirrorOptions,
    channel: Channel<InvokeResponseBody>,
) -> Result<MirrorInfo> {
    stop(&mirror_id);
    let version = server_version()?;
    let jar = server_path();
    if !jar.is_file() {
        bail!("缺少 {}，请运行 node scripts/update-scrcpy.mjs", jar.display());
    }
    super::sync::push_file(&device, &jar, REMOTE_JAR, 0o644).await.context("无法把 scrcpy-server 推送到设备")?;
    let scid: u32 = rand_scid();
    let v2 = super::shell::has_v2(&device.serial).await;
    let mut server = device.open(&super::shell::service(v2, false, "dumb", &server_args(&version, scid, &opts))).await?;

    // Collect the server's output while we wait for its socket: shown if it fails.
    let log = Arc::new(Mutex::new(String::new()));
    let log_w = Arc::clone(&log);
    let stop_n = Arc::new(Notify::new());
    let stop_srv = Arc::clone(&stop_n);
    tauri::async_runtime::spawn(async move {
        let mut dec = super::shell::PacketDecoder::default();
        let mut buf = vec![0u8; 8192];
        loop {
            tokio::select! {
                _ = stop_srv.notified() => break,
                r = server.read(&mut buf) => match r {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let mut l = lock(&log_w);
                        if v2 {
                            for (id, body) in dec.feed(&buf[..n]) {
                                if id == super::shell::ID_STDOUT || id == super::shell::ID_STDERR {
                                    l.push_str(&String::from_utf8_lossy(&body));
                                }
                            }
                        } else {
                            l.push_str(&String::from_utf8_lossy(&buf[..n]));
                        }
                        if l.len() > 16 * 1024 {
                            let cut = l.len() - 8 * 1024;
                            let cut = (cut..l.len()).find(|&i| l.is_char_boundary(i)).unwrap_or(l.len());
                            l.drain(..cut);
                        }
                    }
                },
            }
        }
        // Dropping `server` closes the shell stream; the scrcpy server exits with its sockets.
    });

    let socket = format!("localabstract:scrcpy_{:08x}", scid);
    let mut video = None;
    for _ in 0..100 {
        if let Ok(mut s) = device.open(&socket).await {
            let mut dummy = [0u8; 1];
            if s.read_exact(&mut dummy).await.is_ok() {
                video = Some(s);
                break;
            }
        }
        if lock(&log).contains("ERROR") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let Some(mut video) = video else {
        stop_n.notify_waiters();
        let out = lock(&log).trim().to_string();
        bail!("scrcpy-server 没有启动{}", if out.is_empty() { String::new() } else { format!("：{}", out) });
    };
    let control = device.open(&socket).await.context("无法打开 scrcpy 控制通道")?;

    let mut name = [0u8; 64];
    video.read_exact(&mut name).await.context("scrcpy 视频流中断")?;
    let device_name = String::from_utf8_lossy(&name).trim_end_matches('\0').to_string();
    let mut codec = [0u8; 4];
    video.read_exact(&mut codec).await.context("scrcpy 视频流中断")?;
    match &codec {
        b"h264" => {}
        [0, 0, 0, 1] => bail!("scrcpy-server 配置错误（查看设备日志：adb logcat -s scrcpy）"),
        [0, 0, 0, 0] => bail!("设备无法采集屏幕"),
        other => bail!("设备不支持 H.264 编码（{}）", String::from_utf8_lossy(other)),
    }
    // The first session packet gives the capture size.
    let mut meta = [0u8; 12];
    video.read_exact(&mut meta).await.context("scrcpy 视频流中断")?;
    if meta[0] & FLAG_SESSION_BYTE == 0 {
        bail!("scrcpy 视频流格式不符（server 版本与客户端不一致？）");
    }
    let (width, height) = session_size(&meta);

    let (control_tx, mut control_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let acked = Arc::new(AtomicU32::new(0));
    lock(mirrors()).insert(
        mirror_id.clone(),
        Mirror { control: control_tx.clone(), acked: Arc::clone(&acked), stop: Arc::clone(&stop_n) },
    );
    if opts.screen_off {
        let _ = control_tx.send(encode(&MirrorInput::DisplayPower { on: false }));
    }

    // Control socket: writes from the panel, device messages (clipboard) back.
    let (mut ctl_r, mut ctl_w) = tokio::io::split(control);
    let stop_c = Arc::clone(&stop_n);
    let app_c = app.clone();
    let id_c = mirror_id.clone();
    tauri::async_runtime::spawn(async move {
        let reader = async {
            loop {
                let mut t = [0u8; 1];
                ctl_r.read_exact(&mut t).await?;
                match t[0] {
                    0 => {
                        let mut len = [0u8; 4];
                        ctl_r.read_exact(&mut len).await?;
                        let mut text = vec![0u8; u32::from_be_bytes(len) as usize];
                        ctl_r.read_exact(&mut text).await?;
                        let _ = app_c.emit(
                            "adb-mirror-clipboard",
                            serde_json::json!({ "mirrorId": id_c, "text": String::from_utf8_lossy(&text) }),
                        );
                    }
                    1 => {
                        let mut seq = [0u8; 8];
                        ctl_r.read_exact(&mut seq).await?;
                    }
                    2 => {
                        // UHID output: id u16, size u16, data.
                        let mut h = [0u8; 4];
                        ctl_r.read_exact(&mut h).await?;
                        let mut d = vec![0u8; u16::from_be_bytes([h[2], h[3]]) as usize];
                        ctl_r.read_exact(&mut d).await?;
                    }
                    _ => anyhow::bail!("unknown device message"),
                }
            }
            #[allow(unreachable_code)]
            anyhow::Ok(())
        };
        let writer = async {
            while let Some(msg) = control_rx.recv().await {
                if ctl_w.write_all(&msg).await.is_err() {
                    break;
                }
            }
        };
        tokio::select! {
            _ = stop_c.notified() => {}
            _ = reader => {}
            _ = writer => {}
        }
    });

    // Video: forward packets, holding back while the panel is behind.
    let stop_v = Arc::clone(&stop_n);
    let id_v = mirror_id.clone();
    tauri::async_runtime::spawn(async move {
        let result: Result<()> = async {
            let mut sent: u32 = 0;
            let mut config: Option<Vec<u8>> = None;
            // Packets were dropped: send nothing until a keyframe (asked for once caught up).
            let mut need_key = false;
            let mut asked = false;
            loop {
                let mut h = [0u8; 12];
                tokio::select! {
                    _ = stop_v.notified() => return Ok(()),
                    r = video.read_exact(&mut h) => { r.context("视频流中断")?; }
                }
                if h[0] & FLAG_SESSION_BYTE != 0 {
                    // New capture size (rotation, fold): a header-only message; the panel
                    // reconfigures its decoder, and the next config + keyframe follow.
                    channel.send(InvokeResponseBody::Raw(h.to_vec())).map_err(|e| anyhow::anyhow!("{e}"))?;
                    sent = sent.wrapping_add(1);
                    continue;
                }
                let pts = u64::from_be_bytes(h[..8].try_into().unwrap());
                let size = u32::from_be_bytes(h[8..].try_into().unwrap()) as usize;
                let mut msg = h.to_vec();
                msg.resize(12 + size, 0);
                video.read_exact(&mut msg[12..]).await.context("视频流中断")?;
                let is_config = pts & FLAG_CONFIG != 0;
                if is_config {
                    // SPS / PPS: always delivered (the decoder needs it), kept for resyncs.
                    config = Some(msg.clone());
                } else {
                    // The panel may ack past `sent` after resyncing (it counts skipped packets): never behind then.
                    let behind = sent.saturating_sub(acked.load(Ordering::Acquire)) > MAX_UNACKED;
                    match next_step(behind, need_key, pts & FLAG_KEY_FRAME != 0) {
                        Step::Drop => {
                            if !need_key {
                                need_key = true;
                                asked = false;
                            }
                            continue;
                        }
                        Step::AskKey => {
                            if !asked {
                                let _ = control_tx.send(vec![TYPE_RESET_VIDEO]);
                                asked = true;
                            }
                            continue;
                        }
                        Step::Resync => {
                            if let Some(cfg) = &config {
                                channel.send(InvokeResponseBody::Raw(cfg.clone())).map_err(|e| anyhow::anyhow!("{e}"))?;
                                sent = sent.wrapping_add(1);
                            }
                            need_key = false;
                        }
                        Step::Send => {}
                    }
                }
                channel.send(InvokeResponseBody::Raw(msg)).map_err(|e| anyhow::anyhow!("{e}"))?;
                sent = sent.wrapping_add(1);
            }
        }
        .await;
        let message = result.err().map(|e| format!("{:#}", e));
        let _ = app.emit("adb-mirror-ended", serde_json::json!({ "mirrorId": id_v, "message": message }));
        stop_v.notify_waiters();
        let mut m = lock(mirrors());
        if m.get(&id_v).is_some_and(|x| Arc::ptr_eq(&x.stop, &stop_v)) {
            m.remove(&id_v);
        }
    });

    Ok(MirrorInfo { device_name, width, height })
}


#[derive(Debug, PartialEq, Eq)]
enum Step {
    Send,
    /// Panel behind: drop it.
    Drop,
    /// Caught up after dropping, but this is not a keyframe: ask for one, skip this.
    AskKey,
    /// The awaited keyframe: send the last config, then it.
    Resync,
}

/// What to do with a (non-config) video packet.
fn next_step(behind: bool, need_key: bool, key: bool) -> Step {
    match (behind, need_key, key) {
        (true, _, _) => Step::Drop,
        (false, true, false) => Step::AskKey,
        (false, true, true) => Step::Resync,
        (false, false, _) => Step::Send,
    }
}

/// Width and height of a session packet.
pub fn session_size(h: &[u8; 12]) -> (u32, u32) {
    (u32::from_be_bytes([h[4], h[5], h[6], h[7]]), u32::from_be_bytes([h[8], h[9], h[10], h[11]]))
}

fn rand_scid() -> u32 {
    // 31 bits: scrcpy parses scid as a signed int.
    (uuid::Uuid::new_v4().as_u128() as u32) & 0x7fff_ffff
}

pub fn input(mirror_id: &str, events: &[MirrorInput]) -> Result<()> {
    let m = lock(mirrors());
    let mirror = m.get(mirror_id).context("屏幕镜像未运行")?;
    for e in events {
        mirror.control.send(encode(e)).map_err(|_| anyhow::anyhow!("屏幕镜像已结束"))?;
    }
    Ok(())
}

/// The panel decoded packets up to `count` (a running total).
pub fn ack(mirror_id: &str, count: u32) {
    if let Some(m) = lock(mirrors()).get(mirror_id) {
        m.acked.store(count, Ordering::Release);
    }
}

pub fn stop(mirror_id: &str) {
    if let Some(m) = lock(mirrors()).remove(mirror_id) {
        m.stop.notify_waiters();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn touch_layout() {
        let b = encode(&MirrorInput::Touch { action: 0, x: 100, y: 200, w: 1080, h: 2400, pointer: None });
        assert_eq!(b.len(), 32);
        assert_eq!(b[0], TYPE_INJECT_TOUCH);
        assert_eq!(b[1], 0);
        assert_eq!(&b[2..10], &(u64::MAX - 1).to_be_bytes());
        assert_eq!(&b[10..14], &100i32.to_be_bytes());
        assert_eq!(&b[14..18], &200i32.to_be_bytes());
        assert_eq!(&b[18..20], &1080u16.to_be_bytes());
        assert_eq!(&b[20..22], &2400u16.to_be_bytes());
        assert_eq!(&b[22..24], &[0xff, 0xff]);
        let up = encode(&MirrorInput::Touch { action: 1, x: 0, y: 0, w: 1, h: 1, pointer: None });
        assert_eq!(&up[22..24], &[0, 0]);
    }

    #[test]
    fn key_and_text_layout() {
        let k = encode(&MirrorInput::Key { keycode: 4, down: true, meta: 0, repeat: 0 });
        assert_eq!(k, vec![0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0]);
        let t = encode(&MirrorInput::Text { text: "hé".into() });
        assert_eq!(t, vec![1, 0, 0, 0, 3, b'h', 0xc3, 0xa9]);
        let long = encode(&MirrorInput::Text { text: "中".repeat(200) });
        assert_eq!(u32::from_be_bytes(long[1..5].try_into().unwrap()), 300);
    }

    #[test]
    fn scroll_layout() {
        let s = encode(&MirrorInput::Scroll { x: 1, y: 2, w: 3, h: 4, hscroll: 0.0, vscroll: 16.0 });
        assert_eq!(s.len(), 21);
        assert_eq!(&s[13..15], &[0, 0]);
        assert_eq!(&s[15..17], &0x7fffi16.to_be_bytes());
        assert_eq!(i16_fp(-1.0), -32768);
    }

    #[test]
    fn simple_messages() {
        assert_eq!(encode(&MirrorInput::BackOrScreenOn), vec![4, 0, 4, 1]);
        assert_eq!(encode(&MirrorInput::DisplayPower { on: false }), vec![10, 0]);
        assert_eq!(encode(&MirrorInput::Rotate), vec![11]);
        let c = encode(&MirrorInput::SetClipboard { text: "ab".into(), paste: true });
        assert_eq!(c, vec![9, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 2, b'a', b'b']);
    }

    #[test]
    fn args() {
        let o = MirrorOptions { max_size: 1024, bit_rate: 4_000_000, max_fps: 30, stay_awake: true, screen_off: false };
        let a = server_args("3.3.3", 0x1a, &o);
        assert!(a.contains("Server 3.3.3 scid=0000001a "));
        assert!(a.contains("max_size=1024 video_bit_rate=4000000 max_fps=30"));
        assert!(a.contains("tunnel_forward=true audio=false"));
    }

    #[test]
    fn session_packet() {
        let h = [0x80, 0, 0, 1, 0, 0, 4, 0x38, 0, 0, 9, 0x60];
        assert_ne!(h[0] & FLAG_SESSION_BYTE, 0);
        assert_eq!(session_size(&h), (1080, 2400));
    }

    #[test]
    fn flow_control_steps() {
        assert_eq!(next_step(false, false, false), Step::Send);
        assert_eq!(next_step(true, false, true), Step::Drop);
        assert_eq!(next_step(false, true, false), Step::AskKey);
        assert_eq!(next_step(false, true, true), Step::Resync);
    }
}
