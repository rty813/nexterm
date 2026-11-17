//! MCP server: lets an AI agent (Claude Code, Codex ...) operate panes the user handed to it.
//!
//! - The agent sees every pane (`list_panes`) but may only read or type into one it holds.
//!   It gets a pane by asking (`request_control`: the window showing the pane asks the user)
//!   or because the user handed it over (pane menu › AI control). While the agent holds a
//!   pane, the user's keyboard is locked out of it (terminal replies still go through) until
//!   the user pauses or takes it back from the pane banner, or the agent releases it.
//! - Transport: JSON-RPC over HTTP POST on 127.0.0.1 with a bearer token (Streamable HTTP
//!   without SSE). Address and token are written to `<data>/mcp-endpoint.json`.
//! - `nexterm.exe mcp` is a stdio bridge for MCP clients ([`run_bridge`]): it answers
//!   `initialize` / `tools/list` itself and forwards `tools/call` to the running app, so the
//!   client config never changes when the port does.
//! - Command output is read in the backend (term_capture.rs, OSC 133), the screen from the
//!   pane's xterm.js via an event round trip (`mcp-read-screen` / `mcp_screen_reply`).

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::term_capture::{clip, is_terminal_reply, plain_text, CaptureMode, SharedCapture};

const SERVER_NAME: &str = "nexterm";
const ENDPOINT_FILE: &str = "mcp-endpoint.json";
const PROTOCOL_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL: &str = "2025-06-18";
const POLL: Duration = Duration::from_millis(50);
/// run_command: no OSC 133 C and no output for this long = the shell did not start it.
const NOT_STARTED_QUIET: Duration = Duration::from_secs(3);
const SCREEN_TIMEOUT: Duration = Duration::from_secs(3);
/// Output returned to the model: head + tail characters.
const OUT_HEAD: usize = 4_000;
const OUT_TAIL: usize = 26_000;

const INSTRUCTIONS: &str = "Nexterm 终端控制。先用 list_panes 查看窗格；操作某个窗格前用 request_control 申请，\
用户在 Nexterm 中确认后才能读屏和输入（control 为 active 的窗格可以直接操作）。\
普通 shell 命令用 run_command（有 Shell 集成时返回输出和退出码）；vim、top、REPL、密码提示等交互程序用 send_keys + read_screen；\
长时间运行的命令用 wait_for 继续等待；更早的输出（已滚出屏幕和回滚区）用 search_history 搜索、read_history 读取。SSH 窗格可以用 list_files 浏览服务器目录，用 upload_file / download_file 在本机和服务器之间传输文件或文件夹（SFTP，不支持时用 SCP），不要用 cat、base64 或 heredoc 经终端传文件。完成后用 release_control 把窗格还给用户。\
需要连接新的机器或开新的本地终端时，用 list_sessions 找已保存的会话，再用 open_session 打开（用户确认后新窗格直接归你控制）；\
自己打开的窗格用完可以用 close_pane 关闭。\
用户可以随时暂停或收回控制，此时工具会返回错误，请停止操作并等待用户。用户拒绝申请后不要反复申请。\
不要执行破坏性命令（删除数据、重启、格式化等），除非用户明确要求。";
/// Longest wait for the user's answer in one request_control call (Codex gives a tool 60 s).
const REQUEST_WAIT_DEFAULT: u64 = 50;
/// A refused request is not shown again for this long.
const REJECT_COOLDOWN: Duration = Duration::from_secs(30);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

// ---------------------------------------------------------------- control registry

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ControlMode {
    /// The agent operates the pane; the user's keyboard is locked out.
    Active,
    /// The user took the keyboard back for a while; agent requests are refused.
    Paused,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlView {
    pub instance_id: String,
    pub mode: ControlMode,
    pub title: String,
    /// What the agent is doing right now ("make -j8"), for the pane banner.
    pub activity: Option<String>,
}

/// An agent's request_control waiting for the user (at most one per pane).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlRequest {
    pub request_id: String,
    pub instance_id: String,
    /// "Claude Code", "Codex" ... (from the MCP client's initialize).
    pub client: String,
    pub reason: String,
    /// The pane is paused: the agent asks to continue.
    pub resume: bool,
    /// Session name of the pane.
    pub title: String,
    #[serde(skip)]
    rejected_at: Option<Instant>,
}

#[derive(Default)]
struct Registry {
    controls: HashMap<String, ControlView>,
    /// Panes with an agent request in flight (one at a time per pane).
    busy: HashSet<String>,
    /// request_control waiting for the user, or refused a moment ago (cool-down).
    pending: HashMap<String, ControlRequest>,
    /// Panes the agent opened itself (open_session): only these may it close.
    opened: HashSet<String>,
    /// open_session waiting for the user, by request id (one at a time).
    open_requests: HashMap<String, OpenRequest>,
    /// The user's answers to open_session, picked up by the waiting call.
    open_results: HashMap<String, OpenResult>,
}

/// An agent asking to open a session in a new tab (MCP open_session).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
    pub request_id: String,
    pub client: String,
    pub reason: String,
    /// A saved session (by id) ...
    pub session_id: Option<String>,
    /// ... or a quick connect line ("ssh root@10.0.0.5", "wsl", "powershell").
    pub target: Option<String>,
    /// Saved session name, or the quick connect line.
    pub label: String,
    /// "me@host:22" of a saved session.
    pub summary: String,
}

/// The main window's answer to an OpenRequest.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenResult {
    pub accept: bool,
    /// The new tab's pane.
    pub pane: Option<String>,
    /// The tab first asks the user for a username / password (nothing connects until then).
    #[serde(default)]
    pub needs_login: bool,
    /// The tab could not be opened (e.g. the quick connect line did not parse).
    pub error: Option<String>,
    #[serde(default)]
    pub title: String,
}

fn registry() -> &'static Mutex<Registry> {
    static R: OnceLock<Mutex<Registry>> = OnceLock::new();
    R.get_or_init(Default::default)
}

static APP: OnceLock<AppHandle> = OnceLock::new();

fn emit_control(id: &str, view: Option<ControlView>) {
    if let Some(app) = APP.get() {
        let _ = app.emit("mcp-control", json!({ "instanceId": id, "control": view }));
    }
}

pub fn controls() -> Vec<ControlView> {
    lock(registry()).controls.values().cloned().collect()
}

fn emit_request_done(request_id: &str) {
    if let Some(app) = APP.get() {
        let _ = app.emit("mcp-control-request-done", json!({ "requestId": request_id }));
    }
}

/// Requests waiting for the user (for a window that just opened or adopted a pane).
pub fn pending_requests() -> Vec<ControlRequest> {
    lock(registry()).pending.values().filter(|p| p.rejected_at.is_none()).cloned().collect()
}

/// The user answered a request_control dialog.
pub fn respond_request(request_id: &str, accept: bool, title: &str) {
    let pane = {
        let mut r = lock(registry());
        let Some(pane) = r
            .pending
            .iter()
            .find(|(_, p)| p.request_id == request_id && p.rejected_at.is_none())
            .map(|(k, _)| k.clone())
        else {
            return;
        };
        if !accept {
            if let Some(p) = r.pending.get_mut(&pane) {
                p.rejected_at = Some(Instant::now());
            }
        }
        pane
    };
    if accept {
        // Takes the request out of `pending` and tells the windows.
        set_control(&pane, Some(ControlMode::Active), title);
    } else {
        emit_request_done(request_id);
    }
}

/// Hand a pane to the agent (Active), pause it, or take it back (None).
pub fn set_control(id: &str, mode: Option<ControlMode>, title: &str) {
    let (view, interrupt, settled) = {
        let mut r = lock(registry());
        // The pane is the agent's now (accepted, or handed over by hand): no request left.
        let settled = if mode == Some(ControlMode::Active) {
            r.pending.remove(id).filter(|p| p.rejected_at.is_none()).map(|p| p.request_id)
        } else {
            None
        };
        let (view, interrupt) = match mode {
            Some(mode) => {
                let entry = r.controls.entry(id.to_string()).or_insert_with(|| ControlView {
                    instance_id: id.to_string(),
                    mode,
                    title: title.to_string(),
                    activity: None,
                });
                entry.mode = mode;
                if !title.is_empty() {
                    entry.title = title.to_string();
                }
                (Some(entry.clone()), false)
            }
            None => {
                let had = r.controls.remove(id).is_some();
                (None, had && r.busy.contains(id))
            }
        };
        (view, interrupt, settled)
    };
    if let Some(request_id) = settled {
        emit_request_done(&request_id);
    }
    // Stopping the agent mid-command interrupts what it started.
    if interrupt {
        if let Some(ctx) = APP.get().and_then(|a| a.try_state::<crate::AppContext>()) {
            if ctx.connections.pane_runtime(id).is_some_and(|rt| rt.command_running) {
                let _ = ctx.connections.write(id, b"\x03");
            }
        }
    }
    emit_control(id, view);
}

/// Whether the user is looking at Nexterm: some window shown, not minimized, focused.
fn user_is_looking(app: &AppHandle) -> bool {
    app.webview_windows().values().any(|w| {
        w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false) && w.is_focused().unwrap_or(false)
    })
}

/// A dialog now waits for the user. Decided here, not in the page: a window closed to the
/// tray (or minimized) can neither be seen nor flash its taskbar button, and its page cannot
/// tell reliably whether it has focus. Clicking the toast brings the main window back.
fn alert_user(app: &AppHandle, title: String, body: String, tag: String) {
    if !user_is_looking(app) {
        let _ = crate::notify::show_reveal(app, title, body, tag);
    }
}

/// The main window answered an open_session dialog (accepted: the tab is open now and the
/// agent holds it).
pub fn respond_open(request_id: &str, result: OpenResult) {
    let accepted = {
        let mut r = lock(registry());
        if r.open_requests.remove(request_id).is_none() {
            return;
        }
        let accepted = result.accept && result.error.is_none();
        let pane = result.pane.clone().filter(|_| accepted);
        if let Some(pane) = &pane {
            r.opened.insert(pane.clone());
        }
        let title = result.title.clone();
        r.open_results.insert(request_id.to_string(), result);
        pane.map(|p| (p, title))
    };
    if let Some((pane, title)) = accepted {
        set_control(&pane, Some(ControlMode::Active), &title);
    }
    emit_open_done(request_id);
}

fn emit_open_done(request_id: &str) {
    if let Some(app) = APP.get() {
        let _ = app.emit("mcp-open-request-done", json!({ "requestId": request_id }));
    }
}

/// The pane was closed: forget it.
pub fn forget(id: &str) {
    let (had, request) = {
        let mut r = lock(registry());
        r.opened.remove(id);
        (r.controls.remove(id).is_some(), r.pending.remove(id))
    };
    if had {
        emit_control(id, None);
    }
    if let Some(p) = request.filter(|p| p.rejected_at.is_none()) {
        emit_request_done(&p.request_id);
    }
}

/// User input (keyboard, paste, quick commands, phone, broadcast) for a pane the agent
/// holds is dropped; terminal replies still go through.
pub fn user_write_allowed(id: &str, data: &[u8]) -> bool {
    match lock(registry()).controls.get(id) {
        Some(c) if c.mode == ControlMode::Active => is_terminal_reply(data),
        _ => true,
    }
}

fn set_activity(id: &str, activity: Option<String>) {
    let view = {
        let mut r = lock(registry());
        let Some(c) = r.controls.get_mut(id) else { return };
        c.activity = activity;
        c.clone()
    };
    emit_control(id, Some(view));
}

/// Marks a pane busy for one agent request; clears the banner activity when dropped.
struct Busy {
    id: String,
}

impl Busy {
    fn take(id: &str, activity: Option<String>) -> Result<Self, String> {
        if !lock(registry()).busy.insert(id.to_string()) {
            return Err("该窗格上一个操作还没有结束".into());
        }
        if activity.is_some() {
            set_activity(id, activity);
        }
        Ok(Self { id: id.to_string() })
    }
}

impl Drop for Busy {
    fn drop(&mut self) {
        lock(registry()).busy.remove(&self.id);
        set_activity(&self.id, None);
    }
}

/// Why the agent may not use the pane right now, if it may not.
fn control_error(id: &str) -> Option<String> {
    match lock(registry()).controls.get(id).map(|c| c.mode) {
        None => Some(format!("你还没有控制窗格 {id}（或用户已收回控制）。先调用 request_control 申请，等用户确认。")),
        Some(ControlMode::Paused) => Some("用户暂停了 AI 对该窗格的控制，请停止操作，等待用户继续。".into()),
        Some(ControlMode::Active) => None,
    }
}

// ---------------------------------------------------------------- screen round trip

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenSnapshot {
    pub text: String,
    pub cols: u32,
    pub rows: u32,
    pub cursor_x: u32,
    pub cursor_y: u32,
    pub alternate: bool,
}

fn pending_screens() -> &'static Mutex<HashMap<String, std_mpsc::Sender<ScreenSnapshot>>> {
    static P: OnceLock<Mutex<HashMap<String, std_mpsc::Sender<ScreenSnapshot>>>> = OnceLock::new();
    P.get_or_init(Default::default)
}

/// The window showing the pane answers an `mcp-read-screen` event.
pub fn screen_reply(request_id: &str, snapshot: ScreenSnapshot) {
    if let Some(tx) = lock(pending_screens()).remove(request_id) {
        let _ = tx.send(snapshot);
    }
}

fn read_screen(app: &AppHandle, id: &str, scrollback: u32) -> Result<ScreenSnapshot, String> {
    let request_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = std_mpsc::channel();
    lock(pending_screens()).insert(request_id.clone(), tx);
    let _ = app.emit("mcp-read-screen", json!({ "requestId": request_id, "instanceId": id, "scrollback": scrollback }));
    let got = rx.recv_timeout(SCREEN_TIMEOUT);
    lock(pending_screens()).remove(&request_id);
    got.map_err(|_| "读取屏幕超时（窗格所在窗口没有响应）".to_string())
}

fn format_screen(s: &ScreenSnapshot) -> String {
    format!(
        "[屏幕 {}x{}，光标在第 {} 行第 {} 列{}]\n{}",
        s.cols,
        s.rows,
        s.cursor_y + 1,
        s.cursor_x + 1,
        if s.alternate { "，全屏程序（备用屏幕）" } else { "" },
        s.text.trim_end()
    )
}

// ---------------------------------------------------------------- JSON-RPC

fn rpc_result(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn rpc_error(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn tool_text(text: String, is_error: bool) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
}

fn tool_defs() -> Value {
    let pane = json!({ "type": "string", "description": "窗格 id（来自 list_panes）" });
    let mut tools = json!([
        {
            "name": "list_panes",
            "description": "列出 Nexterm 中打开的终端窗格：id、标题、协议、目标主机、连接状态、control（none 未授权 / active 你在控制 / paused 用户暂停）、是否有待确认的申请、是否有 Shell 集成、是否有命令正在运行。",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "request_control",
            "description": "申请控制一个窗格：Nexterm 弹窗请用户确认，同意后你可以读屏和输入，用户键盘在此期间被锁定。会等待用户回应（默认最多 50 秒）；超时后弹窗仍在，可再次调用继续等待。被拒绝后不要反复申请。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "pane": pane,
                    "reason": { "type": "string", "description": "向用户说明要做什么，显示在确认弹窗里，例如“检查 nginx 日志并重启服务”" },
                    "timeout_sec": { "type": "integer", "minimum": 1, "maximum": 600, "description": "最长等待用户回应的秒数，默认 50" }
                },
                "required": ["pane", "reason"]
            }
        },
        {
            "name": "list_sessions",
            "description": "列出 Nexterm 中已保存的会话（名称、分组、协议、主机、端口、用户名，不含密码）。可用 query 按名称 / 分组 / 主机 / 用户名过滤。",
            "inputSchema": {
                "type": "object",
                "properties": { "query": { "type": "string", "description": "过滤关键字，可选" } }
            },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "open_session",
            "description": "请用户确认后，在 Nexterm 新开一个标签页连接会话，新窗格直接归你控制（不用再 request_control）。session 是已保存会话的名称或 id（见 list_sessions），target 是快速连接地址（如 \"ssh root@10.0.0.5:22\"、\"wsl\"、\"powershell\"、\"cmd\"），二选一。主机密钥确认和密码由用户在 Nexterm 中完成。返回新窗格 id。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "session": { "type": "string", "description": "已保存会话的名称或 id" },
                    "target": { "type": "string", "description": "快速连接地址" },
                    "reason": { "type": "string", "description": "向用户说明要做什么，显示在确认弹窗里" },
                    "timeout_sec": { "type": "integer", "minimum": 1, "maximum": 600, "description": "最长等待用户确认的秒数，默认 50" }
                },
                "required": ["reason"]
            },
            "annotations": { "openWorldHint": true }
        },
        {
            "name": "close_pane",
            "description": "关闭你用 open_session 打开、且仍由你控制的窗格（断开连接并关闭标签页）。用户的窗格不能关闭，请用 release_control 归还。",
            "inputSchema": { "type": "object", "properties": { "pane": pane }, "required": ["pane"] },
            "annotations": { "destructiveHint": true }
        },
        {
            "name": "release_control",
            "description": "把窗格还给用户（解锁键盘、移除 AI 横幅）。任务完成后调用。",
            "inputSchema": { "type": "object", "properties": { "pane": pane }, "required": ["pane"] }
        },
        {
            "name": "read_screen",
            "description": "读取窗格当前屏幕的文本（可附带回滚区），以及光标位置、是否在全屏程序中。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "pane": pane,
                    "scrollback": { "type": "integer", "minimum": 0, "maximum": 2000, "description": "额外读取屏幕上方的回滚行数，默认 0" }
                },
                "required": ["pane"]
            },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "read_history",
            "description": "读取窗格的完整输出历史（包括已滚出 xterm 回滚区的内容和当前屏幕），每行带行号。默认返回最后 200 行；offset 表示从末尾往前跳过多少行，用来往前翻页。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "pane": pane,
                    "lines": { "type": "integer", "minimum": 1, "maximum": 2000, "description": "返回的行数，默认 200" },
                    "offset": { "type": "integer", "minimum": 0, "description": "从末尾往前跳过的行数，默认 0" }
                },
                "required": ["pane"]
            },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "search_history",
            "description": "在窗格的完整输出历史中搜索，返回匹配的行（带行号，从最新往前）。再用 read_history 读取上下文。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "pane": pane,
                    "query": { "type": "string" },
                    "regex": { "type": "boolean", "description": "query 是正则表达式，默认 false" },
                    "case_sensitive": { "type": "boolean", "description": "默认 false" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 500, "description": "最多返回的行数，默认 50" }
                },
                "required": ["pane", "query"]
            },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "run_command",
            "description": "在窗格的 shell 中输入一条命令并等待结束。有 Shell 集成时返回命令输出和退出码；没有时等输出安静后返回屏幕内容。命令不能包含换行（多条用 && 或 ; 连接）。不适用于交互程序（用 send_keys）。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "pane": pane,
                    "command": { "type": "string" },
                    "timeout_sec": { "type": "integer", "minimum": 1, "maximum": 600, "description": "最长等待秒数，默认 30；超时后命令继续运行，可用 wait_for 继续等" }
                },
                "required": ["pane", "command"]
            },
            "annotations": { "destructiveHint": true, "openWorldHint": true }
        },
        {
            "name": "send_keys",
            "description": "向窗格发送按键，用于交互程序（vim、top、REPL、确认提示等）。keys 按顺序发送：形如 <Enter> <Esc> <Tab> <Up> <C-c> <M-x> <F5> 的元素是特殊键，其余按原文输入。发送后等输出安静，返回屏幕。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "pane": pane,
                    "keys": { "type": "array", "items": { "type": "string" }, "description": "例如 [\"<Esc>\", \":wq\", \"<Enter>\"]" },
                    "wait_ms": { "type": "integer", "minimum": 0, "maximum": 10000, "description": "最多等待输出安静的毫秒数，默认 2000" }
                },
                "required": ["pane", "keys"]
            },
            "annotations": { "destructiveHint": true }
        },
        {
            "name": "wait_for",
            "description": "等待窗格的新输出：直到出现指定文本、输出安静了 idle_ms 毫秒、或（有 Shell 集成时）正在运行的命令结束。返回期间的输出。不指定条件时：有命令在运行就等它结束，否则等输出安静 2 秒。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "pane": pane,
                    "text": { "type": "string", "description": "等到输出中出现这段文本" },
                    "idle_ms": { "type": "integer", "minimum": 100, "maximum": 600000 },
                    "timeout_sec": { "type": "integer", "minimum": 1, "maximum": 600, "description": "默认 60" }
                },
                "required": ["pane"]
            },
            "annotations": { "readOnlyHint": true }
        }
    ]);
    if let Some(list) = tools.as_array_mut() {
        list.extend(crate::mcp_files::tool_defs(&pane));
    }
    tools
}

/// Requests answered without the running app (the bridge uses this too).
/// `None`: needs the app (`tools/call`). `Some(None)`: a notification, no answer.
pub fn local_response(msg: &Value) -> Option<Option<Value>> {
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    let Some(id) = msg.get("id") else {
        return Some(None);
    };
    let reply = match method {
        "initialize" => {
            let asked = msg.pointer("/params/protocolVersion").and_then(Value::as_str).unwrap_or("");
            let version = if PROTOCOL_VERSIONS.contains(&asked) { asked } else { DEFAULT_PROTOCOL };
            rpc_result(
                id,
                json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": SERVER_NAME, "title": "Nexterm", "version": env!("CARGO_PKG_VERSION") },
                    "instructions": INSTRUCTIONS
                }),
            )
        }
        "ping" => rpc_result(id, json!({})),
        "tools/list" => rpc_result(id, json!({ "tools": tool_defs() })),
        "tools/call" => return None,
        "" => rpc_error(id, -32600, "Invalid Request"),
        _ => rpc_error(id, -32601, &format!("Method not found: {method}")),
    };
    Some(Some(reply))
}

/// Who is calling: the pane the agent itself runs in (never its target) and the MCP client.
#[derive(Debug, Default, Clone)]
pub struct Caller {
    pub pane: Option<String>,
    pub client: Option<String>,
}

/// "claude-code" -> "Claude Code", "codex-mcp-client" -> "Codex",
/// "gemini-cli-mcp-client" -> "Gemini CLI"; others as they are.
fn client_display(name: Option<&str>) -> String {
    let n = name.unwrap_or("").trim();
    let lower = n.to_ascii_lowercase();
    if lower.contains("claude") {
        "Claude Code".into()
    } else if lower.contains("codex") {
        "Codex".into()
    } else if lower.contains("gemini") {
        "Gemini CLI".into()
    } else if n.is_empty() {
        "AI agent".into()
    } else {
        n.chars().take(40).collect()
    }
}

fn handle_message(app: &AppHandle, msg: &Value, caller: &Caller) -> Option<Value> {
    #[cfg(debug_assertions)]
    if let Some(reply) = debug_method(app, msg) {
        return Some(reply);
    }
    if let Some(local) = local_response(msg) {
        return local;
    }
    let id = msg.get("id").cloned().unwrap_or(Value::Null);
    let name = msg.pointer("/params/name").and_then(Value::as_str).unwrap_or("");
    let args = msg.pointer("/params/arguments").cloned().unwrap_or_else(|| json!({}));
    let result = match call_tool(app, name, &args, caller) {
        Ok(text) => tool_text(text, false),
        Err(text) => tool_text(text, true),
    };
    Some(rpc_result(&id, result))
}

/// Dev builds only (end-to-end tests without clicking the UI): every connection with its
/// runtime, and handing a pane over / taking it back.
#[cfg(debug_assertions)]
fn debug_method(app: &AppHandle, msg: &Value) -> Option<Value> {
    let id = msg.get("id")?;
    let ctx = app.try_state::<crate::AppContext>()?;
    match msg.get("method").and_then(Value::as_str)? {
        "nexterm/debugPanes" => {
            let panes: Vec<Value> = ctx
                .connections
                .instance_ids()
                .into_iter()
                .filter_map(|i| {
                    let rt = ctx.connections.pane_runtime(&i)?;
                    Some(json!({ "pane": i, "protocol": rt.protocol, "status": rt.status, "shellIntegration": rt.shell_integration }))
                })
                .collect();
            Some(rpc_result(id, json!({ "panes": panes, "controls": controls() })))
        }
        "nexterm/debugControl" => {
            let pane = msg.pointer("/params/pane").and_then(Value::as_str)?;
            let mode = msg.pointer("/params/mode").cloned().and_then(|m| serde_json::from_value::<ControlMode>(m).ok());
            set_control(pane, mode, "debug");
            Some(rpc_result(id, json!({})))
        }
        _ => None,
    }
}

// ---------------------------------------------------------------- tools

fn arg_str<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str)
}

fn arg_u64(args: &Value, key: &str, default: u64, max: u64) -> u64 {
    args.get(key).and_then(Value::as_u64).unwrap_or(default).min(max)
}

/// Last component of a local or remote path, for the pane banner.
fn file_name_of(path: &str) -> String {
    let p = path.trim().trim_end_matches(['/', '\\']);
    let name = p.rsplit(['/', '\\']).next().unwrap_or(p);
    name.chars().take(40).collect()
}

fn history_of(pane: &str) -> Result<std::sync::Arc<crate::history::Recorder>, String> {
    crate::history::get(pane).ok_or_else(|| "该窗格没有完整历史（设置里关闭了完整回滚历史，或窗格还没有连接过）".to_string())
}

fn read_history(pane: &str, args: &Value) -> Result<String, String> {
    let r = history_of(pane)?;
    let info = r.info();
    let total = info.end + info.tail;
    let count = arg_u64(args, "lines", 200, 2000);
    let offset = arg_u64(args, "offset", 0, u64::MAX);
    let to = total.saturating_sub(offset).max(info.first);
    let from = to.saturating_sub(count).max(info.first);
    let page = r.lines(from, (to - from) as u32)?;
    let mut out = format!("历史共 {} 行（第 {}～{} 行可读", total - info.first, info.first, total.saturating_sub(1));
    if info.dropped > 0 {
        out.push_str(&format!("，更早的 {} 行已因大小限制丢弃", info.dropped));
    }
    out.push_str(&format!("），以下是第 {}～{} 行：\n", page.first, page.first + page.lines.len() as u64));
    for (i, l) in page.lines.iter().enumerate() {
        let text = if l.kind == crate::history::line::KIND_CLEARED { "──── 已清屏 ────" } else { l.text.as_str() };
        out.push_str(&format!("{:>8}  {}\n", page.first + i as u64, text));
    }
    Ok(out)
}

fn search_history(pane: &str, args: &Value) -> Result<String, String> {
    let r = history_of(pane)?;
    let query = arg_str(args, "query").unwrap_or("");
    let regex = args.get("regex").and_then(Value::as_bool).unwrap_or(false);
    let case = args.get("case_sensitive").and_then(Value::as_bool).unwrap_or(false);
    let limit = arg_u64(args, "limit", 50, 500) as usize;
    let spec = crate::history::QuerySpec { pattern: query.to_string(), regex, case_sensitive: case, whole_word: false };
    let m = crate::history::Matcher::new(&spec)?;
    let mut lines: Vec<u64> = Vec::new();
    let mut from = u64::MAX;
    // Newest first; a line with many matches counts once.
    loop {
        let res = r.search(&m, from, true, limit * 4, u64::MAX)?;
        for m in res.matches {
            if lines.last() != Some(&m.line) {
                lines.push(m.line);
            }
        }
        match res.next {
            Some(n) if lines.len() < limit => from = n,
            _ => break,
        }
    }
    lines.truncate(limit);
    if lines.is_empty() {
        return Ok("没有匹配的行。".into());
    }
    let mut out = format!("{} 行匹配（从最新往前）：\n", lines.len());
    for n in lines {
        if let Some(l) = r.lines(n, 1)?.lines.first() {
            out.push_str(&format!("{:>8}  {}\n", n, l.text));
        }
    }
    Ok(out)
}

fn call_tool(app: &AppHandle, name: &str, args: &Value, caller: &Caller) -> Result<String, String> {
    let ctx = app.try_state::<crate::AppContext>().ok_or("Nexterm 尚未初始化")?;
    let conns = &ctx.connections;
    let own = caller.pane.as_deref();

    if name == "list_panes" {
        let (controls, pending): (HashMap<String, ControlView>, HashSet<String>) = {
            let r = lock(registry());
            let pending = r.pending.iter().filter(|(_, p)| p.rejected_at.is_none()).map(|(k, _)| k.clone()).collect();
            (r.controls.clone(), pending)
        };
        let mut panes: Vec<Value> = conns
            .instance_ids()
            .into_iter()
            .filter(|id| Some(id.as_str()) != own)
            .filter_map(|id| {
                let rt = conns.pane_runtime(&id)?;
                let control = controls.get(&id);
                let title = control.map(|c| c.title.clone()).filter(|t| !t.is_empty()).unwrap_or_else(|| rt.label.clone());
                let mode = control.map(|c| serde_json::to_value(c.mode).unwrap_or_default()).unwrap_or_else(|| json!("none"));
                Some(json!({
                    "pane": id,
                    "title": title,
                    "control": mode,
                    "requestPending": pending.contains(&id),
                    "protocol": rt.protocol,
                    "target": rt.target,
                    "status": rt.status,
                    "shellIntegration": rt.shell_integration,
                    "commandRunning": rt.command_running,
                }))
            })
            .collect();
        panes.sort_by_key(|p| p["title"].as_str().unwrap_or("").to_string());
        if panes.is_empty() {
            return Ok("Nexterm 里没有打开的终端窗格。".into());
        }
        return Ok(serde_json::to_string_pretty(&panes).unwrap_or_default());
    }

    if name == "list_sessions" {
        let sessions = saved_sessions(&ctx)?;
        let query = arg_str(args, "query").map(str::to_lowercase).filter(|q| !q.trim().is_empty());
        let list: Vec<Value> = sessions
            .iter()
            .filter(|s| {
                query.as_ref().map_or(true, |q| {
                    [&s.label, &s.group, &s.host, &s.username].iter().any(|f| f.to_lowercase().contains(q.as_str()))
                })
            })
            .map(|s| {
                json!({
                    "id": s.id,
                    "name": s.label,
                    "group": s.group,
                    "protocol": serde_json::to_value(&s.protocol).unwrap_or_default(),
                    "host": s.host,
                    "port": s.port,
                    "username": s.username,
                })
            })
            .collect();
        if list.is_empty() {
            return Ok("没有匹配的已保存会话。".into());
        }
        return Ok(serde_json::to_string_pretty(&list).unwrap_or_default());
    }

    if name == "open_session" {
        let reason: String = arg_str(args, "reason").unwrap_or("").trim().chars().take(500).collect();
        let wait = Duration::from_secs(arg_u64(args, "timeout_sec", REQUEST_WAIT_DEFAULT, 600).max(1));
        return open_session(app, &ctx, args, &reason, caller, wait);
    }

    if name == "transfer_status" {
        return crate::mcp_files::transfer_status(args);
    }

    let pane = arg_str(args, "pane").ok_or("缺少参数 pane")?.to_string();
    if Some(pane.as_str()) == own {
        return Err("不能操作 agent 自己所在的窗格".into());
    }
    match name {
        "request_control" => {
            let reason: String = arg_str(args, "reason").unwrap_or("").trim().chars().take(500).collect();
            let wait = Duration::from_secs(arg_u64(args, "timeout_sec", REQUEST_WAIT_DEFAULT, 600).max(1));
            return request_control(app, conns, &pane, &reason, caller, wait);
        }
        "release_control" => {
            if !lock(registry()).controls.contains_key(&pane) {
                return Ok("你没有控制这个窗格，无需释放。".into());
            }
            set_control(&pane, None, "");
            return Ok("已把窗格还给用户，键盘已解锁。".into());
        }
        "close_pane" => return close_pane(app, conns, &pane),
        _ => {}
    }
    if let Some(e) = control_error(&pane) {
        return Err(e);
    }
    match name {
        "read_history" => return read_history(&pane, args),
        "search_history" => return search_history(&pane, args),
        _ => {}
    }
    if crate::mcp_files::TOOL_NAMES.contains(&name) {
        let activity = match name {
            "upload_file" => Some(format!("⇡ 上传 {}", file_name_of(arg_str(args, "local_path").unwrap_or("")))),
            "download_file" => Some(format!("⇣ 下载 {}", file_name_of(arg_str(args, "remote_path").unwrap_or("")))),
            _ => None,
        };
        let _busy = Busy::take(&pane, activity)?;
        return crate::mcp_files::call(app, name, &pane, args);
    }
    let rt = conns.pane_runtime(&pane).ok_or("该窗格没有活动的连接")?;

    match name {
        "read_screen" => {
            let scrollback = arg_u64(args, "scrollback", 0, 2000) as u32;
            read_screen(app, &pane, scrollback).map(|s| format_screen(&s))
        }
        "run_command" => {
            let command = arg_str(args, "command").unwrap_or("").trim().to_string();
            if command.is_empty() {
                return Err("command 为空".into());
            }
            if command.contains(['\n', '\r']) {
                return Err("command 不能包含换行；多条命令请用 && 或 ; 连接".into());
            }
            if rt.status != "connected" {
                return Err(format!("窗格未连接（{}）", rt.status));
            }
            if rt.command_running {
                return Err("窗格中已有命令在运行。用 wait_for 等它结束，或用 send_keys 发送 <C-c> 中断，或用 read_screen 查看。".into());
            }
            let timeout = Duration::from_secs(arg_u64(args, "timeout_sec", 30, 600).max(1));
            let _busy = Busy::take(&pane, Some(command.clone()))?;
            // Typed by the backend, so the pane never sees it as keyboard input: tell the
            // window, which records it in the command history like a typed command. Sent
            // before the command, while the cursor is still on the prompt line.
            let _ = app.emit("mcp-command", json!({ "instanceId": pane, "command": command }));
            if rt.shell_integration {
                run_integrated(conns, &pane, &command, timeout)
            } else {
                run_plain(app, conns, &pane, &command, timeout)
            }
        }
        "send_keys" => {
            let keys: Vec<String> = args
                .get("keys")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                .unwrap_or_default();
            if keys.is_empty() {
                return Err("keys 为空".into());
            }
            let bytes = encode_keys(&keys)?;
            let wait = Duration::from_millis(arg_u64(args, "wait_ms", 2000, 10_000));
            let summary: String = keys.join(" ").chars().take(60).collect();
            let _busy = Busy::take(&pane, Some(format!("⌨ {summary}")))?;
            let cap = conns.arm_capture(&pane, CaptureMode::Watch).map_err(|e| e.to_string())?;
            conns.write(&pane, &bytes).map_err(|e| e.to_string())?;
            let outcome = poll(&pane, &cap, wait, |c, now| c.quiet_for(now) >= Duration::from_millis(300));
            conns.disarm_capture(&pane, &cap);
            outcome?;
            // Let the pane's xterm.js parse what just arrived.
            std::thread::sleep(Duration::from_millis(80));
            read_screen(app, &pane, 0).map(|s| format_screen(&s))
        }
        "wait_for" => {
            let text = arg_str(args, "text").filter(|t| !t.is_empty()).map(str::to_string);
            let idle = args.get("idle_ms").and_then(Value::as_u64).map(Duration::from_millis);
            let timeout = Duration::from_secs(arg_u64(args, "timeout_sec", 60, 600).max(1));
            let wait_command = text.is_none() && idle.is_none() && rt.command_running;
            let idle = if text.is_none() && idle.is_none() && !wait_command { Some(Duration::from_secs(2)) } else { idle };
            let _busy = Busy::take(&pane, Some("等待输出…".into()))?;
            // An earlier run_command / wait_for that timed out left its capture running:
            // continue it, so nothing printed between the two calls is lost.
            let cap = match conns.current_capture(&pane).filter(|c| lock(c).finished.is_none()) {
                Some(c) => c,
                None => conns.arm_capture(&pane, CaptureMode::Watch).map_err(|e| e.to_string())?,
            };
            let mut checked = lock(&cap).unreported_start();
            let quiet_from = Instant::now();
            let reason = poll(&pane, &cap, timeout, |c, now| {
                if c.finished.is_some() {
                    return true;
                }
                if let Some(t) = &text {
                    // Re-read only the new part (plus some overlap for text split across chunks).
                    let from = checked.saturating_sub(t.len() * 4 + 256).max(c.unreported_start()).min(c.raw.len());
                    checked = c.raw.len();
                    if plain_text(&c.raw[from..]).contains(t.as_str()) {
                        return true;
                    }
                }
                // Quiet counts from this call, not from output an earlier call already saw.
                idle.is_some_and(|d| now.duration_since(quiet_from) >= d && c.quiet_for(now) >= d)
            });
            // Timed out: keep collecting for a following wait_for.
            if reason != Ok(false) {
                conns.disarm_capture(&pane, &cap);
            }
            let mut c = lock(&cap);
            let finished = c.finished;
            let out = clip(&plain_text(c.take_unreported()), OUT_HEAD, OUT_TAIL);
            let head = match (&reason, finished) {
                (Err(e), _) => return Err(format!("{e}\n--- 期间输出 ---\n{out}")),
                (Ok(false), _) => format!("等待 {} 秒超时，条件未满足。", timeout.as_secs()),
                (Ok(true), Some(exit)) => format!("命令已结束，退出码: {}", exit.map(|e| e.to_string()).unwrap_or_else(|| "未知".into())),
                (Ok(true), None) => "条件已满足。".into(),
            };
            Ok(format!("{head}\n--- 期间输出 ---\n{out}"))
        }
        _ => Err(format!("未知工具: {name}")),
    }
}

/// Ask the user (in the window showing the pane) to let the agent operate it; waits up to
/// `wait`. Asking again while a request waits joins it instead of opening another dialog.
fn request_control(
    app: &AppHandle,
    conns: &crate::manager::ConnectionManager,
    pane: &str,
    reason: &str,
    caller: &Caller,
    wait: Duration,
) -> Result<String, String> {
    let rt = conns.pane_runtime(pane).ok_or("该窗格没有活动的连接（用 list_panes 查看可用窗格）")?;
    let now = Instant::now();
    let (request_id, announce) = {
        let mut r = lock(registry());
        let mode = r.controls.get(pane).map(|c| c.mode);
        if mode == Some(ControlMode::Active) {
            return Ok("你已经在控制这个窗格，可以直接操作。".into());
        }
        match r.pending.get(pane) {
            Some(p) if p.rejected_at.is_none() => (p.request_id.clone(), None),
            Some(p) if p.rejected_at.is_some_and(|t| now.duration_since(t) < REJECT_COOLDOWN) => {
                return Err("用户刚刚拒绝了对这个窗格的控制申请。不要重复申请；如果确实需要，先在对话里向用户说明原因。".into());
            }
            _ => {
                let request = ControlRequest {
                    request_id: uuid::Uuid::new_v4().to_string(),
                    instance_id: pane.to_string(),
                    client: client_display(caller.client.as_deref()),
                    reason: reason.to_string(),
                    resume: mode == Some(ControlMode::Paused),
                    title: rt.label.clone(),
                    rejected_at: None,
                };
                r.pending.insert(pane.to_string(), request.clone());
                (request.request_id.clone(), Some(request))
            }
        }
    };
    if let Some(request) = announce {
        let _ = app.emit("mcp-control-request", &request);
        let title = if request.resume {
            format!("{} 申请继续控制终端", request.client)
        } else {
            format!("{} 申请控制终端", request.client)
        };
        let body = [request.title.as_str(), request.reason.as_str()].iter().filter(|s| !s.is_empty()).copied().collect::<Vec<_>>().join(" · ");
        alert_user(app, title, body, request.instance_id.clone());
    }
    let start = Instant::now();
    loop {
        {
            let r = lock(registry());
            if r.controls.get(pane).is_some_and(|c| c.mode == ControlMode::Active) {
                return Ok(format!("用户已同意，你现在控制窗格「{}」。完成后请用 release_control 归还。", rt.label));
            }
            match r.pending.get(pane) {
                Some(p) if p.request_id == request_id => {
                    if p.rejected_at.is_some() {
                        return Err("用户拒绝了控制申请。请停止对这个窗格的操作，不要重复申请。".into());
                    }
                }
                _ => return Err("申请已取消（窗格已关闭，或用户另行处理了）。用 list_panes 查看当前状态。".into()),
            }
        }
        if start.elapsed() >= wait {
            return Ok(format!(
                "用户在 {} 秒内还没有回应，确认弹窗仍在 Nexterm 中等待。稍后再次调用 request_control 继续等待（不会重复弹窗），或用 list_panes 查看 control 字段。",
                wait.as_secs()
            ));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn saved_sessions(ctx: &crate::AppContext) -> Result<Vec<crate::models::SessionConfig>, String> {
    let storage = ctx.storage.lock().map_err(|e| e.to_string())?;
    // No sessions file yet: nothing saved.
    Ok(storage.load_sessions().unwrap_or_default())
}

/// A saved session by id, exact name, name in any case, or a name part that only one has.
fn find_session<'a>(sessions: &'a [crate::models::SessionConfig], key: &str) -> Result<&'a crate::models::SessionConfig, String> {
    let key = key.trim();
    let lower = key.to_lowercase();
    if let Some(s) = sessions.iter().find(|s| s.id == key) {
        return Ok(s);
    }
    let exact: Vec<_> = sessions.iter().filter(|s| s.label == key).collect();
    let pick = |found: Vec<&'a crate::models::SessionConfig>| -> Result<Option<&'a crate::models::SessionConfig>, String> {
        match found.len() {
            0 => Ok(None),
            1 => Ok(Some(found[0])),
            _ => Err(format!(
                "有 {} 个会话匹配「{key}」，请改用 id：\n{}",
                found.len(),
                found.iter().map(|s| format!("- {} ({}) id={}", s.label, s.host, s.id)).collect::<Vec<_>>().join("\n")
            )),
        }
    };
    if let Some(s) = pick(exact)? {
        return Ok(s);
    }
    if let Some(s) = pick(sessions.iter().filter(|s| s.label.to_lowercase() == lower).collect())? {
        return Ok(s);
    }
    if let Some(s) = pick(sessions.iter().filter(|s| s.label.to_lowercase().contains(&lower)).collect())? {
        return Ok(s);
    }
    Err(format!("没有找到会话「{key}」。用 list_sessions 查看已保存的会话。"))
}

fn session_summary(s: &crate::models::SessionConfig) -> String {
    let user = if s.username.is_empty() { String::new() } else { format!("{}@", s.username) };
    match s.host.trim() {
        "" => serde_json::to_value(&s.protocol).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default(),
        host if s.port > 0 => format!("{user}{host}:{}", s.port),
        host => format!("{user}{host}"),
    }
}

/// Ask the user (main window) to open a session in a new tab; accepted, the agent holds the
/// new pane right away. Then waits a little for the connection.
fn open_session(app: &AppHandle, ctx: &crate::AppContext, args: &Value, reason: &str, caller: &Caller, wait: Duration) -> Result<String, String> {
    let session = arg_str(args, "session").map(str::trim).filter(|s| !s.is_empty());
    let target = arg_str(args, "target").map(str::trim).filter(|s| !s.is_empty());
    let mut request = OpenRequest {
        request_id: uuid::Uuid::new_v4().to_string(),
        client: client_display(caller.client.as_deref()),
        reason: reason.to_string(),
        session_id: None,
        target: None,
        label: String::new(),
        summary: String::new(),
    };
    match (session, target) {
        (Some(key), None) => {
            let sessions = saved_sessions(ctx)?;
            let s = find_session(&sessions, key)?;
            request.session_id = Some(s.id.clone());
            request.label = s.label.clone();
            request.summary = session_summary(s);
        }
        (None, Some(t)) => {
            if t.contains(['\n', '\r']) || t.chars().count() > 300 {
                return Err("target 必须是一行快速连接地址".into());
            }
            request.target = Some(t.to_string());
            request.label = t.to_string();
        }
        _ => return Err("session（已保存会话的名称或 id）和 target（快速连接地址）必须且只能给一个".into()),
    }
    {
        let mut r = lock(registry());
        if !r.open_requests.is_empty() {
            return Err("已经有一个打开会话的请求在等用户确认，请稍后再试。".into());
        }
        r.open_requests.insert(request.request_id.clone(), request.clone());
    }
    let _ = app.emit("mcp-open-request", &request);
    let body = [request.label.as_str(), request.reason.as_str()].iter().filter(|s| !s.is_empty()).copied().collect::<Vec<_>>().join(" · ");
    alert_user(app, format!("{} 申请打开会话", request.client), body, "mcp-open".into());

    // 1. The user's answer.
    let start = Instant::now();
    let result = loop {
        if let Some(res) = lock(registry()).open_results.remove(&request.request_id) {
            break res;
        }
        if start.elapsed() >= wait {
            let cancelled = lock(registry()).open_requests.remove(&request.request_id).is_some();
            if cancelled {
                emit_open_done(&request.request_id);
                return Err(format!("用户在 {} 秒内没有回应，打开请求已取消。", wait.as_secs()));
            }
            // Answered just now.
            continue;
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    if let Some(e) = result.error {
        return Err(format!("无法打开：{e}"));
    }
    if !result.accept {
        return Err("用户拒绝了打开会话的请求。不要重复请求。".into());
    }
    let pane = result.pane.ok_or("Nexterm 没有返回新窗格")?;
    if result.needs_login {
        return Ok(format!(
            "已打开新标签页「{}」，窗格 id: {pane}，你已控制它。它正在等用户在 Nexterm 中输入用户名 / 密码，之后才会连接；\
稍后用 list_panes 查看 status，变成 connected 再操作。",
            request.label
        ));
    }

    // 2. The connection (a host key prompt or a slow login can keep it busy).
    let conns = &ctx.connections;
    let start = Instant::now();
    let mut connected_at: Option<Instant> = None;
    loop {
        let rt = conns.pane_runtime(&pane);
        let status = rt.as_ref().map(|r| r.status.as_str()).unwrap_or("connecting");
        match status {
            "connected" => {
                let at = *connected_at.get_or_insert_with(Instant::now);
                // Give the shell a moment to draw its prompt (and load shell integration).
                if rt.as_ref().is_some_and(|r| r.shell_integration) || at.elapsed() >= Duration::from_secs(4) {
                    let rt = rt.unwrap();
                    return Ok(format!(
                        "已打开并连接「{}」，你已控制它。\n{}",
                        request.label,
                        serde_json::to_string_pretty(&json!({
                            "pane": pane,
                            "protocol": rt.protocol,
                            "target": rt.target,
                            "status": rt.status,
                            "shellIntegration": rt.shell_integration,
                        }))
                        .unwrap_or_default()
                    ));
                }
            }
            "error" | "disconnected" => {
                return Err(format!("新标签页「{}」连接失败（{status}），窗格 id: {pane}。可以用 read_screen 查看错误信息。", request.label));
            }
            _ => {}
        }
        if start.elapsed() >= Duration::from_secs(20) {
            return Ok(format!(
                "已打开新标签页「{}」，窗格 id: {pane}，你已控制它，但 20 秒内还没连上（可能在等用户确认主机密钥或输入密码）。稍后用 list_panes 查看 status。",
                request.label
            ));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Close a pane the agent opened itself and still controls.
fn close_pane(app: &AppHandle, conns: &crate::manager::ConnectionManager, pane: &str) -> Result<String, String> {
    {
        let r = lock(registry());
        if !r.opened.contains(pane) {
            return Err("只能关闭你自己用 open_session 打开的窗格；用户的窗格请用 release_control 归还。".into());
        }
        if r.controls.get(pane).map(|c| c.mode) != Some(ControlMode::Active) {
            return Err("这个窗格现在不归你控制（用户暂停或收回了），不能关闭。".into());
        }
    }
    let _ = app.emit("mcp-close-pane", json!({ "instanceId": pane }));
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(5) {
        if conns.pane_runtime(pane).is_none() && !lock(registry()).opened.contains(pane) {
            return Ok("窗格已关闭。".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err("窗格没有关闭（用户可能锁定了它，禁止关闭）。".into())
}

/// Wait until `done` holds (Ok(true)), the timeout passes (Ok(false)), or the user pauses /
/// takes back the pane (Err).
fn poll(
    pane: &str,
    cap: &SharedCapture,
    timeout: Duration,
    mut done: impl FnMut(&crate::term_capture::Capture, Instant) -> bool,
) -> Result<bool, String> {
    let start = Instant::now();
    loop {
        if let Some(e) = control_error(pane) {
            return Err(e);
        }
        let now = Instant::now();
        if done(&lock(cap), now) {
            return Ok(true);
        }
        if now.duration_since(start) >= timeout {
            return Ok(false);
        }
        std::thread::sleep(POLL);
    }
}

fn run_integrated(conns: &crate::manager::ConnectionManager, pane: &str, command: &str, timeout: Duration) -> Result<String, String> {
    let cap = conns.arm_capture(pane, CaptureMode::Command).map_err(|e| e.to_string())?;
    let started = Instant::now();
    conns.write(pane, format!("{command}\r").as_bytes()).map_err(|e| e.to_string())?;
    // The C comes as soon as the shell starts the command; output going quiet without it
    // means the shell is not going to (waiting for more input, or a syntax error the
    // integration script could not report).
    let outcome = poll(pane, &cap, timeout, |c, now| c.finished.is_some() || (!c.started && c.quiet_for(now) >= NOT_STARTED_QUIET));
    let mut c = lock(&cap);
    let (finished, started_cmd, syntax_error) = (c.finished, c.started, c.syntax_error);
    // Not over: keep collecting for a following wait_for.
    if outcome.is_err() || finished.is_some() {
        conns.disarm_capture(pane, &cap);
    }
    let out = if started_cmd { plain_text(c.take_unreported()) } else { c.pre_text() };
    let out = clip(&out, OUT_HEAD, OUT_TAIL);
    drop(c);
    let secs = started.elapsed().as_secs_f32();
    match (outcome, finished) {
        (Err(e), _) => Err(format!("{e}\n--- 已收到的输出 ---\n{out}")),
        (Ok(_), Some(_)) if syntax_error => {
            // fish keeps the rejected line for editing: the next command would be appended to it.
            let cleared = conns.write(pane, b"\x03").is_ok();
            Ok(format!(
                "语法错误，命令没有执行（注意该 shell 的语法，例如 fish 不是 bash）。{}\n--- 输出 ---\n{out}",
                if cleared { "已发送 Ctrl-C 清空命令行。" } else { "命令行中可能仍留着这条命令，请先用 send_keys 发送 <C-c> 清空。" }
            ))
        }
        (Ok(_), Some(exit)) => Ok(format!(
            "退出码: {}  耗时: {secs:.1}s\n--- 输出 ---\n{out}",
            exit.map(|e| e.to_string()).unwrap_or_else(|| "未知".into())
        )),
        (Ok(_), None) if !started_cmd => Ok(format!(
            "shell 没有开始执行这条命令（{:.0} 秒内没有开始，且已无新输出）：可能有语法错误，或语法不完整（shell 在等待续行，注意该 shell 的语法，例如 fish 不是 bash），或者在等待输入。\
请先用 read_screen 查看；需要取消时用 send_keys 发送 <C-c>。若命令其实已开始，可用 wait_for 继续等待。\n--- 已收到的输出 ---\n{out}",
            secs
        )),
        (Ok(_), None) => Ok(format!(
            "命令在 {} 秒内没有结束，仍在运行。可用 wait_for 继续等待（不会丢失期间的输出），或 send_keys 发送 <C-c> 中断。\n--- 已收到的输出 ---\n{out}",
            timeout.as_secs()
        )),
    }
}

/// No shell integration: type the command, wait for the output to go quiet, show the screen.
fn run_plain(
    app: &AppHandle,
    conns: &crate::manager::ConnectionManager,
    pane: &str,
    command: &str,
    timeout: Duration,
) -> Result<String, String> {
    let cap = conns.arm_capture(pane, CaptureMode::Watch).map_err(|e| e.to_string())?;
    conns.write(pane, format!("{command}\r").as_bytes()).map_err(|e| e.to_string())?;
    let outcome = poll(pane, &cap, timeout, |c, now| c.last_output.is_some() && c.quiet_for(now) >= Duration::from_millis(1500));
    conns.disarm_capture(pane, &cap);
    let finished = outcome?;
    std::thread::sleep(Duration::from_millis(80));
    let screen = read_screen(app, pane, 0)?;
    let note = if finished {
        "该窗格没有 Shell 集成，无法得知命令是否结束和退出码。以下是输出安静 1.5 秒后的屏幕："
    } else {
        "该窗格没有 Shell 集成；等待超时时输出仍在继续，命令可能还在运行。当前屏幕："
    };
    Ok(format!("{note}\n{}", format_screen(&screen)))
}

/// `["<Esc>", ":wq", "<Enter>"]` -> bytes. `<...>` elements are key names; others are text.
pub fn encode_keys(keys: &[String]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    for k in keys {
        let name = k.strip_prefix('<').and_then(|s| s.strip_suffix('>')).filter(|s| !s.is_empty() && !s.contains(['<', '>']));
        match name {
            Some(name) => out.extend_from_slice(&key_bytes(name).ok_or_else(|| format!("未知按键: {k}"))?),
            None => out.extend_from_slice(k.as_bytes()),
        }
    }
    Ok(out)
}

fn key_bytes(name: &str) -> Option<Vec<u8>> {
    let lower = name.to_ascii_lowercase();
    let fixed: &[u8] = match lower.as_str() {
        "enter" | "cr" | "return" => b"\r",
        "tab" => b"\t",
        "esc" | "escape" => b"\x1b",
        "bs" | "backspace" => b"\x7f",
        "space" => b" ",
        "up" => b"\x1b[A",
        "down" => b"\x1b[B",
        "right" => b"\x1b[C",
        "left" => b"\x1b[D",
        "home" => b"\x1b[H",
        "end" => b"\x1b[F",
        "pageup" | "pgup" => b"\x1b[5~",
        "pagedown" | "pgdn" => b"\x1b[6~",
        "insert" | "ins" => b"\x1b[2~",
        "delete" | "del" => b"\x1b[3~",
        "f1" => b"\x1bOP",
        "f2" => b"\x1bOQ",
        "f3" => b"\x1bOR",
        "f4" => b"\x1bOS",
        "f5" => b"\x1b[15~",
        "f6" => b"\x1b[17~",
        "f7" => b"\x1b[18~",
        "f8" => b"\x1b[19~",
        "f9" => b"\x1b[20~",
        "f10" => b"\x1b[21~",
        "f11" => b"\x1b[23~",
        "f12" => b"\x1b[24~",
        _ => b"",
    };
    if !fixed.is_empty() {
        return Some(fixed.to_vec());
    }
    // <C-c> / <Ctrl-c> / <Ctrl+c>, <M-x> / <Alt-x>.
    let (prefix, rest) = lower.split_once(['-', '+'])?;
    let mut chars = rest.chars();
    let c = chars.next()?;
    if chars.next().is_some() {
        return None;
    }
    match prefix {
        "c" | "ctrl" => match c {
            'a'..='z' => Some(vec![c as u8 - b'a' + 1]),
            '@' | ' ' => Some(vec![0]),
            '[' => Some(vec![0x1b]),
            '\\' => Some(vec![0x1c]),
            ']' => Some(vec![0x1d]),
            '^' => Some(vec![0x1e]),
            '_' => Some(vec![0x1f]),
            '?' => Some(vec![0x7f]),
            _ => None,
        },
        "m" | "alt" | "meta" => {
            // Keep the case the caller wrote (<M-X> differs from <M-x>).
            let orig = name.chars().last()?;
            let mut v = vec![0x1b];
            let mut buf = [0u8; 4];
            v.extend_from_slice(orig.encode_utf8(&mut buf).as_bytes());
            Some(v)
        }
        _ => None,
    }
}

// ---------------------------------------------------------------- HTTP server

fn random_token() -> String {
    use ring::rand::SecureRandom;
    let mut buf = [0u8; 24];
    if ring::rand::SystemRandom::new().fill(&mut buf).is_err() {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        buf[..16].copy_from_slice(&nanos.to_le_bytes());
    }
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Debug, Serialize, Deserialize)]
struct Endpoint {
    port: u16,
    token: String,
    pid: u32,
}

/// Where the bridge looks for the running app: its data folder (Tauri's app_data_dir on
/// Windows, unless storage-location.json moved it next to the exe or elsewhere).
fn endpoint_path_for_bridge() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("NEXTERM_MCP_ENDPOINT") {
        return Some(PathBuf::from(p));
    }
    let user_dir = dirs::data_dir()?.join("com.nexterm.app");
    Some(crate::storage_location::data_dir_for(user_dir).join(ENDPOINT_FILE))
}

pub fn start(app: AppHandle) {
    let _ = APP.set(app.clone());
    let listener = match TcpListener::bind("127.0.0.1:0") {
        Ok(l) => l,
        Err(_) => return,
    };
    let Ok(port) = listener.local_addr().map(|a| a.port()) else { return };
    let token = random_token();
    let endpoint = Endpoint { port, token: token.clone(), pid: std::process::id() };
    let path = crate::app_paths::data_dir().join(ENDPOINT_FILE);
    let _ = std::fs::write(&path, serde_json::to_string(&endpoint).unwrap_or_default());
    let token = Arc::new(token);
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            let token = Arc::clone(&token);
            std::thread::spawn(move || {
                let _ = serve(&app, stream, &token);
            });
        }
    });
}

struct HttpRequest {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

fn read_request(stream: &TcpStream) -> std::io::Result<HttpRequest> {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.by_ref().take(8192).read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();
    let mut headers = HashMap::new();
    for _ in 0..100 {
        let mut h = String::new();
        reader.by_ref().take(8192).read_line(&mut h)?;
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }
    let len = headers.get("content-length").and_then(|v| v.parse::<usize>().ok()).unwrap_or(0);
    if len > 4 * 1024 * 1024 {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "body too large"));
    }
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body)?;
    Ok(HttpRequest { method, path, headers, body })
}

fn respond(mut stream: &TcpStream, status: &str, body: Option<&str>) -> std::io::Result<()> {
    let body = body.unwrap_or("");
    let ctype = if body.is_empty() { "" } else { "Content-Type: application/json\r\n" };
    write!(stream, "HTTP/1.1 {status}\r\n{ctype}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())?;
    stream.flush()
}

fn serve(app: &AppHandle, stream: TcpStream, token: &str) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let req = read_request(&stream)?;
    if req.path.split('?').next() != Some("/mcp") {
        return respond(&stream, "404 Not Found", None);
    }
    let auth_ok = req.headers.get("authorization").and_then(|v| v.strip_prefix("Bearer ")) == Some(token);
    if !auth_ok {
        return respond(&stream, "401 Unauthorized", None);
    }
    // DNS rebinding: a browser page always sends its Origin.
    if let Some(origin) = req.headers.get("origin") {
        let local = ["http://127.0.0.1", "http://localhost", "https://127.0.0.1", "https://localhost"];
        if !local.iter().any(|o| origin.starts_with(o)) {
            return respond(&stream, "403 Forbidden", None);
        }
    }
    if req.method != "POST" {
        return respond(&stream, "405 Method Not Allowed", None);
    }
    let msg: Value = match serde_json::from_slice(&req.body) {
        Ok(v) => v,
        Err(_) => return respond(&stream, "400 Bad Request", Some(&rpc_error(&Value::Null, -32700, "Parse error").to_string())),
    };
    let caller = Caller {
        pane: req.headers.get("x-nexterm-pane").filter(|v| !v.is_empty()).cloned(),
        client: req.headers.get("x-nexterm-client").filter(|v| !v.is_empty()).cloned(),
    };
    match handle_message(app, &msg, &caller) {
        Some(reply) => respond(&stream, "200 OK", Some(&reply.to_string())),
        None => respond(&stream, "202 Accepted", None),
    }
}

// ---------------------------------------------------------------- stdio bridge

/// `claude mcp add ...` / `codex mcp add ...` / `gemini mcp add ...` for this exe. No `--`
/// before the server command: the CLIs are npm `.ps1` shims on Windows, PowerShell swallows a bare `--`,
/// and the CLI then rejects the server's own flag. The bare `mcp` argument needs none.
pub fn client_command(client: &str, exe: &str) -> String {
    match client {
        "codex" => format!("codex mcp add nexterm \"{exe}\" mcp"),
        // Gemini CLI's default scope is the project in the current directory.
        "gemini" => format!("gemini mcp add --scope user nexterm \"{exe}\" mcp"),
        _ => format!("claude mcp add --scope user nexterm \"{exe}\" mcp"),
    }
}

/// `nexterm.exe mcp` (or `--mcp`): newline-delimited JSON-RPC on stdin / stdout.
pub fn run_bridge() {
    let out = Arc::new(Mutex::new(std::io::stdout()));
    let mut caller = Caller { pane: std::env::var("NEXTERM_PANE_ID").ok(), client: None };
    let send = |out: &Arc<Mutex<std::io::Stdout>>, v: &Value| {
        let mut o = lock(out);
        let _ = writeln!(o, "{v}");
        let _ = o.flush();
    };
    let stdin = std::io::stdin();
    let mut pending: Vec<std::thread::JoinHandle<()>> = Vec::new();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => {
                send(&out, &rpc_error(&Value::Null, -32700, "Parse error"));
                continue;
            }
        };
        // Remember who connected ("claude-code", "codex-mcp-client", "gemini-cli-mcp-client"), for the confirm dialog.
        if msg.get("method").and_then(Value::as_str) == Some("initialize") {
            caller.client = msg
                .pointer("/params/clientInfo/name")
                .and_then(Value::as_str)
                .map(|n| n.chars().filter(|c| c.is_ascii_graphic() || *c == ' ').take(64).collect::<String>())
                .filter(|n| !n.is_empty());
        }
        if let Some(local) = local_response(&msg) {
            if let Some(reply) = local {
                send(&out, &reply);
            }
            continue;
        }
        // tools/call can take minutes: answer in the background, in any order.
        let out = Arc::clone(&out);
        let caller = caller.clone();
        pending.retain(|h| !h.is_finished());
        pending.push(std::thread::spawn(move || {
            let id = msg.get("id").cloned().unwrap_or(Value::Null);
            let reply = match forward(&line, &caller) {
                Ok(v) => v,
                Err(e) => rpc_result(&id, tool_text(e, true)),
            };
            send(&out, &reply);
        }));
    }
    // stdin closed: answer what is still running before exiting.
    for h in pending {
        let _ = h.join();
    }
}

fn forward(body: &str, caller: &Caller) -> Result<Value, String> {
    let not_running = "Nexterm 没有运行（或 MCP 服务未启动）。请先打开 Nexterm。".to_string();
    let path = endpoint_path_for_bridge().ok_or_else(|| not_running.clone())?;
    let endpoint: Endpoint = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .ok_or_else(|| not_running.clone())?;
    let mut stream = TcpStream::connect(("127.0.0.1", endpoint.port)).map_err(|_| not_running.clone())?;
    let mut pane_header = caller.pane.as_ref().map(|p| format!("X-Nexterm-Pane: {p}\r\n")).unwrap_or_default();
    if let Some(c) = &caller.client {
        pane_header.push_str(&format!("X-Nexterm-Client: {c}\r\n"));
    }
    let request = format!(
        "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nAccept: application/json\r\n{pane_header}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        endpoint.port,
        endpoint.token,
        body.len()
    );
    stream.write_all(request.as_bytes()).map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).map_err(|e| e.to_string())?;
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or("Nexterm 返回了无效的响应")?;
    let head = String::from_utf8_lossy(&raw[..split]);
    let status = head.split_whitespace().nth(1).unwrap_or("");
    if status == "401" {
        // A stale endpoint file from an earlier run whose port got reused.
        return Err(not_running);
    }
    if status != "200" {
        return Err(format!("Nexterm MCP 服务返回 HTTP {status}"));
    }
    serde_json::from_slice(&raw[split + 4..]).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_names_for_the_dialog() {
        assert_eq!(client_display(Some("claude-code")), "Claude Code");
        assert_eq!(client_display(Some("codex-mcp-client")), "Codex");
        assert_eq!(client_display(Some("gemini-cli-mcp-client")), "Gemini CLI");
        assert_eq!(client_display(None), "AI agent");
        assert_eq!(client_display(Some("cursor")), "cursor");
    }

    #[test]
    fn requests_settle_on_hand_over_and_cool_down_after_refusal() {
        let pane = "t-req-pane";
        let put = |id: &str| {
            lock(registry()).pending.insert(
                pane.into(),
                ControlRequest {
                    request_id: id.into(),
                    instance_id: pane.into(),
                    client: "Codex".into(),
                    reason: String::new(),
                    resume: false,
                    title: String::new(),
                    rejected_at: None,
                },
            );
        };
        put("r1");
        assert_eq!(pending_requests().iter().filter(|p| p.instance_id == pane).count(), 1);
        respond_request("r1", false, "");
        assert!(lock(registry()).pending.get(pane).is_some_and(|p| p.rejected_at.is_some()));
        assert_eq!(pending_requests().iter().filter(|p| p.instance_id == pane).count(), 0);
        // Answering a refused request again changes nothing.
        respond_request("r1", true, "");
        assert!(control_error(pane).is_some());
        put("r2");
        respond_request("r2", true, "t");
        assert!(control_error(pane).is_none());
        assert!(lock(registry()).pending.get(pane).is_none());
        forget(pane);
    }

    #[test]
    fn sessions_found_by_id_name_or_unique_part() {
        use crate::models::SessionConfig;
        let mk = |id: &str, label: &str| SessionConfig { id: id.into(), label: label.into(), host: "10.0.0.1".into(), ..Default::default() };
        let list = vec![mk("s1", "一楼服务器"), mk("s2", "一楼服务器"), mk("s3", "NAS"), mk("s4", "算法NAS")];
        assert_eq!(find_session(&list, "s3").unwrap().id, "s3");
        assert_eq!(find_session(&list, "NAS").unwrap().id, "s3");
        assert_eq!(find_session(&list, "nas").unwrap().id, "s3");
        assert_eq!(find_session(&list, "算法").unwrap().id, "s4");
        assert!(find_session(&list, "一楼服务器").unwrap_err().contains("id=s2"));
        assert!(find_session(&list, "nope").is_err());
    }

    #[test]
    fn accepted_open_hands_the_new_pane_to_the_agent() {
        let put = |id: &str| {
            lock(registry()).open_requests.insert(
                id.into(),
                OpenRequest {
                    request_id: id.into(),
                    client: "Codex".into(),
                    reason: String::new(),
                    session_id: None,
                    target: Some("wsl".into()),
                    label: "wsl".into(),
                    summary: String::new(),
                },
            );
        };
        let answer = |accept: bool, pane: Option<&str>| OpenResult {
            accept,
            pane: pane.map(str::to_string),
            needs_login: false,
            error: None,
            title: "WSL".into(),
        };
        put("o1");
        respond_open("o1", answer(false, None));
        assert!(lock(registry()).open_results.remove("o1").is_some_and(|r| !r.accept));
        put("o2");
        respond_open("o2", answer(true, Some("t-open-pane")));
        assert!(control_error("t-open-pane").is_none());
        assert!(lock(registry()).opened.contains("t-open-pane"));
        // A second answer to the same request is ignored.
        respond_open("o2", answer(true, Some("t-other")));
        assert!(control_error("t-other").is_some());
        forget("t-open-pane");
        assert!(!lock(registry()).opened.contains("t-open-pane"));
        lock(registry()).open_results.clear();
    }

    #[test]
    fn client_commands_need_no_double_dash() {
        let exe = r"C:\Program Files\Nexterm\nexterm.exe";
        assert_eq!(client_command("claude", exe), format!("claude mcp add --scope user nexterm \"{exe}\" mcp"));
        assert_eq!(client_command("codex", exe), format!("codex mcp add nexterm \"{exe}\" mcp"));
        assert_eq!(client_command("gemini", exe), format!("gemini mcp add --scope user nexterm \"{exe}\" mcp"));
        assert!(!client_command("codex", exe).contains(" -- "));
        assert!(!client_command("gemini", exe).contains(" -- "));
    }

    #[test]
    fn keys_encode() {
        let k = |v: &[&str]| encode_keys(&v.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert_eq!(k(&["<Esc>", ":wq", "<Enter>"]).unwrap(), b"\x1b:wq\r");
        assert_eq!(k(&["<C-c>"]).unwrap(), b"\x03");
        assert_eq!(k(&["<Ctrl+D>"]).unwrap(), b"\x04");
        assert_eq!(k(&["<M-x>", "<Up>", "<F5>"]).unwrap(), b"\x1bx\x1b[A\x1b[15~");
        assert_eq!(k(&["a<b>c"]).unwrap(), b"a<b>c");
        assert_eq!(k(&["<>"]).unwrap(), b"<>");
        assert!(k(&["<Nope>"]).is_err());
    }

    #[test]
    fn local_protocol_answers() {
        let init = json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}});
        let r = local_response(&init).unwrap().unwrap();
        assert_eq!(r["result"]["protocolVersion"], "2025-03-26");
        let init = json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"1999-01-01"}});
        assert_eq!(local_response(&init).unwrap().unwrap()["result"]["protocolVersion"], DEFAULT_PROTOCOL);
        let list = json!({"jsonrpc":"2.0","id":2,"method":"tools/list"});
        assert_eq!(local_response(&list).unwrap().unwrap()["result"]["tools"].as_array().unwrap().len(), 16);
        assert!(local_response(&json!({"jsonrpc":"2.0","method":"notifications/initialized"})).unwrap().is_none());
        assert!(local_response(&json!({"jsonrpc":"2.0","id":3,"method":"tools/call"})).is_none());
        assert_eq!(local_response(&json!({"jsonrpc":"2.0","id":4,"method":"x"})).unwrap().unwrap()["error"]["code"], -32601);
    }

    #[test]
    fn user_writes_gated_while_active() {
        set_control("t-pane", Some(ControlMode::Active), "t");
        assert!(!user_write_allowed("t-pane", b"ls\r"));
        assert!(user_write_allowed("t-pane", b"\x1b[3;4R"));
        set_control("t-pane", Some(ControlMode::Paused), "");
        assert!(user_write_allowed("t-pane", b"ls\r"));
        assert!(control_error("t-pane").is_some());
        set_control("t-pane", None, "");
        assert!(user_write_allowed("t-pane", b"ls\r"));
    }
}
