//! MobaXterm bookmarks: the `[Bookmarks]` / `[Bookmarks_N]` sections of `MobaXterm.ini`
//! (installed: `%APPDATA%\MobaXterm\`, portable: next to the exe) and of exported
//! `.mxtsessions` files (same format). One section per folder, `SubRep=` is its path
//! (`Parent\Child`); every other key is a session:
//!
//! `Name=#<icon>#<type>%<field>%<field>%...#<terminal settings>%...`
//!
//! Types (the session dialog's order): 0 SSH, 1 Telnet, 2 Rsh, 3 Xdmcp, 4 RDP, 5 VNC, 6 FTP,
//! 7 SFTP, 8 Serial, 9 File, 10 Shell, 11 Browser, 12 Mosh, 13 S3, 14 WSL. Saved passwords
//! live elsewhere (encrypted) and are not imported.

use std::path::{Path, PathBuf};
use anyhow::Result;
use uuid::Uuid;

use crate::importer::{decode_text, parse_ini, read_limited, IMPORT_FILE_MAX};
use crate::models::{AuthType, ProtocolType, SerialConfig, SessionConfig};

pub const MOBA_GROUP: &str = "MobaXterm";

#[derive(Debug, Default, Clone)]
pub struct MobaImport {
    pub sessions: Vec<SessionConfig>,
    /// Bookmarks of a type Nexterm cannot open (RDP, VNC, FTP, ...) or malformed ones.
    pub skipped: usize,
}

/// Candidate MobaXterm.ini locations of an installed MobaXterm.
pub fn mobaxterm_ini_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(d) = dirs::config_dir() {
        out.push(d.join("MobaXterm").join("MobaXterm.ini"));
    }
    if let Some(d) = dirs::document_dir() {
        out.push(d.join("MobaXterm").join("MobaXterm.ini"));
    }
    out.retain(|p| p.is_file());
    out.dedup();
    out
}

pub fn import_path(path: &Path) -> Result<MobaImport> {
    let raw = read_limited(path, IMPORT_FILE_MAX)?;
    parse_bookmarks(&decode_text(&raw))
}

fn is_bookmark_section(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower == "bookmarks" || lower.strip_prefix("bookmarks_").is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

pub fn parse_bookmarks(text: &str) -> Result<MobaImport> {
    let sections = parse_ini(text);
    if !sections.iter().any(|s| is_bookmark_section(&s.name)) {
        anyhow::bail!("没有找到 MobaXterm 会话（文件中没有 [Bookmarks] 段）");
    }
    let mut out = MobaImport::default();
    for sec in sections.iter().filter(|s| is_bookmark_section(&s.name)) {
        let group = group_of(sec.get("SubRep").unwrap_or(""));
        for (name, value) in &sec.entries {
            if name.eq_ignore_ascii_case("SubRep") || name.eq_ignore_ascii_case("ImgNum") {
                continue;
            }
            match parse_entry(name, value, &group) {
                Some(s) => out.sessions.push(s),
                None => out.skipped += 1,
            }
        }
    }
    Ok(out)
}

fn group_of(sub_rep: &str) -> String {
    std::iter::once(MOBA_GROUP)
        .chain(sub_rep.split('\\').map(str::trim).filter(|p| !p.is_empty()))
        .collect::<Vec<_>>()
        .join(">")
}

/// MobaXterm path variables: `_ProfileDir_` (the Windows profile folder), `_CurrentDrive_`.
fn expand_moba_path(p: &str) -> String {
    let mut s = p.trim().to_string();
    if let Some(home) = dirs::home_dir() {
        s = s.replace("_ProfileDir_", &home.to_string_lossy());
    }
    s.replace("_CurrentDrive_", "C:")
}

/// A key file among the SSH fields (its position differs between MobaXterm versions).
fn find_key_path(fields: &[&str]) -> Option<String> {
    fields.iter().skip(3).map(|f| f.trim()).find_map(|f| {
        let lower = f.to_ascii_lowercase();
        let ext = [".ppk", ".pem", ".key", ".pri", ".openssh"].iter().any(|e| lower.ends_with(e));
        let named = ["id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"].iter().any(|n| lower.rsplit(['\\', '/']).next() == Some(*n));
        (ext || named).then(|| expand_moba_path(f))
    })
}

fn local_shell_protocol(field: &str) -> ProtocolType {
    let lower = field.to_ascii_lowercase();
    if lower.contains("powershell") {
        ProtocolType::Powershell
    } else if lower.contains("cmd") {
        ProtocolType::Cmd
    } else if lower.contains("wsl") || lower.contains("ubuntu") || lower.contains("debian") {
        ProtocolType::Wsl
    } else {
        // MobaXterm's own bash / unknown shells: the closest local shell here.
        ProtocolType::Powershell
    }
}

/// One bookmark. None when the type is unsupported or the entry is malformed.
pub fn parse_entry(name: &str, value: &str, group: &str) -> Option<SessionConfig> {
    let name = name.trim();
    let rest = value.trim().strip_prefix('#')?;
    let (_icon, rest) = rest.split_once('#')?;
    let (kind, rest) = rest.split_once('%').unwrap_or((rest, ""));
    let kind: u32 = kind.trim().parse().ok()?;
    // The terminal settings start at the next '#'.
    let block = rest.split_once('#').map_or(rest, |(b, _)| b);
    let fields: Vec<&str> = block.split('%').collect();
    let field = |i: usize| fields.get(i).map(|f| f.trim()).unwrap_or("");

    let mut s = SessionConfig {
        id: Uuid::new_v4().to_string(),
        label: if name.is_empty() { "MobaXterm".into() } else { name.to_string() },
        group: group.to_string(),
        term: "xterm-256color".into(),
        keep_alive_secs: 60,
        ..Default::default()
    };
    match kind {
        0 | 1 => {
            let host = field(0);
            if host.is_empty() {
                return None;
            }
            let telnet = kind == 1;
            s.protocol = if telnet { ProtocolType::Telnet } else { ProtocolType::Ssh };
            s.host = host.to_string();
            s.port = field(1).parse::<u16>().ok().filter(|p| *p > 0).unwrap_or(if telnet { 23 } else { 22 });
            // `[name]` refers to a saved credential; the bracketed name is the login.
            let user = field(2);
            s.username = user.strip_prefix('[').and_then(|u| u.strip_suffix(']')).unwrap_or(user).trim().to_string();
            if !telnet {
                s.private_key_path = find_key_path(&fields);
                s.auth_type = if s.private_key_path.is_some() { AuthType::PrivateKey } else { AuthType::Password };
            }
        }
        8 => {
            // The last field is the device label ("COM3  (USB Serial Port)"), field 1 the baud rate.
            let label = fields.last().map(|f| f.trim()).unwrap_or("");
            let port = label.split_whitespace().next().unwrap_or("");
            if port.is_empty() {
                return None;
            }
            s.protocol = ProtocolType::Serial;
            s.host = port.to_string();
            s.port = 0;
            s.auth_type = AuthType::None;
            let mut serial = SerialConfig::default();
            if let Some(b) = field(1).parse::<u32>().ok().filter(|b| *b >= 50) {
                serial.baud_rate = b;
            }
            s.serial = Some(serial);
        }
        10 => {
            s.protocol = local_shell_protocol(field(0));
            s.auth_type = AuthType::None;
        }
        14 => {
            s.protocol = ProtocolType::Wsl;
            s.auth_type = AuthType::None;
        }
        _ => return None,
    }
    Some(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    const INI: &str = "[Misc]\r\nSomething=1\r\n\
[Bookmarks]\r\nSubRep=\r\nImgNum=42\r\n\
Root web=#109#0%web.example.com%2222%deploy%%-1%-1%%%22%%0%0%0%_ProfileDir_\\.ssh\\id_ed25519%%-1%0%0%0%%1080%%0%0%1#MobaFont%10%0%0%-1%15%236,236,236%30,30,30%180,180,192%0%-1%0%%xterm%-1%-1%_Std_Colors_0_%80%24%0%1%-1%<none>%%0%1%-1#0# #-1\r\n\
[Bookmarks_1]\r\nSubRep=Lab\r\nImgNum=41\r\n\
Lab desktop=#91#4%rdp.example.com%3389%[rdp-login]%\r\n\
Router=#98#1%192.168.1.1%%admin%#MobaFont%10\r\n\
[Bookmarks_2]\r\nSubRep=Lab\\Prod\r\nImgNum=41\r\n\
Prod db=#109#0%10.0.0.9%%[ops]%\r\n\
Console=#131#8%0%115200%3%0%0%1%2%COM3  (USB Serial Port)#MobaFont%12%0\r\n\
Local=#151#10%Windows PowerShell%0#MobaFont\r\n\
Ubuntu=#151#14%Ubuntu%0\r\n\
Broken=no hash\r\n\
Sftp files=#140#7%files.example.com%22%u%\r\n";

    #[test]
    fn test_parse_bookmarks_with_folders() {
        let r = parse_bookmarks(INI).unwrap();
        assert_eq!(r.skipped, 3, "RDP, SFTP and the malformed line");
        assert_eq!(r.sessions.len(), 6);
        let by = |l: &str| r.sessions.iter().find(|s| s.label == l).unwrap();

        let web = by("Root web");
        assert_eq!((web.protocol.clone(), web.host.as_str(), web.port, web.username.as_str()), (ProtocolType::Ssh, "web.example.com", 2222, "deploy"));
        assert_eq!(web.group, "MobaXterm");
        assert_eq!(web.auth_type, AuthType::PrivateKey);
        let key = web.private_key_path.as_deref().unwrap();
        assert!(key.ends_with("id_ed25519") && !key.contains("_ProfileDir_"), "{key}");

        let router = by("Router");
        assert_eq!((router.protocol.clone(), router.port, router.username.as_str(), router.group.as_str()), (ProtocolType::Telnet, 23, "admin", "MobaXterm>Lab"));

        let db = by("Prod db");
        assert_eq!((db.port, db.username.as_str(), db.group.as_str()), (22, "ops", "MobaXterm>Lab>Prod"));
        assert_eq!(db.auth_type, AuthType::Password);
        assert!(db.password.is_none());

        let console = by("Console");
        assert_eq!((console.protocol.clone(), console.host.as_str()), (ProtocolType::Serial, "COM3"));
        assert_eq!(console.serial.as_ref().unwrap().baud_rate, 115200);

        assert_eq!(by("Local").protocol, ProtocolType::Powershell);
        assert_eq!(by("Ubuntu").protocol, ProtocolType::Wsl);
    }

    #[test]
    fn test_mxtsessions_encodings_and_errors() {
        // Exported .mxtsessions files are often in the ANSI code page or UTF-8 with a BOM.
        let mut raw = vec![0xEF, 0xBB, 0xBF];
        raw.extend_from_slice("[Bookmarks]\nSubRep=服务器\\北京\n跳板=#109#0%jump.cn%22%root%\n".as_bytes());
        let r = parse_bookmarks(&decode_text(&raw)).unwrap();
        assert_eq!(r.sessions[0].group, "MobaXterm>服务器>北京");
        assert_eq!(r.sessions[0].label, "跳板");

        assert!(parse_bookmarks("[Misc]\na=b\n").is_err());
        assert!(parse_entry("x", "#109#0%%22%u%", "g").is_none(), "no host");
        assert!(parse_entry("x", "#131#8%0%9600%#Font", "g").is_none(), "no serial port");
        assert!(is_bookmark_section("Bookmarks_12") && !is_bookmark_section("Bookmarks_x"));
    }
}
