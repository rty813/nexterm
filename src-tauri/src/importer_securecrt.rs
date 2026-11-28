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
//! Saved logins of the credential manager ("Tools > Credentials", `Config\Credentials\*.ini`,
//! the file name is the title; `<key name="Credentials">` in the XML) become Nexterm
//! credentials, and sessions naming one in "Credential Title" are linked to it. A Sessions
//! folder brings the Credentials folder next to it; the Credentials folder or one of its
//! files can also be imported on its own.
//!
//! Saved passwords are decrypted (`crypto`): "Password V2" is AES-256-CBC keyed by the
//! SHA-256 of the config passphrase (empty by default), the legacy "Password" is the
//! double-Blowfish scheme. A set config passphrase or any other failure leaves the password
//! out (counted in `passwords_skipped`).

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use anyhow::{Context, Result};
use uuid::Uuid;

use crate::credentials::Credential;
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
    /// Sessions with a saved password, read or not.
    pub passwords_stored: usize,
    pub keys_missing: usize,
    /// Logins of SecureCRT's credential manager, with fresh ids that imported sessions refer
    /// to (`credentials::import_credentials` maps them to the saved ones).
    pub credentials: Vec<Credential>,
    /// Credentials left out: the password could not be decrypted, or nothing usable is saved.
    pub credentials_skipped: usize,
    /// Credentials with a saved password, read or not (for the passphrase check).
    credential_passwords_stored: usize,
    credential_passwords_skipped: usize,
    /// User name of every credential read (usable or not), by lowercased title.
    credential_users: HashMap<String, String>,
    /// (index in `sessions`, "Credential Title"), linked once everything is read.
    links: Vec<(usize, String)>,
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
    let _ = collect_ini(dir, dir, 0, true, &mut files);
    files.len()
}

/// Import a Sessions folder, a single session `.ini` or an exported `.xml`, with an empty
/// config passphrase (SecureCRT's default).
#[cfg(test)]
pub fn import_path(path: &Path) -> Result<SecureCrtImport> {
    import_path_with(path, b"")
}

/// Import with the config passphrase that encrypts saved passwords (empty when none is set).
/// A passphrase that opens none of the stored passwords is an error (`securecrtPassphraseWrong`)
/// rather than an import without them, so a typo does not silently drop every password.
pub fn import_path_with(path: &Path, passphrase: &[u8]) -> Result<SecureCrtImport> {
    let mut out = import_inner(path, passphrase)?;
    let stored = out.passwords_stored + out.credential_passwords_stored;
    let skipped = out.passwords_skipped + out.credential_passwords_skipped;
    anyhow::ensure!(passphrase.is_empty() || stored == 0 || skipped < stored, "securecrtPassphraseWrong");
    link_credentials(&mut out);
    Ok(out)
}

fn import_inner(path: &Path, passphrase: &[u8]) -> Result<SecureCrtImport> {
    let mut out = SecureCrtImport::default();
    if path.is_dir() {
        if is_named(path, "Credentials") {
            add_credentials_dir(&mut out, path, path.parent(), passphrase)?;
            return Ok(out);
        }
        let config_dir = config_dir_of(path);
        // The credentials the sessions refer to, next to the Sessions folder.
        if let Some(dir) = config_dir.as_deref().map(|c| c.join("Credentials")).filter(|d| d.is_dir()) {
            add_credentials_dir(&mut out, &dir, config_dir.as_deref(), passphrase)?;
        }
        let mut files = Vec::new();
        collect_ini(path, path, 0, true, &mut files)?;
        files.sort();
        for (rel, file) in files {
            let raw = read_limited(&file, INI_MAX)?;
            let fields = parse_session_ini(&decode_text(&raw));
            let (groups, label) = split_rel(&rel);
            add(&mut out, &fields, &groups, &label, config_dir.as_deref(), passphrase);
        }
        return Ok(out);
    }
    let raw = read_limited(path, IMPORT_FILE_MAX)?;
    let text = decode_text(&raw);
    if text.trim_start().starts_with('<') {
        return parse_xml_export(&text, passphrase);
    }
    let name = path.file_stem().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let fields = parse_session_ini(&text);
    // A credential file: in a Credentials folder, or (copied elsewhere) without the
    // "Protocol Name" every session file has.
    let parent = path.parent();
    let in_credentials = parent.is_some_and(|p| is_named(p, "Credentials"));
    if in_credentials || !fields.contains_key("Protocol Name") {
        let config_dir = parent.filter(|_| in_credentials).and_then(Path::parent);
        add_credential(&mut out, &fields, &name, config_dir, passphrase);
        return Ok(out);
    }
    let config_dir = parent.and_then(config_dir_of);
    add(&mut out, &fields, &[], &name, config_dir.as_deref(), passphrase);
    Ok(out)
}

fn is_named(dir: &Path, name: &str) -> bool {
    dir.file_name().is_some_and(|n| n.eq_ignore_ascii_case(name))
}

fn add_credentials_dir(out: &mut SecureCrtImport, dir: &Path, config_dir: Option<&Path>, passphrase: &[u8]) -> Result<()> {
    let mut files = Vec::new();
    collect_ini(dir, dir, 0, false, &mut files)?;
    files.sort();
    for (rel, file) in files {
        let raw = read_limited(&file, INI_MAX)?;
        let (_, name) = split_rel(&rel);
        add_credential(out, &parse_session_ini(&decode_text(&raw)), &name, config_dir, passphrase);
    }
    Ok(())
}

/// The config folder (parent of `Sessions`) for `${VDS_CONFIG_PATH}` in key paths.
fn config_dir_of(dir: &Path) -> Option<PathBuf> {
    dir.ancestors()
        .find(|a| a.file_name().is_some_and(|n| n.eq_ignore_ascii_case("Sessions")))
        .and_then(|s| s.parent())
        .map(Path::to_path_buf)
}

/// `(relative path with "/" separators, absolute path)` of every `.ini` below `dir`, without
/// folder data and (`sessions`) the root `Default.ini` of a Sessions folder.
fn collect_ini(root: &Path, dir: &Path, depth: usize, sessions: bool, out: &mut Vec<(String, PathBuf)>) -> Result<()> {
    if depth > MAX_DEPTH {
        return Ok(());
    }
    let entries = fs::read_dir(dir).with_context(|| format!("无法读取目录: {}", dir.display()))?;
    for entry in entries.flatten() {
        let p = entry.path();
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            collect_ini(root, &p, depth + 1, sessions, out)?;
            continue;
        }
        if !p.extension().is_some_and(|e| e.eq_ignore_ascii_case("ini")) {
            continue;
        }
        let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        if name.eq_ignore_ascii_case("__FolderData__.ini") || (sessions && depth == 0 && name.eq_ignore_ascii_case("Default.ini")) {
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

fn add(out: &mut SecureCrtImport, fields: &HashMap<String, String>, groups: &[String], label: &str, config_dir: Option<&Path>, passphrase: &[u8]) {
    match session_from_fields_with(fields, groups, label, config_dir, passphrase) {
        Some(p) => {
            out.passwords_skipped += p.had_password as usize;
            out.passwords_stored += (p.had_password || p.session.password.is_some()) as usize;
            out.keys_missing += p.key_missing as usize;
            if let Some(title) = fields.get("Credential Title").map(|t| t.trim()).filter(|t| !t.is_empty()) {
                out.links.push((out.sessions.len(), title.to_string()));
            }
            out.sessions.push(p.session);
        }
        None => out.skipped += 1,
    }
}

/// One credential (`name`: its title). The key wins over the password like in sessions; a key
/// file that is gone falls back to the password, and one with neither is left out.
fn add_credential(out: &mut SecureCrtImport, fields: &HashMap<String, String>, name: &str, config_dir: Option<&Path>, passphrase: &[u8]) {
    let get = |k: &str| fields.get(k).map(|v| v.trim()).filter(|v| !v.is_empty());
    let name = name.trim();
    if name.is_empty() {
        return;
    }
    let username = get("Username").unwrap_or("").to_string();
    out.credential_users.insert(name.to_lowercase(), username.clone());
    let password = crypto::session_password_with(fields, passphrase);
    out.credential_passwords_stored += (password.skipped || password.value.is_some()) as usize;
    out.credential_passwords_skipped += password.skipped as usize;
    let key = get("Identity Filename V2").or_else(|| get("Identity Filename")).and_then(|k| resolve_key(k, config_dir));
    let (auth_type, private_key_path, password) = match (key, password.value) {
        (Some(path), _) => (AuthType::PrivateKey, Some(path), None),
        (None, Some(pw)) => (AuthType::Password, None, Some(pw)),
        (None, None) => {
            out.credentials_skipped += 1;
            return;
        }
    };
    let credential = Credential {
        id: Uuid::new_v4().to_string(),
        name: name.to_string(),
        username,
        auth_type,
        password,
        private_key_path,
        passphrase: None,
        login: true,
        onekey: false,
        expect: Default::default(),
        applies_to: None,
    };
    // Titles are unique in SecureCRT; a repeat (differing in case, in an XML) replaces the first.
    match out.credentials.iter_mut().find(|c| c.name.to_lowercase() == name.to_lowercase()) {
        Some(c) => *c = Credential { id: c.id.clone(), ..credential },
        None => out.credentials.push(credential),
    }
}

/// Point sessions at the credential their "Credential Title" names. The credential's user
/// name and kind are copied (shown in lists) and its secrets replace the session's own. When
/// the credential could not be imported, only its user name fills an empty one.
fn link_credentials(out: &mut SecureCrtImport) {
    for (index, title) in std::mem::take(&mut out.links) {
        let key = title.to_lowercase();
        let Some(s) = out.sessions.get_mut(index) else { continue };
        if !matches!(s.protocol, ProtocolType::Ssh | ProtocolType::Telnet | ProtocolType::Rdp) {
            continue;
        }
        let Some(c) = out.credentials.iter().find(|c| c.name.to_lowercase() == key) else {
            if let Some(user) = out.credential_users.get(&key).filter(|u| !u.is_empty() && s.username.is_empty()) {
                s.username = user.clone();
            }
            continue;
        };
        if s.protocol == ProtocolType::Ssh {
            s.auth_type = c.auth_type.clone();
            s.private_key_path = None;
            s.passphrase = None;
        } else if c.auth_type == AuthType::PrivateKey {
            continue;
        }
        if !c.username.is_empty() {
            s.username = c.username.clone();
        }
        s.credential_id = Some(c.id.clone());
        s.password = None;
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

#[cfg(test)]
pub fn session_from_fields(
    fields: &HashMap<String, String>,
    groups: &[String],
    label: &str,
    config_dir: Option<&Path>,
) -> Option<ParsedSession> {
    session_from_fields_with(fields, groups, label, config_dir, b"")
}

/// One session. None when the protocol has no Nexterm equivalent or the target is missing.
pub fn session_from_fields_with(
    fields: &HashMap<String, String>,
    groups: &[String],
    label: &str,
    config_dir: Option<&Path>,
    passphrase: &[u8],
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
    // Saved password: decrypted when it can be, otherwise counted as skipped.
    let password = crypto::session_password_with(fields, passphrase);
    match protocol.as_str() {
        "SSH2" => {
            if host.is_empty() {
                return None;
            }
            s.protocol = ProtocolType::Ssh;
            s.host = host;
            s.port = port("[SSH2] Port", 22);
            s.password = password.value.clone();
            had_password = password.skipped;
            // "Identity Filename V2" is `<path>::rawkey` / `<path>::openssh...`; an empty one
            // with "Use Global Public Key" means the global key, which is not imported. Only a
            // session key counts: "SSH2 Authentications V2" starts with `publickey` by default
            // (`publickey,keyboard-interactive,password,gssapi`), so its order says nothing
            // about whether the session actually signs in with a key.
            let key_field = get("Identity Filename V2").or_else(|| get("Identity Filename"));
            if let Some(path) = key_field.and_then(|k| resolve_key(k, config_dir)) {
                s.auth_type = AuthType::PrivateKey;
                s.private_key_path = Some(path);
            } else if key_field.is_some() {
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
        "RDP" => {
            if host.is_empty() {
                return None;
            }
            s.protocol = ProtocolType::Rdp;
            let (user, user_domain) = split_rdp_username(&s.username, &host);
            s.username = user;
            s.host = host;
            s.port = num("[RDP] Port").or_else(|| num("Port")).and_then(|p| u16::try_from(p).ok()).filter(|p| *p > 0).unwrap_or(3389);
            s.auth_type = AuthType::None;
            s.keep_alive_secs = 0;
            s.password = password.value.clone();
            had_password = password.skipped;
            let mut desktop = crate::models::DesktopConfig::default();
            if let Some(domain) = get("[RDP] Domain").or_else(|| get("Domain")).map(str::to_string).or(user_domain) {
                desktop.domain = domain;
            }
            s.desktop = Some(desktop);
        }
        _ => return None,
    }
    Some(ParsedSession { session: s, had_password, key_missing })
}

/// SecureCRT's RDP "Username" is `DOMAIN\user` (it fills in the host as the domain for local
/// accounts). The domain is dropped when it is just the host or `.` (a local account) or the
/// user is a UPN (`user@example.com`, e.g. a Microsoft account), which carries its own.
fn split_rdp_username(raw: &str, host: &str) -> (String, Option<String>) {
    let Some((domain, user)) = raw.split_once('\\') else {
        return (raw.to_string(), None);
    };
    let (domain, user) = (domain.trim(), user.trim());
    if user.is_empty() {
        return (raw.to_string(), None);
    }
    let local = domain.is_empty() || domain == "." || domain.eq_ignore_ascii_case(host.trim()) || user.contains('@');
    (user.to_string(), (!local).then(|| domain.to_string()))
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

// ------------------------------------------------------------------ passwords

/// A session's saved password: `value` when it was decrypted, `skipped` when one was stored
/// but could not be read (a config passphrase is set, or anything unexpected).
#[derive(Default)]
pub struct Password {
    pub value: Option<String>,
    pub skipped: bool,
}

/// SecureCRT's password schemes. "Password V2" is keyed by the config passphrase (empty by
/// default); with a wrong one the checksum fails and the password is left out.
mod crypto {
    use super::Password;
    use std::collections::HashMap;
    use aes::cipher::{block_padding::NoPadding, BlockModeDecrypt, KeyIvInit};

    // Legacy "Password": the two hard-coded Blowfish keys.
    const V1_KEY1: [u8; 16] = [0x24, 0xA6, 0x3D, 0xDE, 0x5B, 0xD3, 0xB3, 0x82, 0x9C, 0x7E, 0x06, 0xF4, 0x08, 0x16, 0xAA, 0x07];
    const V1_KEY2: [u8; 16] = [0x5F, 0xB0, 0x45, 0xA2, 0x94, 0x17, 0xD9, 0x16, 0xC6, 0xC6, 0xA2, 0xFF, 0x06, 0x41, 0x82, 0xB7];

    #[cfg(test)]
    pub fn session_password(fields: &HashMap<String, String>) -> Password {
        session_password_with(fields, b"")
    }

    /// The decrypted saved password of a session. "Password V2" wins over the legacy "Password"
    /// (which does not use the passphrase).
    pub fn session_password_with(fields: &HashMap<String, String>, passphrase: &[u8]) -> Password {
        let field = |k: &str| fields.get(k).map(|v| v.trim()).filter(|v| !v.is_empty());
        if let Some(v2) = field("Password V2") {
            // Stored as `02:<hex>` (older SecureCRT) or `03:<hex>` (9.x); the `NN:` prefix is
            // the format tag.
            return stored(match v2.split_once(':') {
                Some(("03", hex)) => decrypt_v3(hex, passphrase),
                Some((_, hex)) => decrypt_v2(hex, passphrase),
                None => decrypt_v2(v2, passphrase),
            });
        }
        if let Some(v1) = field("Password") {
            return stored(decrypt_v1(v1));
        }
        Password::default()
    }

    /// A password field was present: `None` means it could not be read, so it is skipped.
    fn stored(value: Option<String>) -> Password {
        Password { skipped: value.is_none(), value }
    }

    #[cfg(test)]
    pub fn test_encrypt_v2(password: &str) -> String {
        encrypt::v2(password)
    }
    #[cfg(test)]
    pub fn test_encrypt_v3(password: &str) -> String {
        encrypt::v3(password, [0x5a; 16], b"")
    }
    #[cfg(test)]
    pub fn test_encrypt_v1(password: &str) -> String {
        encrypt::v1(password)
    }

    fn unhex(s: &str) -> Option<Vec<u8>> {
        let s = s.trim();
        if s.is_empty() || s.len() % 2 != 0 {
            return None;
        }
        (0..s.len() / 2).map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()).collect()
    }

    /// "02": AES-256-CBC, key = SHA-256(passphrase), IV = 0.
    fn decrypt_v2(hex: &str, passphrase: &[u8]) -> Option<String> {
        let mut data = unhex(hex)?;
        let key = ring::digest::digest(&ring::digest::SHA256, passphrase);
        aes_payload(key.as_ref(), &[0u8; 16], &mut data)
    }

    /// "03": a 16-byte salt, then AES-256-CBC whose key and IV are the 48 bytes of
    /// bcrypt_pbkdf(passphrase, salt, 16 rounds).
    fn decrypt_v3(hex: &str, passphrase: &[u8]) -> Option<String> {
        let data = unhex(hex)?;
        if data.len() <= 16 {
            return None;
        }
        let (salt, ct) = data.split_at(16);
        let mut key_iv = [0u8; 48];
        bcrypt_pbkdf(passphrase, salt, 16, &mut key_iv);
        aes_payload(&key_iv[..32], &key_iv[32..], &mut ct.to_vec())
    }

    /// The V2 / V3 plaintext: a 4-byte little-endian length, the UTF-8 password, its SHA-256
    /// (verified) and then padding.
    fn aes_payload(key: &[u8], iv: &[u8], data: &mut [u8]) -> Option<String> {
        if data.is_empty() || data.len() % 16 != 0 {
            return None;
        }
        let plain = cbc::Decryptor::<aes::Aes256>::new_from_slices(key, iv)
            .ok()?
            .decrypt_padded::<NoPadding>(data)
            .ok()?;
        let len = u32::from_le_bytes(plain.get(..4)?.try_into().ok()?) as usize;
        let body = plain.get(4..)?;
        let pw = body.get(..len)?;
        let digest = body.get(len..len + 32)?;
        (ring::digest::digest(&ring::digest::SHA256, pw).as_ref() == digest)
            .then(|| String::from_utf8(pw.to_vec()).ok())
            .flatten()
    }

    /// Legacy "Password": Blowfish-CBC (IV = 0, big-endian) under Key1 wraps `[4 random
    /// bytes][Blowfish-CBC(Key2, password)][4 random bytes]`. The inner plaintext is the
    /// UTF-16-LE password terminated by a NUL code unit.
    fn decrypt_v1(hex: &str) -> Option<String> {
        let mut data = unhex(hex)?;
        if data.len() <= 8 || data.len() % 8 != 0 {
            return None;
        }
        let outer = blowfish_dec(&V1_KEY1, &mut data)?.to_vec();
        let mut inner = outer.get(4..outer.len().checked_sub(4)?)?.to_vec();
        if inner.is_empty() || inner.len() % 8 != 0 {
            return None;
        }
        let plain = blowfish_dec(&V1_KEY2, &mut inner)?;
        // UTF-16-LE, NUL-terminated.
        let units: Vec<u16> = plain
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .take_while(|&u| u != 0)
            .collect();
        String::from_utf16(&units).ok()
    }

    /// OpenSSH's bcrypt_pbkdf. Written out because the `bcrypt-pbkdf` crate (like OpenSSH)
    /// rejects an empty passphrase, which is SecureCRT's default.
    pub(super) fn bcrypt_pbkdf(pass: &[u8], salt: &[u8], rounds: u32, out: &mut [u8]) {
        use ring::digest::{digest, Context, SHA512};
        let sha_pass = digest(&SHA512, pass);
        let stride = out.len().div_ceil(32);
        for block in 0..stride {
            let mut ctx = Context::new(&SHA512);
            ctx.update(salt);
            ctx.update(&(block as u32 + 1).to_be_bytes());
            let mut tmp = bhash(sha_pass.as_ref(), ctx.finish().as_ref());
            let mut acc = tmp;
            for _ in 1..rounds {
                tmp = bhash(sha_pass.as_ref(), digest(&SHA512, &tmp).as_ref());
                acc.iter_mut().zip(tmp).for_each(|(a, t)| *a ^= t);
            }
            // The output bytes are interleaved across the blocks.
            for (i, b) in acc.iter().enumerate() {
                if let Some(o) = out.get_mut(i * stride + block) {
                    *o = *b;
                }
            }
        }
    }

    fn bhash(sha_pass: &[u8], sha_salt: &[u8]) -> [u8; 32] {
        let mut bf: blowfish::Blowfish = blowfish::Blowfish::bc_init_state();
        bf.salted_expand_key(sha_salt, sha_pass);
        for _ in 0..64 {
            bf.bc_expand_key(sha_salt);
            bf.bc_expand_key(sha_pass);
        }
        let mut words = [0u32; 8];
        for (w, c) in words.iter_mut().zip(b"OxychromaticBlowfishSwatDynamite".chunks_exact(4)) {
            *w = u32::from_be_bytes([c[0], c[1], c[2], c[3]]);
        }
        for _ in 0..64 {
            for pair in words.chunks_exact_mut(2) {
                let [l, r] = bf.bc_encrypt([pair[0], pair[1]]);
                pair[0] = l;
                pair[1] = r;
            }
        }
        let mut out = [0u8; 32];
        for (o, w) in out.chunks_exact_mut(4).zip(words) {
            o.copy_from_slice(&w.to_le_bytes());
        }
        out
    }

    fn blowfish_dec<'a>(key: &[u8], data: &'a mut [u8]) -> Option<&'a [u8]> {
        cbc::Decryptor::<blowfish::Blowfish>::new_from_slices(key, &[0u8; 8])
            .ok()?
            .decrypt_padded::<NoPadding>(data)
            .ok()
    }

    #[cfg(test)]
    mod encrypt {
        //! Encryption, for round-trip tests only (SecureCRT itself never reads these back).
        use super::*;
        use aes::cipher::{BlockModeEncrypt, KeyIvInit};

        pub fn v2(password: &str) -> String {
            let mut plain = (password.len() as u32).to_le_bytes().to_vec();
            plain.extend_from_slice(password.as_bytes());
            plain.extend_from_slice(ring::digest::digest(&ring::digest::SHA256, password.as_bytes()).as_ref());
            plain.resize(plain.len().div_ceil(16) * 16, 0);
            let key = ring::digest::digest(&ring::digest::SHA256, b"");
            let ct = cbc::Encryptor::<aes::Aes256>::new_from_slices(key.as_ref(), &[0u8; 16])
                .unwrap()
                .encrypt_padded::<NoPadding>(&mut plain.clone(), plain.len())
                .unwrap()
                .to_vec();
            format!("02:{}", hex(&ct))
        }

        pub fn v3(password: &str, salt: [u8; 16], passphrase: &[u8]) -> String {
            let mut plain = (password.len() as u32).to_le_bytes().to_vec();
            plain.extend_from_slice(password.as_bytes());
            plain.extend_from_slice(ring::digest::digest(&ring::digest::SHA256, password.as_bytes()).as_ref());
            plain.resize(plain.len().div_ceil(16) * 16, 0);
            let mut key_iv = [0u8; 48];
            bcrypt_pbkdf(passphrase, &salt, 16, &mut key_iv);
            let n = plain.len();
            let ct = cbc::Encryptor::<aes::Aes256>::new_from_slices(&key_iv[..32], &key_iv[32..])
                .unwrap()
                .encrypt_padded::<NoPadding>(&mut plain, n)
                .unwrap()
                .to_vec();
            format!("03:{}{}", hex(&salt), hex(&ct))
        }

        pub fn v1(password: &str) -> String {
            // UTF-16-LE with a NUL terminator, zero-padded to the Blowfish block.
            let mut plain: Vec<u8> = password.encode_utf16().flat_map(u16::to_le_bytes).collect();
            plain.extend_from_slice(&[0, 0]);
            plain.resize(plain.len().div_ceil(8) * 8, 0);
            let inner = bf_enc(&V1_KEY2, plain);
            let mut framed = vec![0u8; 4];
            framed.extend_from_slice(&inner);
            framed.extend_from_slice(&[0u8; 4]);
            hex(&bf_enc(&V1_KEY1, framed))
        }

        fn bf_enc(key: &[u8], mut data: Vec<u8>) -> Vec<u8> {
            let n = data.len();
            cbc::Encryptor::<blowfish::Blowfish>::new_from_slices(key, &[0u8; 8])
                .unwrap()
                .encrypt_padded::<NoPadding>(&mut data, n)
                .unwrap()
                .to_vec()
        }

        fn hex(bytes: &[u8]) -> String {
            bytes.iter().map(|b| format!("{b:02x}")).collect()
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn fields(key: &str, value: &str) -> HashMap<String, String> {
            HashMap::from([(key.to_string(), value.to_string())])
        }

        #[test]
        fn v2_round_trip() {
            for pw in ["hunter2", "", "пароль🔒", "x".repeat(40).as_str()] {
                let p = session_password(&fields("Password V2", &encrypt::v2(pw)));
                assert_eq!(p.value.as_deref(), Some(pw), "V2 {pw:?}");
                assert!(!p.skipped);
            }
        }

        #[test]
        fn v1_round_trip() {
            for pw in ["hunter2", "a", "exactly-eight!!"] {
                let p = session_password(&fields("Password", &encrypt::v1(pw)));
                assert_eq!(p.value.as_deref(), Some(pw), "V1 {pw:?}");
            }
        }

        #[test]
        fn known_answer_vectors() {
            // Ciphertext produced by an independent OpenSSL implementation (aes-256-cbc /
            // bf-cbc), not by this crate — a real cross-check of the decrypt, not a round-trip.
            let v2 = "02:a946feca74f2916b52e36e1458fa1a6647b1af207ac92ee8b3273d4f6e54f8c85d5a0dcd7431cd38b8cab7f85133bddf";
            assert_eq!(decrypt_v2(v2.split_once(':').unwrap().1, b"").as_deref(), Some("hunter2"));
            let v1 = "1966e6b30a27b2c25c50ba9c27d68b524f672c4994101e7d";
            assert_eq!(decrypt_v1(v1).as_deref(), Some("hunter2"));
        }

        #[test]
        fn bcrypt_pbkdf_matches_crate() {
            // The crate refuses an empty passphrase, so compare on a non-empty one.
            for (pass, salt, len) in [(&b"pw"[..], &b"0123456789abcdef"[..], 48), (b"secret", b"s", 70)] {
                let mut ours = vec![0u8; len];
                bcrypt_pbkdf(pass, salt, 16, &mut ours);
                let mut theirs = vec![0u8; len];
                ::bcrypt_pbkdf::bcrypt_pbkdf(pass, salt, 16, &mut theirs).unwrap();
                assert_eq!(ours, theirs);
            }
        }

        #[test]
        fn v3_round_trip() {
            for pw in ["hunter2", "", "пароль🔒"] {
                let p = session_password(&fields("Password V2", &encrypt::v3(pw, [7u8; 16], b"")));
                assert_eq!(p.value.as_deref(), Some(pw), "V3 {pw:?}");
            }
        }

        #[test]
        fn passphrase_v2_v3() {
            let pass = "口令 pass".as_bytes();
            let f = fields("Password V2", &encrypt::v3("hunter2", [3u8; 16], pass));
            assert_eq!(session_password_with(&f, pass).value.as_deref(), Some("hunter2"));
            assert!(session_password_with(&f, b"wrong").skipped);
            assert!(session_password(&f).skipped);
            // "02" is keyed by the SHA-256 of the passphrase.
            assert!(session_password_with(&fields("Password V2", &encrypt::v2("hunter2")), b"x").skipped);
        }

        #[test]
        fn undecryptable_is_skipped() {
            // A config passphrase: the key is SHA-256(passphrase), so the checksum fails here.
            let p = session_password(&fields("Password V2", "02:9f3a"));
            assert!(p.value.is_none() && p.skipped);
            // No password field at all is not a skip.
            let none = session_password(&HashMap::new());
            assert!(none.value.is_none() && !none.skipped);
        }
    }
}

// ------------------------------------------------------------------ XML export

/// Sessions of an exported settings XML.
pub fn parse_xml_export(text: &str, passphrase: &[u8]) -> Result<SecureCrtImport> {
    let mut stack: Vec<(String, HashMap<String, String>)> = Vec::new();
    let mut value: Option<(String, String)> = None;
    let mut found_sessions = false;
    let mut out = SecureCrtImport::default();

    for token in XmlTokens::new(text) {
        match token? {
            XmlToken::Open { tag, name, empty } => match tag.as_str() {
                "key" if !empty => {
                    found_sessions |= stack.len() <= 1 && matches!(name.as_deref(), Some("Sessions" | "Credentials"));
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
                    // A credential is a key with values right below the top-level `Credentials`.
                    if stack.first().is_some_and(|(n, _)| n == "Credentials") {
                        if stack.len() == 1 && !fields.is_empty() {
                            add_credential(&mut out, &fields, &name, None, passphrase);
                        }
                        continue;
                    }
                    // A session is a key with values somewhere below `Sessions`.
                    let Some(at) = stack.iter().position(|(n, _)| n == "Sessions") else { continue };
                    if fields.is_empty() || !(fields.contains_key("Protocol Name") || fields.contains_key("Hostname")) {
                        continue;
                    }
                    let groups: Vec<String> = stack[at + 1..].iter().map(|(n, _)| n.clone()).collect();
                    add(&mut out, &fields, &groups, &name, None, passphrase);
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
        let r = parse_xml_export(XML, b"").unwrap();
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
        assert!(parse_xml_export("<VanDyke><key name=\"Options\"></key></VanDyke>", b"").is_err());
        assert!(parse_xml_export("<VanDyke><key name=\"Sessions\"", b"").is_err());
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

    #[test]
    fn test_rdp_session() {
        let mut f = HashMap::new();
        for (k, v) in [
            ("Protocol Name", "RDP"),
            ("Hostname", "win.example.com"),
            ("[RDP] Port", "3390"),
            ("Username", "admin"),
            ("[RDP] Domain", "CORP"),
        ] {
            f.insert(k.to_string(), v.to_string());
        }
        f.insert("Password V2".into(), crypto::test_encrypt_v2("s3cret"));
        let p = session_from_fields(&f, &[], "win", None).unwrap();
        assert_eq!(p.session.protocol, ProtocolType::Rdp);
        assert_eq!((p.session.host.as_str(), p.session.port, p.session.username.as_str()), ("win.example.com", 3390, "admin"));
        assert_eq!(p.session.auth_type, AuthType::None);
        assert_eq!(p.session.password.as_deref(), Some("s3cret"));
        assert_eq!(p.session.desktop.as_ref().unwrap().domain, "CORP");
        assert!(!p.had_password);
    }

    #[test]
    fn test_default_auth_list_is_password() {
        // SecureCRT 9.x defaults: publickey first, global key, no session key, "03:" password.
        let mut f = parse_session_ini(
            "S:\"Protocol Name\"=SSH2\r\nS:\"Hostname\"=backend.cn\r\nS:\"Username\"=admin\r\nS:\"Identity Filename V2\"=\r\n\
D:\"Use Global Public Key\"=00000001\r\nS:\"SSH2 Authentications V2\"=publickey,keyboard-interactive,password,gssapi\r\n",
        );
        f.insert("Password V2".into(), crypto::test_encrypt_v3("s3cret"));
        let p = session_from_fields(&f, &[], "backend", None).unwrap();
        assert_eq!(p.session.auth_type, AuthType::Password);
        assert_eq!(p.session.password.as_deref(), Some("s3cret"));
        assert!(!p.key_missing && !p.had_password);
        // No saved password either: still a password login (prompted when connecting).
        f.remove("Password V2");
        let p = session_from_fields(&f, &[], "backend", None).unwrap();
        assert_eq!(p.session.auth_type, AuthType::Password);
        assert!(!p.key_missing);
    }

    #[test]
    fn test_rdp_username_domain() {
        let rdp = |user: &str| {
            let f = HashMap::from([
                ("Protocol Name".to_string(), "RDP".to_string()),
                ("Hostname".to_string(), "192.0.2.10".to_string()),
                ("Port".to_string(), "3389".to_string()),
                ("Username".to_string(), user.to_string()),
            ]);
            let s = session_from_fields(&f, &[], "pc", None).unwrap().session;
            (s.username, s.desktop.unwrap().domain, s.port)
        };
        assert_eq!(rdp("192.0.2.10\\user@example.com"), ("user@example.com".into(), String::new(), 3389));
        assert_eq!(rdp("192.0.2.10\\admin"), ("admin".into(), String::new(), 3389));
        assert_eq!(rdp(".\\admin").0, "admin");
        assert_eq!(rdp("CORP\\alice"), ("alice".into(), "CORP".into(), 3389));
        assert_eq!(rdp("bob"), ("bob".into(), String::new(), 3389));
    }

    #[test]
    fn test_imports_saved_password() {
        let mut f = parse_session_ini("S:\"Protocol Name\"=SSH2\r\nS:\"Hostname\"=db.cn\r\nS:\"Username\"=root\r\n");
        // Legacy "Password" (double Blowfish) also decrypts.
        f.insert("Password".into(), crypto::test_encrypt_v1("p@ss w0rd"));
        let p = session_from_fields(&f, &[], "db", None).unwrap();
        assert_eq!(p.session.auth_type, AuthType::Password);
        assert_eq!(p.session.password.as_deref(), Some("p@ss w0rd"));
        assert!(!p.had_password);

        // A key wins over the password for the auth method, but the password is still kept.
        f.insert("Identity Filename V2".into(), "${VDS_CONFIG_PATH}\\Keys\\gone::rawkey".into());
        let p = session_from_fields(&f, &[], "db", None).unwrap();
        assert_eq!(p.session.auth_type, AuthType::PrivateKey);
        assert!(p.key_missing && p.session.password.as_deref() == Some("p@ss w0rd"));
    }

    #[test]
    fn test_credentials_folder_and_links() {
        let root = std::env::temp_dir().join(format!("nexterm-securecrt-cred-{}", Uuid::new_v4()));
        let config = root.join("Config");
        let (sessions, creds) = (config.join("Sessions"), config.join("Credentials"));
        fs::create_dir_all(&sessions).unwrap();
        fs::create_dir_all(&creds).unwrap();
        fs::create_dir_all(config.join("Keys")).unwrap();
        fs::write(config.join("Keys").join("id_ops"), "key").unwrap();
        let pw = crypto::test_encrypt_v3("hunter2");
        fs::write(creds.join("asdf.ini"), format!("S:\"Username\"=asdf\r\nS:\"Password V2\"={pw}\r\nS:\"Identity Filename V2\"=\r\n")).unwrap();
        fs::write(creds.join("ops.ini"), "S:\"Username\"=ops\r\nS:\"Identity Filename V2\"=${VDS_CONFIG_PATH}\\Keys\\id_ops::rawkey\r\n").unwrap();
        fs::write(creds.join("broken.ini"), "S:\"Username\"=nobody\r\nS:\"Password V2\"=03:00\r\n").unwrap();
        let session = |cred: &str| format!("S:\"Protocol Name\"=SSH2\r\nS:\"Hostname\"=h.cn\r\nS:\"Username\"=\r\nS:\"Credential Title\"={cred}\r\n");
        fs::write(sessions.join("a.ini"), session("ASDF")).unwrap();
        fs::write(sessions.join("b.ini"), session("ops")).unwrap();
        fs::write(sessions.join("c.ini"), session("broken")).unwrap();
        fs::write(sessions.join("d.ini"), session("gone")).unwrap();

        let r = import_path(&sessions).unwrap();
        let only_creds = import_path(&creds).unwrap();
        let one = import_path(&creds.join("asdf.ini")).unwrap();
        let _ = fs::remove_dir_all(&root);

        assert_eq!((r.credentials.len(), r.credentials_skipped), (2, 1));
        let asdf = r.credentials.iter().find(|c| c.name == "asdf").unwrap();
        assert_eq!((asdf.username.as_str(), asdf.auth_type.clone(), asdf.password.as_deref()), ("asdf", AuthType::Password, Some("hunter2")));
        let ops = r.credentials.iter().find(|c| c.name == "ops").unwrap();
        assert_eq!(ops.auth_type, AuthType::PrivateKey);
        assert!(ops.private_key_path.as_deref().unwrap().ends_with("id_ops"));

        let by = |l: &str| r.sessions.iter().find(|s| s.label == l).unwrap();
        // Title matched ignoring case; user name and kind copied, no secret on the session.
        let a = by("a");
        assert_eq!((a.credential_id.as_deref(), a.username.as_str(), a.auth_type.clone()), (Some(asdf.id.as_str()), "asdf", AuthType::Password));
        assert!(a.password.is_none());
        assert_eq!((by("b").credential_id.as_deref(), by("b").auth_type.clone()), (Some(ops.id.as_str()), AuthType::PrivateKey));
        // Not importable: the user name still fills an empty one; unknown: left as it is.
        assert_eq!((by("c").credential_id.as_deref(), by("c").username.as_str()), (None, "nobody"));
        assert_eq!((by("d").credential_id.as_deref(), by("d").username.as_str()), (None, ""));

        assert_eq!((only_creds.sessions.len(), only_creds.credentials.len()), (0, 2));
        assert_eq!((one.sessions.len(), one.credentials.len()), (0, 1));
    }

    #[test]
    fn test_credentials_wrong_passphrase() {
        let root = std::env::temp_dir().join(format!("nexterm-securecrt-credpp-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("asdf.ini");
        fs::write(&file, format!("S:\"Username\"=asdf\r\nS:\"Password V2\"={}\r\n", crypto::test_encrypt_v3("x"))).unwrap();
        let err = import_path_with(&file, b"typo").unwrap_err().to_string();
        let ok = import_path(&file).unwrap();
        let _ = fs::remove_dir_all(&root);
        assert_eq!(err, "securecrtPassphraseWrong");
        assert_eq!(ok.credentials[0].password.as_deref(), Some("x"));
    }

    #[test]
    fn test_xml_credentials() {
        let pw = crypto::test_encrypt_v2("s3cret");
        let xml = format!(r#"<VanDyke version="3.0">
  <key name="Credentials">
    <key name="lab"><string name="Username">root</string><string name="Password V2">{pw}</string></key>
  </key>
  <key name="Sessions">
    <key name="Credentials">
      <key name="web"><string name="Protocol Name">SSH2</string><string name="Hostname">web.cn</string><string name="Credential Title">lab</string></key>
    </key>
  </key>
</VanDyke>"#);
        let mut r = parse_xml_export(&xml, b"").unwrap();
        link_credentials(&mut r);
        assert_eq!(r.credentials.len(), 1);
        assert_eq!(r.credentials[0].password.as_deref(), Some("s3cret"));
        // A session folder called "Credentials" stays a session folder.
        assert_eq!(r.sessions.len(), 1);
        assert_eq!(r.sessions[0].group, "SecureCRT>Credentials");
        assert_eq!((r.sessions[0].username.as_str(), r.sessions[0].credential_id.as_deref()), ("root", Some(r.credentials[0].id.as_str())));
        // Credentials alone are an export too.
        assert!(parse_xml_export(r#"<VanDyke><key name="Credentials"></key></VanDyke>"#, b"").is_ok());
    }
}
