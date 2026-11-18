//! Xshell sessions: `.xsh` files (INI, usually UTF-16LE with BOM) in
//! `Documents\NetSarang Computer\<version>\Xshell\Sessions\` (sub folders are groups),
//! or the `.xts` archive Xshell's "Export Sessions" writes (a ZIP of `.xsh` files whose
//! names are often GBK-encoded). Saved passwords are encrypted by Xshell and skipped.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use anyhow::{Context, Result};
use uuid::Uuid;

use crate::importer::{decode_text, parse_ini, read_limited, IniSection};
use crate::models::{AuthType, ProtocolType, SerialConfig, SessionConfig};

/// Root group of imported sessions; folders below it follow the Xshell folders.
pub const XSHELL_GROUP: &str = "Xshell";

const XSH_MAX: u64 = 1024 * 1024;
const XTS_MAX: u64 = 64 * 1024 * 1024;
const MAX_ENTRIES: usize = 10_000;
const MAX_DEPTH: usize = 16;

#[derive(Debug, Default, Clone)]
pub struct XshellImport {
    pub sessions: Vec<SessionConfig>,
    /// .xsh files with a protocol Nexterm has no equivalent for (RLOGIN, SFTP, ...).
    pub skipped: usize,
    /// Sessions that had a saved (encrypted) password, not imported.
    pub passwords_skipped: usize,
    /// Sessions using a key from Xshell's key store that could not be found as a file.
    pub keys_missing: usize,
}

/// Where Xshell keeps its data: every `...\NetSarang Computer\<version>\Xshell` folder.
pub fn xshell_data_dirs() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(d) = dirs::document_dir() {
        roots.push(d);
    }
    if let Some(h) = dirs::home_dir() {
        roots.push(h.join("Documents"));
    }
    roots.dedup();
    let mut out = Vec::new();
    for root in roots {
        let Ok(entries) = fs::read_dir(root.join("NetSarang Computer")) else {
            continue;
        };
        let mut versions: Vec<PathBuf> = entries.flatten().map(|e| e.path().join("Xshell")).filter(|p| p.is_dir()).collect();
        versions.sort();
        for v in versions.into_iter().rev() {
            if !out.contains(&v) {
                out.push(v);
            }
        }
    }
    out
}

/// Import a Sessions folder, a single `.xsh` or an `.xts` archive.
pub fn import_path(path: &Path) -> Result<XshellImport> {
    let mut out = XshellImport::default();
    if path.is_dir() {
        let key_dir = key_store_for(path);
        let mut files = Vec::new();
        collect_xsh(path, path, 0, &mut files)?;
        files.sort();
        for (rel, file) in files {
            let raw = read_limited(&file, XSH_MAX)?;
            add_session(&mut out, &decode_text(&raw), &rel, key_dir.as_deref());
        }
        return Ok(out);
    }
    let lower = path.to_string_lossy().to_ascii_lowercase();
    if lower.ends_with(".xts") || lower.ends_with(".zip") {
        return import_xts(path);
    }
    let raw = read_limited(path, XSH_MAX)?;
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let key_dir = path.parent().and_then(key_store_for);
    add_session(&mut out, &decode_text(&raw), &name, key_dir.as_deref());
    Ok(out)
}

/// Count of .xsh files below `dir` (discovery), without parsing them.
pub fn count_sessions(dir: &Path) -> usize {
    let mut files = Vec::new();
    let _ = collect_xsh(dir, dir, 0, &mut files);
    files.len()
}

/// `(relative path with "/" separators, absolute path)` of every .xsh below `dir`.
fn collect_xsh(root: &Path, dir: &Path, depth: usize, out: &mut Vec<(String, PathBuf)>) -> Result<()> {
    if depth > MAX_DEPTH {
        return Ok(());
    }
    let entries = fs::read_dir(dir).with_context(|| format!("无法读取目录: {}", dir.display()))?;
    for entry in entries.flatten() {
        let p = entry.path();
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            collect_xsh(root, &p, depth + 1, out)?;
        } else if p.extension().is_some_and(|e| e.eq_ignore_ascii_case("xsh")) {
            if out.len() >= MAX_ENTRIES {
                anyhow::bail!("会话文件超过 {} 个", MAX_ENTRIES);
            }
            let rel = p.strip_prefix(root).unwrap_or(&p);
            let rel = rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
            out.push((rel, p));
        }
    }
    Ok(())
}

/// `...\Xshell\UserKeys` next to a `...\Xshell\Sessions\...` folder, if there is one.
fn key_store_for(dir: &Path) -> Option<PathBuf> {
    dir.ancestors()
        .find(|a| a.file_name().is_some_and(|n| n.eq_ignore_ascii_case("Sessions")))
        .and_then(|s| s.parent())
        .map(|x| x.join("UserKeys"))
        .filter(|k| k.is_dir())
}

fn import_xts(path: &Path) -> Result<XshellImport> {
    let size = fs::metadata(path).with_context(|| format!("读取文件失败: {}", path.display()))?.len();
    if size > XTS_MAX {
        anyhow::bail!("Xshell 导出包超过 {} MB", XTS_MAX / (1024 * 1024));
    }
    let file = fs::File::open(path).with_context(|| format!("读取文件失败: {}", path.display()))?;
    let mut zip = zip::ZipArchive::new(file).context("不是有效的 Xshell 导出包 (.xts)")?;
    if zip.len() > MAX_ENTRIES {
        anyhow::bail!("Xshell 导出包中的文件超过 {} 个", MAX_ENTRIES);
    }
    let mut out = XshellImport::default();
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).context("Xshell 导出包已损坏")?;
        // Names without the UTF-8 flag are in the ANSI code page (GBK on Chinese Windows).
        let name = decode_text(entry.name_raw()).replace('\\', "/");
        if entry.is_dir() || !name.to_ascii_lowercase().ends_with(".xsh") {
            continue;
        }
        if entry.size() > XSH_MAX {
            anyhow::bail!("会话文件过大: {}", name);
        }
        let mut raw = Vec::new();
        (&mut entry).take(XSH_MAX + 1).read_to_end(&mut raw).with_context(|| format!("无法读取 {}", name))?;
        if raw.len() as u64 > XSH_MAX {
            anyhow::bail!("会话文件过大: {}", name);
        }
        add_session(&mut out, &decode_text(&raw), &name, None);
    }
    Ok(out)
}

fn add_session(out: &mut XshellImport, text: &str, rel_path: &str, key_dir: Option<&Path>) {
    match parse_xsh(text, rel_path, key_dir) {
        Some(p) => {
            out.passwords_skipped += p.had_password as usize;
            out.keys_missing += p.key_missing as usize;
            out.sessions.push(p.session);
        }
        None => out.skipped += 1,
    }
}

pub struct ParsedXsh {
    pub session: SessionConfig,
    pub had_password: bool,
    pub key_missing: bool,
}

fn section<'a>(sections: &'a [IniSection], name: &str) -> Option<&'a IniSection> {
    sections.iter().find(|s| s.name.eq_ignore_ascii_case(name))
}

/// Group from the path inside the Sessions folder / archive: `Xshell>Prod>Web` for
/// `Prod/Web/a.xsh` (a leading `Xshell/Sessions/` of exported archives is dropped).
fn group_of(rel_path: &str) -> String {
    let mut parts: Vec<&str> = rel_path.split('/').filter(|p| !p.is_empty()).collect();
    parts.pop();
    if parts.first().is_some_and(|p| p.eq_ignore_ascii_case("Xshell")) {
        parts.remove(0);
    }
    if parts.first().is_some_and(|p| p.eq_ignore_ascii_case("Sessions")) {
        parts.remove(0);
    }
    std::iter::once(XSHELL_GROUP).chain(parts).collect::<Vec<_>>().join(">")
}

fn label_of(rel_path: &str) -> String {
    let file = rel_path.rsplit('/').next().unwrap_or(rel_path);
    let stem = file.strip_suffix(".xsh").or_else(|| file.strip_suffix(".XSH")).unwrap_or(file);
    if stem.is_empty() { "Xshell".to_string() } else { stem.to_string() }
}

/// Parse one .xsh. None for protocols without a Nexterm equivalent or without a host.
pub fn parse_xsh(text: &str, rel_path: &str, key_dir: Option<&Path>) -> Option<ParsedXsh> {
    let sections = parse_ini(text);
    let conn = section(&sections, "CONNECTION")?;
    let auth = section(&sections, "CONNECTION:AUTHENTICATION");
    let protocol_raw = conn.get("Protocol").unwrap_or("SSH").to_ascii_uppercase();
    let protocol = match protocol_raw.as_str() {
        "SSH" | "SSH2" => ProtocolType::Ssh,
        "TELNET" => ProtocolType::Telnet,
        "SERIAL" => ProtocolType::Serial,
        "LOCAL" => ProtocolType::Cmd,
        _ => return None,
    };
    let host = conn.get("Host").unwrap_or("").to_string();
    if host.is_empty() && matches!(protocol, ProtocolType::Ssh | ProtocolType::Telnet) {
        return None;
    }
    let default_port = if protocol == ProtocolType::Telnet { 23 } else { 22 };
    let port = conn.get("Port").and_then(|p| p.parse::<u16>().ok()).filter(|p| *p > 0).unwrap_or(default_port);
    let username = auth.and_then(|a| a.get("UserName")).unwrap_or("").to_string();
    let had_password = auth.and_then(|a| a.get("Password")).is_some();

    // Method 1 = public key. UserKey names a key in Xshell's key store (UserKeys folder).
    let user_key = auth.and_then(|a| a.get("UserKey"));
    let uses_key = protocol == ProtocolType::Ssh && (user_key.is_some() || auth.and_then(|a| a.get("Method")) == Some("1"));
    let key_path = user_key.and_then(|k| resolve_key(k, key_dir));
    let key_missing = uses_key && key_path.is_none();

    let mut s = SessionConfig {
        id: Uuid::new_v4().to_string(),
        label: label_of(rel_path),
        group: group_of(rel_path),
        protocol: protocol.clone(),
        host,
        port,
        username,
        auth_type: if uses_key { AuthType::PrivateKey } else { AuthType::Password },
        private_key_path: key_path,
        term: "xterm-256color".to_string(),
        keep_alive_secs: 60,
        ..Default::default()
    };
    if protocol == ProtocolType::Serial {
        s.serial = Some(parse_serial(section(&sections, "CONNECTION:SERIAL")));
        s.host = serial_port(section(&sections, "CONNECTION:SERIAL")).unwrap_or_default();
        s.port = 0;
        s.auth_type = AuthType::None;
    }
    if protocol == ProtocolType::Cmd {
        s.host = String::new();
        s.auth_type = AuthType::None;
    }
    if let Some(cp) = section(&sections, "TERMINAL").and_then(|t| t.get("CodePage")) {
        s.charset = codepage_charset(cp).to_string();
    }
    if let Some(desc) = section(&sections, "SessionInfo").and_then(|i| i.get("Description")) {
        s.extra.insert("description".into(), serde_json::Value::String(desc.to_string()));
    }
    Some(ParsedXsh { session: s, had_password, key_missing })
}

/// A key given as a file path is used as is; a key store name is looked up in UserKeys.
fn resolve_key(key: &str, key_dir: Option<&Path>) -> Option<String> {
    let looks_like_path = key.contains('\\') || key.contains('/') || key.contains(':');
    if looks_like_path {
        return Some(crate::importer::expand_tilde(key));
    }
    let dir = key_dir?;
    ["", ".pri", ".pem", ".key"]
        .iter()
        .map(|ext| dir.join(format!("{key}{ext}")))
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().to_string())
}

fn serial_port(sec: Option<&IniSection>) -> Option<String> {
    let v = sec?.get("Port").or_else(|| sec?.get("ComPort"))?;
    // Some versions store the COM number only.
    Some(match v.parse::<u32>() {
        Ok(n) => format!("COM{}", n),
        Err(_) => v.to_string(),
    })
}

/// Baud rate and data bits as written; parity / stop bits / flow control as Xshell's
/// list indexes (0 = none / 1 bit / no flow control), defaults when unknown.
fn parse_serial(sec: Option<&IniSection>) -> SerialConfig {
    let mut c = SerialConfig::default();
    let Some(sec) = sec else { return c };
    if let Some(b) = sec.get("BaudRate").and_then(|v| v.parse::<u32>().ok()).filter(|b| *b > 0) {
        c.baud_rate = b;
    }
    if let Some(d) = sec.get("DataBits").and_then(|v| v.parse::<u8>().ok()).filter(|d| (5..=8).contains(d)) {
        c.data_bits = d;
    }
    c.parity = match sec.get("Parity") {
        Some("1") => "odd".into(),
        Some("2") => "even".into(),
        _ => "none".into(),
    };
    c.stop_bits = match sec.get("StopBits") {
        Some("2") => 2,
        _ => 1,
    };
    c.flow_control = match sec.get("FlowCtrl").or_else(|| sec.get("FlowControl")) {
        Some("1") => "software".into(),
        Some("2") => "hardware".into(),
        _ => "none".into(),
    };
    c
}

fn codepage_charset(cp: &str) -> &'static str {
    match cp {
        "936" => "GBK",
        "950" => "Big5",
        "932" => "Shift_JIS",
        "949" => "EUC-KR",
        _ => "",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "[CONNECTION]\r\nHost=10.0.0.5\r\nPort=2222\r\nProtocol=SSH\r\n\
[CONNECTION:AUTHENTICATION]\r\nUserName=deploy\r\nPassword=ENCRYPTEDblob==\r\nMethod=1\r\nUserKey=C:\\keys\\deploy.pem\r\n\
[TERMINAL]\r\nType=xterm\r\nCodePage=936\r\n[SessionInfo]\r\nVersion=7.0\r\nDescription=生产 Web\r\n";

    fn utf16le_bom(s: &str) -> Vec<u8> {
        let mut v = vec![0xFF, 0xFE];
        for u in s.encode_utf16() {
            v.extend_from_slice(&u.to_le_bytes());
        }
        v
    }

    #[test]
    fn test_parse_utf16le_xsh() {
        let raw = utf16le_bom(SAMPLE);
        let text = decode_text(&raw);
        let p = parse_xsh(&text, "生产/Web/网关 01.xsh", None).unwrap();
        let s = &p.session;
        assert_eq!((s.host.as_str(), s.port, s.username.as_str()), ("10.0.0.5", 2222, "deploy"));
        assert_eq!(s.protocol, ProtocolType::Ssh);
        assert_eq!(s.label, "网关 01");
        assert_eq!(s.group, "Xshell>生产>Web");
        assert_eq!(s.auth_type, AuthType::PrivateKey);
        assert_eq!(s.private_key_path.as_deref(), Some("C:\\keys\\deploy.pem"));
        assert!(s.password.is_none(), "encrypted passwords must not be imported");
        assert!(p.had_password && !p.key_missing);
        assert_eq!(s.charset, "GBK");
        assert_eq!(s.extra.get("description").and_then(|v| v.as_str()), Some("生产 Web"));

        // UTF-16LE without a BOM is recognised too.
        let no_bom = &raw[2..];
        assert!(decode_text(no_bom).contains("Host=10.0.0.5"));
    }

    #[cfg(windows)]
    #[test]
    fn test_gbk_fallback() {
        // "生产" in GBK: archive entry names and old .xsh files use the ANSI code page.
        assert_eq!(decode_text(&[0xC9, 0xFA, 0xB2, 0xFA]), "生产");
        assert_eq!(group_of(&decode_text(&[b'X', b'/', 0xC9, 0xFA, b'/', b'a', b'.', b'x', b's', b'h'])), "Xshell>X>生");
    }

    #[test]
    fn test_parse_utf8_telnet_serial_and_unsupported() {
        let telnet = "[CONNECTION]\nHost=switch1\nProtocol=TELNET\n[CONNECTION:AUTHENTICATION]\nUserName=admin\n";
        let p = parse_xsh(telnet, "Xshell/Sessions/Net/sw.xsh", None).unwrap();
        assert_eq!((p.session.protocol.clone(), p.session.port), (ProtocolType::Telnet, 23));
        assert_eq!(p.session.group, "Xshell>Net");
        assert!(!p.had_password);

        let serial = "[CONNECTION]\nProtocol=SERIAL\n[CONNECTION:SERIAL]\nPort=3\nBaudRate=9600\nDataBits=7\nParity=2\nStopBits=2\nFlowCtrl=2\n";
        let s = parse_xsh(serial, "console.xsh", None).unwrap().session;
        assert_eq!((s.protocol.clone(), s.host.as_str(), s.group.as_str()), (ProtocolType::Serial, "COM3", "Xshell"));
        let c = s.serial.unwrap();
        assert_eq!((c.baud_rate, c.data_bits, c.parity.as_str(), c.stop_bits, c.flow_control.as_str()), (9600, 7, "even", 2, "hardware"));

        assert!(parse_xsh("[CONNECTION]\nHost=h\nProtocol=RLOGIN\n", "r.xsh", None).is_none());
        assert!(parse_xsh("[CONNECTION]\nProtocol=SSH\n", "nohost.xsh", None).is_none());
        assert!(parse_xsh("not an ini", "x.xsh", None).is_none());
    }

    #[test]
    fn test_import_sessions_folder_with_key_store() {
        let base = std::env::temp_dir().join(format!("nexterm-xsh-{}", Uuid::new_v4()));
        let sessions = base.join("Xshell").join("Sessions");
        fs::create_dir_all(sessions.join("Lab")).unwrap();
        fs::create_dir_all(base.join("Xshell").join("UserKeys")).unwrap();
        fs::write(base.join("Xshell").join("UserKeys").join("id_lab.pri"), "key").unwrap();
        fs::write(sessions.join("top.xsh"), utf16le_bom("[CONNECTION]\nHost=a\nProtocol=SSH\n")).unwrap();
        fs::write(
            sessions.join("Lab").join("box.xsh"),
            "[CONNECTION]\nHost=b\nProtocol=SSH\n[CONNECTION:AUTHENTICATION]\nUserKey=id_lab\n",
        )
        .unwrap();
        fs::write(
            sessions.join("Lab").join("missing.xsh"),
            "[CONNECTION]\nHost=c\nProtocol=SSH\n[CONNECTION:AUTHENTICATION]\nUserKey=gone\nPassword=x\n",
        )
        .unwrap();
        fs::write(sessions.join("Lab").join("ftp.xsh"), "[CONNECTION]\nHost=d\nProtocol=SFTP\n").unwrap();
        fs::write(sessions.join("readme.txt"), "ignored").unwrap();

        assert_eq!(count_sessions(&sessions), 4);
        let r = import_path(&sessions).unwrap();
        let _ = fs::remove_dir_all(&base);
        assert_eq!((r.sessions.len(), r.skipped, r.passwords_skipped, r.keys_missing), (3, 1, 1, 1));
        let by = |h: &str| r.sessions.iter().find(|s| s.host == h).unwrap();
        assert_eq!(by("a").group, "Xshell");
        assert_eq!(by("b").group, "Xshell>Lab");
        assert!(by("b").private_key_path.as_deref().unwrap().ends_with("id_lab.pri"));
        assert!(by("c").private_key_path.is_none());
    }

    #[test]
    fn test_import_xts_archive() {
        use std::io::Write;
        let path = std::env::temp_dir().join(format!("nexterm-{}.xts", Uuid::new_v4()));
        {
            let f = fs::File::create(&path).unwrap();
            let mut w = zip::ZipWriter::new(f);
            let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            w.add_directory("Xshell/Sessions/Ops/", opts).unwrap();
            w.start_file("Xshell/Sessions/Ops/web.xsh", opts).unwrap();
            w.write_all(&utf16le_bom("[CONNECTION]\r\nHost=web.example\r\nProtocol=SSH\r\n")).unwrap();
            w.start_file("Xshell/Sessions/notes.txt", opts).unwrap();
            w.write_all(b"x").unwrap();
            w.finish().unwrap();
        }
        let r = import_path(&path).unwrap();
        let _ = fs::remove_file(&path);
        assert_eq!(r.sessions.len(), 1);
        assert_eq!((r.sessions[0].host.as_str(), r.sessions[0].group.as_str(), r.sessions[0].label.as_str()), ("web.example", "Xshell>Ops", "web"));
    }
}
