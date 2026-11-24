//! Tauri commands of the ADB features (registered in `lib.rs`).

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, State};

use super::{client, locate, logcat, ops, scrcpy, AdbDevice};
use crate::manager::TauriSink;
use crate::AppContext;

fn err(e: anyhow::Error) -> String {
    format!("{:#}", e)
}

/// The device of a connected ADB pane, or a serial given directly (sidebar device list,
/// session form).
async fn device_of(ctx: &AppContext, instance_id: Option<&str>, serial: Option<&str>) -> Result<AdbDevice, String> {
    if let Some(id) = instance_id.filter(|s| !s.is_empty()) {
        return ctx.connections.adb_device(id).map_err(err);
    }
    match serial.filter(|s| !s.is_empty()) {
        Some(s) => Ok(AdbDevice::new(s)),
        None => Err("没有指定设备".into()),
    }
}

#[tauri::command]
pub async fn adb_status() -> locate::AdbStatus {
    locate::status().await
}

/// Download Google's platform-tools; progress as `adb-download-progress` {received, total}.
#[tauri::command]
pub async fn adb_download(app: AppHandle) -> Result<String, String> {
    let path = locate::download(|received, total| {
        let _ = app.emit("adb-download-progress", serde_json::json!({ "received": received, "total": total }));
    })
    .await
    .map_err(err)?;
    Ok(path.display().to_string())
}

#[tauri::command]
pub async fn adb_devices() -> Result<Vec<client::DeviceInfo>, String> {
    client::devices().await.map_err(err)
}

/// Device list updates as `adb-devices` events (the adb server pushes them). One watcher
/// for the app; it restarts the server connection when it drops.
#[tauri::command]
pub fn adb_watch_devices(app: AppHandle) {
    static WATCHING: AtomicBool = AtomicBool::new(false);
    if WATCHING.swap(true, Ordering::SeqCst) {
        // Already running: send the current list to the caller's window right away.
        tauri::async_runtime::spawn(async move {
            if let Ok(list) = client::devices().await {
                let _ = app.emit("adb-devices", list);
            }
        });
        return;
    }
    tauri::async_runtime::spawn(async move {
        loop {
            // Does not start a server: the watcher waits for one (a pane or the form starts it).
            if client::running_version().await.is_none() {
                let _ = app.emit("adb-devices", Vec::<client::DeviceInfo>::new());
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                continue;
            }
            if let Ok(mut s) = client::track_devices().await {
                while let Ok(text) = client::read_block(&mut s).await {
                    let _ = app.emit("adb-devices", client::parse_devices(&text));
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    });
}

#[tauri::command]
pub async fn adb_start_server() -> Result<u32, String> {
    client::version().await.map_err(err)
}

#[tauri::command]
pub async fn adb_connect(addr: String) -> Result<String, String> {
    client::connect_network(addr.trim()).await.map_err(err)
}

#[tauri::command]
pub async fn adb_disconnect(addr: String) -> Result<String, String> {
    client::disconnect_network(addr.trim()).await.map_err(err)
}

#[tauri::command]
pub async fn adb_pair(addr: String, code: String) -> Result<String, String> {
    // pair needs a running server too.
    client::version().await.map_err(err)?;
    locate::pair(&addr, &code).await.map_err(err)
}

/// Switch a USB device to WLAN debugging (`adb tcpip 5555`) and return its Wi-Fi address.
#[tauri::command]
pub async fn adb_enable_wlan(serial: String, port: Option<u16>) -> Result<String, String> {
    let device = AdbDevice::new(serial.trim());
    let port = port.unwrap_or(5555);
    let ip = device
        .exec_output("ip -f inet addr show wlan0 2>/dev/null | grep -o 'inet [0-9.]*' | head -n1 | cut -d' ' -f2")
        .await
        .map_err(err)?
        .trim()
        .to_string();
    // Restarting adbd drops this socket: the reply may never come, which is fine.
    let _ = device.open(&format!("tcpip:{}", port)).await;
    if ip.is_empty() {
        return Err("设备没有连接 Wi-Fi（找不到 wlan0 地址）".into());
    }
    Ok(format!("{}:{}", ip, port))
}

#[tauri::command]
pub async fn adb_props(ctx: State<'_, AppContext>, instance_id: Option<String>, serial: Option<String>) -> Result<ops::DeviceProps, String> {
    let d = device_of(&ctx, instance_id.as_deref(), serial.as_deref()).await?;
    ops::props(&d).await.map_err(err)
}

// ---------------------------------------------------------------------------------------
// Apps / processes

#[tauri::command]
pub async fn adb_apps(ctx: State<'_, AppContext>, instance_id: Option<String>, serial: Option<String>, versions: bool) -> Result<Vec<ops::AppInfo>, String> {
    let d = device_of(&ctx, instance_id.as_deref(), serial.as_deref()).await?;
    ops::apps(&d, versions).await.map_err(err)
}

#[tauri::command]
pub async fn adb_app_action(ctx: State<'_, AppContext>, instance_id: String, package: String, action: ops::AppAction) -> Result<String, String> {
    let d = device_of(&ctx, Some(&instance_id), None).await?;
    ops::app_action(&d, &package, action).await.map_err(err)
}

#[tauri::command]
pub async fn adb_install(ctx: State<'_, AppContext>, instance_id: String, path: String) -> Result<String, String> {
    let d = device_of(&ctx, Some(&instance_id), None).await?;
    ops::install(&d, &PathBuf::from(path)).await.map_err(err)
}

#[tauri::command]
pub async fn adb_export_apk(ctx: State<'_, AppContext>, instance_id: String, package: String, dir: String) -> Result<Vec<String>, String> {
    let d = device_of(&ctx, Some(&instance_id), None).await?;
    ops::export_apk(&d, &package, &PathBuf::from(dir)).await.map_err(err)
}

#[tauri::command]
pub async fn adb_foreground(ctx: State<'_, AppContext>, instance_id: Option<String>, serial: Option<String>) -> Result<Option<String>, String> {
    let d = device_of(&ctx, instance_id.as_deref(), serial.as_deref()).await?;
    ops::foreground(&d).await.map_err(err)
}

#[tauri::command]
pub async fn adb_processes(ctx: State<'_, AppContext>, instance_id: Option<String>, serial: Option<String>) -> Result<Vec<ops::ProcessInfo>, String> {
    let d = device_of(&ctx, instance_id.as_deref(), serial.as_deref()).await?;
    ops::processes(&d).await.map_err(err)
}

#[tauri::command]
pub async fn adb_kill(ctx: State<'_, AppContext>, instance_id: String, pids: Vec<u32>, signal: Option<u8>) -> Result<(), String> {
    let d = device_of(&ctx, Some(&instance_id), None).await?;
    ops::kill(&d, &pids, signal.unwrap_or(15)).await.map_err(err)
}

// ---------------------------------------------------------------------------------------
// Logcat tabs. A logcat tab has its own `instance_id` (pane id) but no terminal
// connection: the device comes from its session (serial / WLAN address).

#[tauri::command]
pub async fn adb_logcat_start(
    app: AppHandle,
    instance_id: String,
    session: crate::models::SessionConfig,
    options: logcat::LogcatOptions,
    channel: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    let sink: Arc<dyn crate::manager::TerminalSink> = Arc::new(TauriSink { app });
    sink.emit_state(&instance_id, "connecting", None);
    let device = match crate::adb_conn::resolve_device(&session).await {
        Ok(d) => d,
        Err(e) => {
            sink.emit_state(&instance_id, "error", Some(err(e)));
            return Ok(());
        }
    };
    logcat::start(instance_id, device, options, channel, sink);
    Ok(())
}

#[tauri::command]
pub fn adb_logcat_stop(instance_id: String) {
    logcat::stop(&instance_id);
}

#[tauri::command]
pub async fn adb_logcat_clear(session: crate::models::SessionConfig, buffers: Vec<String>) -> Result<(), String> {
    let d = crate::adb_conn::resolve_device(&session).await.map_err(err)?;
    logcat::clear(&d, &buffers).await.map_err(err)
}

// ---------------------------------------------------------------------------------------
// Screen mirror (side panel). `mirror_id` is chosen by the panel.

#[tauri::command]
pub async fn adb_mirror_start(
    app: AppHandle,
    ctx: State<'_, AppContext>,
    mirror_id: String,
    instance_id: Option<String>,
    serial: Option<String>,
    options: scrcpy::MirrorOptions,
    channel: Channel<InvokeResponseBody>,
) -> Result<scrcpy::MirrorInfo, String> {
    let d = device_of(&ctx, instance_id.as_deref(), serial.as_deref()).await?;
    scrcpy::start(app, mirror_id, d, options, channel).await.map_err(err)
}

#[tauri::command]
pub fn adb_mirror_input(mirror_id: String, events: Vec<scrcpy::MirrorInput>) -> Result<(), String> {
    scrcpy::input(&mirror_id, &events).map_err(err)
}

#[tauri::command]
pub fn adb_mirror_ack(mirror_id: String, count: u32) {
    scrcpy::ack(&mirror_id, count);
}

#[tauri::command]
pub fn adb_mirror_stop(mirror_id: String) {
    scrcpy::stop(&mirror_id);
}

/// A PNG of the device screen (`screencap -p`), saved to `path`.
#[tauri::command]
pub async fn adb_screenshot(ctx: State<'_, AppContext>, instance_id: Option<String>, serial: Option<String>, path: String) -> Result<(), String> {
    let d = device_of(&ctx, instance_id.as_deref(), serial.as_deref()).await?;
    let r = super::shell::exec(&d, "screencap -p", std::time::Duration::from_secs(20)).await.map_err(err)?;
    if r.stdout.len() < 8 || &r.stdout[..4] != b"\x89PNG" {
        return Err(format!("截图失败：{}", String::from_utf8_lossy(&r.stderr).trim()));
    }
    std::fs::write(&path, &r.stdout).map_err(|e| e.to_string())
}
