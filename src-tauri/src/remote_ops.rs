//! Phone remote requests beyond watching tabs: managing saved sessions and the file
//! browser of SSH panes (list, download to the phone, upload from it).
//!
//! A phone sends `{"t":"req","rid":N,"op":"...","a":{...}}` and gets one
//! `{"t":"res","rid":N,"ok":true,"data":...}` (or `"ok":false,"error":"..."`) back.
//! File contents travel as `[P_FILE][transfer id u32 BE][bytes]` frames, both ways;
//! the transfer id is the rid of the request that started it.
//!
//!   download: fs.get -> res {size,name}, file frames..., {"t":"fsEnd","x":N,"ok":true}
//!             the phone acknowledges received bytes ({"t":"fsAck","x":N,"n":bytes}); the
//!             computer keeps at most DOWN_WINDOW unacknowledged so the relay never drops
//!             a slow phone.
//!   upload:   fs.put -> res, phone file frames (each acknowledged with fsAck),
//!             {"t":"fsEnd","x":N} -> {"t":"fsEnd","x":N,"ok":true}

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, watch};

use crate::models::SessionConfig;
use crate::AppContext;

const DOWN_CHUNK: usize = 128 * 1024;
/// Sent and not yet acknowledged by the phone.
const DOWN_WINDOW: u64 = 2 * 1024 * 1024;
/// Protocols a phone can create or edit (the rest are edited on the computer).
const PHONE_PROTOCOLS: &[&str] = &["ssh", "telnet", "tcp", "powershell", "cmd", "wsl"];

enum Xfer {
    /// Bytes the phone acknowledged.
    Down(watch::Sender<u64>),
    Up(mpsc::UnboundedSender<UpMsg>),
}

enum UpMsg {
    Data(Vec<u8>),
    End,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// (phone, transfer id) -> running transfer. Dropping an entry stops its task.
fn transfers() -> &'static Mutex<HashMap<(u32, u32), Xfer>> {
    static T: OnceLock<Mutex<HashMap<(u32, u32), Xfer>>> = OnceLock::new();
    T.get_or_init(Default::default)
}

/// The phone left: stop its transfers.
pub fn forget_phone(phone: u32) {
    lock(transfers()).retain(|(p, _), _| *p != phone);
}

pub fn ack(phone: u32, x: u32, n: u64) {
    if let Some(Xfer::Down(acked)) = lock(transfers()).get(&(phone, x)) {
        acked.send_if_modified(|v| {
            let grew = n > *v;
            *v = (*v).max(n);
            grew
        });
    }
}

pub fn cancel(phone: u32, x: u32) {
    lock(transfers()).remove(&(phone, x));
}

/// Upload chunk from the phone.
pub fn upload_chunk(phone: u32, x: u32, bytes: &[u8]) {
    if let Some(Xfer::Up(tx)) = lock(transfers()).get(&(phone, x)) {
        let _ = tx.send(UpMsg::Data(bytes.to_vec()));
    }
}

pub fn upload_end(phone: u32, x: u32) {
    if let Some(Xfer::Up(tx)) = lock(transfers()).get(&(phone, x)) {
        let _ = tx.send(UpMsg::End);
    }
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Args {
    id: String,
    pane: String,
    path: String,
    to: String,
    name: String,
    session: Value,
}

/// Ops that change something; refused when phones may only watch.
fn writes(op: &str) -> bool {
    matches!(op, "sessions.save" | "sessions.delete" | "sessions.open" | "tabs.close" | "fs.mkdir" | "fs.remove" | "fs.rename" | "fs.put")
}

pub fn request(app: AppHandle, phone: u32, rid: u32, op: String, args: Value, read_only: bool) {
    tauri::async_runtime::spawn(async move {
        let result = if read_only && writes(&op) {
            Err("read-only".to_string())
        } else {
            let args: Args = serde_json::from_value(args).unwrap_or_default();
            run(&app, phone, rid, &op, args).await
        };
        crate::remote::reply(phone, rid, result);
    });
}

async fn run(app: &AppHandle, phone: u32, rid: u32, op: &str, a: Args) -> Result<Value, String> {
    let ctx = app.try_state::<AppContext>().ok_or("app is starting")?;
    match op {
        "sessions.list" => Ok(json!(load_sessions(&ctx)?.iter().map(summary).collect::<Vec<_>>())),
        "sessions.save" => {
            let mut list = load_sessions(&ctx)?;
            let saved = merge_session(list.iter().find(|s| s.id == a.session["id"].as_str().unwrap_or("")), &a.session)?;
            let id = saved.id.clone();
            match list.iter_mut().find(|s| s.id == id) {
                Some(slot) => *slot = saved,
                None => list.push(saved),
            }
            save_sessions(app, &ctx, &list)?;
            Ok(json!({ "id": id }))
        }
        "sessions.delete" => {
            let mut list = load_sessions(&ctx)?;
            let before = list.len();
            list.retain(|s| s.id != a.id);
            if list.len() == before {
                return Err("session not found".into());
            }
            save_sessions(app, &ctx, &list)?;
            Ok(Value::Null)
        }
        "sessions.open" => {
            if !load_sessions(&ctx)?.iter().any(|s| s.id == a.id) {
                return Err("session not found".into());
            }
            // The main window opens it as a new tab; the phone sees it in the next tab list.
            app.emit("remote-open-session", &a.id).map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "tabs.close" => {
            match crate::remote::tab_locked(&a.id) {
                None => return Err("tab not found".into()),
                Some(true) => return Err("locked".into()),
                Some(false) => {}
            }
            // The window holding the pane closes it without asking (the phone asked).
            app.emit("remote-close-pane", &a.id).map_err(|e| e.to_string())?;
            for _ in 0..50 {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                if crate::remote::tab_locked(&a.id).is_none() {
                    return Ok(Value::Null);
                }
            }
            Err("the tab did not close".into())
        }
        "fs.home" => crate::with_sftp(&ctx, &a.pane, |s| async move { s.home().await }).await.map(Value::String),
        "fs.list" => {
            let path = a.path.clone();
            let listing = crate::with_sftp(&ctx, &a.pane, |s| {
                let path = path.clone();
                async move { s.list(&path).await }
            })
            .await?;
            serde_json::to_value(listing).map_err(|e| e.to_string())
        }
        "fs.mkdir" => {
            let path = a.path.clone();
            crate::with_sftp(&ctx, &a.pane, |s| {
                let path = path.clone();
                async move { s.mkdir(&path).await }
            })
            .await
            .map(|_| Value::Null)
        }
        "fs.remove" => {
            let path = a.path.clone();
            crate::with_sftp(&ctx, &a.pane, |s| {
                let path = path.clone();
                async move { s.remove(&path).await }
            })
            .await
            .map(|_| Value::Null)
        }
        "fs.rename" => {
            let (from, to) = (a.path.clone(), a.to.clone());
            crate::with_sftp(&ctx, &a.pane, |s| {
                let (from, to) = (from.clone(), to.clone());
                async move { s.rename(&from, &to).await }
            })
            .await
            .map(|_| Value::Null)
        }
        "fs.get" => start_download(&ctx, phone, rid, &a.pane, &a.path).await,
        "fs.put" => {
            let name = a.name.trim();
            if name.is_empty() || name.contains('/') || name == "." || name == ".." {
                return Err(format!("bad file name: {name}"));
            }
            let target = crate::transfer::join_remote(&a.path, name);
            start_upload(&ctx, phone, rid, &a.pane, target).await
        }
        _ => Err(format!("unknown request {op}")),
    }
}

// ---------------------------------------------------------------------------------------
// Sessions

fn load_sessions(ctx: &AppContext) -> Result<Vec<SessionConfig>, String> {
    let storage = ctx.storage.lock().map_err(|e| e.to_string())?;
    storage.load_sessions().map_err(|e| e.to_string())
}

fn save_sessions(app: &AppHandle, ctx: &AppContext, list: &[SessionConfig]) -> Result<(), String> {
    {
        let storage = ctx.storage.lock().map_err(|e| e.to_string())?;
        storage.save_sessions(list).map_err(|e| e.to_string())?;
    }
    // Every window reloads its session list (same event the windows send each other).
    let _ = app.emit("sessions-changed", ());
    Ok(())
}

/// What a phone sees of a session: no secrets.
fn summary(s: &SessionConfig) -> Value {
    let v = serde_json::to_value(s).unwrap_or_default();
    json!({
        "id": s.id,
        "label": s.label,
        "group": s.group,
        "protocol": v["protocol"],
        "host": s.host,
        "port": s.port,
        "username": s.username,
        "authType": v["authType"],
        "privateKeyPath": s.private_key_path,
        "startupCommand": s.startup_command,
        "hasPassword": s.password.as_deref().is_some_and(|p| !p.is_empty()),
        "editable": PHONE_PROTOCOLS.contains(&v["protocol"].as_str().unwrap_or("")),
    })
}

/// The phone's form on top of the saved session (or a new one). Fields the phone does not
/// edit stay as they are; an empty password keeps the saved one unless `clearPassword`.
fn merge_session(existing: Option<&SessionConfig>, form: &Value) -> Result<SessionConfig, String> {
    let protocol = form["protocol"].as_str().unwrap_or("ssh");
    if !PHONE_PROTOCOLS.contains(&protocol) {
        return Err(format!("protocol {protocol} can only be edited on the computer"));
    }
    let mut v = match existing {
        Some(s) => serde_json::to_value(s).map_err(|e| e.to_string())?,
        None => json!({ "id": new_id(), "keepAliveSecs": 60, "term": "xterm-256color" }),
    };
    let text = |key: &str| form[key].as_str().map(str::trim).unwrap_or("").to_string();
    let opt = |key: &str| {
        let t = text(key);
        if t.is_empty() {
            Value::Null
        } else {
            Value::String(t)
        }
    };
    let host = text("host");
    let remote = matches!(protocol, "ssh" | "telnet" | "tcp");
    if remote && host.is_empty() {
        return Err("host is required".into());
    }
    let username = text("username");
    let default_port = match protocol {
        "ssh" => 22,
        "telnet" => 23,
        _ => 0,
    };
    let port = form["port"].as_u64().filter(|p| (1..=65535).contains(p)).unwrap_or(default_port);
    let mut label = text("label");
    if label.is_empty() {
        label = match protocol {
            "ssh" if !username.is_empty() => format!("{username}@{host}"),
            "ssh" => host.clone(),
            "telnet" => format!("Telnet {host}:{port}"),
            "tcp" => format!("TCP {host}:{port}"),
            other => other.to_uppercase(),
        };
    }
    let auth = match form["authType"].as_str() {
        _ if protocol != "ssh" => "none",
        Some("privatekey") => "privatekey",
        Some("none") => "none",
        _ => "password",
    };
    v["label"] = json!(label);
    v["group"] = json!(text("group"));
    v["protocol"] = json!(protocol);
    v["host"] = json!(host);
    v["port"] = json!(port);
    v["username"] = json!(username);
    v["authType"] = json!(auth);
    v["privateKeyPath"] = opt("privateKeyPath");
    v["startupCommand"] = opt("startupCommand");
    let password = form["password"].as_str().unwrap_or("");
    if !password.is_empty() {
        v["password"] = json!(password);
    } else if form["clearPassword"].as_bool() == Some(true) {
        v["password"] = Value::Null;
    }
    serde_json::from_value(v).map_err(|e| e.to_string())
}

/// UUID v4 text, like the session dialog makes.
fn new_id() -> String {
    let mut b = crate::remote_crypto::random::<16>();
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

// ---------------------------------------------------------------------------------------
// Files

async fn sftp_of(ctx: &AppContext, pane: &str) -> Result<Arc<SftpSession>, String> {
    crate::with_sftp(ctx, pane, |s| async move { s.sftp().map(Arc::clone) }).await
}

async fn start_download(ctx: &AppContext, phone: u32, x: u32, pane: &str, path: &str) -> Result<Value, String> {
    let sftp = sftp_of(ctx, pane).await?;
    let meta = sftp.metadata(path).await.map_err(|e| e.to_string())?;
    if meta.file_type().is_dir() {
        return Err(format!("{path} is a folder"));
    }
    let size = meta.size.unwrap_or(0);
    let file = sftp.open(path).await.map_err(|e| e.to_string())?;
    let (acked_tx, mut acked) = watch::channel(0u64);
    lock(transfers()).insert((phone, x), Xfer::Down(acked_tx));
    tauri::async_runtime::spawn(async move {
        let mut file = file;
        let mut buf = vec![0u8; DOWN_CHUNK];
        let mut sent = 0u64;
        let result: Result<(), String> = async {
            loop {
                // Wait for the phone to catch up; a dropped entry (cancel, phone gone) ends it.
                while sent.saturating_sub(*acked.borrow()) >= DOWN_WINDOW {
                    acked.changed().await.map_err(|_| "cancelled".to_string())?;
                }
                if !lock(transfers()).contains_key(&(phone, x)) {
                    return Err("cancelled".into());
                }
                let n = file.read(&mut buf).await.map_err(|e| e.to_string())?;
                if n == 0 {
                    return Ok(());
                }
                if !crate::remote::send_file(phone, x, &buf[..n]) {
                    return Err("cancelled".into());
                }
                sent += n as u64;
            }
        }
        .await;
        lock(transfers()).remove(&(phone, x));
        if !matches!(&result, Err(e) if e == "cancelled") {
            crate::remote::send_to(phone, &end_msg(x, result));
        }
    });
    let name = crate::transfer::split_remote(path).1;
    Ok(json!({ "x": x, "size": size, "name": name }))
}

async fn start_upload(ctx: &AppContext, phone: u32, x: u32, pane: &str, target: String) -> Result<Value, String> {
    let sftp = sftp_of(ctx, pane).await?;
    let mut file = sftp
        .open_with_flags(target.as_str(), OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE)
        .await
        .map_err(|e| format!("{target}: {e}"))?;
    let (tx, mut rx) = mpsc::unbounded_channel();
    lock(transfers()).insert((phone, x), Xfer::Up(tx));
    tauri::async_runtime::spawn(async move {
        let mut written = 0u64;
        let result: Result<(), String> = async {
            loop {
                match rx.recv().await {
                    // Entry dropped: cancelled, or the phone left.
                    None => return Err("cancelled".to_string()),
                    Some(UpMsg::Data(bytes)) => {
                        file.write_all(&bytes).await.map_err(|e| e.to_string())?;
                        written += bytes.len() as u64;
                        crate::remote::send_to(phone, &json!({ "t": "fsAck", "x": x, "n": written }));
                    }
                    Some(UpMsg::End) => {
                        file.shutdown().await.map_err(|e| e.to_string())?;
                        return Ok(());
                    }
                }
            }
        }
        .await;
        lock(transfers()).remove(&(phone, x));
        if result.is_err() {
            // A half-written file is worse than none.
            drop(file);
            let _ = sftp.remove_file(target.as_str()).await;
        }
        if !matches!(&result, Err(e) if e == "cancelled") {
            crate::remote::send_to(phone, &end_msg(x, result));
        }
    });
    Ok(json!({ "x": x }))
}

fn end_msg(x: u32, result: Result<(), String>) -> Value {
    match result {
        Ok(()) => json!({ "t": "fsEnd", "x": x, "ok": true }),
        Err(e) => json!({ "t": "fsEnd", "x": x, "ok": false, "error": e }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn saved() -> SessionConfig {
        serde_json::from_value(json!({
            "id": "s1", "label": "web", "protocol": "ssh", "host": "10.0.0.1", "port": 2222,
            "username": "root", "password": "pw", "tunnels": [], "tabColor": "#f00"
        }))
        .unwrap()
    }

    #[test]
    fn summary_hides_secrets() {
        let v = summary(&saved());
        assert_eq!(v["hasPassword"], json!(true));
        assert!(v.get("password").is_none());
        assert_eq!(v["editable"], json!(true));
    }

    #[test]
    fn merge_keeps_what_the_phone_does_not_edit() {
        let s = saved();
        let form = json!({ "id": "s1", "label": "web2", "protocol": "ssh", "host": "10.0.0.2", "port": 22, "username": "u", "password": "" });
        let m = merge_session(Some(&s), &form).unwrap();
        assert_eq!(m.label, "web2");
        assert_eq!(m.host, "10.0.0.2");
        assert_eq!(m.password.as_deref(), Some("pw"));
        assert_eq!(m.extra.get("tabColor"), Some(&json!("#f00")));
        let cleared = merge_session(Some(&s), &json!({ "protocol": "ssh", "host": "h", "clearPassword": true })).unwrap();
        assert_eq!(cleared.password, None);
    }

    #[test]
    fn new_sessions_get_defaults() {
        let m = merge_session(None, &json!({ "protocol": "ssh", "host": "box", "username": "me" })).unwrap();
        assert_eq!(m.label, "me@box");
        assert_eq!(m.port, 22);
        assert_eq!(m.term, "xterm-256color");
        assert_eq!(m.id.len(), 36);
        assert!(merge_session(None, &json!({ "protocol": "ssh" })).is_err());
        assert!(merge_session(None, &json!({ "protocol": "serial", "host": "COM1" })).is_err());
        let local = merge_session(None, &json!({ "protocol": "powershell" })).unwrap();
        assert_eq!(local.label, "POWERSHELL");
    }
}
