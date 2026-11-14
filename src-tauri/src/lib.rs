pub mod agent;
pub mod app_paths;
pub mod charset;
pub mod commands;
pub mod importer;
pub mod local_pty;
pub mod manager;
pub mod mcp;
pub mod models;
pub mod net;
pub mod notify;
pub mod output;
pub mod remote;
pub mod remote_crypto;
pub mod serial_conn;
pub mod session_log;
pub mod shell_integration;
pub mod ssh_conn;
pub mod storage;
pub mod tcp_conn;
pub mod telnet_conn;
pub mod term_capture;
pub mod xserver;
pub mod xymodem;
pub mod zmodem;

use crate::serial_conn::list_serial_ports as windterm_serial_ports;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, State, WindowEvent};

use crate::importer::{discover_import_sources, import_from_path};
use crate::manager::{resolve_host_key, ConnectionManager, HostKeyDecision, InjectOutcome, TauriSink, TunnelRequest, TunnelStatus};
use crate::models::{
    AppSettings, AppStateSnapshot, DiscoveryCandidate, ImportResult, QuickCommand, SessionConfig, TunnelConfig,
};
use crate::session_log::{expand_log_file_name, LogNameVars, LogOptions, SessionLog};
use crate::storage::Storage;

pub struct AppContext {
    pub storage: Mutex<Storage>,
    pub connections: ConnectionManager,
    /// Mirrors AppSettings.close_to_tray for the window close handler.
    pub close_to_tray: AtomicBool,
    /// Mirrors AppSettings.askBeforeCloseWindow: confirm quitting while sessions are open.
    pub ask_before_quit: AtomicBool,
    /// Set once the user confirmed quitting.
    pub quit_confirmed: AtomicBool,
}

impl AppContext {
    fn settings(&self) -> AppSettings {
        self.storage
            .lock()
            .ok()
            .and_then(|s| s.load_settings().ok())
            .unwrap_or_default()
    }
}

fn log_dir(settings: &AppSettings) -> PathBuf {
    match settings.log_dir.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
        Some(dir) => PathBuf::from(dir),
        None => dirs::document_dir()
            .or_else(dirs::home_dir)
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Nexterm")
            .join("logs"),
    }
}

fn extra_bool(settings: &AppSettings, key: &str, default: bool) -> bool {
    settings.extra.get(key).and_then(|v| v.as_bool()).unwrap_or(default)
}

fn extra_str(settings: &AppSettings, key: &str) -> String {
    settings.extra.get(key).and_then(|v| v.as_str()).unwrap_or_default().to_string()
}

fn log_options(settings: &AppSettings) -> LogOptions {
    let max_mb = settings.extra.get("logMaxSizeMb").and_then(|v| v.as_f64()).unwrap_or(0.0).max(0.0);
    let pattern = extra_str(settings, "logLinePattern");
    LogOptions {
        timestamp: settings.log_timestamp,
        line_pattern: if pattern.trim().is_empty() { crate::session_log::default_line_pattern() } else { pattern },
        max_bytes: (max_mb * 1024.0 * 1024.0) as u64,
        raw: extra_str(settings, "logType") == "raw",
    }
}

fn remote_config(settings: &AppSettings) -> crate::remote::RemoteConfig {
    settings
        .extra
        .get("remote")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default()
}

fn xserver_config(settings: &AppSettings) -> crate::xserver::XServerConfig {
    settings
        .extra
        .get("xserver")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default()
}

fn open_session_log(settings: &AppSettings, vars: &LogNameVars) -> anyhow::Result<SessionLog> {
    let name = expand_log_file_name(&settings.log_file_pattern, vars);
    SessionLog::create(&log_dir(settings), &name, log_options(settings))
}

fn log_vars(session: &SessionConfig) -> LogNameVars {
    LogNameVars {
        label: session.label.clone(),
        host: session.host.clone(),
        user: session.username.clone(),
        protocol: serde_json::to_value(&session.protocol)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_default(),
    }
}

fn show_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

#[tauri::command]
fn load_initial_state(ctx: State<'_, AppContext>) -> Result<AppStateSnapshot, String> {
    let storage = ctx.storage.lock().map_err(|e| e.to_string())?;
    Ok(storage.load_snapshot())
}

#[tauri::command]
fn save_sessions(ctx: State<'_, AppContext>, sessions: Vec<SessionConfig>) -> Result<(), String> {
    let storage = ctx.storage.lock().map_err(|e| e.to_string())?;
    storage.save_sessions(&sessions).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_quick_commands(
    ctx: State<'_, AppContext>,
    commands: Vec<QuickCommand>,
) -> Result<(), String> {
    let storage = ctx.storage.lock().map_err(|e| e.to_string())?;
    storage
        .save_quick_commands(&commands)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn save_settings(ctx: State<'_, AppContext>, settings: AppSettings) -> Result<(), String> {
    ctx.close_to_tray.store(settings.close_to_tray, Ordering::Relaxed);
    ctx.ask_before_quit
        .store(extra_bool(&settings, "askBeforeCloseWindow", true), Ordering::Relaxed);
    crate::shell_integration::set_enabled(extra_bool(&settings, "shellIntegration", true));
    crate::xserver::configure(xserver_config(&settings));
    crate::remote::configure(remote_config(&settings));
    let storage = ctx.storage.lock().map_err(|e| e.to_string())?;
    storage.save_settings(&settings).map_err(|e| e.to_string())
}

#[tauri::command]
async fn connect_terminal(
    app: AppHandle,
    ctx: State<'_, AppContext>,
    instance_id: String,
    session: SessionConfig,
    cols: u16,
    rows: u16,
    reuse_from: Option<String>,
) -> Result<Option<String>, String> {
    let sink = Arc::new(TauriSink { app });
    let auto_log = session.auto_log;
    let vars = log_vars(&session);
    ctx.connections
        .connect(instance_id.clone(), session, cols, rows, sink, reuse_from.as_deref())
        .map_err(|e| format!("{:#}", e))?;
    if !auto_log || ctx.connections.is_logging(&instance_id) {
        return Ok(ctx.connections.log_path(&instance_id));
    }
    let log = open_session_log(&ctx.settings(), &vars).map_err(|e| format!("{:#}", e))?;
    ctx.connections
        .start_log(&instance_id, log)
        .map(Some)
        .map_err(|e| format!("{:#}", e))
}

#[tauri::command]
fn start_session_log(
    ctx: State<'_, AppContext>,
    instance_id: String,
    label: String,
    host: Option<String>,
    username: Option<String>,
    protocol: Option<String>,
) -> Result<String, String> {
    let vars = LogNameVars {
        label,
        host: host.unwrap_or_default(),
        user: username.unwrap_or_default(),
        protocol: protocol.unwrap_or_default(),
    };
    let log = open_session_log(&ctx.settings(), &vars).map_err(|e| format!("{:#}", e))?;
    ctx.connections
        .start_log(&instance_id, log)
        .map_err(|e| format!("{:#}", e))
}

#[tauri::command]
fn stop_session_log(ctx: State<'_, AppContext>, instance_id: String) {
    ctx.connections.stop_log(&instance_id);
}

/// Pause / resume writing a session log (WindTerm: pause logging). Returns the new state.
#[tauri::command]
fn pause_session_log(ctx: State<'_, AppContext>, instance_id: String, paused: bool) -> Result<bool, String> {
    ctx.connections
        .pause_log(&instance_id, paused)
        .ok_or_else(|| "该窗格没有正在记录的日志".to_string())
}

/// XMODEM / YMODEM transfer started from the pane menu.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn modem_start(
    ctx: State<'_, AppContext>,
    instance_id: String,
    protocol: String,
    send: bool,
    files: Vec<String>,
    target: Option<String>,
    command: Option<String>,
    packet_size: Option<usize>,
) -> Result<(), String> {
    let proto = match protocol.to_ascii_lowercase().as_str() {
        "xmodem" => crate::xymodem::Protocol::Xmodem,
        "ymodem" => crate::xymodem::Protocol::Ymodem,
        other => return Err(format!("未知的传输协议 {}", other)),
    };
    let default_packet = if proto == crate::xymodem::Protocol::Xmodem { 128 } else { 1024 };
    ctx.connections
        .modem_start(
            &instance_id,
            proto,
            send,
            files.into_iter().map(PathBuf::from).collect(),
            target.filter(|t| !t.trim().is_empty()).map(PathBuf::from),
            command,
            packet_size.unwrap_or(default_packet),
        )
        .map_err(|e| format!("{:#}", e))
}

/// Small JSON data files next to settings.json (command history, senders, last sessions).
const DATA_FILES: &[&str] = &[
    "command_history",
    "senders",
    "last_sessions",
    "session_usage",
    "last_workspace",
    "ui_state",
    "quick_connect_history",
];

/// A saved session was opened: bump its use count and last-used time in session_usage.json
/// ({ id: { count, lastUsed } }), then tell every window (sidebar sorting).
#[tauri::command]
fn record_session_use(app: AppHandle, ctx: State<'_, AppContext>, id: String) -> Result<(), String> {
    let usage = {
        let storage = ctx.storage.lock().map_err(|e| e.to_string())?;
        let path = storage.base_dir().join("session_usage.json");
        let mut usage: serde_json::Map<String, serde_json::Value> = std::fs::read_to_string(&path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        let count = usage.get(&id).and_then(|v| v.get("count")).and_then(|c| c.as_u64()).unwrap_or(0);
        let now = chrono::Utc::now().timestamp_millis();
        usage.insert(id, serde_json::json!({ "count": count + 1, "lastUsed": now }));
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string(&usage).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
        usage
    };
    use tauri::Emitter;
    let _ = app.emit("session-usage", usage);
    Ok(())
}

#[tauri::command]
fn load_data_file(ctx: State<'_, AppContext>, name: String) -> Result<Option<serde_json::Value>, String> {
    if !DATA_FILES.contains(&name.as_str()) {
        return Err(format!("unknown data file {}", name));
    }
    let storage = ctx.storage.lock().map_err(|e| e.to_string())?;
    let path = storage.base_dir().join(format!("{}.json", name));
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(serde_json::from_str(&text).ok()),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
fn save_data_file(ctx: State<'_, AppContext>, name: String, value: serde_json::Value) -> Result<(), String> {
    if !DATA_FILES.contains(&name.as_str()) {
        return Err(format!("unknown data file {}", name));
    }
    let storage = ctx.storage.lock().map_err(|e| e.to_string())?;
    let path = storage.base_dir().join(format!("{}.json", name));
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string(&value).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Save terminal output (Save to file).
#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content.as_bytes()).map_err(|e| format!("无法写入 {}: {}", path, e))
}

/// Open a link from the terminal in the system's default browser / mail client.
/// Only web and mail links: a terminal can print anything, so no file:// or programs.
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    let url = url.trim().to_string();
    let lower = url.to_ascii_lowercase();
    if !["http://", "https://", "ftp://", "mailto:"].iter().any(|p| lower.starts_with(p)) {
        return Err(format!("不支持打开这种链接：{}", url));
    }
    if url.chars().any(|c| c.is_control()) {
        return Err("链接里有控制字符".into());
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
        let (verb, target) = (wide("open"), wide(&url));
        let code = unsafe {
            ShellExecuteW(0, verb.as_ptr(), target.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL as i32)
        };
        // ShellExecute returns a value > 32 on success.
        if code as isize <= 32 {
            return Err(format!("无法打开链接（错误 {}）", code as isize));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
        std::process::Command::new(opener).arg(&url).spawn().map(|_| ()).map_err(|e| e.to_string())
    }
}

/// Command names + descriptions for auto completion (WindTerm terminal/commands).
#[tauri::command]
async fn command_catalog(scheme: String) -> Vec<crate::commands::CatalogEntry> {
    tauri::async_runtime::spawn_blocking(move || crate::commands::catalog(&scheme))
        .await
        .unwrap_or_default()
}

#[tauri::command]
async fn command_options(scheme: String, name: String) -> Vec<crate::commands::CommandOption> {
    tauri::async_runtime::spawn_blocking(move || crate::commands::options(&scheme, &name))
        .await
        .unwrap_or_default()
}

#[tauri::command]
fn xserver_status() -> crate::xserver::XServerStatus {
    crate::xserver::status()
}

#[tauri::command]
async fn xserver_start() -> Result<crate::xserver::XServerStatus, String> {
    tauri::async_runtime::spawn_blocking(|| crate::xserver::start(None))
        .await
        .map_err(|e| e.to_string())??;
    Ok(crate::xserver::status())
}

#[tauri::command]
fn xserver_stop() -> crate::xserver::XServerStatus {
    crate::xserver::stop();
    crate::xserver::status()
}

/// Show a log file (or the log folder when no path is given) in Explorer.
#[tauri::command]
fn reveal_log(ctx: State<'_, AppContext>, path: Option<String>) -> Result<(), String> {
    let mut cmd = std::process::Command::new("explorer");
    match path.filter(|p| std::path::Path::new(p).exists()) {
        Some(p) => {
            cmd.arg(format!("/select,{}", p.replace('/', "\\")));
        }
        None => {
            let dir = log_dir(&ctx.settings());
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            cmd.arg(dir);
        }
    }
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Locked sessions per window, reported by each window's frontend.
fn locked_counts() -> &'static Mutex<std::collections::HashMap<String, usize>> {
    static COUNTS: std::sync::OnceLock<Mutex<std::collections::HashMap<String, usize>>> = std::sync::OnceLock::new();
    COUNTS.get_or_init(Default::default)
}

#[tauri::command]
fn report_locked_sessions(window: tauri::WebviewWindow, count: usize) {
    if let Ok(mut m) = locked_counts().lock() {
        m.insert(window.label().to_string(), count);
    }
}

/// Quit unless some window still holds locked sessions; then show it and say why.
/// With "ask before closing" on and sessions open, the main window asks first.
fn request_quit(app: &AppHandle) {
    use tauri::Emitter;
    if let Some(ctx) = app.try_state::<AppContext>() {
        let open = ctx.connections.count();
        if open > 0 && ctx.ask_before_quit.load(Ordering::Relaxed) && !ctx.quit_confirmed.load(Ordering::Relaxed) {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
                let _ = win.emit("confirm-quit", open);
                return;
            }
        }
    }
    let locked: Vec<(String, usize)> = locked_counts()
        .lock()
        .map(|m| m.iter().filter(|(_, c)| **c > 0).map(|(l, c)| (l.clone(), *c)).collect())
        .unwrap_or_default();
    if locked.is_empty() {
        crate::xserver::stop();
        app.exit(0);
        return;
    }
    for (label, count) in locked {
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.unminimize();
            let _ = win.show();
            let _ = win.set_focus();
            let _ = win.emit("quit-blocked", count);
        }
    }
}

#[tauri::command]
fn quit_app(app: AppHandle, ctx: State<'_, AppContext>, confirmed: Option<bool>) {
    if confirmed.unwrap_or(false) {
        ctx.quit_confirmed.store(true, Ordering::Relaxed);
    }
    request_quit(&app);
}

#[tauri::command]
fn respond_host_key(request_id: String, decision: HostKeyDecision) {
    resolve_host_key(&request_id, decision);
}

/// Run a command on a pane's SSH connection (own exec channel), e.g. tmux queries.
#[tauri::command]
async fn ssh_exec(ctx: State<'_, AppContext>, instance_id: String, command: String) -> Result<String, String> {
    let rx = ctx.connections.exec(&instance_id, &command).map_err(|e| format!("{:#}", e))?;
    rx.await.map_err(|_| "SSH 连接已断开".to_string())?
}

/// Pane menu › "Load shell integration": "loaded" / "unsupported" / "noAnswer".
#[tauri::command]
async fn inject_shell_integration(ctx: State<'_, AppContext>, instance_id: String) -> Result<InjectOutcome, String> {
    let rx = ctx.connections.inject_shell_integration(&instance_id).map_err(|e| format!("{:#}", e))?;
    rx.await.map_err(|_| "连接已断开".to_string())
}

#[tauri::command]
async fn tunnel_list(ctx: State<'_, AppContext>, instance_id: String) -> Result<Vec<TunnelStatus>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    ctx.connections.tunnel(&instance_id, TunnelRequest::List(tx)).map_err(|e| format!("{:#}", e))?;
    rx.await.map_err(|_| "SSH 连接已断开".to_string())
}

#[tauri::command]
async fn tunnel_start(
    ctx: State<'_, AppContext>,
    instance_id: String,
    tunnel: TunnelConfig,
) -> Result<Vec<TunnelStatus>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    ctx.connections
        .tunnel(&instance_id, TunnelRequest::Start(tunnel, tx))
        .map_err(|e| format!("{:#}", e))?;
    rx.await.map_err(|_| "SSH 连接已断开".to_string())?
}

#[tauri::command]
async fn tunnel_stop(ctx: State<'_, AppContext>, instance_id: String, id: String) -> Result<Vec<TunnelStatus>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    ctx.connections.tunnel(&instance_id, TunnelRequest::Stop(id, tx)).map_err(|e| format!("{:#}", e))?;
    rx.await.map_err(|_| "SSH 连接已断开".to_string())
}

#[tauri::command]
fn zmodem_start(
    ctx: State<'_, AppContext>,
    instance_id: String,
    files: Vec<String>,
    dir: Option<String>,
) -> Result<(), String> {
    ctx.connections
        .zmodem_start(
            &instance_id,
            files.into_iter().map(PathBuf::from).collect(),
            dir.filter(|d| !d.trim().is_empty()).map(PathBuf::from),
        )
        .map_err(|e| format!("{:#}", e))
}

/// Folder holding files dropped on a terminal until ZMODEM has sent them.
fn zmodem_drop_dir(ctx: &AppContext) -> Result<PathBuf, String> {
    let storage = ctx.storage.lock().map_err(|e| e.to_string())?;
    Ok(storage.base_dir().join("zmodem-drop"))
}

/// A token or file name usable as one path component (no separators, no "..").
fn safe_component(raw: &str) -> Option<String> {
    let name = raw.rsplit(['/', '\\']).next().unwrap_or("").trim();
    let name: String = name.chars().filter(|c| !c.is_control() && !"<>:\"|?*".contains(*c)).collect();
    (!name.is_empty() && name != "." && name != "..").then_some(name)
}

/// Write one chunk of a file dropped on a terminal (the webview has its contents, not its
/// path). Headers: x-token (batch), x-name (base64 UTF-8 file name), x-append ("1" after the
/// first chunk). Body: raw bytes. Returns the file's path, for zmodem_start.
#[tauri::command]
fn zmodem_stage_chunk(ctx: State<'_, AppContext>, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    use std::io::Write;
    let header = |key: &str| request.headers().get(key).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let token = safe_component(&header("x-token")).ok_or("bad token")?;
    // Headers are ASCII: the name comes base64-encoded (UTF-8).
    let name = B64.decode(header("x-name")).map_err(|e| e.to_string())?;
    let name = String::from_utf8(name).map_err(|e| e.to_string())?;
    let name = safe_component(&name).ok_or("bad file name")?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw bytes".into());
    };
    let dir = zmodem_drop_dir(&ctx)?.join(token);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(name);
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(header("x-append") == "1")
        .truncate(header("x-append") != "1")
        .open(&path)
        .map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Delete a batch of staged files (token), or every leftover batch (no token).
#[tauri::command]
fn zmodem_unstage(ctx: State<'_, AppContext>, token: Option<String>) -> Result<(), String> {
    let base = zmodem_drop_dir(&ctx)?;
    let target = match token {
        Some(t) => base.join(safe_component(&t).ok_or("bad token")?),
        None => base,
    };
    if target.exists() {
        std::fs::remove_dir_all(&target).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn zmodem_cancel(ctx: State<'_, AppContext>, instance_id: String) {
    ctx.connections.zmodem_cancel(&instance_id);
}

#[tauri::command]
fn list_charsets() -> Vec<String> {
    crate::charset::CHARSETS.iter().map(|(n, _)| n.to_string()).collect()
}

/// Whole-window opacity (0.2 - 1.0), like WindTerm's translucent window.
#[tauri::command]
fn set_window_opacity(window: tauri::WebviewWindow, opacity: f64) -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GetWindowLongPtrW, SetLayeredWindowAttributes, SetWindowLongPtrW, GWL_EXSTYLE, LWA_ALPHA, WS_EX_LAYERED,
        };
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
        let alpha = (opacity.clamp(0.2, 1.0) * 255.0).round() as u8;
        unsafe {
            let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            if alpha >= 255 {
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style & !(WS_EX_LAYERED as isize));
            } else {
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style | WS_EX_LAYERED as isize);
                SetLayeredWindowAttributes(hwnd, 0, alpha, LWA_ALPHA);
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (window, opacity);
    }
    Ok(())
}

/// Whether the primary mouse button is held right now. A window dragged by its title
/// bar reports moves but no button release; this tells when the drag ended (docking).
#[tauri::command]
fn mouse_primary_down() -> bool {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_SWAPBUTTON};
        let key = if GetSystemMetrics(SM_SWAPBUTTON) != 0 { VK_RBUTTON } else { VK_LBUTTON };
        (GetAsyncKeyState(key as i32) as u16 & 0x8000) != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Windows toast; a click comes back as the `notification-clicked` event with `tag`.
#[tauri::command]
fn show_notification(app: AppHandle, title: String, body: String, tag: String) -> Result<(), String> {
    notify::show(&app, title, body, tag)
}

#[tauri::command]
fn agent_hooks_read_local() -> agent::LocalHookFiles {
    agent::read_local()
}

#[tauri::command]
fn agent_hooks_write_local(files: agent::LocalHookWrite) -> Result<(), String> {
    agent::write_local(files)
}

/// Panes handed to the MCP agent (for a window that just opened).
#[tauri::command]
fn mcp_controls() -> Vec<mcp::ControlView> {
    mcp::controls()
}

/// Pane banner / menu: hand the pane to the agent ("active"), pause, or take it back (None).
#[tauri::command]
fn mcp_set_control(instance_id: String, mode: Option<mcp::ControlMode>, title: String) {
    mcp::set_control(&instance_id, mode, &title);
}

/// request_control dialogs still waiting for the user (a window that just opened).
#[tauri::command]
fn mcp_pending_requests() -> Vec<mcp::ControlRequest> {
    mcp::pending_requests()
}

/// The main window answered an agent's open_session (and opened the tab if allowed).
#[tauri::command]
fn mcp_open_respond(request_id: String, result: mcp::OpenResult) {
    mcp::respond_open(&request_id, result);
}

/// The user allowed / refused an agent's request_control.
#[tauri::command]
fn mcp_respond_request(request_id: String, accept: bool, title: String) {
    mcp::respond_request(&request_id, accept, &title);
}

#[tauri::command]
fn mcp_screen_reply(request_id: String, snapshot: mcp::ScreenSnapshot) {
    mcp::screen_reply(&request_id, snapshot);
}

/// The command line that adds Nexterm to an agent CLI ("claude" or "codex") as an MCP server.
#[tauri::command]
fn mcp_client_command(client: String) -> String {
    let exe = std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_else(|_| "nexterm.exe".into());
    mcp::client_command(&client, &exe)
}

/// Tabs moving to another window: the source parks the pane (session + scrollback)
/// here and the target window picks it up by token.
fn pane_transfers() -> &'static Mutex<std::collections::HashMap<String, serde_json::Value>> {
    static TRANSFERS: std::sync::OnceLock<Mutex<std::collections::HashMap<String, serde_json::Value>>> =
        std::sync::OnceLock::new();
    TRANSFERS.get_or_init(Default::default)
}

#[tauri::command]
fn stash_pane_transfer(token: String, payload: serde_json::Value) {
    if let Ok(mut m) = pane_transfers().lock() {
        m.insert(token, payload);
    }
}

#[tauri::command]
fn take_pane_transfer(token: String) -> Option<serde_json::Value> {
    pane_transfers().lock().ok().and_then(|mut m| m.remove(&token))
}

#[tauri::command]
fn write_terminal(
    ctx: State<'_, AppContext>,
    instance_id: String,
    data_b64: String,
) -> Result<(), String> {
    let bytes = B64.decode(&data_b64).map_err(|e| e.to_string())?;
    // The AI agent holds this pane: keystrokes wait until the user pauses it.
    if !mcp::user_write_allowed(&instance_id, &bytes) {
        return Err("ai-locked".into());
    }
    ctx.connections
        .write(&instance_id, &bytes)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn broadcast_terminal(
    ctx: State<'_, AppContext>,
    instance_ids: Vec<String>,
    data_b64: String,
) -> Result<(), String> {
    let bytes = B64.decode(&data_b64).map_err(|e| e.to_string())?;
    let instance_ids: Vec<String> = instance_ids.into_iter().filter(|id| mcp::user_write_allowed(id, &bytes)).collect();
    ctx.connections
        .broadcast_write(&instance_ids, &bytes)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn resize_terminal(
    ctx: State<'_, AppContext>,
    instance_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    ctx.connections
        .resize(&instance_id, cols, rows)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn disconnect_terminal(
    app: AppHandle,
    ctx: State<'_, AppContext>,
    instance_id: String,
) -> Result<(), String> {
    ctx.connections.disconnect(&instance_id);
    mcp::forget(&instance_id);
    let sink = TauriSink { app };
    crate::manager::TerminalSink::emit_state(
        &sink,
        &instance_id,
        "disconnected",
        Some("已手动断开连接".into()),
    );
    Ok(())
}

/// Attach a pane's output to a binary channel of the calling window (see `output.rs`).
#[tauri::command]
fn subscribe_output(instance_id: String, on_output: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>) -> u64 {
    crate::output::subscribe(&instance_id, on_output)
}

#[tauri::command]
fn unsubscribe_output(ctx: State<'_, AppContext>, instance_id: String, token: u64) {
    let live = ctx.connections.is_open(&instance_id);
    crate::output::unsubscribe(&instance_id, token, live);
}

/// The webview has parsed `bytes` more bytes of the pane's output.
#[tauri::command]
fn ack_output(instance_id: String, bytes: usize) {
    crate::output::ack(&instance_id, bytes);
}

#[tauri::command]
fn remote_status() -> crate::remote::RemoteStatus {
    crate::remote::status()
}

#[tauri::command]
fn remote_pairing() -> crate::remote::RemotePairing {
    crate::remote::pairing()
}

#[tauri::command]
fn remote_reset_pairing() -> crate::remote::RemotePairing {
    crate::remote::reset_pairing();
    crate::remote::pairing()
}

#[tauri::command]
fn remote_kick(phone: u32) {
    crate::remote::kick(phone);
}

/// The calling window's tabs, for the phones' tab list.
#[tauri::command]
fn remote_report_tabs(window: tauri::WebviewWindow, tabs: Vec<crate::remote::RemoteTab>) {
    crate::remote::report_tabs(window.label(), tabs);
}

/// What phones watch and which sizes they hold, for a pane that mounts later.
#[tauri::command]
fn remote_watch_state() -> serde_json::Value {
    let sizes: Vec<serde_json::Value> = crate::remote::takeovers()
        .into_iter()
        .map(|(pane, cols, rows)| serde_json::json!({ "paneId": pane, "cols": cols, "rows": rows }))
        .collect();
    serde_json::json!({ "watched": crate::remote::watched(), "sizes": sizes })
}

#[tauri::command]
fn remote_release(pane_id: String) {
    crate::remote::release(&pane_id);
}

/// Output, size changes and screen snapshots of a watched pane (raw body, see `remote.rs`).
#[tauri::command]
fn remote_feed(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let pane = request.headers().get("x-pane").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw bytes".into());
    };
    crate::remote::feed(&pane, bytes);
    Ok(())
}

#[tauri::command]
fn list_serial_ports() -> Vec<String> {
    windterm_serial_ports()
}

#[tauri::command]
fn scan_import_candidates() -> Vec<DiscoveryCandidate> {
    discover_import_sources()
}

/// Quick commands of the local WindTerm (quickbar.config), read but not saved: the Quick
/// Commands dialog merges them into its draft. None when no quickbar.config is found.
#[tauri::command]
fn read_windterm_quick_commands() -> Result<Option<Vec<models::QuickCommand>>, String> {
    let Some(source) = discover_import_sources()
        .into_iter()
        .find(|c| c.source_type == "windterm_quickbar")
    else {
        return Ok(None);
    };
    let raw = std::fs::read_to_string(&source.path).map_err(|e| e.to_string())?;
    crate::importer::parse_windterm_quickbar(&raw)
        .map(Some)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn execute_import(
    ctx: State<'_, AppContext>,
    source_type: String,
    path: String,
) -> Result<ImportResult, String> {
    let res = import_from_path(&source_type, &path).map_err(|e| format!("{:#}", e))?;

    let storage = ctx.storage.lock().map_err(|e| e.to_string())?;

    if !res.sessions.is_empty() {
        let mut existing = storage.load_sessions().unwrap_or_default();
        for incoming in &res.sessions {
            if let Some(pos) = existing.iter().position(|s| s.id == incoming.id) {
                existing[pos] = incoming.clone();
            } else {
                existing.push(incoming.clone());
            }
        }
        storage.save_sessions(&existing).map_err(|e| e.to_string())?;
    }

    if !res.quick_commands.is_empty() {
        let mut existing = storage.load_quick_commands().unwrap_or_default();
        for incoming in &res.quick_commands {
            if let Some(pos) = existing.iter().position(|q| q.id == incoming.id) {
                existing[pos] = incoming.clone();
            } else {
                existing.push(incoming.clone());
            }
        }
        storage
            .save_quick_commands(&existing)
            .map_err(|e| e.to_string())?;
    }

    if !res.themes.is_empty() {
        let mut existing_themes = storage.load_themes().unwrap_or_default();
        for incoming in &res.themes {
            if let Some(pos) = existing_themes.iter().position(|t| t.id == incoming.id) {
                existing_themes[pos] = incoming.clone();
            } else {
                existing_themes.push(incoming.clone());
            }
        }
        storage
            .save_themes(&existing_themes)
            .map_err(|e| e.to_string())?;
    }

    Ok(res)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Launching the exe again brings back the (possibly hidden) running window.
            show_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        // Main window size / position / maximized across runs. Not visibility (it may be
        // hidden in the tray when the app quits) and not fullscreen (focus mode).
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .with_filter(|label| label == "main")
                .build(),
        )
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::current_dir().unwrap().join("data"));
            notify::init(&data_dir);
            crate::app_paths::init(
                app.path().resource_dir().unwrap_or_else(|_| crate::app_paths::resource_dir()),
                data_dir.clone(),
            );
            let storage = Storage::new(data_dir).expect("Failed to initialize Nexterm data directory");
            let settings = storage.load_settings().unwrap_or_default();
            crate::shell_integration::set_enabled(extra_bool(&settings, "shellIntegration", true));
            app.manage(AppContext {
                storage: Mutex::new(storage),
                connections: ConnectionManager::new(),
                close_to_tray: AtomicBool::new(settings.close_to_tray),
                ask_before_quit: AtomicBool::new(extra_bool(&settings, "askBeforeCloseWindow", true)),
                quit_confirmed: AtomicBool::new(false),
            });
            let xs_app = app.handle().clone();
            crate::xserver::init(
                Box::new(move |status| {
                    use tauri::Emitter;
                    let _ = xs_app.emit("xserver-state", status);
                }),
                xserver_config(&settings),
            );
            agent::start(app.handle().clone());
            mcp::start(app.handle().clone());
            crate::remote::init(app.handle().clone(), remote_config(&settings));

            let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出 Nexterm", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let mut tray = TrayIconBuilder::with_id("main-tray")
                .tooltip("Nexterm")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "quit" => request_quit(app),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                let label = window.label().to_string();
                // The context menu host lives for the whole app; it only hides.
                if label == "ctx-menu" {
                    api.prevent_close();
                    let _ = window.hide();
                    return;
                }
                let to_tray = label == "main"
                    && window
                        .app_handle()
                        .try_state::<AppContext>()
                        .map(|ctx| ctx.close_to_tray.load(Ordering::Relaxed))
                        .unwrap_or(false);
                if to_tray {
                    // Keep every SSH / serial / shell connection alive in the background.
                    api.prevent_close();
                    let _ = window.hide();
                    return;
                }
                // Closing the main window would end its locked sessions: refuse. (A secondary
                // window hands its sessions back to the main window instead.)
                if label != "main" {
                    return;
                }
                // Closing the main window ends the app, so count every window's locked sessions.
                let locked: usize = locked_counts().lock().map(|m| m.values().sum()).unwrap_or(0);
                if locked > 0 {
                    use tauri::Emitter;
                    api.prevent_close();
                    let _ = window.emit("quit-blocked", locked);
                    return;
                }
                // Ask before ending open sessions (WindTerm: askBeforeCloseWindow).
                if let Some(ctx) = window.app_handle().try_state::<AppContext>() {
                    let open = ctx.connections.count();
                    if open > 0
                        && ctx.ask_before_quit.load(Ordering::Relaxed)
                        && !ctx.quit_confirmed.load(Ordering::Relaxed)
                    {
                        use tauri::Emitter;
                        api.prevent_close();
                        let _ = window.emit("confirm-quit", open);
                    }
                }
            }
            WindowEvent::Destroyed => {
                if let Ok(mut m) = locked_counts().lock() {
                    m.remove(window.label());
                }
                crate::remote::forget_window(window.label());
                // Secondary windows and the hidden menu host belong to the main window.
                if window.label() == "main" {
                    crate::xserver::stop();
                    window.app_handle().exit(0);
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            load_initial_state,
            save_sessions,
            save_quick_commands,
            save_settings,
            connect_terminal,
            write_terminal,
            broadcast_terminal,
            resize_terminal,
            disconnect_terminal,
            subscribe_output,
            unsubscribe_output,
            ack_output,
            scan_import_candidates,
            list_serial_ports,
            start_session_log,
            stop_session_log,
            pause_session_log,
            modem_start,
            load_data_file,
            record_session_use,
            save_data_file,
            write_text_file,
            open_external,
            command_catalog,
            command_options,
            xserver_status,
            xserver_start,
            xserver_stop,
            reveal_log,
            quit_app,
            report_locked_sessions,
            respond_host_key,
            ssh_exec,
            inject_shell_integration,
            zmodem_start,
            tunnel_list,
            tunnel_start,
            tunnel_stop,
            zmodem_cancel,
            zmodem_stage_chunk,
            zmodem_unstage,
            list_charsets,
            set_window_opacity,
            stash_pane_transfer,
            take_pane_transfer,
            mouse_primary_down,
            agent_hooks_read_local,
            show_notification,
            agent_hooks_write_local,
            mcp_controls,
            mcp_set_control,
            mcp_screen_reply,
            mcp_pending_requests,
            mcp_respond_request,
            mcp_open_respond,
            mcp_client_command,
            execute_import,
            read_windterm_quick_commands,
            remote_status,
            remote_pairing,
            remote_reset_pairing,
            remote_kick,
            remote_report_tabs,
            remote_watch_state,
            remote_release,
            remote_feed
        ])
        .run(tauri::generate_context!())
        .expect("error while running Nexterm");
}
