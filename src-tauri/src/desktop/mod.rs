//! RDP / VNC panes: the protocol runs here (IronRDP, vnc-rs), the pane only draws the
//! framebuffer it is sent (`frame.rs`) and returns keyboard and mouse input.
//!
//! One session per pane `instance_id`, like terminal connections. Connection state uses
//! the terminal's `terminal-state` event, so tabs show the same status dots, and the server
//! certificate (RDP) / jump host key prompts reuse the `host-key-prompt` round trip.

mod certs;
pub mod frame;
mod keyhook;
pub mod keymap;
mod rdp;
mod vnc;

use std::collections::HashMap;
use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context as TaskContext, Poll};
use std::time::Duration;

use anyhow::{Context, Result};
use serde::Deserialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::sync::mpsc;

use crate::manager::TerminalSink;
use crate::models::{DesktopConfig, ProtocolType, SessionConfig};
use crate::net::BoxedStream;
use crate::ssh_conn::JumpTunnel;
use frame::{FrameOut, FrameSink};

/// Input from the pane. Coordinates are remote desktop pixels.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum InputEvent {
    /// `code` is `KeyboardEvent.code`, `key` is `KeyboardEvent.key`.
    Key {
        code: String,
        #[serde(default)]
        key: String,
        down: bool,
    },
    /// Text committed by an input method (typed as Unicode characters).
    Text { text: String },
    Move { x: u16, y: u16 },
    /// `button` uses `MouseEvent.button` numbering: 0 left, 1 middle, 2 right, 3 back, 4 forward.
    Button { x: u16, y: u16, button: u8, down: bool },
    /// Wheel rotation in 1/120 notch units, positive = away from the user (up / right).
    Wheel {
        x: u16,
        y: u16,
        #[serde(default)]
        dx: i16,
        #[serde(default)]
        dy: i16,
    },
    /// The pane lost focus: lift every key and button still held.
    ReleaseAll,
    CtrlAltDel,
    /// VNC: local clipboard text for the server (RDP syncs the Windows clipboard itself).
    Clipboard { text: String },
}

pub(crate) enum Control {
    Input(Vec<InputEvent>),
    /// Pane size in device pixels and its scale (100 = 96 DPI).
    Resize { width: u16, height: u16, scale: u32 },
    Close,
}

/// What a protocol task works with.
pub(crate) struct SessionCtx {
    pub instance_id: String,
    pub session: SessionConfig,
    pub desktop: DesktopConfig,
    pub frames: Arc<FrameOut>,
    pub sink: Arc<dyn TerminalSink>,
    /// Requested desktop size (device pixels) and scale.
    pub width: u16,
    pub height: u16,
    pub scale: u32,
    /// Set once the pane closed or reconnected: this session's last words would land on
    /// the new connection's status, so it stays quiet.
    pub superseded: Arc<AtomicBool>,
}

impl SessionCtx {
    pub fn state(&self, status: &str, message: Option<String>) {
        if !self.superseded.load(Ordering::SeqCst) {
            self.sink.emit_state(&self.instance_id, status, message);
        }
    }
}

struct ChannelSink(Channel<InvokeResponseBody>);

impl FrameSink for ChannelSink {
    fn send(&self, frame: Vec<u8>) -> bool {
        self.0.send(InvokeResponseBody::Raw(frame)).is_ok()
    }
}

struct Entry {
    tx: mpsc::UnboundedSender<Control>,
    frames: Arc<FrameOut>,
    superseded: Arc<AtomicBool>,
    task: tauri::async_runtime::JoinHandle<()>,
}

#[derive(Default)]
pub struct DesktopManager {
    sessions: Mutex<HashMap<String, Entry>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Desktop size a pane asks for: even width (RDP requires it), 200..=8192.
pub(crate) fn clamp_size(width: u32, height: u32) -> (u16, u16) {
    let w = (width.clamp(200, 8192) & !1) as u16;
    let h = height.clamp(200, 8192) as u16;
    (w, h)
}

impl DesktopManager {
    #[allow(clippy::too_many_arguments)]
    pub fn connect(
        &self,
        instance_id: String,
        session: SessionConfig,
        width: u32,
        height: u32,
        scale: u32,
        channel: Channel<InvokeResponseBody>,
        sink: Arc<dyn TerminalSink>,
    ) -> Result<()> {
        if !session.protocol.is_desktop() {
            anyhow::bail!("不是远程桌面会话");
        }
        if session.host.trim().is_empty() {
            anyhow::bail!("未设置主机地址");
        }
        self.disconnect(&instance_id);
        let desktop = session.desktop.clone().unwrap_or_default();
        let (width, height) = if desktop.resize == "fixed" {
            clamp_size(u32::from(desktop.width), u32::from(desktop.height))
        } else {
            clamp_size(width, height)
        };
        let frames = Arc::new(FrameOut::new(Box::new(ChannelSink(channel))));
        let (tx, rx) = mpsc::unbounded_channel();
        let protocol = session.protocol.clone();
        let superseded = Arc::new(AtomicBool::new(false));
        let ctx = SessionCtx {
            instance_id: instance_id.clone(),
            session,
            desktop,
            frames: Arc::clone(&frames),
            sink,
            width,
            height,
            scale: scale.clamp(100, 500),
            superseded: Arc::clone(&superseded),
        };
        keyhook::retarget(&instance_id, &tx);
        let task = tauri::async_runtime::spawn(async move {
            ctx.state("connecting", None);
            let session: BoxFuture<'_, Result<()>> = match protocol {
                ProtocolType::Rdp => Box::pin(rdp::run(&ctx, rx)),
                _ => Box::pin(vnc::run(&ctx, rx)),
            };
            let result = session.await;
            match result {
                Ok(()) => ctx.state("disconnected", None),
                Err(err) => ctx.state("error", Some(format!("{err:#}"))),
            }
        });
        lock(&self.sessions).insert(instance_id, Entry { tx, frames, superseded, task });
        Ok(())
    }

    pub fn input(&self, instance_id: &str, events: Vec<InputEvent>) {
        if let Some(e) = lock(&self.sessions).get(instance_id) {
            let _ = e.tx.send(Control::Input(events));
        }
    }

    pub fn resize(&self, instance_id: &str, width: u32, height: u32, scale: u32) {
        let (width, height) = clamp_size(width, height);
        if let Some(e) = lock(&self.sessions).get(instance_id) {
            let _ = e.tx.send(Control::Resize { width, height, scale: scale.clamp(100, 500) });
        }
    }

    /// Windows key combinations (Win+X, Alt+Tab, ...) go to this pane's session while `on`
    /// and its window (`hwnd`) is in front; see `keyhook.rs`.
    pub fn capture_keys(&self, instance_id: &str, hwnd: isize, on: bool) {
        if !on {
            keyhook::release(instance_id);
            return;
        }
        let tx = lock(&self.sessions).get(instance_id).map(|e| e.tx.clone());
        if let Some(tx) = tx {
            keyhook::capture(instance_id, hwnd, tx);
        }
    }

    pub fn ack(&self, instance_id: &str, seq: u32) {
        let frames = lock(&self.sessions).get(instance_id).map(|e| Arc::clone(&e.frames));
        if let Some(f) = frames {
            f.ack(seq);
        }
    }

    /// Ask the session to sign off, and stop it for good shortly after.
    pub fn disconnect(&self, instance_id: &str) {
        keyhook::release(instance_id);
        let Some(entry) = lock(&self.sessions).remove(instance_id) else {
            return;
        };
        entry.superseded.store(true, Ordering::SeqCst);
        let _ = entry.tx.send(Control::Close);
        let task = entry.task;
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(3)).await;
            task.abort();
        });
    }

    pub fn disconnect_all(&self) {
        let ids: Vec<String> = lock(&self.sessions).keys().cloned().collect();
        for id in ids {
            self.disconnect(&id);
        }
    }
}

/// A byte stream made `Sync` (IronRDP and vnc-rs require it; SSH channels, proxy pipes and
/// TLS streams are only `Send`). Access is always through `&mut`, so the mutex is never
/// actually locked.
pub(crate) struct SyncIo<T>(Mutex<T>);

pub(crate) type SyncStream = SyncIo<BoxedStream>;

impl<T> SyncIo<T> {
    pub fn new(inner: T) -> Self {
        Self(Mutex::new(inner))
    }
}

impl<T: Unpin> SyncIo<T> {
    fn inner(self: Pin<&mut Self>) -> Pin<&mut T> {
        let stream = self.get_mut().0.get_mut().unwrap_or_else(|e| e.into_inner());
        Pin::new(stream)
    }
}

impl<T: AsyncRead + Unpin> AsyncRead for SyncIo<T> {
    fn poll_read(self: Pin<&mut Self>, cx: &mut TaskContext<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        self.inner().poll_read(cx, buf)
    }
}

impl<T: AsyncWrite + Unpin> AsyncWrite for SyncIo<T> {
    fn poll_write(self: Pin<&mut Self>, cx: &mut TaskContext<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        self.inner().poll_write(cx, buf)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        self.inner().poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        self.inner().poll_shutdown(cx)
    }
}

/// Connect to the session's host: through its SSH jump host when one is enabled, else
/// directly or through its SOCKS / HTTP proxy. The tunnel guard keeps the jump connection.
///
/// Boxed as `dyn Future + Send`: rustc cannot otherwise prove the spawned session future
/// `Send` through these borrowing async calls ("Send is not general enough").
pub(crate) fn open_stream(ctx: &SessionCtx) -> BoxFuture<'_, Result<(SyncStream, Option<JumpTunnel>)>> {
    Box::pin(async move {
        let s = &ctx.session;
        let jump = s.jump_host.as_ref().filter(|j| j.enabled && !j.host.trim().is_empty());
        if let Some(jump) = jump {
            let tunnel: BoxFuture<'_, _> = Box::pin(crate::ssh_conn::jump_tunnel(&ctx.instance_id, s, jump, &ctx.sink));
            let (stream, guard) = tunnel.await?;
            return Ok((SyncIo::new(stream), Some(guard)));
        }
        // ProxyCommand is an SSH-only proxy; RDP / VNC need a TCP path.
        let proxy = s.proxy.as_ref().filter(|p| p.kind != "command");
        let connect: BoxFuture<'_, _> =
            Box::pin(crate::net::connect_stream(s.host.trim(), s.port, &s.username, proxy, Duration::from_secs(20)));
        let stream = connect.await.with_context(|| format!("无法连接到 {}:{}", s.host.trim(), s.port))?;
        Ok((SyncIo::new(stream), None))
    })
}

pub(crate) type BoxFuture<'a, T> = Pin<Box<dyn std::future::Future<Output = T> + Send + 'a>>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn input_events_parse_from_the_page() {
        let events: Vec<InputEvent> = serde_json::from_str(
            r#"[{"type":"key","code":"KeyA","key":"a","down":true},
                {"type":"wheel","x":1,"y":2,"dy":-120},
                {"type":"button","x":3,"y":4,"button":2,"down":false},
                {"type":"releaseAll"},{"type":"ctrlAltDel"},{"type":"text","text":"中"}]"#,
        )
        .unwrap();
        assert_eq!(events.len(), 6);
        assert!(matches!(&events[0], InputEvent::Key { code, down: true, .. } if code == "KeyA"));
        assert!(matches!(events[1], InputEvent::Wheel { dx: 0, dy: -120, .. }));
        assert!(matches!(events[2], InputEvent::Button { button: 2, down: false, .. }));
    }

    #[test]
    fn requested_sizes_are_even_and_bounded() {
        assert_eq!(clamp_size(1281, 721), (1280, 721));
        assert_eq!(clamp_size(10, 10), (200, 200));
        assert_eq!(clamp_size(20000, 9000), (8192, 8192));
    }
}
