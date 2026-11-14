//! AI agent status (Claude Code, Codex ...) reported by their lifecycle hooks.
//!
//! Remote shells: the hook script writes OSC 7501 (Herdr's format) to the pane's tty and
//! the terminal parses it. Local shells (ConPTY drops unknown OSC sequences): the hook
//! calls a small HTTP endpoint on 127.0.0.1 whose address and the pane id are passed in
//! the environment (NEXTERM_AGENT_URL, NEXTERM_PANE_ID).

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

static ENDPOINT: OnceLock<String> = OnceLock::new();

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatePayload {
    pub pane_id: String,
    pub state: String,
    pub kind: String,
    pub app: String,
}

/// `http://127.0.0.1:<port>/agent?token=<random>` once the listener runs.
pub fn endpoint() -> Option<&'static str> {
    ENDPOINT.get().map(String::as_str)
}

fn random_token() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut out = String::new();
    for i in 0..2u64 {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(i ^ std::process::id() as u64);
        h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

fn decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => {
                if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                    out.push(v);
                    i += 2;
                } else {
                    out.push(b'%');
                }
            }
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Parse `GET /agent?token=..&pane=..&state=..` into a payload when the token matches.
fn parse_request(line: &str, token: &str) -> Option<AgentStatePayload> {
    let target = line.strip_prefix("GET ")?.split_whitespace().next()?;
    let query = target.strip_prefix("/agent?")?;
    let (mut tok, mut pane, mut state, mut kind, mut app) = (None, None, None, String::new(), String::new());
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let v = decode(v);
        match k {
            "token" => tok = Some(v),
            "pane" => pane = Some(v),
            "state" => state = Some(v),
            "kind" => kind = v,
            "app" => app = v,
            _ => {}
        }
    }
    if tok.as_deref() != Some(token) {
        return None;
    }
    let pane = pane.filter(|p| !p.is_empty() && p.len() < 128)?;
    let state = state.filter(|s| !s.is_empty() && s.len() < 32)?;
    Some(AgentStatePayload { pane_id: pane, state, kind, app })
}

pub fn start(app: AppHandle) {
    let listener = match TcpListener::bind("127.0.0.1:0") {
        Ok(l) => l,
        Err(_) => return,
    };
    let port = match listener.local_addr() {
        Ok(a) => a.port(),
        Err(_) => return,
    };
    let token = random_token();
    let _ = ENDPOINT.set(format!("http://127.0.0.1:{port}/agent?token={token}"));
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(2)));
            let mut reader = BufReader::new(&stream);
            let mut line = String::new();
            if reader.by_ref().take(4096).read_line(&mut line).is_err() {
                continue;
            }
            let ok = match parse_request(line.trim_end(), &token) {
                Some(payload) => {
                    let _ = app.emit("agent-state", payload);
                    true
                }
                None => false,
            };
            let status = if ok { "204 No Content" } else { "403 Forbidden" };
            let _ = (&stream).write_all(format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes());
        }
    });
}

use std::io::Read as _;

// ---------------------------------------------------------------- local hook files

fn home() -> Option<PathBuf> {
    dirs::home_dir()
}

fn claude_dir() -> Option<PathBuf> {
    std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from).or_else(|| home().map(|h| h.join(".claude")))
}

fn codex_dir() -> Option<PathBuf> {
    std::env::var_os("CODEX_HOME").map(PathBuf::from).or_else(|| home().map(|h| h.join(".codex")))
}

fn script_path() -> Option<PathBuf> {
    home().map(|h| h.join(".nexterm").join("agent-state.sh"))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalHookFiles {
    pub claude_dir: bool,
    pub codex_dir: bool,
    pub claude_settings: Option<String>,
    pub codex_hooks: Option<String>,
    pub script_installed: bool,
    /// Installed script, to tell an outdated install.
    pub script: Option<String>,
}

pub fn read_local() -> LocalHookFiles {
    let cd = claude_dir();
    let xd = codex_dir();
    LocalHookFiles {
        claude_dir: cd.as_ref().map(|d| d.is_dir()).unwrap_or(false),
        codex_dir: xd.as_ref().map(|d| d.is_dir()).unwrap_or(false),
        claude_settings: cd.and_then(|d| std::fs::read_to_string(d.join("settings.json")).ok()),
        codex_hooks: xd.and_then(|d| std::fs::read_to_string(d.join("hooks.json")).ok()),
        script_installed: script_path().map(|p| p.is_file()).unwrap_or(false),
        script: script_path().and_then(|p| std::fs::read_to_string(p).ok()),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalHookWrite {
    /// None: remove the script.
    pub script: Option<String>,
    pub claude_settings: Option<String>,
    pub codex_hooks: Option<String>,
}

fn write_with_backup(path: PathBuf, content: &str) -> Result<(), String> {
    if path.is_file() {
        let bak = path.with_extension("json.nexterm-bak");
        if !bak.exists() {
            std::fs::copy(&path, &bak).map_err(|e| format!("{}: {e}", path.display()))?;
        }
    }
    std::fs::write(&path, content).map_err(|e| format!("{}: {e}", path.display()))
}

pub fn write_local(w: LocalHookWrite) -> Result<(), String> {
    let script = script_path().ok_or("找不到用户目录")?;
    match &w.script {
        Some(body) => {
            if let Some(dir) = script.parent() {
                std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            }
            std::fs::write(&script, body).map_err(|e| e.to_string())?;
        }
        None => {
            let _ = std::fs::remove_file(&script);
        }
    }
    if let (Some(content), Some(dir)) = (&w.claude_settings, claude_dir()) {
        write_with_backup(dir.join("settings.json"), content)?;
    }
    if let (Some(content), Some(dir)) = (&w.codex_hooks, codex_dir()) {
        write_with_backup(dir.join("hooks.json"), content)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_hook_requests() {
        let p = parse_request("GET /agent?token=abc&pane=pane-1&state=blocked&kind=permission&app=claude HTTP/1.1", "abc").unwrap();
        assert_eq!(p.pane_id, "pane-1");
        assert_eq!(p.state, "blocked");
        assert_eq!(p.kind, "permission");
        assert_eq!(p.app, "claude");
        assert!(parse_request("GET /agent?token=bad&pane=p&state=idle HTTP/1.1", "abc").is_none());
        assert!(parse_request("GET /agent?token=abc&state=idle HTTP/1.1", "abc").is_none());
        assert_eq!(decode("a%20b+c"), "a b c");
    }
}
