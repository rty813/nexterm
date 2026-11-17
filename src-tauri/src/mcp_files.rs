//! MCP file tools: browse an SSH pane's server and move files between this computer and it.
//!
//! Transfers go through the file browser's queue (transfer.rs), so they pick SFTP when the
//! server has it and SCP otherwise, and show up in the transfer panel like the user's own.
//! The agent must hold the pane (request_control), like every other pane tool.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use chrono::TimeZone;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::sftp::{Fs, RemoteEntry};
use crate::transfer::{join_remote, split_remote, TransferInfo, TransferOptions, TransferRequest};

/// Entries `list_files` shows before summarizing the rest.
const MAX_ENTRIES: usize = 500;
/// How long upload / download wait for the transfer by default.
const WAIT_DEFAULT: u64 = 60;
const POLL: Duration = Duration::from_millis(200);

pub const TOOL_NAMES: &[&str] = &["list_files", "upload_file", "download_file", "transfer_status"];

pub fn tool_defs(pane: &Value) -> Vec<Value> {
    let conflict = json!({
        "type": "string",
        "enum": ["ask", "overwrite", "skip", "rename", "newer"],
        "description": "目标已存在时：ask 由用户在传输面板里决定（默认），overwrite 覆盖，skip 跳过，rename 自动改名，newer 源文件更新时才覆盖"
    });
    let timeout = json!({
        "type": "integer", "minimum": 0, "maximum": 600,
        "description": "最长等待传输完成的秒数，默认 60；超时后传输在后台继续，用 transfer_status 查询"
    });
    vec![
        json!({
            "name": "list_files",
            "description": "列出 SSH 窗格所连服务器上的目录（服务器支持 SFTP 时用 SFTP，否则用 shell 命令）。path 省略时为登录用户的主目录；相对路径和 ~/ 都相对主目录。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "pane": pane,
                    "path": { "type": "string", "description": "远端目录，默认主目录" }
                },
                "required": ["pane"]
            },
            "annotations": { "readOnlyHint": true }
        }),
        json!({
            "name": "upload_file",
            "description": "把本机的文件或文件夹上传到 SSH 窗格所连的服务器（SFTP，不支持时用 SCP），等传输结束后返回结果。传输显示在 Nexterm 的传输面板里，用户可以暂停或取消。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "pane": pane,
                    "local_path": { "type": "string", "description": "本机文件或文件夹的绝对路径" },
                    "remote_path": { "type": "string", "description": "远端目标。是已存在的目录时放进该目录（保留原名），否则作为完整目标路径。默认主目录" },
                    "conflict": conflict,
                    "timeout_sec": timeout
                },
                "required": ["pane", "local_path"]
            },
            "annotations": { "destructiveHint": true, "openWorldHint": true }
        }),
        json!({
            "name": "download_file",
            "description": "把 SSH 窗格所连服务器上的文件或文件夹下载到本机（SFTP，不支持时用 SCP），等传输结束后返回结果。传输显示在 Nexterm 的传输面板里，用户可以暂停或取消。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "pane": pane,
                    "remote_path": { "type": "string", "description": "远端文件或文件夹；相对路径和 ~/ 相对主目录" },
                    "local_path": { "type": "string", "description": "本机目标（绝对路径）。是已存在的文件夹时放进去（保留原名），否则作为完整目标路径。默认本机的“下载”文件夹" },
                    "conflict": conflict,
                    "timeout_sec": timeout
                },
                "required": ["pane", "remote_path"]
            },
            "annotations": { "destructiveHint": true, "openWorldHint": true }
        }),
        json!({
            "name": "transfer_status",
            "description": "查询 upload_file / download_file 启动的传输：状态、进度、错误。可以等待它结束，或取消它。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "transfer_id": { "type": "string", "description": "upload_file / download_file 返回的传输 id" },
                    "wait_sec": { "type": "integer", "minimum": 0, "maximum": 600, "description": "等待传输结束的秒数，默认 0（立即返回）" },
                    "cancel": { "type": "boolean", "description": "取消这个传输" }
                },
                "required": ["transfer_id"]
            }
        }),
    ]
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Transfers started by the agent: the only ones transfer_status reports on.
fn started() -> &'static Mutex<HashSet<String>> {
    static S: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    S.get_or_init(Default::default)
}

fn arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

fn wait_arg(args: &Value, key: &str, default: u64) -> Duration {
    Duration::from_secs(args.get(key).and_then(Value::as_u64).unwrap_or(default).min(600))
}

/// The pane's files, SFTP or shell. The pane must be a connected SSH session.
fn fs_of(app: &AppHandle, pane: &str) -> Result<Fs, String> {
    let link = app
        .state::<crate::AppContext>()
        .connections
        .ssh_link(pane)
        .map_err(|e| format!("{e:#}（文件工具只支持 SSH 窗格）"))?;
    tauri::async_runtime::block_on(crate::sftp::fs(pane, &link)).map_err(|e| format!("无法打开文件通道：{e:#}"))
}

fn block<T>(f: impl std::future::Future<Output = anyhow::Result<T>>) -> Result<T, String> {
    tauri::async_runtime::block_on(f).map_err(|e| format!("{e:#}"))
}

/// Remote path as given, with "~", "~/x" and relative paths taken from the home folder.
fn remote_abs(fs: &Fs, path: Option<&str>) -> Result<String, String> {
    match path {
        Some(p) if p.starts_with('/') => Ok(p.to_string()),
        p => {
            let home = block(fs.home())?;
            Ok(match p.map(|p| p.trim_start_matches('~').trim_start_matches('/')) {
                None | Some("") => home,
                Some(rest) => join_remote(&home, rest),
            })
        }
    }
}

fn conflict_arg(args: &Value) -> Result<String, String> {
    let c = arg(args, "conflict").unwrap_or("ask");
    if ["ask", "overwrite", "skip", "rename", "newer"].contains(&c) {
        Ok(c.to_string())
    } else {
        Err(format!("conflict 只能是 ask / overwrite / skip / rename / newer，不是 {c}"))
    }
}

pub fn call(app: &AppHandle, name: &str, pane: &str, args: &Value) -> Result<String, String> {
    match name {
        "list_files" => list_files(app, pane, args),
        "upload_file" => upload(app, pane, args),
        "download_file" => download(app, pane, args),
        _ => Err(format!("未知工具 {name}")),
    }
}

// ---------------------------------------------------------------- list

fn list_files(app: &AppHandle, pane: &str, args: &Value) -> Result<String, String> {
    let fs = fs_of(app, pane)?;
    let path = remote_abs(&fs, arg(args, "path"))?;
    let listing = block(fs.list(&path))?;
    let mut entries = listing.entries;
    entries.sort_by(|a, b| is_dir(b).cmp(&is_dir(a)).then_with(|| a.name.cmp(&b.name)));
    let mut out = format!("{}（{} 项，{}）\n", listing.path, entries.len(), listing.mode);
    for e in entries.iter().take(MAX_ENTRIES) {
        out.push_str(&entry_line(e));
        out.push('\n');
    }
    if entries.len() > MAX_ENTRIES {
        out.push_str(&format!("…… 另有 {} 项未列出\n", entries.len() - MAX_ENTRIES));
    }
    Ok(out)
}

fn is_dir(e: &RemoteEntry) -> bool {
    e.kind == "dir" || e.link_dir
}

fn entry_line(e: &RemoteEntry) -> String {
    let kind = match e.kind.as_str() {
        "dir" => 'd',
        "link" => 'l',
        "file" => '-',
        _ => '?',
    };
    let mode = e.mode.map(|m| format!("{m:04o}")).unwrap_or_else(|| "----".into());
    let size = if is_dir(e) { "-".to_string() } else { human_size(e.size) };
    let name = if is_dir(e) { format!("{}/", e.name) } else { e.name.clone() };
    let link = e.link_target.as_ref().map(|t| format!(" -> {t}")).unwrap_or_default();
    format!("{kind} {mode} {size:>9}  {}  {name}{link}", time_of(e.mtime))
}

fn time_of(secs: Option<u64>) -> String {
    secs.and_then(|s| chrono::Local.timestamp_opt(s as i64, 0).single())
        .map(|t| t.format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_else(|| "????-??-?? ??:??".into())
}

fn human_size(n: u64) -> String {
    const UNITS: [&str; 5] = ["B", "K", "M", "G", "T"];
    let mut v = n as f64;
    let mut u = 0;
    while v >= 1024.0 && u < UNITS.len() - 1 {
        v /= 1024.0;
        u += 1;
    }
    if u == 0 {
        format!("{n}B")
    } else {
        format!("{v:.1}{}", UNITS[u])
    }
}

// ---------------------------------------------------------------- transfers

fn upload(app: &AppHandle, pane: &str, args: &Value) -> Result<String, String> {
    let local = PathBuf::from(arg(args, "local_path").ok_or("缺少参数 local_path")?);
    if !local.is_absolute() {
        return Err("local_path 必须是绝对路径".into());
    }
    let meta = std::fs::metadata(&local).map_err(|e| format!("无法读取 {}：{e}", local.display()))?;
    let name = local
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or("local_path 没有文件名")?;
    let conflict = conflict_arg(args)?;
    let fs = fs_of(app, pane)?;
    let mut remote = remote_abs(&fs, arg(args, "remote_path"))?;
    // An existing folder: put it inside, under its own name.
    if block(fs.stat(&remote)).is_ok_and(|e| is_dir(&e)) {
        remote = join_remote(&remote, &name);
    }
    let req = TransferRequest {
        instance_id: pane.to_string(),
        direction: "upload".into(),
        local_path: local.to_string_lossy().to_string(),
        remote_path: remote,
        is_dir: meta.is_dir(),
        options: TransferOptions { conflict, preserve_times: true, protocol: "auto".into(), cleanup: None },
    };
    start_and_wait(req, wait_arg(args, "timeout_sec", WAIT_DEFAULT))
}

fn download(app: &AppHandle, pane: &str, args: &Value) -> Result<String, String> {
    let fs = fs_of(app, pane)?;
    let remote = remote_abs(&fs, Some(arg(args, "remote_path").ok_or("缺少参数 remote_path")?))?;
    let entry = block(fs.stat(&remote)).map_err(|e| format!("远端路径不可用：{e}"))?;
    let conflict = conflict_arg(args)?;
    let name = split_remote(&remote).1;
    let mut local = match arg(args, "local_path") {
        Some(p) => PathBuf::from(p),
        None => dirs::download_dir().or_else(dirs::home_dir).ok_or("找不到本机的“下载”文件夹，请指定 local_path")?,
    };
    if !local.is_absolute() {
        return Err("local_path 必须是绝对路径".into());
    }
    if local.is_dir() {
        local = local.join(&name);
    } else if let Some(parent) = local.parent().filter(|p| !p.as_os_str().is_empty()) {
        if !parent.is_dir() {
            return Err(format!("本机文件夹 {} 不存在", parent.display()));
        }
    }
    let req = TransferRequest {
        instance_id: pane.to_string(),
        direction: "download".into(),
        local_path: local.to_string_lossy().to_string(),
        remote_path: remote,
        is_dir: is_dir(&entry),
        options: TransferOptions { conflict, preserve_times: true, protocol: "auto".into(), cleanup: None },
    };
    start_and_wait(req, wait_arg(args, "timeout_sec", WAIT_DEFAULT))
}

fn start_and_wait(req: TransferRequest, wait: Duration) -> Result<String, String> {
    let hub = crate::transfer::hub().ok_or("传输队列还没有就绪")?;
    let info = hub.enqueue(vec![req]).into_iter().next().ok_or("无法加入传输队列")?;
    lock(started()).insert(info.id.clone());
    let info = wait_for(&info.id, wait).unwrap_or(info);
    Ok(describe(&info))
}

/// Poll until the transfer ends or `wait` passes; the latest state.
fn wait_for(id: &str, wait: Duration) -> Option<TransferInfo> {
    let hub = crate::transfer::hub()?;
    let deadline = Instant::now() + wait;
    loop {
        let info = hub.get(id)?;
        if is_finished(&info.state) || Instant::now() >= deadline {
            return Some(info);
        }
        std::thread::sleep(POLL);
    }
}

fn is_finished(state: &str) -> bool {
    matches!(state, "done" | "error" | "cancelled")
}

pub fn transfer_status(args: &Value) -> Result<String, String> {
    let id = arg(args, "transfer_id").ok_or("缺少参数 transfer_id")?;
    if !lock(started()).contains(id) {
        return Err(format!("没有 id 为 {id} 的传输（只能查询 upload_file / download_file 启动的传输）"));
    }
    let hub = crate::transfer::hub().ok_or("传输队列还没有就绪")?;
    if args.get("cancel").and_then(Value::as_bool) == Some(true) {
        hub.cancel(id);
    }
    let info = wait_for(id, wait_arg(args, "wait_sec", 0)).ok_or_else(|| format!("传输 {id} 已从列表中移除"))?;
    Ok(describe(&info))
}

/// What the agent reads back about a transfer.
fn describe(i: &TransferInfo) -> String {
    let dir = if i.direction == "upload" { "上传" } else { "下载" };
    let local = i.local_path.as_deref().unwrap_or("");
    let (from, to) = if i.direction == "upload" { (local, i.remote_path.as_str()) } else { (i.remote_path.as_str(), local) };
    let proto = if i.protocol.is_empty() { String::new() } else { format!("，{}", i.protocol.to_uppercase()) };
    let mut out = format!("传输 {}：{dir} {from} → {to}{proto}\n", i.id);
    let progress = if i.files_total > 1 {
        format!("{} / {}，文件 {} / {}", human_size(i.transferred), human_size(i.total), i.files_done, i.files_total)
    } else {
        format!("{} / {}", human_size(i.transferred), human_size(i.total))
    };
    let state = match i.state.as_str() {
        "done" if i.skipped > 0 => format!("完成（{progress}，{} 个文件因目标已存在而跳过）", i.skipped),
        "done" => format!("完成（{progress}）"),
        "error" => format!("失败：{}", i.error.as_deref().unwrap_or("未知错误")),
        "cancelled" => "已取消".into(),
        "conflict" => {
            let what = i.conflict.as_ref().map(|c| c.path.clone()).unwrap_or_default();
            format!("目标已存在（{what}），等待用户在 Nexterm 传输面板中选择覆盖、跳过或改名")
        }
        "paused" => format!("用户已暂停（{progress}）"),
        "queued" => "排队中".into(),
        _ => format!("进行中（{progress}，{}/s）", human_size(i.speed)),
    };
    out.push_str(&format!("状态：{state}"));
    if !is_finished(&i.state) {
        out.push_str(&format!("\n还没有结束，可以用 transfer_status（transfer_id: {}）继续等待或取消。", i.id));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_read_like_ls_h() {
        assert_eq!(human_size(0), "0B");
        assert_eq!(human_size(1023), "1023B");
        assert_eq!(human_size(1536), "1.5K");
        assert_eq!(human_size(5 * 1024 * 1024 * 1024), "5.0G");
    }

    #[test]
    fn tools_have_unique_names_and_schemas() {
        let defs = tool_defs(&json!({ "type": "string" }));
        let names: Vec<&str> = defs.iter().filter_map(|d| d["name"].as_str()).collect();
        assert_eq!(names, TOOL_NAMES);
        for d in &defs {
            assert_eq!(d["inputSchema"]["type"], "object");
        }
    }

    #[test]
    fn conflict_must_be_known() {
        assert_eq!(conflict_arg(&json!({})).unwrap(), "ask");
        assert_eq!(conflict_arg(&json!({ "conflict": "rename" })).unwrap(), "rename");
        assert!(conflict_arg(&json!({ "conflict": "delete" })).is_err());
    }
}
