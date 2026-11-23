//! ADB panes: the device's interactive shell (`shell,v2,pty:`) through the adb server.
//! Structure follows `tcp_conn.rs`; resize sends shell v2 window-size packets.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

use crate::adb::shell::{encode_packet, encode_resize, PacketDecoder, ID_EXIT, ID_STDERR, ID_STDIN, ID_STDOUT};
use crate::adb::{AdbDevice, AdbSlot};
use crate::manager::{AsyncChannels, RuntimeControl, TerminalSink};
use crate::models::SessionConfig;
use crate::pump::OutputPump;

/// The device a session means: its serial, after `adb connect` for WLAN sessions. With
/// neither a serial nor an address, the only device that is ready.
pub async fn resolve_device(session: &SessionConfig) -> Result<AdbDevice> {
    let cfg = session.adb.clone().unwrap_or_default();
    let host = session.host.trim();
    if cfg.is_wlan() {
        if host.is_empty() {
            bail!("请填写设备的 IP 地址");
        }
        let port = if session.port == 0 || session.port == 22 { 5555 } else { session.port };
        let addr = if host.contains(':') && !host.starts_with('[') { format!("[{host}]:{port}") } else { format!("{host}:{port}") };
        // Already listed (connected earlier, or by Android Studio): no reconnect needed.
        let listed = crate::adb::client::devices().await?;
        if !listed.iter().any(|d| d.serial == addr && d.state == "device") {
            crate::adb::client::connect_network(&addr).await?;
        }
        return wait_ready(&addr).await;
    }
    let serial = cfg.serial.trim();
    if !serial.is_empty() {
        return wait_ready(serial).await;
    }
    let ready: Vec<_> = crate::adb::client::devices().await?.into_iter().filter(|d| d.state == "device").collect();
    match ready.len() {
        0 => bail!("没有已连接的 Android 设备：请用 USB 连接并允许 USB 调试"),
        1 => Ok(AdbDevice::new(ready[0].serial.clone())),
        _ => bail!("连接了多台设备，请在会话里选择一台"),
    }
}

/// A just-connected device can be "offline" / "authorizing" for a moment.
async fn wait_ready(serial: &str) -> Result<AdbDevice> {
    let mut last = String::from("未找到");
    for _ in 0..20 {
        let list = crate::adb::client::devices().await?;
        match list.iter().find(|d| d.serial == serial) {
            Some(d) if d.state == "device" => return Ok(AdbDevice::new(serial)),
            Some(d) if d.state == "unauthorized" => bail!("设备未授权：请在手机上允许 USB 调试（勾选“一律允许”）"),
            Some(d) => last = d.state.clone(),
            None => {}
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    bail!("设备 {} 不可用（{}）", serial, last)
}

pub fn spawn_adb_session(
    instance_id: String,
    session: SessionConfig,
    cols: u16,
    rows: u16,
    sink: Arc<dyn TerminalSink>,
    slot: AdbSlot,
) -> RuntimeControl {
    let (write_tx, mut write_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let (resize_tx, mut resize_rx) = mpsc::unbounded_channel::<(u16, u16)>();
    let (close_tx, mut close_rx) = mpsc::unbounded_channel::<()>();

    tauri::async_runtime::spawn(async move {
        sink.emit_state(&instance_id, "connecting", None);
        let opened = async {
            let device = resolve_device(&session).await?;
            crate::adb::shell::forget_features(&device.serial);
            let v2 = crate::adb::shell::has_v2(&device.serial).await;
            let term = if session.term.trim().is_empty() { "xterm-256color" } else { session.term.trim() };
            let stream = device
                .open(&crate::adb::shell::service(v2, true, term, ""))
                .await
                .context("无法打开设备 shell")?;
            anyhow::Ok((device, v2, stream))
        };
        let (device, v2, stream) = match opened.await {
            Ok(x) => x,
            Err(e) => {
                sink.emit_state(&instance_id, "error", Some(format!("{:#}", e)));
                return;
            }
        };
        *slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(device.clone());
        let (mut rd, mut wr) = tokio::io::split(stream);
        sink.emit_state(&instance_id, "connected", None);

        let frame = |data: &[u8]| if v2 { encode_packet(ID_STDIN, data) } else { data.to_vec() };
        if v2 {
            let _ = wr.write_all(&encode_resize(cols, rows)).await;
        }
        let startup = session
            .startup_command
            .as_ref()
            .filter(|s| !s.trim().is_empty())
            .map(|s| format!("{}\r", s.trim_end()));
        let working = session
            .working_dir
            .as_ref()
            .filter(|s| !s.trim().is_empty())
            .map(|d| format!("cd {}\r", crate::transfer::shell_quote(d.trim())));
        for line in [working, startup].into_iter().flatten() {
            let _ = wr.write_all(&frame(line.as_bytes())).await;
        }

        let mut buf = vec![0u8; 64 * 1024];
        let mut dec = PacketDecoder::default();
        let mut pump = OutputPump::new(Arc::clone(&sink), instance_id.clone());
        loop {
            tokio::select! {
                read_res = rd.read(&mut buf), if !pump.is_behind() => {
                    match read_res {
                        Ok(0) => {
                            pump.state("disconnected", Some("设备已断开".into()));
                            break;
                        }
                        Ok(n) if !v2 => pump.output(&buf[..n]),
                        Ok(n) => {
                            let mut exit = None;
                            for (id, body) in dec.feed(&buf[..n]) {
                                match id {
                                    ID_STDOUT | ID_STDERR => pump.output(&body),
                                    ID_EXIT => exit = Some(body.first().copied().unwrap_or(0)),
                                    _ => {}
                                }
                            }
                            if let Some(code) = exit {
                                pump.state("disconnected", Some(format!("shell 已退出（{}）", code)));
                                break;
                            }
                        }
                        Err(e) => {
                            pump.state("disconnected", Some(format!("设备连接中断: {}", e)));
                            break;
                        }
                    }
                }
                _ = pump.flush(), if pump.is_behind() => {}
                Some(data) = write_rx.recv() => {
                    if let Err(e) = wr.write_all(&frame(&data)).await {
                        pump.state("disconnected", Some(format!("写入设备失败: {}", e)));
                        break;
                    }
                }
                Some((c, r)) = resize_rx.recv() => {
                    if v2 {
                        let _ = wr.write_all(&encode_resize(c, r)).await;
                    }
                }
                Some(()) = close_rx.recv() => {
                    let _ = wr.shutdown().await;
                    pump.state("disconnected", Some("已断开连接".into()));
                    break;
                }
            }
        }
        pump.finish().await;
        slot.lock().unwrap_or_else(|e| e.into_inner()).take();
    });

    RuntimeControl::Async(AsyncChannels { write_tx, resize_tx, close_tx, exec_tx: None, tunnel_tx: None })
}
