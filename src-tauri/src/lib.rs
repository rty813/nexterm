pub mod agent;
pub mod anti_idle;
pub mod app_paths;
pub mod background;
pub mod charset;
pub mod commands;
pub mod fonts;
mod plugin_http;
mod plugin_credentials;
mod plugin_store;
pub mod hexdump;
pub mod history;
pub mod importer;
pub mod importer_mobaxterm;
pub mod importer_xshell;
pub mod local_pty;
pub mod manager;
pub mod mcp;
pub mod mcp_files;
pub mod models;
pub mod net;
pub mod notify;
pub mod output;
pub mod pump;
pub mod relay_link;
pub mod remote;
pub mod remote_crypto;
pub mod remote_ops;
pub mod scp;
pub mod serial_conn;
pub mod server_stats;
pub mod share;
pub mod socks;
pub mod session_log;
pub mod sftp;
pub mod shell_integration;
pub mod ssh_conn;
pub mod storage;
mod local_secrets;
pub mod storage_location;
pub mod sync;
pub mod tcp_conn;
pub mod telnet_conn;
pub mod term_capture;
pub mod transfer;
pub mod update;
pub mod window_opacity;
pub mod http_proxy;
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

/// Parallel transfers of the file browser's queue (settings.sftp.concurrency).
fn sftp_concurrency(settings: &AppSettings) -> usize {
    settings
        .extra
        .get("sftp")
        .and_then(|v| v.get("concurrency"))
        .and_then(|v| v.as_u64())
        .unwrap_or(3) as usize
}

/// settings.extra.fullHistory (default on) and its memory / disk limits per pane.
fn history_config(settings: &AppSettings) -> (bool, crate::history::HistoryLimits) {
    let mb = |key: &str, default: f64| settings.extra.get(key).and_then(|v| v.as_f64()).unwrap_or(default).max(0.0);
    let limits = crate::history::HistoryLimits {
        memory: (mb("fullHistoryMemoryMb", 32.0).max(1.0) * 1_048_576.0) as usize,
        disk: (mb("fullHistoryDiskMb", 2048.0) * 1_048_576.0) as u64,
    };
    (extra_bool(settings, "fullHistory", true), limits)
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

/// Main window backdrop (theme background, RGB) for the next start, painted before the page
/// is. Local to this computer, not synced.
const WINDOW_BACKGROUND: &str = "window_background.json";

fn read_window_background(dir: &std::path::Path) -> Option<[u8; 3]> {
    serde_json::from_str(&std::fs::read_to_string(dir.join(WINDOW_BACKGROUND)).ok()?).ok()
}

fn window_color([r, g, b]: [u8; 3]) -> tauri::window::Color {
    tauri::window::Color(r, g, b, 255)
}

/// The main window's backdrop follows the theme and is saved for the next start.
#[tauri::command]
fn set_window_background(app: AppHandle, ctx: State<'_, AppContext>, rgb: [u8; 3]) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_background_color(Some(window_color(rgb)));
        // A theme change must not leave a translucent window opaque.
        let w = win.as_ref().window();
        let _ = win.run_on_main_thread(move || crate::window_opacity::ensure(&w));
    }
    let dir = ctx.storage.lock().map_err(|e| e.to_string())?.base_dir().to_path_buf();
    if read_window_background(&dir) == Some(rgb) {
        return Ok(());
    }
    std::fs::write(dir.join(WINDOW_BACKGROUND), serde_json::to_string(&rgb).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn load_initial_state(ctx: State<'_, AppContext>) -> Result<AppStateSnapshot, String> {
    let mut storage = ctx.storage.lock().map_err(|e| e.to_string())?;
    storage.load_snapshot().map_err(|e| e.to_string())
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
    apply_settings_effects(&ctx, &settings);
    let storage = ctx.storage.lock().map_err(|e| e.to_string())?;
    storage.save_settings(&settings).map_err(|e| e.to_string())
}

/// Push saved settings into the backend's running parts.
fn apply_settings_effects(ctx: &AppContext, settings: &AppSettings) {
    ctx.close_to_tray.store(settings.close_to_tray, Ordering::Relaxed);
    ctx.ask_before_quit
        .store(extra_bool(&settings, "askBeforeCloseWindow", true), Ordering::Relaxed);
    crate::shell_integration::set_enabled(extra_bool(&settings, "shellIntegration", true));
    crate::http_proxy::configure(crate::http_proxy::from_settings(settings.extra.get("httpProxy")));
    let (history_on, history_limits) = history_config(settings);
    crate::history::configure(history_on, history_limits);
    crate::xserver::configure(xserver_config(settings));
    crate::remote::configure(remote_config(settings));
    if let Some(hub) = crate::transfer::hub() {
        hub.set_limit(sftp_concurrency(settings));
    }
}

// ------------------------------------------------------------------ full scrollback history

/// Async: a sync command runs on the main thread, and `info` may wait for the history
/// worker's lock while it parses a batch.
#[tauri::command]
async fn history_info(instance_id: String) -> Option<crate::history::Info> {
    let r = crate::history::get(&instance_id)?;
    tauri::async_runtime::spawn_blocking(move || r.info()).await.ok()
}

/// Lines `from..from + count` of a pane's history (archived lines, then those on screen).
#[tauri::command]
async fn history_lines(instance_id: String, from: u64, count: u32) -> Result<Option<crate::history::Page>, String> {
    let Some(r) = crate::history::get(&instance_id) else { return Ok(None) };
    tauri::async_runtime::spawn_blocking(move || r.lines(from, count).map(Some))
        .await
        .map_err(|e| e.to_string())?
}

/// Up to `limit` matches from history line `from` on (or back), across the whole history.
#[tauri::command]
async fn history_search(
    instance_id: String,
    spec: crate::history::QuerySpec,
    from: u64,
    backward: bool,
    limit: Option<u32>,
    budget: Option<u64>,
) -> Result<crate::history::SearchResult, String> {
    let r = crate::history::get(&instance_id).ok_or("no history")?;
    let m = crate::history::Matcher::new(&spec)?;
    let limit = limit.unwrap_or(500).clamp(1, 5000) as usize;
    // `budget`: search at most this many lines (the results list loads in steps).
    let budget = budget.unwrap_or(u64::MAX).max(1);
    tauri::async_runtime::spawn_blocking(move || r.search(&m, from, backward, limit, budget))
        .await
        .map_err(|e| e.to_string())?
}

/// Scrollbar marks and match counts of several queries over the whole history.
#[tauri::command]
async fn history_marks(
    instance_id: String,
    specs: Vec<crate::history::QuerySpec>,
    buckets: u32,
    budget_ms: Option<u64>,
) -> Result<Option<crate::history::Marks>, String> {
    let Some(r) = crate::history::get(&instance_id) else { return Ok(None) };
    // `budget_ms`: return what is known after about this long (`complete` false), so the
    // count fills in while a long history is scanned.
    let budget = budget_ms.map(std::time::Duration::from_millis);
    tauri::async_runtime::spawn_blocking(move || r.marks_of(&specs, buckets, budget).map(Some))
        .await
        .map_err(|e| e.to_string())?
}

/// How many matches come before (line, UTF-16 offset `start`): the "3" of "3/120".
#[tauri::command]
async fn history_rank(instance_id: String, spec: crate::history::QuerySpec, line: u64, start: u32) -> Result<u64, String> {
    let r = crate::history::get(&instance_id).ok_or("no history")?;
    let m = crate::history::Matcher::new(&spec)?;
    tauri::async_runtime::spawn_blocking(move || r.rank(&m, line, start))
        .await
        .map_err(|e| e.to_string())?
}

/// Write the whole history to a file (plain text or with ANSI colors); returns the line count.
#[tauri::command]
async fn history_export(instance_id: String, path: String, ansi: bool) -> Result<u64, String> {
    let r = crate::history::get(&instance_id).ok_or("no history")?;
    tauri::async_runtime::spawn_blocking(move || r.export(std::path::Path::new(&path), ansi))
        .await
        .map_err(|e| e.to_string())?
}

/// Which history line xterm.js's buffer starts at: `sig` are its first logical lines,
/// `hint` the expected position, `window` how far either side to look. None: not found.
#[tauri::command]
async fn history_locate(instance_id: String, sig: Vec<String>, hint: u64, window: Option<u64>) -> Result<Option<u64>, String> {
    let Some(r) = crate::history::get(&instance_id) else { return Ok(None) };
    let window = window.unwrap_or(200_000).min(2_000_000);
    tauri::async_runtime::spawn_blocking(move || r.locate(&sig, hint, window))
        .await
        .map_err(|e| e.to_string())?
}

/// The user cleared the scrollback.
#[tauri::command]
fn history_clear(instance_id: String) {
    if let Some(r) = crate::history::get(&instance_id) {
        r.clear();
    }
}

/// The pane closed.
#[tauri::command]
fn history_drop(instance_id: String) {
    crate::history::remove(&instance_id);
}

/// Text the front end wrote into xterm.js itself (banners, local resets), so the
/// history's terminal stays in step with the screen.
#[tauri::command]
fn history_feed(instance_id: String, data: String) {
    if let Some(r) = crate::history::get(&instance_id) {
        r.feed(data.as_bytes());
    }
}

// ------------------------------------------------------------------ config export / import / sync

/// Imported or downloaded data was written: refresh the backend and every window.
fn config_applied(app: &AppHandle, ctx: &AppContext, applied: &[String]) {
    use tauri::Emitter;
    if applied.is_empty() {
        return;
    }
    if applied.iter().any(|c| c == "settings") {
        apply_settings_effects(ctx, &ctx.settings());
    }
    let _ = app.emit("config-applied", applied);
    let _ = app.emit("settings-changed", ());
    let _ = app.emit("sessions-changed", ());
}

#[tauri::command]
fn config_export(ctx: State<'_, AppContext>, path: String, categories: Vec<String>, password: String) -> Result<(), String> {
    let categories = sync::normalize_categories(&categories);
    let data = {
        let storage = ctx.storage.lock().map_err(|e| e.to_string())?;
        sync::collect(storage.base_dir(), &categories)?
    };
    let bytes = sync::seal(&data, &password)?;
    std::fs::write(&path, bytes).map_err(|e| format!("{}: {}", path, e))
}

#[tauri::command]
fn config_inspect(path: String) -> Result<sync::BundleInfo, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("{}: {}", path, e))?;
    Ok(sync::BundleInfo::from(&sync::Envelope::parse(&bytes)?))
}

#[tauri::command]
fn config_import(
    app: AppHandle,
    ctx: State<'_, AppContext>,
    path: String,
    password: String,
    categories: Vec<String>,
    mode: sync::ImportMode,
) -> Result<Vec<String>, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("{}: {}", path, e))?;
    let data = sync::Envelope::parse(&bytes)?.open(&password)?;
    let applied = sync::apply_locked(&ctx.storage, &data, &sync::normalize_categories(&categories), mode)?;
    config_applied(&app, &ctx, &applied);
    Ok(applied)
}

/// Reach the remote storage; returns what is there (None: no file yet).
#[tauri::command]
async fn sync_test(config: sync::SyncConfig) -> Result<Option<sync::BundleInfo>, String> {
    match sync::remote_get(&config).await? {
        Some(bytes) => Ok(Some(sync::BundleInfo::from(&sync::Envelope::parse(&bytes)?))),
        None => Ok(None),
    }
}

#[tauri::command]
async fn sync_run(
    app: AppHandle,
    ctx: State<'_, AppContext>,
    config: sync::SyncConfig,
    action: sync::SyncAction,
) -> Result<sync::SyncOutcome, String> {
    static RUNNING: AtomicBool = AtomicBool::new(false);
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Err("busy".into());
    }
    let result = sync::run(&ctx.storage, &config, action).await;
    RUNNING.store(false, Ordering::SeqCst);
    let outcome = result?;
    config_applied(&app, &ctx, &outcome.applied);
    Ok(outcome)
}

#[tauri::command]
fn sync_state(ctx: State<'_, AppContext>) -> Result<sync::SyncState, String> {
    let storage = ctx.storage.lock().map_err(|e| e.to_string())?;
    Ok(sync::load_state(storage.base_dir()))
}

#[tauri::command]
async fn connect_terminal(
    window: tauri::WebviewWindow,
    app: AppHandle,
    ctx: State<'_, AppContext>,
    instance_id: String,
    mut session: SessionConfig,
    cols: u16,
    rows: u16,
    reuse_from: Option<String>,
) -> Result<Option<String>, String> {
    if let Some(password) = plugin_http::take_ssh_password(window.label(), &session.id, &session.host, session.port, &session.username) {
        session.password = Some(password);
        session.auth_type = crate::models::AuthType::Password;
    }
    let sink = Arc::new(TauriSink { app });
    // Before connecting, so the first output is recorded; a reconnect keeps the pane's history.
    crate::history::ensure(&instance_id, cols, rows);
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
    // Installed plugins (packages, enablement, plugin configuration) and plugin stores; both synced.
    "plugins",
    "plugin_stores",
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

/// Replace the saved custom themes (the theme editor in settings).
#[tauri::command]
fn save_custom_themes(ctx: State<'_, AppContext>, themes: Vec<crate::models::ImportedTheme>) -> Result<(), String> {
    let storage = ctx.storage.lock().map_err(|e| e.to_string())?;
    storage.save_themes(&themes).map_err(|e| e.to_string())
}

/// Copy a picked image into the data folder for the terminal background; returns its stored name.
#[tauri::command]
fn import_background_image(ctx: State<'_, AppContext>, path: String) -> Result<String, String> {
    let base = ctx.storage.lock().map_err(|e| e.to_string())?.base_dir().to_path_buf();
    crate::background::import(&base, std::path::Path::new(&path))
}

/// The stored background image as raw bytes (an ArrayBuffer in the page, not JSON).
#[tauri::command]
fn read_background_image(ctx: State<'_, AppContext>, name: String) -> Result<tauri::ipc::Response, String> {
    let base = ctx.storage.lock().map_err(|e| e.to_string())?.base_dir().to_path_buf();
    crate::background::read(&base, &name).map(tauri::ipc::Response::new)
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
    if !["http://", "https://", "ftp://", "ftps://", "mailto:"].iter().any(|p| lower.starts_with(p)) {
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

/// Where the configuration is stored (program folder, user folder or a chosen one).
#[tauri::command]
fn storage_location_info() -> Option<crate::storage_location::StorageLocationInfo> {
    crate::storage_location::info()
}

/// The storage chooser to show at startup, if any (once per run).
#[tauri::command]
fn storage_location_prompt() -> Option<crate::storage_location::StorageLocationInfo> {
    crate::storage_location::startup_prompt()
}

/// Save where the configuration is stored; copies it there when `migrate` and the new
/// folder has none. A changed folder takes effect after `restart_app`.
#[tauri::command]
async fn set_storage_location(
    mode: crate::storage_location::StorageMode,
    path: String,
    ask_at_startup: bool,
    migrate: bool,
) -> Result<crate::storage_location::ApplyOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || crate::storage_location::apply(mode, &path, ask_at_startup, migrate))
        .await
        .map_err(|e| e.to_string())?
}

/// Restart the app (after the storage folder changed).
#[tauri::command]
fn restart_app(app: AppHandle) {
    crate::xserver::stop();
    app.request_restart();
}

/// Newest GitHub release compared with this build.
#[tauri::command]
async fn check_update() -> Result<crate::update::UpdateInfo, String> {
    crate::update::check().await
}

/// Settings' proxy "Test": reaches GitHub with the proxy as entered (not yet saved), in ms.
#[tauri::command]
async fn test_http_proxy(mode: String, url: String) -> Result<u64, String> {
    let proxy = match mode.as_str() {
        "direct" => crate::http_proxy::ProxyMode::Direct,
        "custom" => crate::http_proxy::ProxyMode::Custom(crate::http_proxy::normalize_url(&url)?),
        _ => crate::http_proxy::ProxyMode::System,
    };
    crate::http_proxy::test(proxy).await
}

/// Downloads the update the last check offered (`can_install`), with `update-progress` events.
#[tauri::command]
async fn download_update(app: AppHandle) -> Result<(), String> {
    use tauri::Emitter;
    crate::update::download(|p| {
        let _ = app.emit("update-progress", p);
    })
    .await
}

/// Stops the update download in progress (`download_update` then fails with "cancelled").
#[tauri::command]
fn cancel_update() {
    crate::update::cancel();
}

/// Starts the downloaded update and quits; the new version starts when it is installed.
#[tauri::command]
fn apply_update(app: AppHandle) -> Result<(), String> {
    crate::update::apply()?;
    crate::xserver::stop();
    app.exit(0);
    Ok(())
}

/// Font families installed on this computer, for the terminal font picker.
#[tauri::command]
async fn list_system_fonts() -> Vec<crate::fonts::SystemFont> {
    tauri::async_runtime::spawn_blocking(crate::fonts::list)
        .await
        .unwrap_or_default()
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

/// Run a POSIX sh command in the default WSL distribution and user (agent hook installer,
/// tmux panel), matching the application's WSL session launcher (wsl.exe with no
/// distro/user override).
#[tauri::command]
async fn wsl_agent_exec(ctx: State<'_, AppContext>, instance_id: String, command: String) -> Result<String, String> {
    let runtime = ctx.connections.pane_runtime(&instance_id).ok_or("该窗格没有活动的连接")?;
    if runtime.protocol != "wsl" || runtime.status != "connected" {
        return Err("该窗格不是已连接的 WSL 会话".into());
    }
    let mut child = tokio::process::Command::new("wsl.exe");
    child.args(["--exec", "sh", "-c", &command]);
    #[cfg(windows)]
    child.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    child.kill_on_drop(true);
    let output = tokio::time::timeout(std::time::Duration::from_secs(20), child.output())
        .await.map_err(|_| "WSL 命令执行超时".to_string())?
        .map_err(|e| format!("无法启动 WSL: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("WSL 命令失败: {}", if stderr.trim().is_empty() { stdout.trim() } else { stderr.trim() }));
    }
    Ok(stdout)
}

/// Integration markers observed on a connection, queried when opening its menu.
#[tauri::command]
fn shell_integration_status(ctx: State<'_, AppContext>, instance_id: String) -> Option<crate::manager::ShellIntegrationStatus> {
    ctx.connections.shell_integration_status(&instance_id)
}

/// Pane menu › "Install shell integration": install for this user and load immediately.
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
fn zmodem_answer(ctx: State<'_, AppContext>, instance_id: String, request_id: String, answer: zmodem::ConflictAnswer) -> Result<(), String> {
    ctx.connections.zmodem_answer(&instance_id, &request_id, answer).map_err(|error| error.to_string())
}

#[tauri::command]
fn zmodem_cancel(ctx: State<'_, AppContext>, instance_id: String) {
    ctx.connections.zmodem_cancel(&instance_id);
}

// ---------------------------------------------------------------------------------------
// SFTP file browser and transfer queue (sftp.rs, scp.rs, transfer.rs)

/// Run `f` on the pane's files (SFTP, or shell commands when the server has no SFTP). A
/// broken SFTP channel (server closed an idle session, pane reconnected) is replaced once.
pub(crate) async fn with_sftp<T, F, Fut>(ctx: &AppContext, instance_id: &str, f: F) -> Result<T, String>
where
    F: Fn(crate::sftp::Fs) -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<T>>,
{
    let mut retried = false;
    loop {
        let link = ctx.connections.ssh_link(instance_id).map_err(|e| format!("{:#}", e))?;
        let fs = crate::sftp::fs(instance_id, &link).await.map_err(|e| format!("{:#}", e))?;
        match f(fs).await {
            Ok(v) => return Ok(v),
            Err(e) if !retried && crate::sftp::is_link_error(&e) => {
                crate::sftp::forget(instance_id);
                retried = true;
            }
            Err(e) => return Err(format!("{:#}", e)),
        }
    }
}

#[tauri::command]
async fn sftp_home(ctx: State<'_, AppContext>, instance_id: String) -> Result<String, String> {
    with_sftp(&ctx, &instance_id, |s| async move { s.home().await }).await
}

#[tauri::command]
async fn sftp_list(ctx: State<'_, AppContext>, instance_id: String, path: String) -> Result<crate::sftp::Listing, String> {
    with_sftp(&ctx, &instance_id, |s| {
        let path = path.clone();
        async move { s.list(&path).await }
    })
    .await
}

#[tauri::command]
async fn sftp_stat(ctx: State<'_, AppContext>, instance_id: String, path: String) -> Result<crate::sftp::RemoteEntry, String> {
    with_sftp(&ctx, &instance_id, |s| {
        let path = path.clone();
        async move { s.stat(&path).await }
    })
    .await
}

#[tauri::command]
async fn sftp_mkdir(ctx: State<'_, AppContext>, instance_id: String, path: String) -> Result<(), String> {
    with_sftp(&ctx, &instance_id, |s| {
        let path = path.clone();
        async move { s.mkdir(&path).await }
    })
    .await
}

#[tauri::command]
async fn sftp_touch(ctx: State<'_, AppContext>, instance_id: String, path: String) -> Result<(), String> {
    with_sftp(&ctx, &instance_id, |s| {
        let path = path.clone();
        async move { s.touch(&path).await }
    })
    .await
}

/// Rename or move (to another folder) a remote file or folder.
#[tauri::command]
async fn sftp_rename(ctx: State<'_, AppContext>, instance_id: String, from: String, to: String) -> Result<(), String> {
    with_sftp(&ctx, &instance_id, |s| {
        let (from, to) = (from.clone(), to.clone());
        async move { s.rename(&from, &to).await }
    })
    .await
}

#[tauri::command]
async fn sftp_remove(ctx: State<'_, AppContext>, instance_id: String, paths: Vec<String>) -> Result<(), String> {
    for path in paths {
        with_sftp(&ctx, &instance_id, |s| {
            let path = path.clone();
            async move { s.remove(&path).await }
        })
        .await?;
    }
    Ok(())
}

#[tauri::command]
async fn sftp_chmod(ctx: State<'_, AppContext>, instance_id: String, paths: Vec<String>, mode: u32) -> Result<(), String> {
    for path in paths {
        with_sftp(&ctx, &instance_id, |s| {
            let path = path.clone();
            async move { s.chmod(&path, mode).await }
        })
        .await?;
    }
    Ok(())
}

#[tauri::command]
async fn sftp_symlink(ctx: State<'_, AppContext>, instance_id: String, link: String, target: String) -> Result<(), String> {
    with_sftp(&ctx, &instance_id, |s| {
        let (link, target) = (link.clone(), target.clone());
        async move { s.symlink(&link, &target).await }
    })
    .await
}

/// A remote file's bytes for the preview (raw, not JSON). Above `limit`: "TOO_LARGE:<size>".
#[tauri::command]
async fn sftp_read(ctx: State<'_, AppContext>, instance_id: String, path: String, limit: u64) -> Result<tauri::ipc::Response, String> {
    let bytes = with_sftp(&ctx, &instance_id, |s| {
        let path = path.clone();
        async move { crate::sftp::read_limited(s.sftp()?, &path, limit).await }
    })
    .await?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Write one chunk of an item dropped on the file browser. Headers: x-token (one dropped
/// item), x-rel (base64 UTF-8 path below it, `/`-separated), x-dir ("1": an empty folder),
/// x-append ("1" after the first chunk). Returns the staging folder of the token.
#[tauri::command]
fn sftp_stage_chunk(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    use std::io::Write;
    let header = |key: &str| request.headers().get(key).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let token = safe_component(&header("x-token")).ok_or("bad token")?;
    let rel = B64.decode(header("x-rel")).map_err(|e| e.to_string())?;
    let rel = String::from_utf8(rel).map_err(|e| e.to_string())?;
    let base = crate::transfer::staging_root().join(token);
    let mut path = base.clone();
    for part in rel.split('/').filter(|p| !p.is_empty()) {
        // Every component on its own: no separators, no "..".
        if safe_component(part).as_deref() != Some(part) {
            return Err(format!("bad file name: {}", part));
        }
        path.push(part);
    }
    if path == base {
        return Err("empty path".into());
    }
    if header("x-dir") == "1" {
        std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
        return Ok(base.to_string_lossy().into_owned());
    }
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw bytes".into());
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let append = header("x-append") == "1";
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(append)
        .truncate(!append)
        .open(&path)
        .map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    Ok(base.to_string_lossy().into_owned())
}

#[tauri::command]
async fn sftp_edit_start(
    app: AppHandle,
    ctx: State<'_, AppContext>,
    instance_id: String,
    path: String,
    program: Option<String>,
) -> Result<crate::sftp::EditInfo, String> {
    let link = ctx.connections.ssh_link(&instance_id).map_err(|e| format!("{:#}", e))?;
    crate::sftp::edit_start(app, &instance_id, &link, &path, program)
        .await
        .map_err(|e| format!("{:#}", e))
}

/// Raw resource sample (/proc + df) of the SSH host behind a pane, on an exec channel of
/// its existing connection. Parsed by the frontend (utils/serverStats.ts).
#[tauri::command]
async fn server_stats_sample(ctx: State<'_, AppContext>, instance_id: String) -> Result<String, String> {
    let link = ctx.connections.ssh_link(&instance_id).map_err(|e| format!("{:#}", e))?;
    crate::server_stats::sample(&link).await.map_err(|e| format!("{:#}", e))
}

#[tauri::command]
fn sftp_edit_stop(app: AppHandle, id: String) {
    crate::sftp::edit_stop(&app, &id);
}

#[tauri::command]
fn sftp_edit_retry(id: String) {
    crate::sftp::edit_retry(&id);
}

#[tauri::command]
fn sftp_edit_list() -> Vec<crate::sftp::EditInfo> {
    crate::sftp::edit_list()
}

fn transfer_hub() -> Result<&'static crate::transfer::Hub, String> {
    crate::transfer::hub().ok_or_else(|| "传输队列未就绪".to_string())
}

#[tauri::command]
fn transfer_enqueue(requests: Vec<crate::transfer::TransferRequest>) -> Result<Vec<crate::transfer::TransferInfo>, String> {
    Ok(transfer_hub()?.enqueue(requests))
}

#[tauri::command]
fn transfer_list() -> Vec<crate::transfer::TransferInfo> {
    crate::transfer::hub().map(|h| h.list()).unwrap_or_default()
}

#[tauri::command]
fn transfer_pause(id: String) -> Result<(), String> {
    transfer_hub()?.pause(&id);
    Ok(())
}

#[tauri::command]
fn transfer_resume(id: String) -> Result<(), String> {
    transfer_hub()?.resume(&id);
    Ok(())
}

#[tauri::command]
fn transfer_cancel(id: String) -> Result<(), String> {
    transfer_hub()?.cancel(&id);
    Ok(())
}

#[tauri::command]
fn transfer_retry(id: String) -> Result<(), String> {
    transfer_hub()?.retry(&id);
    Ok(())
}

#[tauri::command]
fn transfer_answer(id: String, answer: crate::transfer::ConflictAnswer) -> Result<(), String> {
    transfer_hub()?.answer(&id, answer);
    Ok(())
}

/// Clear finished transfers (`ids`, or all of them).
#[tauri::command]
fn transfer_remove(ids: Option<Vec<String>>) -> Result<Vec<String>, String> {
    Ok(transfer_hub()?.remove(ids))
}

/// Show a file (selected) or folder in Explorer.
#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("{} 已不存在", path));
    }
    let mut cmd = std::process::Command::new("explorer");
    if p.is_dir() {
        cmd.arg(path.replace('/', "\\"));
    } else {
        cmd.arg(format!("/select,{}", path.replace('/', "\\")));
    }
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Open a local file with its default program.
#[tauri::command]
fn open_local_path(path: String) -> Result<(), String> {
    if !std::path::Path::new(&path).exists() {
        return Err(format!("{} 已不存在", path));
    }
    crate::sftp::open_local(&path, None).map_err(|e| format!("{:#}", e))
}

#[tauri::command]
fn list_charsets() -> Vec<String> {
    crate::charset::CHARSETS.iter().map(|(n, _)| n.to_string()).collect()
}

/// Whole-window opacity (0.2 - 1.0), like WindTerm's translucent window. Kept per window
/// and put back after tao resets the window's style (see `window_opacity.rs`).
#[tauri::command]
fn set_window_opacity(window: tauri::WebviewWindow, opacity: f64) -> Result<(), String> {
    crate::window_opacity::remember(window.label(), opacity);
    // On the main thread, in order with tao's own window changes.
    let win = window.as_ref().window();
    window
        .run_on_main_thread(move || crate::window_opacity::apply(&win))
        .map_err(|e| e.to_string())
}

/// Always on top. Changing it makes tao rewrite the window style, which drops the
/// opacity: put it back right after, on the main thread (queued behind the change).
#[tauri::command]
fn set_window_always_on_top(window: tauri::WebviewWindow, on: bool) -> Result<(), String> {
    window.set_always_on_top(on).map_err(|e| e.to_string())?;
    let win = window.as_ref().window();
    window
        .run_on_main_thread(move || crate::window_opacity::ensure(&win))
        .map_err(|e| e.to_string())
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

/// The command line that adds Nexterm to an agent CLI ("claude", "codex" or "gemini") as an MCP server.
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
    crate::sftp::forget_instance(&app, &instance_id);
    if let Some(hub) = crate::transfer::hub() {
        hub.forget_instance(&instance_id);
    }
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
    crate::share::tabs_changed();
}

/// What remote devices and shares watch and which sizes devices hold, for a pane that mounts later.
#[tauri::command]
fn remote_watch_state() -> serde_json::Value {
    let sizes: Vec<serde_json::Value> = crate::remote::takeovers()
        .into_iter()
        .chain(crate::share::takeovers())
        .map(|(pane, cols, rows)| serde_json::json!({ "paneId": pane, "cols": cols, "rows": rows }))
        .collect();
    serde_json::json!({ "watched": crate::remote::watched(), "sizes": sizes })
}

#[tauri::command]
fn remote_release(pane_id: String) {
    crate::remote::release(&pane_id);
    crate::share::release_pane(&pane_id);
}

/// Output, size changes and screen snapshots of a watched pane (raw body, see `remote.rs`).
#[tauri::command]
fn remote_feed(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let pane = request.headers().get("x-pane").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw bytes".into());
    };
    crate::remote::feed(&pane, bytes);
    crate::share::feed(&pane, bytes);
    Ok(())
}

/// Share a pane through the relay (or get its share when it has one).
#[tauri::command]
async fn share_start(pane_id: String, options: crate::share::ShareOptions) -> Result<crate::share::ShareInfo, String> {
    crate::share::start(pane_id, options).await
}

#[tauri::command]
fn share_stop(id: String) {
    crate::share::stop(&id);
}

#[tauri::command]
fn share_update(id: String, options: crate::share::ShareOptions) {
    crate::share::update(&id, options);
}

#[tauri::command]
fn share_grant(id: String, viewer: u32, on: bool) {
    crate::share::grant(&id, viewer, on);
}

#[tauri::command]
fn share_approve(id: String, viewer: u32, allow: bool) {
    crate::share::approve(&id, viewer, allow);
}

#[tauri::command]
fn share_kick(id: String, viewer: u32) {
    crate::share::kick(&id, viewer);
}

#[tauri::command]
fn share_list() -> Vec<crate::share::ShareInfo> {
    crate::share::list()
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
async fn execute_import(
    ctx: State<'_, AppContext>,
    source_type: String,
    path: String,
    windterm_master: Option<String>,
) -> Result<ImportResult, String> {
    let res = tauri::async_runtime::spawn_blocking(move || {
        let master = windterm_master.map(zeroize::Zeroizing::new);
        import_from_path(&source_type, &path, master.as_ref().map(|s| s.as_str()))
    }).await.map_err(|e| e.to_string())?.map_err(|e| format!("{:#}", e))?;

    let storage = ctx.storage.lock().map_err(|e| e.to_string())?;

    if !res.sessions.is_empty() {
        let mut existing = storage.load_sessions().map_err(|e| e.to_string())?;
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
            let user_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::current_dir().unwrap().join("data"));
            // Program folder, user folder or a chosen one (storage-location.json).
            let data_dir = crate::storage_location::init(user_dir);
            notify::init(&data_dir);
            crate::app_paths::init(
                app.path().resource_dir().unwrap_or_else(|_| crate::app_paths::resource_dir()),
                data_dir.clone(),
            );
            crate::history::init_dir(&data_dir.join("history"));
            let storage = Storage::new(data_dir).expect("Failed to initialize Nexterm data directory");
            let settings = storage.load_settings().unwrap_or_default();
            // The main window is created hidden (tauri.conf.json) so it can take last run's
            // theme background first, then is shown right away, before the page loads: it
            // never waits on the page, so a page that fails to load still has a window, and
            // the page lays out at the window's final (possibly maximized) size.
            if let Some(win) = app.get_webview_window("main") {
                if let Some(rgb) = read_window_background(storage.base_dir()) {
                    let _ = win.set_background_color(Some(window_color(rgb)));
                }
                let _ = win.show();
                let _ = win.set_focus();
            }
            crate::shell_integration::set_enabled(extra_bool(&settings, "shellIntegration", true));
            crate::http_proxy::configure(crate::http_proxy::from_settings(settings.extra.get("httpProxy")));
            let (history_on, history_limits) = history_config(&settings);
            crate::history::configure(history_on, history_limits);
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
            crate::share::init(app.handle().clone());
            crate::transfer::init(app.handle().clone());
            if let Some(hub) = crate::transfer::hub() {
                hub.set_limit(sftp_concurrency(&settings));
            }
            // Local copies of remote files edited in an earlier run, files dropped then.
            crate::sftp::edit_cleanup();
            let _ = std::fs::remove_dir_all(crate::transfer::staging_root());
            // What an update left behind: the replaced exe, the downloaded setup.
            crate::update::cleanup();

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
            // Maximize / restore / un-minimize change tao's window flags, which resets the
            // window style and with it the opacity.
            // tao may send the event before it rewrites the style: check again once the
            // main thread is done with the change.
            WindowEvent::Resized(_) | WindowEvent::Focused(true) => {
                crate::window_opacity::ensure(window);
                let w = window.clone();
                let _ = window.run_on_main_thread(move || crate::window_opacity::ensure(&w));
            }
            WindowEvent::Destroyed => {
                crate::window_opacity::forget(window.label());
                crate::plugin_http::forget_window(window.label());
                if let Ok(mut m) = locked_counts().lock() {
                    m.remove(window.label());
                }
                crate::remote::forget_window(window.label());
                crate::share::tabs_changed();
                // Secondary windows and the hidden menu host belong to the main window.
                if window.label() == "main" {
                    crate::xserver::stop();
                    window.app_handle().exit(0);
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            set_window_background,
            plugin_http::plugin_grant,
            plugin_http::plugin_allow_origin,
            plugin_http::plugin_revoke,
            plugin_http::plugin_secret,
            plugin_http::plugin_credential,
            plugin_http::plugin_forget_credentials,
            plugin_http::plugin_http,
            plugin_http::plugin_stage_ssh,
            plugin_store::plugin_store_probe,
            plugin_store::plugin_store_index,
            plugin_store::plugin_store_fetch,
            check_update,
            test_http_proxy,
            download_update,
            cancel_update,
            apply_update,
            storage_location_info,
            storage_location_prompt,
            set_storage_location,
            restart_app,
            config_export,
            config_inspect,
            config_import,
            sync_test,
            sync_run,
            sync_state,
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
            save_custom_themes,
            import_background_image,
            read_background_image,
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
            wsl_agent_exec,
            shell_integration_status,
            zmodem_start,
            tunnel_list,
            tunnel_start,
            tunnel_stop,
            server_stats_sample,
            zmodem_cancel,
            zmodem_answer,
            zmodem_stage_chunk,
            zmodem_unstage,
            list_charsets,
            list_system_fonts,
            set_window_opacity,
            set_window_always_on_top,
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
            remote_feed,
            share_start,
            share_stop,
            share_update,
            share_grant,
            share_approve,
            share_kick,
            share_list,
            sftp_home,
            sftp_list,
            sftp_stat,
            sftp_mkdir,
            sftp_touch,
            sftp_rename,
            sftp_remove,
            sftp_chmod,
            sftp_symlink,
            sftp_read,
            sftp_stage_chunk,
            sftp_edit_start,
            sftp_edit_stop,
            sftp_edit_retry,
            sftp_edit_list,
            transfer_enqueue,
            transfer_list,
            transfer_pause,
            transfer_resume,
            transfer_cancel,
            transfer_retry,
            transfer_answer,
            transfer_remove,
            reveal_path,
            open_local_path,
            history_info,
            history_lines,
            history_search,
            history_marks,
            history_rank,
            history_export,
            history_locate,
            history_clear,
            history_drop,
            history_feed
        ])
        .build(tauri::generate_context!())
        .expect("error while running Nexterm")
        .run(|_, event| {
            if let tauri::RunEvent::Exit = event {
                // Spill files of the full history are deleted with their folder.
                crate::history::shutdown();
            }
        });
}
