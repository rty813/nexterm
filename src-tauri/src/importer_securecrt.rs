//! SecureCRT sessions, from either of:
//!
//! - the Sessions folder of its config folder (`%APPDATA%\VanDyke\Config\Sessions\`): one
//!   `.ini` per session, sub folders are groups. Lines are `S:"Name"=text` (string),
//!   `D:"Name"=0000001a` (dword, hex), plus multi-line `Z:` / `B:` values whose continuation
//!   lines start with a space. `__FolderData__.ini` and the root `Default.ini` are not
//!   sessions.
//! - the XML written by "Tools > Export Settings": nested `<key name="...">` elements below
//!   `<key name="Sessions">`, values as `<string name="...">` / `<dword name="...">` (decimal).
//!
//! Saved passwords are encrypted by SecureCRT and not imported.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use anyhow::{Context, Result};
use uuid::Uuid;

use crate::importer::{decode_text, read_limited, IMPORT_FILE_MAX};
use crate::models::{AuthType, ProtocolType, SerialConfig, SessionConfig};

pub const SECURECRT_GROUP: &str = "SecureCRT";

const INI_MAX: u64 = 1024 * 1024;
const MAX_ENTRIES: usize = 10_000;
const MAX_DEPTH: usize = 16;

#[derive(Debug, Default, Clone)]
pub struct SecureCrtImport {
    pub sessions: Vec<SessionConfig>,
    /// Sessions of a protocol Nexterm cannot open (SSH1, RLogin, TAPI, ...) or without a host.
    pub skipped: usize,
    pub passwords_skipped: usize,
    pub keys_missing: usize,
}

/// `...\VanDyke\Config\Sessions` of an installed SecureCRT, when it has sessions.
pub fn sessions_dirs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(d) = dirs::config_dir() {
        out.push(d.join("VanDyke").join("Config").join("Sessions"));
    }
    out.retain(|p| p.is_dir());
    out
}

/// Session files below a Sessions folder (discovery), without parsing them.
pub fn count_sessions(dir: &Path) -> usize {
    let mut files = Vec::new();
    let _ = collect_ini(dir, dir, 0, &mut files);
    files.len()
}

/// Import a Sessions folder, a single session `.ini` or an exported `.xml`.
pub fn import_path(path: &Path) -> Result<SecureCrtImport> {
    let mut out = SecureCrtImport::default();
    if path.is_dir() {
        let config_dir = config_dir_of(path);
        let mut files = Vec::new();
        collect_ini(path, path, 0, &mut files)?;
        files.sort();
        for (rel, file) in files {
            let raw = read_limited(&file, INI_MAX)?;
            let fields = parse_session_ini(&decode_text(&raw));
            let (groups, label) = split_rel(&rel);
            add(&mut out, &fields, &groups, &label, config_dir.as_deref());
        }
        return Ok(out);
    }
    let raw = read_limited(path, IMPORT_FILE_MAX)?;
    let text = decode_text(&raw);
    if text.trim_start().starts_with('<') {
        return parse_xml_export(&text);
    }
    let name = path.file_stem().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let config_dir = path.parent().and_then(config_dir_of);
    add(&mut out, &parse_session_ini(&text), &[], &name, config_dir.as_deref());
    Ok(out)
}

/// The config folder (parent of `Sessions`) for `${VDS_CONFIG_PATH}` in key paths.
fn config_dir_of(dir: &Path) -> Option<PathBuf> {
    dir.ancestors()
        .find(|a| a.file_name().is_some_and(|n| n.eq_ignore_ascii_case("Sessions")))
        .and_then(|s| s.parent())
        .map(Path::to_path_buf)
}

/// `(relative path with "/" separators, absolute path)` of every session `.ini` below `dir`.
fn collect_ini(root: &Path, dir: &Path, depth: usize, out: &mut Vec<(String, PathBuf)>) -> Result<()> {
    if depth > MAX_DEPTH {
        return Ok(());
    }
    let entries = fs::read_dir(dir).with_context(|| format!("无法读取目录: {}", dir.display()))?;
    for entry in entries.flatten() {
        let p = entry.path();
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            collect_ini(root, &p, depth + 1, out)?;
            continue;
        }
        if !p.extension().is_some_and(|e| e.eq_ignore_ascii_case("ini")) {
            continue;
        }
        let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        if name.eq_ignore_ascii_case("__FolderData__.ini") || (depth == 0 && name.eq_ignore_ascii_case("Default.ini")) {
            continue;
        }
        if out.len() >= MAX_ENTRIES {
            anyhow::bail!("会话文件超过 {} 个", MAX_ENTRIES);
        }
        let rel = p.strip_prefix(root).unwrap_or(&p);
        let rel = rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
        out.push((rel, p));
    }
    Ok(())
}

/// Folders and session name of `Prod/Web/app.ini`.
fn split_rel(rel: &str) -> (Vec<String>, String) {
    let mut parts: Vec<String> = rel.split('/').filter(|p| !p.is_empty()).map(str::to_string).collect();
    let file = parts.pop().unwrap_or_default();
    let label = file.strip_suffix(".ini").or_else(|| file.strip_suffix(".INI")).unwrap_or(&file).to_string();
    (parts, label)
}

/// Values of one session `.ini`, keyed by name (`"Hostname"`, `"[SSH2] Port"`). Dwords are
/// converted from hex to decimal text so both formats read the same.
pub fn parse_session_ini(text: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for line in text.lines() {
        // Continuation lines of Z: / B: values start with a space.
        if line.starts_with(' ') || line.starts_with('\t') {
            continue;
        }
        let line = line.trim().trim_start_matches('\u{feff}');
        let Some((kind, rest)) = line.split_once(':') else { continue };
        let Some(rest) = rest.strip_prefix('"') else { continue };
        let Some((name, value)) = rest.split_once("\"=") else { continue };
        let value = match kind {
            "S" => value.to_string(),
            "D" => match u32::from_str_radix(value.trim(), 16) {
                Ok(n) => n.to_string(),
                Err(_) => continue,
            },
            _ => continue,
        };
        out.insert(name.to_string(), value);
    }
    out
}

fn add(out: &mut SecureCrtImport, fields: &HashMap<String, String>, groups: &[String], label: &str, config_dir: Option<&Path>) {
    match session_from_fields(fields, groups, label, config_dir) {
        Some(p) => {
            out.passwords_skipped += p.had_password as usize;
            out.keys_missing += p.key_missing as usize;
            out.sessions.push(p.session);
        }
        None => out.skipped += 1,
    }
}

pub struct ParsedSession {
    pub session: SessionConfig,
    pub had_password: bool,
    pub key_missing: bool,
}

fn group_path(groups: &[String]) -> String {
    std::iter::once(SECURECRT_GROUP)
        .chain(groups.iter().map(|g| g.trim()).filter(|g| !g.is_empty()))
        .collect::<Vec<_>>()
        .join(">")
}

/// One session. None when the protocol has no Nexterm equivalent or the target is missing.
pub fn session_from_fields(
    fields: &HashMap<String, String>,
    groups: &[String],
    label: &str,
    config_dir: Option<&Path>,
) -> Option<ParsedSession> {
    let get = |k: &str| fields.get(k).map(|v| v.trim()).filter(|v| !v.is_empty());
    let num = |k: &str| get(k).and_then(|v| v.parse::<u32>().ok());
    let protocol = get("Protocol Name").unwrap_or("SSH2").to_ascii_uppercase();
    let host = get("Hostname").unwrap_or("").to_string();
    let mut s = SessionConfig {
        id: Uuid::new_v4().to_string(),
        label: if label.trim().is_empty() { host.clone() } else { label.trim().to_string() },
        group: group_path(groups),
        username: get("Username").unwrap_or("").to_string(),
        term: "xterm-256color".into(),
        keep_alive_secs: 60,
        ..Default::default()
    };
    let port = |key: &str, default: u16| {
        num(key).and_then(|p| u16::try_from(p).ok()).filter(|p| *p > 0).unwrap_or(default)
    };
    let mut had_password = false;
    let mut key_missing = false;
    match protocol.as_str() {
        "SSH2" => {
            if host.is_empty() {
                return None;
            }
            s.protocol = ProtocolType::Ssh;
            s.host = host;
            s.port = port("[SSH2] Port", 22);
            had_password = get("Password V2").or_else(|| get("Password")).is_some();
            // "Identity Filename V2" is `<path>::rawkey` / `<path>::openssh...`; an empty one
            // with "Use Global Public Key" means the global key, which is not imported.
            let key = get("Identity Filename V2").or_else(|| get("Identity Filename")).and_then(|k| resolve_key(k, config_dir));
            let wants_key = key.is_some()
                || get("Identity Filename V2").is_some()
                || get("Identity Filename").is_some()
                || auth_prefers_key(get("SSH2 Authentications V2"));
            if let Some(path) = key {
                s.auth_type = AuthType::PrivateKey;
                s.private_key_path = Some(path);
            } else if wants_key {
                s.auth_type = AuthType::PrivateKey;
                key_missing = true;
            } else {
                s.auth_type = AuthType::Password;
            }
        }
        "TELNET" | "RAW" => {
            if host.is_empty() {
                return None;
            }
            let telnet = protocol == "TELNET";
            s.protocol = if telnet { ProtocolType::Telnet } else { ProtocolType::Tcp };
            s.host = host;
            s.port = port("Port", 23);
            s.auth_type = AuthType::None;
        }
        "SERIAL" => {
            let com = get("Com Port")?;
            s.protocol = ProtocolType::Serial;
            s.host = com.to_string();
            s.port = 0;
            s.username.clear();
            s.auth_type = AuthType::None;
            let mut serial = SerialConfig::default();
            if let Some(b) = num("Baud Rate").filter(|b| *b >= 50) {
                serial.baud_rate = b;
            }
            if let Some(d) = num("Data Bits").and_then(|d| u8::try_from(d).ok()).filter(|d| (5..=8).contains(d)) {
                serial.data_bits = d;
            }
            // SecureCRT's list indexes: parity None / Odd / Even / Mark / Space, stop bits 1 / 1.5 / 2.
            serial.parity = match num("Parity") {
                Some(1) => "odd".into(),
                Some(2) => "even".into(),
                _ => "none".into(),
            };
            serial.stop_bits = if num("Stop Bits") == Some(2) { 2 } else { 1 };
            serial.flow_control = if num("CTS Flow") == Some(1) || num("RTS Flow") == Some(1) {
                "hardware".into()
            } else if num("XON Flow") == Some(1) {
                "software".into()
            } else {
                "none".into()
            };
            s.serial = Some(serial);
        }
        _ => return None,
    }
    Some(ParsedSession { session: s, had_password, key_missing })
}

/// "SSH2 Authentications V2" lists methods in preference order, e.g. `publickey,password`.
fn auth_prefers_key(methods: Option<&str>) -> bool {
    methods
        .and_then(|m| m.split(',').map(str::trim).find(|m| !m.is_empty()))
        .is_some_and(|first| first.eq_ignore_ascii_case("publickey"))
}

/// A key file path with SecureCRT's suffix removed and `${VDS_CONFIG_PATH}` (and the user
/// data path, the same folder by default) expanded. None when unresolvable or missing.
fn resolve_key(raw: &str, config_dir: Option<&Path>) -> Option<String> {
    let path = raw.split("::").next().unwrap_or("").trim();
    if path.is_empty() {
        return None;
    }
    let mut path = path.to_string();
    for var in ["${VDS_CONFIG_PATH}", "${VDS_USER_DATA_PATH}"] {
        if path.contains(var) {
            let dir = config_dir?;
            path = path.replace(var, &dir.to_string_lossy());
        }
    }
    if path.contains("${") {
        return None;
    }
    let path = crate::importer::expand_tilde(&path);
    Path::new(&path).is_file().then_some(path)
}

// ------------------------------------------------------------------ XML export

/// Sessions of an exported settings XML.
pub fn parse_xml_export(text: &str) -> Result<SecureCrtImport> {
    let mut stack: Vec<(String, HashMap<String, String>)> = Vec::new();
    let mut value: Option<(String, String)> = None;
    let mut found_sessions = false;
    let mut out = SecureCrtImport::default();

    for token in XmlTokens::new(text) {
        match token? {
            XmlToken::Open { tag, name, empty } => match tag.as_str() {
                "key" if !empty => {
                    found_sessions |= stack.len() <= 1 && name.as_deref() == Some("Sessions");
                    stack.push((name.unwrap_or_default(), HashMap::new()));
                }
                "string" | "dword" if !empty => value = name.map(|n| (n, String::new())),
                "string" | "dword" => {
                    if let (Some(n), Some(frame)) = (name, stack.last_mut()) {
                        frame.1.insert(n, String::new());
                    }
                }
                _ => {}
            },
            XmlToken::Text(t) => {
                if let Some((_, v)) = value.as_mut() {
                    v.push_str(&t);
                }
            }
            XmlToken::Close(tag) => match tag.as_str() {
                "string" | "dword" => {
                    if let (Some((n, v)), Some(frame)) = (value.take(), stack.last_mut()) {
                        frame.1.insert(n, v.trim().to_string());
                    }
                }
                "key" => {
                    let Some((name, fields)) = stack.pop() else { continue };
                    // A session is a key with values somewhere below `Sessions`.
                    let Some(at) = stack.iter().position(|(n, _)| n == "Sessions") else { continue };
                    if fields.is_empty() || !(fields.contains_key("Protocol Name") || fields.contains_key("Hostname")) {
                        continue;
                    }
                    let groups: Vec<String> = stack[at + 1..].iter().map(|(n, _)| n.clone()).collect();
                    add(&mut out, &fields, &groups, &name, None);
                }
                _ => {}
            },
        }
    }
    if !found_sessions {
        anyhow::bail!("没有找到 SecureCRT 会话（XML 中没有 Sessions 节点）");
    }
    Ok(out)
}

enum XmlToken {
    Open { tag: String, name: Option<String>, empty: bool },
    Close(String),
    Text(String),
}

/// Just enough XML for SecureCRT's export: elements with a `name` attribute, text, CDATA,
/// entities; comments, declarations and processing instructions are skipped.
struct XmlTokens<'a> {
    rest: &'a str,
}

impl<'a> XmlTokens<'a> {
    fn new(text: &'a str) -> Self {
        Self { rest: text.trim_start_matches('\u{feff}') }
    }
}

impl Iterator for XmlTokens<'_> {
    type Item = Result<XmlToken>;

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            if self.rest.is_empty() {
                return None;
            }
            if !self.rest.starts_with('<') {
                let end = self.rest.find('<').unwrap_or(self.rest.len());
                let text = unescape(&self.rest[..end]);
                self.rest = &self.rest[end..];
                return Some(Ok(XmlToken::Text(text)));
            }
            let skip = |s: &mut &str, close: &str| -> Option<String> {
                let end = s.find(close)?;
                let inner = s[..end].to_string();
                *s = &s[end + close.len()..];
                Some(inner)
            };
            if let Some(r) = self.rest.strip_prefix("<![CDATA[") {
                self.rest = r;
                return Some(skip(&mut self.rest, "]]>").map(XmlToken::Text).ok_or_else(|| anyhow::anyhow!("SecureCRT XML 格式不正确")));
            }
            if let Some(r) = self.rest.strip_prefix("<!--") {
                self.rest = r;
                if skip(&mut self.rest, "-->").is_none() {
                    return Some(Err(anyhow::anyhow!("SecureCRT XML 格式不正确")));
                }
                continue;
            }
            let Some(end) = self.rest.find('>') else {
                return Some(Err(anyhow::anyhow!("SecureCRT XML 格式不正确")));
            };
            let inner = &self.rest[1..end];
            self.rest = &self.rest[end + 1..];
            if inner.starts_with('?') || inner.starts_with('!') {
                continue;
            }
            if let Some(tag) = inner.strip_prefix('/') {
                return Some(Ok(XmlToken::Close(tag.trim().to_string())));
            }
            let empty = inner.ends_with('/');
            let inner = inner.trim_end_matches('/');
            let tag_end = inner.find(|c: char| c.is_whitespace()).unwrap_or(inner.len());
            let tag = inner[..tag_end].to_string();
            let name = attr(&inner[tag_end..], "name");
            return Some(Ok(XmlToken::Open { tag, name, empty }));
        }
    }
}

/// Value of attribute `key` in ` a="1" name='x'`.
fn attr(attrs: &str, key: &str) -> Option<String> {
    let mut rest = attrs;
    while let Some(eq) = rest.find('=') {
        let k = rest[..eq].trim();
        let after = rest[eq + 1..].trim_start();
        let quote = after.chars().next().filter(|c| *c == '"' || *c == '\'')?;
        let body = &after[1..];
        let close = body.find(quote)?;
        if k == key {
            return Some(unescape(&body[..close]));
        }
        rest = &body[close + 1..];
    }
    None
}

fn unescape(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let Some(semi) = rest.find(';').filter(|n| *n <= 10) else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let entity = &rest[1..semi];
        let ch = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            e => e
                .strip_prefix("#x")
                .or_else(|| e.strip_prefix("#X"))
                .and_then(|h| u32::from_str_radix(h, 16).ok())
                .or_else(|| e.strip_prefix('#').and_then(|d| d.parse().ok()))
                .and_then(char::from_u32),
        };
        match ch {
            Some(c) => {
                out.push(c);
                rest = &rest[semi + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<VanDyke version="3.0">
  <key name="Sessions">
    <key name="Default">
      <string name="Protocol Name">SSH2</string>
    </key>
    <key name="Prod &amp; Ops">
      <key name="web-01">
        <dword name="[SSH2] Port">2222</dword>
        <string name="Hostname">10.0.0.5</string>
        <string name="Protocol Name">SSH2</string>
        <string name="Username">deploy</string>
        <string name="Password V2">02:9f3a</string>
        <array name="Port Forward Filter"><string>allow,127.0.0.1,0</string></array>
      </key>
      <key name="switch">
        <string name="Hostname">192.168.1.1</string>
        <string name="Protocol Name">Telnet</string>
        <dword name="Port">23</dword>
      </key>
    </key>
    <key name="console">
      <string name="Protocol Name">Serial</string>
      <string name="Com Port">COM3</string>
      <dword name="Baud Rate">115200</dword>
      <dword name="Parity">2</dword>
    </key>
    <key name="old">
      <string name="Hostname">old.example.com</string>
      <string name="Protocol Name">RLogin</string>
    </key>
  </key>
</VanDyke>
"#;

    #[test]
    fn test_parse_xml_export() {
        let r = parse_xml_export(XML).unwrap();
        // "Default" (no host) and RLogin are skipped.
        assert_eq!(r.skipped, 2);
        assert_eq!(r.passwords_skipped, 1);
        assert_eq!(r.sessions.len(), 3);
        let by = |l: &str| r.sessions.iter().find(|s| s.label == l).unwrap();

        let web = by("web-01");
        assert_eq!((web.protocol.clone(), web.host.as_str(), web.port, web.username.as_str()), (ProtocolType::Ssh, "10.0.0.5", 2222, "deploy"));
        assert_eq!(web.group, "SecureCRT>Prod & Ops");
        assert_eq!(web.auth_type, AuthType::Password);

        let sw = by("switch");
        assert_eq!((sw.protocol.clone(), sw.port), (ProtocolType::Telnet, 23));

        let console = by("console");
        assert_eq!((console.protocol.clone(), console.host.as_str(), console.group.as_str()), (ProtocolType::Serial, "COM3", "SecureCRT"));
        let serial = console.serial.as_ref().unwrap();
        assert_eq!((serial.baud_rate, serial.parity.as_str()), (115200, "even"));
    }

    #[test]
    fn test_xml_without_sessions() {
        assert!(parse_xml_export("<VanDyke><key name=\"Options\"></key></VanDyke>").is_err());
        assert!(parse_xml_export("<VanDyke><key name=\"Sessions\"").is_err());
    }

    #[test]
    fn test_parse_session_ini() {
        let ini = "S:\"Protocol Name\"=SSH2\r\nS:\"Hostname\"=db.example.com\r\nD:\"[SSH2] Port\"=00000016\r\n\
S:\"Username\"=root\r\nS:\"Identity Filename V2\"=${VDS_CONFIG_PATH}\\Keys\\missing::rawkey\r\n\
Z:\"Description\"=00000002\r\n line one\r\n line two\r\nB:\"Blob\"=00000002\r\n 00 01\r\n";
        let fields = parse_session_ini(ini);
        assert_eq!(fields.get("[SSH2] Port").map(String::as_str), Some("22"));
        assert!(!fields.contains_key("Description"));
        let p = session_from_fields(&fields, &["A".into(), "B".into()], "db", None).unwrap();
        assert_eq!(p.session.group, "SecureCRT>A>B");
        assert_eq!((p.session.port, p.session.username.as_str()), (22, "root"));
        assert_eq!(p.session.auth_type, AuthType::PrivateKey);
        assert!(p.key_missing && p.session.private_key_path.is_none());
    }

    #[test]
    fn test_import_sessions_folder() {
        let root = std::env::temp_dir().join(format!("nexterm-securecrt-{}", Uuid::new_v4()));
        let sessions = root.join("Config").join("Sessions");
        fs::create_dir_all(sessions.join("Lab")).unwrap();
        fs::create_dir_all(root.join("Config").join("Keys")).unwrap();
        fs::write(root.join("Config").join("Keys").join("id_lab"), "key").unwrap();
        fs::write(sessions.join("Default.ini"), "S:\"Protocol Name\"=SSH2\r\n").unwrap();
        fs::write(sessions.join("__FolderData__.ini"), "S:\"Folder List\"=Lab\r\n").unwrap();
        fs::write(sessions.join("Lab").join("__FolderData__.ini"), "").unwrap();
        let mut utf8_bom = vec![0xEF, 0xBB, 0xBF];
        utf8_bom.extend_from_slice(
            "S:\"Protocol Name\"=SSH2\r\nS:\"Hostname\"=lab.cn\r\nS:\"Identity Filename V2\"=${VDS_CONFIG_PATH}\\Keys\\id_lab::rawkey\r\n".as_bytes(),
        );
        fs::write(sessions.join("Lab").join("测试机.ini"), utf8_bom).unwrap();

        assert_eq!(count_sessions(&sessions), 1);
        let r = import_path(&sessions).unwrap();
        let _ = fs::remove_dir_all(&root);
        assert_eq!(r.sessions.len(), 1);
        let s = &r.sessions[0];
        assert_eq!((s.label.as_str(), s.group.as_str(), s.port), ("测试机", "SecureCRT>Lab", 22));
        assert_eq!(s.auth_type, AuthType::PrivateKey);
        assert!(s.private_key_path.as_deref().unwrap().ends_with("id_lab"));
        assert_eq!(r.keys_missing, 0);
    }
}
