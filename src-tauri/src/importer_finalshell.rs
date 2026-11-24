//! FinalShell connections: the `conn` folder of its data folder (Windows: next to the
//! program, by default `%LOCALAPPDATA%\finalshell\conn`; macOS: `~/Library/FinalShell/conn`).
//! Every connection is a `<id>_connect_config.json`, every folder a `folder.json` (sub
//! folders on disk do not have to match the tree: `parent_id` does). Deleted entries keep
//! their file with a non-zero `delete_time`.
//!
//! `conection_type` (sic) 100 is SSH; others (RDP, ...) are skipped. Saved passwords are
//! encrypted by FinalShell and not imported.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use anyhow::{Context, Result};
use serde_json::Value;
use uuid::Uuid;

use crate::importer::read_limited;
use crate::models::{AuthType, ProtocolType, SessionConfig};

pub const FINALSHELL_GROUP: &str = "FinalShell";

const JSON_MAX: u64 = 1024 * 1024;
const MAX_ENTRIES: usize = 10_000;
const MAX_DEPTH: usize = 16;
const SSH: i64 = 100;

#[derive(Debug, Default, Clone)]
pub struct FinalShellImport {
    pub sessions: Vec<SessionConfig>,
    /// Connections that are not SSH or have no host.
    pub skipped: usize,
    pub passwords_skipped: usize,
    /// Connections using a key from FinalShell's key manager (not a file).
    pub keys_missing: usize,
}

/// `conn` folders of an installed FinalShell.
pub fn conn_dirs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(d) = dirs::data_local_dir() {
        out.push(d.join("finalshell").join("conn"));
    }
    if let Some(h) = dirs::home_dir() {
        out.push(h.join("Library").join("FinalShell").join("conn"));
    }
    out.retain(|p| p.is_dir());
    out.dedup();
    out
}

/// Connection files below a conn folder (discovery), without parsing them.
pub fn count_connections(dir: &Path) -> usize {
    let mut files = Files::default();
    let _ = collect(dir, 0, &mut files);
    files.connections.len()
}

#[derive(Default)]
struct Files {
    folders: Vec<PathBuf>,
    connections: Vec<PathBuf>,
}

fn collect(dir: &Path, depth: usize, out: &mut Files) -> Result<()> {
    if depth > MAX_DEPTH {
        return Ok(());
    }
    let entries = fs::read_dir(dir).with_context(|| format!("无法读取目录: {}", dir.display()))?;
    for entry in entries.flatten() {
        let p = entry.path();
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            collect(&p, depth + 1, out)?;
            continue;
        }
        let name = p.file_name().map(|n| n.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
        if out.folders.len() + out.connections.len() >= MAX_ENTRIES {
            anyhow::bail!("文件超过 {} 个", MAX_ENTRIES);
        }
        if name == "folder.json" {
            out.folders.push(p);
        } else if name.ends_with("_connect_config.json") {
            out.connections.push(p);
        }
    }
    Ok(())
}

fn read_json(path: &Path) -> Option<Value> {
    let raw = read_limited(path, JSON_MAX).ok()?;
    let text = crate::importer::decode_text(&raw);
    serde_json::from_str(&text).ok()
}

/// Import a conn folder or a single `*_connect_config.json`.
pub fn import_path(path: &Path) -> Result<FinalShellImport> {
    let mut files = Files::default();
    if path.is_dir() {
        collect(path, 0, &mut files)?;
        files.connections.sort();
        if files.connections.is_empty() {
            anyhow::bail!("没有找到 FinalShell 连接（文件夹中没有 *_connect_config.json）");
        }
    } else {
        files.connections.push(path.to_path_buf());
    }
    let folders: Vec<Value> = files.folders.iter().filter_map(|p| read_json(p)).collect();
    let mut connections = Vec::new();
    let mut unreadable = 0;
    for p in &files.connections {
        match read_json(p) {
            Some(v) => connections.push(v),
            None => unreadable += 1,
        }
    }
    if connections.is_empty() {
        anyhow::bail!("不是有效的 FinalShell 连接文件");
    }
    let mut out = parse(&folders, &connections);
    out.skipped += unreadable;
    Ok(out)
}

fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

/// Numbers are sometimes written as strings.
fn int_of(v: &Value, key: &str) -> Option<i64> {
    match v.get(key)? {
        Value::Number(n) => n.as_i64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn deleted(v: &Value) -> bool {
    int_of(v, "delete_time").is_some_and(|t| t != 0)
}

pub fn parse(folders: &[Value], connections: &[Value]) -> FinalShellImport {
    // id -> (name, parent id)
    let tree: HashMap<&str, (&str, Option<&str>)> = folders
        .iter()
        .filter(|f| !deleted(f))
        .filter_map(|f| Some((str_of(f, "id")?, (str_of(f, "name").unwrap_or(""), str_of(f, "parent_id")))))
        .collect();
    let mut out = FinalShellImport::default();
    for c in connections {
        if deleted(c) {
            continue;
        }
        match session_from(c, &tree) {
            Some((s, had_password, key_missing)) => {
                out.passwords_skipped += had_password as usize;
                out.keys_missing += key_missing as usize;
                out.sessions.push(s);
            }
            None => out.skipped += 1,
        }
    }
    out
}

fn is_root(id: &str) -> bool {
    id.is_empty() || id == "root" || id == "0"
}

fn group_of(parent: Option<&str>, tree: &HashMap<&str, (&str, Option<&str>)>) -> String {
    let mut names = Vec::new();
    let mut current = parent;
    // Bounded by the folder count, so a cycle cannot loop forever.
    for _ in 0..=tree.len() {
        let Some(id) = current.filter(|id| !is_root(id)) else { break };
        let Some((name, up)) = tree.get(id) else { break };
        if !name.is_empty() {
            names.push(*name);
        }
        current = *up;
    }
    names.reverse();
    std::iter::once(FINALSHELL_GROUP).chain(names).collect::<Vec<_>>().join(">")
}

fn session_from(c: &Value, tree: &HashMap<&str, (&str, Option<&str>)>) -> Option<(SessionConfig, bool, bool)> {
    if int_of(c, "conection_type").or_else(|| int_of(c, "connection_type")) != Some(SSH) {
        return None;
    }
    let host = str_of(c, "host")?.to_string();
    let port = int_of(c, "port").and_then(|p| u16::try_from(p).ok()).filter(|p| *p > 0).unwrap_or(22);
    // authentication_type: 1 password, 2 public key (a key from FinalShell's key manager).
    let key = int_of(c, "authentication_type") == Some(2);
    let mut s = SessionConfig {
        id: Uuid::new_v4().to_string(),
        label: str_of(c, "name").unwrap_or(&host).to_string(),
        group: group_of(str_of(c, "parent_id"), tree),
        protocol: ProtocolType::Ssh,
        host,
        port,
        username: str_of(c, "user_name").unwrap_or("").to_string(),
        auth_type: if key { AuthType::PrivateKey } else { AuthType::Password },
        term: "xterm-256color".into(),
        keep_alive_secs: 60,
        ..Default::default()
    };
    if let Some(desc) = str_of(c, "description") {
        s.extra.insert("description".into(), Value::String(desc.to_string()));
    }
    let had_password = !key && str_of(c, "password").is_some();
    Some((s, had_password, key))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_parse_tree_and_types() {
        let folders = vec![
            json!({"id": "f1", "name": "生产", "parent_id": "root", "delete_time": 0}),
            json!({"id": "f2", "name": "Web", "parent_id": "f1"}),
            json!({"id": "f3", "name": "Gone", "parent_id": "root", "delete_time": 1700000000}),
            // A cycle must not hang.
            json!({"id": "c1", "name": "A", "parent_id": "c2"}),
            json!({"id": "c2", "name": "B", "parent_id": "c1"}),
        ];
        let connections = vec![
            json!({"name": "web-01", "host": "10.0.0.5", "port": 2222, "user_name": "deploy", "password": "enc==",
                   "parent_id": "f2", "conection_type": 100, "authentication_type": 1, "description": "前端"}),
            json!({"name": "", "host": "db.example.com", "port": "22", "user_name": "root", "parent_id": "root",
                   "conection_type": 100, "authentication_type": 2, "secret_key_id": "k1"}),
            json!({"name": "rdp", "host": "win.example.com", "conection_type": 101}),
            json!({"name": "deleted", "host": "x", "conection_type": 100, "delete_time": 5}),
            json!({"name": "no host", "host": " ", "conection_type": 100}),
            json!({"name": "in deleted folder", "host": "h", "conection_type": 100, "parent_id": "f3"}),
            json!({"name": "cycle", "host": "c", "conection_type": 100, "parent_id": "c1"}),
        ];
        let r = parse(&folders, &connections);
        assert_eq!(r.skipped, 2, "RDP and the one without a host");
        assert_eq!((r.passwords_skipped, r.keys_missing), (1, 1));
        assert_eq!(r.sessions.len(), 4);

        let web = &r.sessions[0];
        assert_eq!((web.label.as_str(), web.host.as_str(), web.port, web.username.as_str()), ("web-01", "10.0.0.5", 2222, "deploy"));
        assert_eq!(web.group, "FinalShell>生产>Web");
        assert_eq!(web.auth_type, AuthType::Password);
        assert_eq!(web.extra.get("description"), Some(&json!("前端")));

        let db = &r.sessions[1];
        assert_eq!((db.label.as_str(), db.port, db.group.as_str()), ("db.example.com", 22, "FinalShell"));
        assert_eq!(db.auth_type, AuthType::PrivateKey);

        assert_eq!(r.sessions[2].group, "FinalShell", "a deleted folder falls back to the root");
        assert!(r.sessions[3].group.starts_with("FinalShell>"));
    }

    #[test]
    fn test_import_conn_folder() {
        let root = std::env::temp_dir().join(format!("nexterm-finalshell-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("folder.json"), r#"{"id":"f1","name":"Lab","parent_id":"root"}"#).unwrap();
        fs::write(root.join("sub").join("abc_connect_config.json"),
            r#"{"name":"lab","host":"lab.local","port":22,"user_name":"pi","parent_id":"f1","conection_type":100}"#).unwrap();
        fs::write(root.join("broken_connect_config.json"), "{").unwrap();
        assert_eq!(count_connections(&root), 2);
        let r = import_path(&root).unwrap();
        let empty = root.join("sub");
        fs::remove_file(empty.join("abc_connect_config.json")).unwrap();
        let err = import_path(&empty).is_err();
        let _ = fs::remove_dir_all(&root);
        assert_eq!((r.sessions.len(), r.skipped), (1, 1));
        assert_eq!(r.sessions[0].group, "FinalShell>Lab");
        assert!(err);
    }
}
