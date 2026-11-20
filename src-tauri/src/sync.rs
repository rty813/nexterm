//! Config export / import and sync to remote storage (S3-compatible, WebDAV, a GitHub
//! Gist, a local or network folder such as OneDrive / Dropbox / an SMB share).
//!
//! A bundle is one JSON file holding the selected data files:
//!
//! ```text
//! { "format": "nexterm-config", "version": 1, "hash", "exportedAt", "device",
//!   "data": { "sessions": [...], "settings": {...}, ... } }
//! ```
//!
//! With a password the `data` object is replaced by AES-256-GCM ciphertext
//! (key = PBKDF2-HMAC-SHA256(password, salt)); `hash` (SHA-256 of `data`) stays readable so
//! sync can tell whether the remote copy changed before asking for the password.
//!
//! Sync keeps the hashes of the last synced local and remote bundles in `sync_state.json`:
//! only the local side changed -> upload, only the remote side -> download, both -> conflict
//! (the user picks upload, download or merge).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use ring::digest::{digest, SHA256};
use ring::hmac;
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::models::{AppSettings, ImportedTheme, QuickCommand, SessionConfig};
use crate::storage::Storage;

pub const FORMAT: &str = "nexterm-config";
pub const VERSION: u64 = 1;
const PBKDF2_ITERATIONS: u32 = 210_000;

/// Category -> data files (without `.json`) it covers.
pub const CATEGORIES: &[(&str, &[&str])] = &[
    ("sessions", &["sessions"]),
    ("quickCommands", &["quick_commands"]),
    ("themes", &["custom_themes"]),
    ("settings", &["settings"]),
    ("senders", &["senders"]),
    ("history", &["command_history", "quick_connect_history"]),
    // Installed plugins (with their packages and configuration) and plugin stores (with access tokens).
    // Passwords plugins keep in Windows Credential Manager are the `credentials` category.
    ("plugins", &["plugins", "plugin_stores"]),
    // Passwords and tokens plugins keep in Windows Credential Manager (`plugin_credential`).
    // Not a data file: read from and written to the credential store. Opt-in, see `DEFAULT_OFF`.
    ("credentials", &[CREDENTIALS_FILE]),
];

/// Bundle entry holding the plugin credentials (`[{ target, value }]`, sorted by target).
const CREDENTIALS_FILE: &str = "plugin_credentials";
/// Categories only synced when asked for by name (none given = all the others).
const DEFAULT_OFF: &[&str] = &["credentials"];

/// Settings that belong to this computer: never exported, kept when importing.
const LOCAL_SETTING_KEYS: &[&str] = &["sync", "logDir", "zmodemDownloadDir", "xserver", "background"];
/// Remote access: the relay (address + token) is shared, the rest (`enabled`, `readOnly`) stays local.
/// The pairing secret lives in `remote_pairing.json` and is never synced.
const REMOTE_KEY: &str = "remote";

/// Error codes the frontend translates (`sync.err.<code>`).
pub mod code {
    pub const PASSWORD_REQUIRED: &str = "passwordRequired";
    pub const BAD_PASSWORD: &str = "badPassword";
    pub const BAD_FORMAT: &str = "badFormat";
    pub const NEWER_VERSION: &str = "newerVersion";
    pub const REMOTE_EMPTY: &str = "remoteEmpty";
    pub const NO_PROVIDER: &str = "noProvider";
}

// ------------------------------------------------------------------ config

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct S3Config {
    /// Empty: AWS (`https://s3.<region>.amazonaws.com`). R2, MinIO, OSS, COS ... give theirs.
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    /// Folder inside the bucket.
    pub prefix: String,
    /// `endpoint/bucket/key` instead of `bucket.endpoint/key` (MinIO and most self-hosted).
    pub path_style: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WebDavConfig {
    /// Folder URL, e.g. https://dav.jianguoyun.com/dav/nexterm/
    pub url: String,
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FolderConfig {
    pub path: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GistConfig {
    /// Personal access token with the `gist` scope (fine-grained: Gists read / write).
    pub token: String,
    /// Empty: the token owner's gist holding the file, created on first upload.
    pub gist_id: String,
    /// Empty: https://api.github.com. GitHub Enterprise: https://HOST/api/v3
    pub api_url: String,
}

/// `settings.sync` as the frontend saves it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SyncConfig {
    /// "none" | "s3" | "webdav" | "folder"
    pub provider: String,
    pub s3: S3Config,
    pub webdav: WebDavConfig,
    pub folder: FolderConfig,
    pub gist: GistConfig,
    pub file_name: String,
    /// Encryption password; empty = the file is stored as plain JSON.
    pub password: String,
    pub categories: Vec<String>,
}

impl SyncConfig {
    fn file_name(&self) -> String {
        let name = self.file_name.trim().trim_matches('/');
        if name.is_empty() { "nexterm-config.json".to_string() } else { name.to_string() }
    }

    /// Identifies the remote file, so switching target starts over.
    fn target_id(&self) -> String {
        match self.provider.as_str() {
            "s3" => format!("s3|{}|{}|{}|{}", self.s3.endpoint.trim(), self.s3.bucket.trim(), self.s3.prefix.trim_matches('/'), self.file_name()),
            "webdav" => format!("webdav|{}|{}", self.webdav.url.trim().trim_end_matches('/'), self.file_name()),
            "folder" => format!("folder|{}|{}", self.folder.path.trim(), self.file_name()),
            "gist" => format!("gist|{}|{}|{}", self.gist.api(), self.gist.gist_id.trim(), self.file_name()),
            other => other.to_string(),
        }
    }
}

// ------------------------------------------------------------------ bundle

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex(digest(&SHA256, bytes).as_ref())
}

/// Categories to use: the requested known ones, or all when none are given.
pub fn normalize_categories(requested: &[String]) -> Vec<String> {
    let known: Vec<String> = CATEGORIES
        .iter()
        .map(|(c, _)| c.to_string())
        .filter(|c| if requested.is_empty() { !DEFAULT_OFF.contains(&c.as_str()) } else { requested.contains(c) })
        .collect();
    known
}

fn files_of(categories: &[String]) -> Vec<&'static str> {
    CATEGORIES
        .iter()
        .filter(|(c, _)| categories.iter().any(|x| x == c))
        .flat_map(|(_, files)| files.iter().copied())
        .collect()
}

fn read_json(path: &Path) -> Option<Value> {
    fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok())
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|e| format!("{}: {}", tmp.display(), e))?;
    fs::rename(&tmp, path).map_err(|e| format!("{}: {}", path.display(), e))
}

/// `relayUrl` + `hostToken` of `settings.remote`; none without a relay address.
fn shared_remote(settings: &Value) -> Option<Map<String, Value>> {
    let remote = settings.get(REMOTE_KEY)?;
    let url = remote.get("relayUrl").and_then(Value::as_str).unwrap_or("").trim();
    if url.is_empty() {
        return None;
    }
    let token = remote.get("hostToken").and_then(Value::as_str).unwrap_or("");
    let mut out = Map::new();
    out.insert("relayUrl".into(), Value::String(url.into()));
    out.insert("hostToken".into(), Value::String(token.into()));
    Some(out)
}

fn strip_local_settings(value: &mut Value) {
    let shared = shared_remote(value);
    if let Some(obj) = value.as_object_mut() {
        for key in LOCAL_SETTING_KEYS {
            obj.remove(*key);
        }
        match shared {
            Some(r) => obj.insert(REMOTE_KEY.into(), Value::Object(r)),
            None => obj.remove(REMOTE_KEY),
        };
    }
}

/// The selected data files as a `data` object (absent files are left out).
pub fn collect(base: &Path, categories: &[String]) -> Map<String, Value> {
    let mut data = Map::new();
    for file in files_of(categories) {
        if file == CREDENTIALS_FILE {
            // Unreadable store: leave the entry out rather than sync an empty list.
            if let Ok(list) = crate::plugin_credentials::list_all() {
                data.insert(file.to_string(), credentials_value(&list));
            }
            continue;
        }
        let Some(mut value) = read_json(&base.join(format!("{file}.json"))) else { continue };
        if file == "settings" {
            strip_local_settings(&mut value);
        }
        data.insert(file.to_string(), value);
    }
    data
}

/// Hash of a `data` object (serde_json's map is ordered, so this is stable).
pub fn data_hash(data: &Map<String, Value>) -> String {
    sha256_hex(&serde_json::to_vec(data).unwrap_or_default())
}

fn device_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_default()
}

fn derive_key(password: &str, salt: &[u8], iterations: u32) -> LessSafeKey {
    let mut raw = [0u8; 32];
    ring::pbkdf2::derive(
        ring::pbkdf2::PBKDF2_HMAC_SHA256,
        std::num::NonZeroU32::new(iterations.max(1)).expect("non-zero"),
        salt,
        password.as_bytes(),
        &mut raw,
    );
    LessSafeKey::new(UnboundKey::new(&AES_256_GCM, &raw).expect("AES-256 key"))
}

/// Serialize a bundle, encrypting `data` when a password is given.
pub fn seal(data: &Map<String, Value>, password: &str) -> Result<Vec<u8>, String> {
    let mut out = Map::new();
    out.insert("format".into(), FORMAT.into());
    out.insert("version".into(), VERSION.into());
    out.insert("hash".into(), data_hash(data).into());
    out.insert("exportedAt".into(), chrono::Utc::now().to_rfc3339().into());
    out.insert("device".into(), device_name().into());
    if password.is_empty() {
        out.insert("data".into(), Value::Object(data.clone()));
    } else {
        let rng = SystemRandom::new();
        let mut salt = [0u8; 16];
        let mut nonce = [0u8; 12];
        rng.fill(&mut salt).map_err(|_| "random".to_string())?;
        rng.fill(&mut nonce).map_err(|_| "random".to_string())?;
        let key = derive_key(password, &salt, PBKDF2_ITERATIONS);
        let mut buf = serde_json::to_vec(data).map_err(|e| e.to_string())?;
        key.seal_in_place_append_tag(Nonce::assume_unique_for_key(nonce), Aad::from(FORMAT.as_bytes()), &mut buf)
            .map_err(|_| "encrypt".to_string())?;
        out.insert(
            "encryption".into(),
            serde_json::json!({
                "kdf": "pbkdf2-sha256",
                "iterations": PBKDF2_ITERATIONS,
                "salt": B64.encode(salt),
                "nonce": B64.encode(nonce),
                "cipher": "aes-256-gcm",
            }),
        );
        out.insert("ciphertext".into(), B64.encode(buf).into());
    }
    serde_json::to_vec_pretty(&Value::Object(out)).map_err(|e| e.to_string())
}

/// A bundle read back, `data` still sealed when it is encrypted.
#[derive(Debug, Clone)]
pub struct Envelope {
    pub hash: String,
    pub exported_at: String,
    pub device: String,
    raw: Map<String, Value>,
}

impl Envelope {
    pub fn parse(bytes: &[u8]) -> Result<Self, String> {
        let raw: Map<String, Value> = serde_json::from_slice(bytes).map_err(|_| code::BAD_FORMAT.to_string())?;
        if raw.get("format").and_then(Value::as_str) != Some(FORMAT) {
            return Err(code::BAD_FORMAT.into());
        }
        if raw.get("version").and_then(Value::as_u64).unwrap_or(0) > VERSION {
            return Err(code::NEWER_VERSION.into());
        }
        let s = |k: &str| raw.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
        let mut env = Envelope { hash: s("hash"), exported_at: s("exportedAt"), device: s("device"), raw };
        if env.hash.is_empty() {
            if let Some(Value::Object(data)) = env.raw.get("data") {
                env.hash = data_hash(data);
            }
        }
        Ok(env)
    }

    pub fn encrypted(&self) -> bool {
        self.raw.contains_key("ciphertext")
    }

    pub fn open(&self, password: &str) -> Result<Map<String, Value>, String> {
        if !self.encrypted() {
            return match self.raw.get("data") {
                Some(Value::Object(data)) => Ok(data.clone()),
                _ => Err(code::BAD_FORMAT.into()),
            };
        }
        if password.is_empty() {
            return Err(code::PASSWORD_REQUIRED.into());
        }
        let enc = self.raw.get("encryption").ok_or(code::BAD_FORMAT)?;
        let field = |k: &str| -> Result<Vec<u8>, String> {
            enc.get(k)
                .and_then(Value::as_str)
                .and_then(|v| B64.decode(v).ok())
                .ok_or_else(|| code::BAD_FORMAT.to_string())
        };
        let salt = field("salt")?;
        let nonce: [u8; 12] = field("nonce")?.try_into().map_err(|_| code::BAD_FORMAT.to_string())?;
        let iterations = enc.get("iterations").and_then(Value::as_u64).unwrap_or(PBKDF2_ITERATIONS as u64) as u32;
        let mut buf = self
            .raw
            .get("ciphertext")
            .and_then(Value::as_str)
            .and_then(|v| B64.decode(v).ok())
            .ok_or(code::BAD_FORMAT)?;
        let key = derive_key(password, &salt, iterations);
        let plain = key
            .open_in_place(Nonce::assume_unique_for_key(nonce), Aad::from(FORMAT.as_bytes()), &mut buf)
            .map_err(|_| code::BAD_PASSWORD.to_string())?;
        serde_json::from_slice(plain).map_err(|_| code::BAD_FORMAT.to_string())
    }

    /// Categories present (only known for plain bundles).
    pub fn categories(&self) -> Option<Vec<String>> {
        let Some(Value::Object(data)) = self.raw.get("data") else { return None };
        Some(
            CATEGORIES
                .iter()
                .filter(|(_, files)| files.iter().any(|f| data.contains_key(*f)))
                .map(|(c, _)| c.to_string())
                .collect(),
        )
    }
}

// ------------------------------------------------------------------ apply

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ImportMode {
    /// Same id: incoming wins; everything else is kept.
    Merge,
    /// The imported lists replace the local ones.
    Replace,
}

fn item_key(v: &Value) -> String {
    match v.get("id").and_then(Value::as_str) {
        Some(id) => format!("id:{id}"),
        None => v.to_string(),
    }
}

/// Merge two JSON arrays: items with the same `id` (or equal items without one) are
/// replaced in place by the incoming one, new items are appended.
pub fn merge_lists(local: &Value, incoming: &Value) -> Value {
    let mut out: Vec<Value> = local.as_array().cloned().unwrap_or_default();
    for item in incoming.as_array().into_iter().flatten() {
        let key = item_key(item);
        match out.iter().position(|x| item_key(x) == key) {
            Some(i) => out[i] = item.clone(),
            None => out.push(item.clone()),
        }
    }
    Value::Array(out)
}

/// Incoming settings on top of local ones; this computer's own keys always stay local,
/// and of `remote` only the relay comes in (an incoming one without an address changes nothing).
pub fn merge_settings(local: &Value, incoming: &Value, mode: ImportMode) -> Value {
    let local_obj = local.as_object().cloned().unwrap_or_default();
    let mut out = match mode {
        ImportMode::Merge => local_obj.clone(),
        ImportMode::Replace => Map::new(),
    };
    for (k, v) in incoming.as_object().into_iter().flatten() {
        if !LOCAL_SETTING_KEYS.contains(&k.as_str()) && k != REMOTE_KEY {
            out.insert(k.clone(), v.clone());
        }
    }
    for key in LOCAL_SETTING_KEYS {
        match local_obj.get(*key) {
            Some(v) => out.insert(key.to_string(), v.clone()),
            None => out.remove(*key),
        };
    }
    let mut remote = local_obj.get(REMOTE_KEY).cloned();
    if let Some(shared) = shared_remote(incoming) {
        let mut r = remote.and_then(|v| v.as_object().cloned()).unwrap_or_default();
        r.extend(shared);
        remote = Some(Value::Object(r));
    }
    match remote {
        Some(v) => out.insert(REMOTE_KEY.into(), v),
        None => out.remove(REMOTE_KEY),
    };
    Value::Object(out)
}

fn validate(file: &str, value: &Value) -> Result<(), String> {
    let bad = |e: serde_json::Error| format!("{}: {}", file, e);
    match file {
        "sessions" => serde_json::from_value::<Vec<SessionConfig>>(value.clone()).map(|_| ()).map_err(bad),
        "quick_commands" => serde_json::from_value::<Vec<QuickCommand>>(value.clone()).map(|_| ()).map_err(bad),
        "custom_themes" => serde_json::from_value::<Vec<ImportedTheme>>(value.clone()).map(|_| ()).map_err(bad),
        "settings" => serde_json::from_value::<AppSettings>(value.clone()).map(|_| ()).map_err(bad),
        _ if value.is_array() => Ok(()),
        _ => Err(format!("{}: {}", file, code::BAD_FORMAT)),
    }
}

/// Copy the current data files to `backups/<time>/` (the last 10 are kept).
fn backup(base: &Path, files: &[&str]) -> Result<PathBuf, String> {
    let root = base.join("backups");
    let dir = root.join(chrono::Local::now().format("%Y%m%d-%H%M%S%.3f").to_string());
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    for file in files {
        let src = base.join(format!("{file}.json"));
        if src.exists() {
            fs::copy(&src, dir.join(format!("{file}.json"))).map_err(|e| e.to_string())?;
        }
    }
    if let Ok(entries) = fs::read_dir(&root) {
        let mut dirs: Vec<PathBuf> = entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
        dirs.sort();
        while dirs.len() > 10 {
            let _ = fs::remove_dir_all(dirs.remove(0));
        }
    }
    Ok(dir)
}

/// Write `data` into the data folder. Returns the categories that were applied.
pub fn apply(base: &Path, data: &Map<String, Value>, categories: &[String], mode: ImportMode) -> Result<Vec<String>, String> {
    let files: Vec<&str> = files_of(categories).into_iter().filter(|f| data.contains_key(*f)).collect();
    // Validate everything before touching a file.
    let mut planned = Vec::new();
    let mut credentials = None;
    for file in &files {
        if *file == CREDENTIALS_FILE {
            let incoming = parse_credentials(&data[*file])?;
            let local = crate::plugin_credentials::list_all()?;
            credentials = Some(plan_credentials(&local, &incoming, mode));
            continue;
        }
        let path = base.join(format!("{file}.json"));
        let local = read_json(&path);
        let incoming = &data[*file];
        let next = match (*file, mode, local) {
            ("settings", _, local) => merge_settings(&local.unwrap_or(Value::Null), incoming, mode),
            (_, ImportMode::Merge, Some(local)) => merge_lists(&local, incoming),
            _ => incoming.clone(),
        };
        validate(file, &next)?;
        planned.push((path, next));
    }
    if planned.is_empty() && credentials.is_none() {
        return Ok(Vec::new());
    }
    // Credentials are not copied into the (plain text) backup folder.
    let backed: Vec<&str> = files.iter().copied().filter(|f| *f != CREDENTIALS_FILE).collect();
    backup(base, &backed)?;
    for (path, value) in &planned {
        write_json(path, value)?;
    }
    if let Some(plan) = credentials {
        for (target, value) in &plan.set {
            crate::plugin_credentials::put(target, value)?;
        }
        for target in &plan.delete {
            crate::plugin_credentials::remove(target)?;
        }
    }
    Ok(CATEGORIES
        .iter()
        .filter(|(c, fs)| categories.iter().any(|x| x == c) && fs.iter().any(|f| files.contains(f)))
        .map(|(c, _)| c.to_string())
        .collect())
}

// ------------------------------------------------------------------ plugin credentials

fn credentials_value(list: &[(String, String)]) -> Value {
    Value::Array(list.iter().map(|(t, v)| serde_json::json!({ "target": t, "value": v })).collect())
}

/// The bundle's credentials, checked: only plugin credential names, values within the store's limit.
fn parse_credentials(value: &Value) -> Result<Vec<(String, String)>, String> {
    let bad = || format!("{}: {}", CREDENTIALS_FILE, code::BAD_FORMAT);
    let mut out = Vec::new();
    for item in value.as_array().ok_or_else(bad)? {
        let target = item.get("target").and_then(Value::as_str).ok_or_else(bad)?;
        let value = item.get("value").and_then(Value::as_str).ok_or_else(bad)?;
        if !crate::plugin_credentials::valid_target(target) || value.len() > crate::plugin_credentials::MAX_VALUE {
            return Err(bad());
        }
        out.push((target.to_string(), value.to_string()));
    }
    Ok(out)
}

/// What importing credentials changes in the store.
#[derive(Debug, Default, PartialEq, Eq)]
struct CredentialPlan {
    set: Vec<(String, String)>,
    delete: Vec<String>,
}

/// Merge: incoming credentials are written (unchanged ones skipped), local ones stay.
/// Replace: in addition, local credentials the bundle does not have are deleted.
fn plan_credentials(local: &[(String, String)], incoming: &[(String, String)], mode: ImportMode) -> CredentialPlan {
    let set = incoming.iter().filter(|c| !local.contains(c)).cloned().collect();
    let delete = match mode {
        ImportMode::Merge => Vec::new(),
        ImportMode::Replace => local.iter().filter(|(t, _)| !incoming.iter().any(|(i, _)| i == t)).map(|(t, _)| t.clone()).collect(),
    };
    CredentialPlan { set, delete }
}

// ------------------------------------------------------------------ remote storage

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(10))
        .user_agent(concat!("Nexterm/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())
}

async fn http_error(what: &str, resp: reqwest::Response) -> String {
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let detail: String = body.chars().take(300).collect();
    format!("{what}: HTTP {status} {}", detail.trim())
}

/// RFC 3986 encoding of one path segment (S3 canonical URI rules).
fn encode_segment(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn hmac_sha256(key: &[u8], msg: &str) -> Vec<u8> {
    hmac::sign(&hmac::Key::new(hmac::HMAC_SHA256, key), msg.as_bytes()).as_ref().to_vec()
}

/// AWS Signature V4 `Authorization` header. `headers` are lower-case names with their
/// values, all of them signed; `path` is already URI-encoded.
#[allow(clippy::too_many_arguments)]
pub fn sigv4_authorization(
    method: &str,
    path: &str,
    query: &str,
    headers: &[(&str, String)],
    payload_hash: &str,
    access_key: &str,
    secret_key: &str,
    region: &str,
    amz_date: &str,
) -> String {
    let mut sorted: Vec<(&str, &str)> = headers.iter().map(|(k, v)| (*k, v.trim())).collect();
    sorted.sort_by(|a, b| a.0.cmp(b.0));
    let canonical_headers: String = sorted.iter().map(|(k, v)| format!("{k}:{v}\n")).collect();
    let signed_headers = sorted.iter().map(|(k, _)| *k).collect::<Vec<_>>().join(";");
    let canonical = format!("{method}\n{path}\n{query}\n{canonical_headers}\n{signed_headers}\n{payload_hash}");
    let date = &amz_date[..8];
    let scope = format!("{date}/{region}/s3/aws4_request");
    let to_sign = format!("AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}", sha256_hex(canonical.as_bytes()));
    let k_date = hmac_sha256(format!("AWS4{secret_key}").as_bytes(), date);
    let k_region = hmac_sha256(&k_date, region);
    let k_service = hmac_sha256(&k_region, "s3");
    let k_signing = hmac_sha256(&k_service, "aws4_request");
    let signature = hex(&hmac_sha256(&k_signing, &to_sign));
    format!("AWS4-HMAC-SHA256 Credential={access_key}/{scope}, SignedHeaders={signed_headers}, Signature={signature}")
}

impl S3Config {
    fn region(&self) -> String {
        let r = self.region.trim();
        if r.is_empty() { "us-east-1".to_string() } else { r.to_string() }
    }

    /// Object URL for `name`.
    fn object_url(&self, name: &str) -> Result<reqwest::Url, String> {
        let bucket = self.bucket.trim();
        if bucket.is_empty() || self.access_key_id.trim().is_empty() || self.secret_access_key.is_empty() {
            return Err(code::NO_PROVIDER.into());
        }
        let key: Vec<String> = self
            .prefix
            .split('/')
            .chain(name.split('/'))
            .filter(|s| !s.is_empty())
            .map(encode_segment)
            .collect();
        let key = key.join("/");
        let endpoint = self.endpoint.trim().trim_end_matches('/');
        let endpoint = if endpoint.is_empty() {
            format!("https://s3.{}.amazonaws.com", self.region())
        } else if endpoint.contains("://") {
            endpoint.to_string()
        } else {
            format!("https://{endpoint}")
        };
        let base = reqwest::Url::parse(&endpoint).map_err(|e| format!("{endpoint}: {e}"))?;
        let url = if self.path_style {
            format!("{}/{}/{}", endpoint, encode_segment(bucket), key)
        } else {
            let host = base.host_str().ok_or_else(|| format!("{endpoint}: no host"))?;
            let port = base.port().map(|p| format!(":{p}")).unwrap_or_default();
            format!("{}://{}.{}{}/{}", base.scheme(), bucket, host, port, key)
        };
        reqwest::Url::parse(&url).map_err(|e| format!("{url}: {e}"))
    }

    fn signed(&self, client: &reqwest::Client, method: reqwest::Method, url: &reqwest::Url, body: &[u8]) -> reqwest::RequestBuilder {
        let host = match url.port() {
            Some(p) => format!("{}:{}", url.host_str().unwrap_or_default(), p),
            None => url.host_str().unwrap_or_default().to_string(),
        };
        let amz_date = chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
        let payload_hash = sha256_hex(body);
        let headers = [
            ("host", host),
            ("x-amz-content-sha256", payload_hash.clone()),
            ("x-amz-date", amz_date.clone()),
        ];
        let auth = sigv4_authorization(
            method.as_str(),
            url.path(),
            url.query().unwrap_or_default(),
            &headers,
            &payload_hash,
            self.access_key_id.trim(),
            &self.secret_access_key,
            &self.region(),
            &amz_date,
        );
        client
            .request(method, url.clone())
            .header("x-amz-content-sha256", payload_hash)
            .header("x-amz-date", amz_date)
            .header("authorization", auth)
    }
}

impl WebDavConfig {
    fn file_url(&self, name: &str) -> Result<(reqwest::Url, reqwest::Url), String> {
        let base = self.url.trim();
        if base.is_empty() {
            return Err(code::NO_PROVIDER.into());
        }
        let dir = format!("{}/", base.trim_end_matches('/'));
        let dir = reqwest::Url::parse(&dir).map_err(|e| format!("{base}: {e}"))?;
        let path: Vec<String> = name.split('/').filter(|s| !s.is_empty()).map(encode_segment).collect();
        let file = dir.join(&path.join("/")).map_err(|e| e.to_string())?;
        Ok((dir, file))
    }

    fn auth(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        if self.username.is_empty() && self.password.is_empty() {
            req
        } else {
            req.basic_auth(&self.username, Some(&self.password))
        }
    }
}

impl GistConfig {
    fn api(&self) -> String {
        let url = self.api_url.trim().trim_end_matches('/');
        if url.is_empty() { "https://api.github.com".to_string() } else { url.to_string() }
    }

    fn request(&self, client: &reqwest::Client, method: reqwest::Method, url: &str) -> reqwest::RequestBuilder {
        client
            .request(method, url)
            .bearer_auth(self.token.trim())
            .header("accept", "application/vnd.github+json")
            .header("x-github-api-version", "2022-11-28")
    }

    async fn get_json(&self, client: &reqwest::Client, url: &str) -> Result<Option<Value>, String> {
        if self.token.trim().is_empty() {
            return Err(code::NO_PROVIDER.into());
        }
        let resp = self.request(client, reqwest::Method::GET, url).send().await.map_err(|e| format!("{e:#}"))?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !resp.status().is_success() {
            return Err(http_error("GitHub", resp).await);
        }
        resp.json().await.map(Some).map_err(|e| e.to_string())
    }

    /// The gist to use: the configured one, else the token owner's gist holding `name`.
    /// Returns the gist JSON (None: no such gist yet).
    async fn find(&self, client: &reqwest::Client, name: &str) -> Result<Option<Value>, String> {
        let api = self.api();
        let id = self.gist_id.trim();
        if !id.is_empty() {
            return match self.get_json(client, &format!("{api}/gists/{id}")).await? {
                Some(g) => Ok(Some(g)),
                None => Err(format!("GitHub: gist {id} not found")),
            };
        }
        for page in 1..=10 {
            let list = self
                .get_json(client, &format!("{api}/gists?per_page=100&page={page}"))
                .await?
                .and_then(|v| v.as_array().cloned())
                .unwrap_or_default();
            if let Some(g) = list.iter().find(|g| g.get("files").and_then(|f| f.get(name)).is_some()) {
                let id = g.get("id").and_then(Value::as_str).unwrap_or_default();
                // The list leaves file contents out: read the gist itself.
                return self.get_json(client, &format!("{api}/gists/{id}")).await;
            }
            if list.len() < 100 {
                break;
            }
        }
        Ok(None)
    }

    async fn read(&self, name: &str) -> Result<Option<Vec<u8>>, String> {
        let client = client()?;
        let Some(gist) = self.find(&client, name).await? else { return Ok(None) };
        let Some(file) = gist.get("files").and_then(|f| f.get(name)) else { return Ok(None) };
        // Files over 1 MB come truncated: fetch the raw file.
        if file.get("truncated").and_then(Value::as_bool) == Some(true) {
            let raw = file.get("raw_url").and_then(Value::as_str).ok_or(code::BAD_FORMAT)?;
            let resp = self.request(&client, reqwest::Method::GET, raw).send().await.map_err(|e| format!("{e:#}"))?;
            if !resp.status().is_success() {
                return Err(http_error("GitHub", resp).await);
            }
            return Ok(Some(resp.bytes().await.map_err(|e| e.to_string())?.to_vec()));
        }
        Ok(file.get("content").and_then(Value::as_str).map(|c| c.as_bytes().to_vec()))
    }

    async fn write(&self, name: &str, bytes: Vec<u8>) -> Result<(), String> {
        let client = client()?;
        let content = String::from_utf8(bytes).map_err(|e| e.to_string())?;
        let files = serde_json::json!({ name: { "content": content } });
        let api = self.api();
        let req = match self.find(&client, name).await? {
            Some(gist) => {
                let id = gist.get("id").and_then(Value::as_str).unwrap_or_default();
                self.request(&client, reqwest::Method::PATCH, &format!("{api}/gists/{id}"))
                    .json(&serde_json::json!({ "files": files }))
            }
            None => self
                .request(&client, reqwest::Method::POST, &format!("{api}/gists"))
                .json(&serde_json::json!({ "description": "Nexterm config sync", "public": false, "files": files })),
        };
        let resp = req.send().await.map_err(|e| format!("{e:#}"))?;
        if !resp.status().is_success() {
            return Err(http_error("GitHub", resp).await);
        }
        Ok(())
    }
}

/// Read the remote bundle (`None`: not there yet).
pub async fn remote_get(cfg: &SyncConfig) -> Result<Option<Vec<u8>>, String> {
    let name = cfg.file_name();
    match cfg.provider.as_str() {
        "s3" => {
            let client = client()?;
            let url = cfg.s3.object_url(&name)?;
            let resp = cfg.s3.signed(&client, reqwest::Method::GET, &url, b"").send().await.map_err(|e| format!("{e:#}"))?;
            if resp.status() == reqwest::StatusCode::NOT_FOUND {
                return Ok(None);
            }
            if !resp.status().is_success() {
                return Err(http_error("S3 GET", resp).await);
            }
            Ok(Some(resp.bytes().await.map_err(|e| e.to_string())?.to_vec()))
        }
        "webdav" => {
            let client = client()?;
            let (_, url) = cfg.webdav.file_url(&name)?;
            let resp = cfg.webdav.auth(client.get(url)).send().await.map_err(|e| format!("{e:#}"))?;
            if resp.status() == reqwest::StatusCode::NOT_FOUND {
                return Ok(None);
            }
            if !resp.status().is_success() {
                return Err(http_error("WebDAV GET", resp).await);
            }
            Ok(Some(resp.bytes().await.map_err(|e| e.to_string())?.to_vec()))
        }
        "folder" => {
            let dir = cfg.folder.path.trim();
            if dir.is_empty() {
                return Err(code::NO_PROVIDER.into());
            }
            if !Path::new(dir).is_dir() {
                return Err(format!("{dir}: folder not found"));
            }
            match fs::read(Path::new(dir).join(&name)) {
                Ok(bytes) => Ok(Some(bytes)),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(e.to_string()),
            }
        }
        "gist" => cfg.gist.read(&name).await,
        _ => Err(code::NO_PROVIDER.into()),
    }
}

/// Write the remote bundle.
pub async fn remote_put(cfg: &SyncConfig, bytes: Vec<u8>) -> Result<(), String> {
    let name = cfg.file_name();
    match cfg.provider.as_str() {
        "s3" => {
            let client = client()?;
            let url = cfg.s3.object_url(&name)?;
            let resp = cfg
                .s3
                .signed(&client, reqwest::Method::PUT, &url, &bytes)
                .header("content-type", "application/json")
                .body(bytes)
                .send()
                .await
                .map_err(|e| format!("{e:#}"))?;
            if !resp.status().is_success() {
                return Err(http_error("S3 PUT", resp).await);
            }
            Ok(())
        }
        "webdav" => {
            let client = client()?;
            let (dir, url) = cfg.webdav.file_url(&name)?;
            let put = || {
                cfg.webdav
                    .auth(client.put(url.clone()))
                    .header("content-type", "application/json")
                    .body(bytes.clone())
                    .send()
            };
            let mut resp = put().await.map_err(|e| format!("{e:#}"))?;
            // The folder does not exist yet: create it once and retry.
            if matches!(resp.status().as_u16(), 404 | 409) {
                let mkcol = reqwest::Method::from_bytes(b"MKCOL").expect("method");
                let _ = cfg.webdav.auth(client.request(mkcol, dir)).send().await;
                resp = put().await.map_err(|e| format!("{e:#}"))?;
            }
            if !resp.status().is_success() {
                return Err(http_error("WebDAV PUT", resp).await);
            }
            Ok(())
        }
        "folder" => {
            let dir = cfg.folder.path.trim();
            if dir.is_empty() {
                return Err(code::NO_PROVIDER.into());
            }
            let path = Path::new(dir).join(&name);
            let tmp = path.with_extension("tmp");
            fs::write(&tmp, &bytes).map_err(|e| format!("{}: {}", tmp.display(), e))?;
            fs::rename(&tmp, &path).map_err(|e| format!("{}: {}", path.display(), e))
        }
        "gist" => cfg.gist.write(&name, bytes).await,
        _ => Err(code::NO_PROVIDER.into()),
    }
}

// ------------------------------------------------------------------ sync

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SyncState {
    pub target: String,
    pub local_hash: String,
    pub remote_hash: String,
    /// Unix ms of the last successful sync.
    pub last_sync: i64,
    pub last_result: String,
}

pub fn load_state(base: &Path) -> SyncState {
    read_json(&base.join("sync_state.json"))
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

pub fn save_state(base: &Path, state: &SyncState) -> Result<(), String> {
    write_json(&base.join("sync_state.json"), &serde_json::to_value(state).map_err(|e| e.to_string())?)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncAction {
    /// Upload or download whichever side changed; report a conflict when both did.
    Auto,
    /// Overwrite the remote copy with this computer's.
    Push,
    /// Overwrite this computer's data with the remote copy.
    Pull,
    /// Merge the remote copy into this computer's data, then upload the result.
    Merge,
}

/// What `decide` picked for an `Auto` sync.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    UpToDate,
    Push,
    Pull,
    Conflict,
}

/// `remote_hash` is None when there is no remote file yet.
pub fn decide(state: &SyncState, target: &str, local_hash: &str, remote_hash: Option<&str>) -> Decision {
    let Some(remote_hash) = remote_hash else { return Decision::Push };
    if remote_hash == local_hash {
        return Decision::UpToDate;
    }
    if state.target != target || state.local_hash.is_empty() {
        // Never synced with this target and both sides differ: let the user choose.
        return Decision::Conflict;
    }
    let local_changed = state.local_hash != local_hash;
    let remote_changed = state.remote_hash != remote_hash;
    match (local_changed, remote_changed) {
        (true, false) => Decision::Push,
        (false, true) => Decision::Pull,
        (false, false) => Decision::Conflict, // state out of step with both sides
        (true, true) => Decision::Conflict,
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOutcome {
    /// "uploaded" | "downloaded" | "merged" | "upToDate" | "conflict"
    pub result: String,
    /// Categories written to this computer (download / merge).
    pub applied: Vec<String>,
    pub remote_device: String,
    pub remote_time: String,
    pub at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleInfo {
    pub encrypted: bool,
    pub exported_at: String,
    pub device: String,
    /// None for encrypted files (unknown until opened).
    pub categories: Option<Vec<String>>,
}

impl From<&Envelope> for BundleInfo {
    fn from(env: &Envelope) -> Self {
        BundleInfo {
            encrypted: env.encrypted(),
            exported_at: env.exported_at.clone(),
            device: env.device.clone(),
            categories: env.categories(),
        }
    }
}

fn base_of(storage: &Mutex<Storage>) -> Result<PathBuf, String> {
    Ok(storage.lock().map_err(|e| e.to_string())?.base_dir().to_path_buf())
}

/// Apply with the storage lock held, so a concurrent save_* command cannot interleave.
pub fn apply_locked(storage: &Mutex<Storage>, data: &Map<String, Value>, categories: &[String], mode: ImportMode) -> Result<Vec<String>, String> {
    let guard = storage.lock().map_err(|e| e.to_string())?;
    apply(guard.base_dir(), data, categories, mode)
}

/// One sync with the remote file.
pub async fn run(storage: &Mutex<Storage>, cfg: &SyncConfig, action: SyncAction) -> Result<SyncOutcome, String> {
    let base = base_of(storage)?;
    let categories = normalize_categories(&cfg.categories);
    let target = cfg.target_id();
    let mut state = load_state(&base);
    let local = collect(&base, &categories);
    let local_hash = data_hash(&local);
    let remote = match remote_get(cfg).await? {
        Some(bytes) => Some(Envelope::parse(&bytes)?),
        None => None,
    };
    let mut outcome = SyncOutcome {
        result: String::new(),
        applied: Vec::new(),
        remote_device: remote.as_ref().map(|r| r.device.clone()).unwrap_or_default(),
        remote_time: remote.as_ref().map(|r| r.exported_at.clone()).unwrap_or_default(),
        at: chrono::Utc::now().timestamp_millis(),
    };

    let decision = match action {
        SyncAction::Auto => decide(&state, &target, &local_hash, remote.as_ref().map(|r| r.hash.as_str())),
        SyncAction::Push => Decision::Push,
        SyncAction::Pull | SyncAction::Merge if remote.is_none() => return Err(code::REMOTE_EMPTY.into()),
        SyncAction::Pull => Decision::Pull,
        SyncAction::Merge => Decision::Conflict, // handled below
    };

    let (new_local, new_remote) = match (action, decision) {
        (_, Decision::UpToDate) => {
            outcome.result = "upToDate".into();
            (local_hash.clone(), local_hash)
        }
        (SyncAction::Merge, _) => {
            let remote = remote.as_ref().expect("checked above");
            let data = remote.open(&cfg.password)?;
            outcome.applied = apply_locked(storage, &data, &categories, ImportMode::Merge)?;
            let merged = collect(&base, &categories);
            remote_put(cfg, seal(&merged, &cfg.password)?).await?;
            outcome.result = "merged".into();
            let h = data_hash(&merged);
            (h.clone(), h)
        }
        (_, Decision::Push) => {
            remote_put(cfg, seal(&local, &cfg.password)?).await?;
            outcome.result = "uploaded".into();
            (local_hash.clone(), local_hash)
        }
        (_, Decision::Pull) => {
            let remote = remote.as_ref().expect("pull needs a remote file");
            let data = remote.open(&cfg.password)?;
            outcome.applied = apply_locked(storage, &data, &categories, ImportMode::Replace)?;
            outcome.result = "downloaded".into();
            (data_hash(&collect(&base, &categories)), remote.hash.clone())
        }
        (_, Decision::Conflict) => {
            outcome.result = "conflict".into();
            state.last_result = outcome.result.clone();
            save_state(&base, &state)?;
            return Ok(outcome);
        }
    };
    state = SyncState {
        target,
        local_hash: new_local,
        remote_hash: new_remote,
        last_sync: outcome.at,
        last_result: outcome.result.clone(),
    };
    save_state(&base, &state)?;
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tmp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nexterm-sync-test-{}-{}", name, uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn sigv4_matches_aws_example() {
        // "Example: GET Object" from the AWS Signature V4 documentation for S3.
        let empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        let auth = sigv4_authorization(
            "GET",
            "/test.txt",
            "",
            &[
                ("host", "examplebucket.s3.amazonaws.com".into()),
                ("range", "bytes=0-9".into()),
                ("x-amz-content-sha256", empty.into()),
                ("x-amz-date", "20130524T000000Z".into()),
            ],
            empty,
            "AKIAIOSFODNN7EXAMPLE",
            "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
            "us-east-1",
            "20130524T000000Z",
        );
        assert_eq!(
            auth,
            "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, \
             SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, \
             Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
        );
    }

    #[test]
    fn s3_urls() {
        let mut s3 = S3Config {
            region: "eu-west-1".into(),
            bucket: "b".into(),
            access_key_id: "k".into(),
            secret_access_key: "s".into(),
            prefix: "/team configs/".into(),
            ..Default::default()
        };
        assert_eq!(
            s3.object_url("a.json").unwrap().as_str(),
            "https://b.s3.eu-west-1.amazonaws.com/team%20configs/a.json"
        );
        s3.endpoint = "http://127.0.0.1:9000".into();
        s3.path_style = true;
        assert_eq!(s3.object_url("a.json").unwrap().as_str(), "http://127.0.0.1:9000/b/team%20configs/a.json");
    }

    #[test]
    fn webdav_url_keeps_folder() {
        let dav = WebDavConfig { url: "https://dav.example.com/dav/nexterm".into(), ..Default::default() };
        let (dir, file) = dav.file_url("my config.json").unwrap();
        assert_eq!(dir.as_str(), "https://dav.example.com/dav/nexterm/");
        assert_eq!(file.as_str(), "https://dav.example.com/dav/nexterm/my%20config.json");
    }

    #[test]
    fn seal_roundtrip_plain_and_encrypted() {
        let mut data = Map::new();
        data.insert("sessions".into(), json!([{ "id": "1" }]));
        let plain = Envelope::parse(&seal(&data, "").unwrap()).unwrap();
        assert!(!plain.encrypted());
        assert_eq!(plain.open("").unwrap(), data);
        assert_eq!(plain.hash, data_hash(&data));
        assert_eq!(plain.categories().unwrap(), vec!["sessions".to_string()]);

        let sealed = seal(&data, "pw").unwrap();
        assert!(!String::from_utf8_lossy(&sealed).contains("\"id\""));
        let env = Envelope::parse(&sealed).unwrap();
        assert!(env.encrypted());
        assert_eq!(env.hash, data_hash(&data));
        assert_eq!(env.open("").unwrap_err(), code::PASSWORD_REQUIRED);
        assert_eq!(env.open("wrong").unwrap_err(), code::BAD_PASSWORD);
        assert_eq!(env.open("pw").unwrap(), data);
    }

    #[test]
    fn rejects_foreign_and_newer_files() {
        assert_eq!(Envelope::parse(b"{\"a\":1}").unwrap_err(), code::BAD_FORMAT);
        assert_eq!(Envelope::parse(b"not json").unwrap_err(), code::BAD_FORMAT);
        let newer = json!({ "format": FORMAT, "version": VERSION + 1, "data": {} });
        assert_eq!(Envelope::parse(newer.to_string().as_bytes()).unwrap_err(), code::NEWER_VERSION);
    }

    #[test]
    fn merge_lists_by_id() {
        let local = json!([{ "id": "a", "v": 1 }, { "id": "b", "v": 1 }, "x"]);
        let incoming = json!([{ "id": "b", "v": 2 }, { "id": "c", "v": 2 }, "x", "y"]);
        assert_eq!(
            merge_lists(&local, &incoming),
            json!([{ "id": "a", "v": 1 }, { "id": "b", "v": 2 }, "x", { "id": "c", "v": 2 }, "y"])
        );
    }

    #[test]
    fn credentials_are_opt_in_checked_and_planned() {
        assert!(!normalize_categories(&[]).contains(&"credentials".to_string()));
        assert_eq!(normalize_categories(&["credentials".into()]), vec!["credentials".to_string()]);

        let t = |p: &str, c: char| format!("Nexterm/Plugins/{p}/{}", c.to_string().repeat(64));
        let (a, b, c) = (t("team.a", 'a'), t("team.a", 'b'), t("team.b", 'c'));
        let parsed = parse_credentials(&credentials_value(&[(a.clone(), "new".into()), (b.clone(), "same".into())])).unwrap();
        assert!(parse_credentials(&json!([{ "target": "Other/x", "value": "v" }])).is_err());
        assert!(parse_credentials(&json!([{ "target": a, "value": "x".repeat(2561) }])).is_err());
        assert!(parse_credentials(&json!({})).is_err());

        let local = vec![(a.clone(), "old".to_string()), (b.clone(), "same".to_string()), (c.clone(), "mine".to_string())];
        assert_eq!(plan_credentials(&local, &parsed, ImportMode::Merge), CredentialPlan { set: vec![(a.clone(), "new".into())], delete: vec![] });
        assert_eq!(plan_credentials(&local, &parsed, ImportMode::Replace), CredentialPlan { set: vec![(a, "new".into())], delete: vec![c] });
    }

    #[test]
    fn plugins_category_carries_installed_plugins_and_stores() {
        let dir = tmp_dir("plugins");
        write_json(&dir.join("plugins.json"), &json!([{ "id": "team.a", "enabled": true, "config": { "user": "me" } }])).unwrap();
        write_json(&dir.join("plugin_stores.json"), &json!([{ "id": "2648d2bab1b4c559", "token": "t" }])).unwrap();
        let categories = vec!["plugins".to_string()];
        let data = collect(&dir, &categories);
        assert_eq!(data.keys().cloned().collect::<Vec<_>>(), vec!["plugin_stores", "plugins"]);
        // Another computer's plugins merge by id; local ones it does not know about stay.
        let mut incoming = data.clone();
        incoming.insert("plugins".into(), json!([{ "id": "team.b", "enabled": false }]));
        assert_eq!(apply(&dir, &incoming, &categories, ImportMode::Merge).unwrap(), categories);
        assert_eq!(read_json(&dir.join("plugins.json")).unwrap(), json!([{ "id": "team.a", "enabled": true, "config": { "user": "me" } }, { "id": "team.b", "enabled": false }]));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn settings_keep_local_keys() {
        let local = json!({ "fontSize": 12, "sync": { "provider": "s3" }, "logDir": "D:/logs", "keep": 1 });
        let incoming = json!({ "fontSize": 16, "sync": { "provider": "webdav" }, "remote": { "enabled": true } });
        let merged = merge_settings(&local, &incoming, ImportMode::Merge);
        assert_eq!(merged, json!({ "fontSize": 16, "sync": { "provider": "s3" }, "logDir": "D:/logs", "keep": 1 }));
        let replaced = merge_settings(&local, &incoming, ImportMode::Replace);
        assert_eq!(replaced, json!({ "fontSize": 16, "sync": { "provider": "s3" }, "logDir": "D:/logs" }));
    }

    #[test]
    fn settings_share_only_the_relay() {
        let mut exported = json!({
            "fontSize": 12,
            "remote": { "enabled": true, "readOnly": true, "relayUrl": " https://r.example.com ", "hostToken": "t1" }
        });
        strip_local_settings(&mut exported);
        assert_eq!(exported, json!({ "fontSize": 12, "remote": { "relayUrl": "https://r.example.com", "hostToken": "t1" } }));

        let mut no_relay = json!({ "remote": { "enabled": true, "relayUrl": "", "hostToken": "t" } });
        strip_local_settings(&mut no_relay);
        assert_eq!(no_relay, json!({}));

        // The relay comes in; this computer's switches stay.
        let local = json!({ "remote": { "enabled": false, "readOnly": true, "relayUrl": "https://old", "hostToken": "old" } });
        for mode in [ImportMode::Merge, ImportMode::Replace] {
            let merged = merge_settings(&local, &exported, mode);
            assert_eq!(
                merged["remote"],
                json!({ "enabled": false, "readOnly": true, "relayUrl": "https://r.example.com", "hostToken": "t1" })
            );
        }
        // The token belongs to the relay: a missing one clears the old.
        let incoming = json!({ "remote": { "enabled": true, "relayUrl": "https://new" } });
        let merged = merge_settings(&local, &incoming, ImportMode::Merge);
        assert_eq!(merged["remote"], json!({ "enabled": false, "readOnly": true, "relayUrl": "https://new", "hostToken": "" }));
        // No relay incoming: local remote kept as is, or still absent.
        assert_eq!(merge_settings(&local, &json!({}), ImportMode::Replace)["remote"], local["remote"]);
        assert!(merge_settings(&json!({}), &json!({ "remote": { "enabled": true } }), ImportMode::Merge).get("remote").is_none());
        // A computer without remote settings gets the relay, still switched off.
        let fresh = merge_settings(&json!({}), &exported, ImportMode::Merge);
        assert_eq!(fresh["remote"], json!({ "relayUrl": "https://r.example.com", "hostToken": "t1" }));
    }

    #[test]
    fn collect_strips_local_settings_and_apply_backs_up() {
        let base = tmp_dir("apply");
        let settings = serde_json::to_value(AppSettings::default()).unwrap();
        let mut local_settings = settings.clone();
        local_settings["sync"] = json!({ "provider": "folder" });
        write_json(&base.join("settings.json"), &local_settings).unwrap();
        write_json(&base.join("senders.json"), &json!([{ "id": "s1" }])).unwrap();

        let all = normalize_categories(&[]);
        let data = collect(&base, &all);
        assert!(data["settings"].get("sync").is_none());
        assert!(data.contains_key("senders"));
        assert!(!data.contains_key("sessions"));

        let mut incoming = data.clone();
        let mut s = settings.clone();
        s["fontSize"] = json!(20);
        incoming.insert("settings".into(), s);
        incoming.insert("senders".into(), json!([{ "id": "s2" }]));
        let applied = apply(&base, &incoming, &all, ImportMode::Merge).unwrap();
        assert_eq!(applied, vec!["settings".to_string(), "senders".to_string()]);
        let saved = read_json(&base.join("settings.json")).unwrap();
        assert_eq!(saved["fontSize"], json!(20));
        assert_eq!(saved["sync"], json!({ "provider": "folder" }));
        assert_eq!(read_json(&base.join("senders.json")).unwrap(), json!([{ "id": "s1" }, { "id": "s2" }]));
        assert_eq!(fs::read_dir(base.join("backups")).unwrap().count(), 1);

        // Invalid data is refused before anything is written.
        let mut bad = Map::new();
        bad.insert("sessions".into(), json!([{ "nope": true }]));
        assert!(apply(&base, &bad, &all, ImportMode::Replace).is_err());
        assert!(!base.join("sessions.json").exists());
        let _ = fs::remove_dir_all(base);
    }

    fn sessions_of(base: &Path) -> Vec<String> {
        read_json(&base.join("sessions.json"))
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default()
            .iter()
            .map(|s| s["label"].as_str().unwrap_or_default().to_string())
            .collect()
    }

    fn session(id: &str) -> Value {
        let mut s = serde_json::to_value(SessionConfig { id: id.into(), label: id.into(), ..Default::default() }).unwrap();
        s["label"] = json!(id);
        s
    }

    #[tokio::test]
    async fn two_computers_sync_through_a_folder() {
        let shared = tmp_dir("shared");
        let (a, b) = (tmp_dir("a"), tmp_dir("b"));
        write_json(&a.join("sessions.json"), &json!([session("a1")])).unwrap();
        write_json(&b.join("sessions.json"), &json!([session("b1")])).unwrap();
        let store_a = Mutex::new(Storage::new(a.clone()).unwrap());
        let store_b = Mutex::new(Storage::new(b.clone()).unwrap());
        let cfg = SyncConfig {
            provider: "folder".into(),
            folder: FolderConfig { path: shared.to_string_lossy().into() },
            password: "secret".into(),
            categories: vec!["sessions".into()],
            ..Default::default()
        };
        let res = |o: Result<SyncOutcome, String>| o.unwrap().result;

        // A uploads first; B differs and never synced: conflict, then B takes the remote copy.
        assert_eq!(res(run(&store_a, &cfg, SyncAction::Auto).await), "uploaded");
        assert!(!fs::read_to_string(shared.join("nexterm-config.json")).unwrap().contains("\"a1\""));
        assert_eq!(res(run(&store_b, &cfg, SyncAction::Auto).await), "conflict");
        assert_eq!(res(run(&store_b, &cfg, SyncAction::Pull).await), "downloaded");
        assert_eq!(sessions_of(&b), vec!["a1"]);
        assert_eq!(res(run(&store_b, &cfg, SyncAction::Auto).await), "upToDate");

        // A changes -> A uploads, B downloads.
        write_json(&a.join("sessions.json"), &json!([session("a1"), session("a2")])).unwrap();
        assert_eq!(res(run(&store_a, &cfg, SyncAction::Auto).await), "uploaded");
        assert_eq!(res(run(&store_b, &cfg, SyncAction::Auto).await), "downloaded");
        assert_eq!(sessions_of(&b), vec!["a1", "a2"]);

        // Both change -> conflict; merge keeps both sides and A picks the merge up.
        write_json(&a.join("sessions.json"), &json!([session("a1"), session("a2"), session("a3")])).unwrap();
        write_json(&b.join("sessions.json"), &json!([session("a1"), session("a2"), session("b2")])).unwrap();
        assert_eq!(res(run(&store_a, &cfg, SyncAction::Auto).await), "uploaded");
        assert_eq!(res(run(&store_b, &cfg, SyncAction::Auto).await), "conflict");
        assert_eq!(res(run(&store_b, &cfg, SyncAction::Merge).await), "merged");
        assert_eq!(sessions_of(&b), vec!["a1", "a2", "b2", "a3"]);
        assert_eq!(res(run(&store_a, &cfg, SyncAction::Auto).await), "downloaded");
        assert_eq!(sessions_of(&a), vec!["a1", "a2", "b2", "a3"]);

        // Wrong password cannot read the remote copy.
        let wrong = SyncConfig { password: "nope".into(), ..cfg.clone() };
        assert_eq!(run(&store_b, &wrong, SyncAction::Pull).await.unwrap_err(), code::BAD_PASSWORD);
        for d in [shared, a, b] {
            let _ = fs::remove_dir_all(d);
        }
    }

    type Log = std::sync::Arc<Mutex<Vec<String>>>;

    /// Local HTTP/1.1 server, one request per connection. `handle(method, path, authorized
    /// header value, body)` returns the status line and body. Gives the base URL and a log
    /// of "METHOD path" lines.
    async fn mock_http<F>(mut handle: F) -> (String, Log)
    where
        F: FnMut(&str, &str, &str, Vec<u8>) -> (&'static str, Vec<u8>) + Send + 'static,
    {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let log: Log = Default::default();
        let log2 = log.clone();
        tokio::spawn(async move {
            loop {
                let (mut sock, _) = listener.accept().await.unwrap();
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                let (head, body) = loop {
                    let n = sock.read(&mut chunk).await.unwrap();
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&buf[..pos]).to_string();
                        let len: usize = head
                            .lines()
                            .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap()))
                            .unwrap_or(0);
                        while buf.len() < pos + 4 + len {
                            let n = sock.read(&mut chunk).await.unwrap();
                            buf.extend_from_slice(&chunk[..n]);
                        }
                        break (head, buf[pos + 4..pos + 4 + len].to_vec());
                    }
                };
                let mut parts = head.split(' ');
                let (method, path) = (parts.next().unwrap().to_string(), parts.next().unwrap().to_string());
                log2.lock().unwrap().push(format!("{method} {path}"));
                let auth = head
                    .lines()
                    .find_map(|l| l.split_once(':').filter(|(k, _)| k.eq_ignore_ascii_case("authorization")).map(|(_, v)| v.trim().to_string()))
                    .unwrap_or_default();
                let (status, out) = handle(&method, &path, &auth, body);
                let resp = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", out.len());
                let _ = sock.write_all(resp.as_bytes()).await;
                let _ = sock.write_all(&out).await;
            }
        });
        (format!("http://{addr}"), log)
    }

    /// WebDAV: GET / PUT / MKCOL with Basic auth; PUT fails with 409 until the folder exists.
    async fn mock_webdav() -> (String, Log) {
        let mut files = std::collections::HashMap::<String, Vec<u8>>::new();
        let mut folder = false;
        let expected = format!("Basic {}", B64.encode("u:p"));
        let (base, log) = mock_http(move |method, path, auth, body| {
            if auth != expected {
                return ("401 Unauthorized", Vec::new());
            }
            match method {
                "GET" => match files.get(path) {
                    Some(f) => ("200 OK", f.clone()),
                    None => ("404 Not Found", Vec::new()),
                },
                "PUT" if !folder => ("409 Conflict", Vec::new()),
                "PUT" => {
                    files.insert(path.to_string(), body);
                    ("201 Created", Vec::new())
                }
                "MKCOL" => {
                    folder = true;
                    ("201 Created", Vec::new())
                }
                _ => ("405 Method Not Allowed", Vec::new()),
            }
        })
        .await;
        (format!("{base}/dav/nexterm"), log)
    }

    /// GitHub gists API: list, get, create, update; bearer token "tok". Files with
    /// content over 64 bytes come back truncated, with a raw_url.
    async fn mock_github() -> (String, Log) {
        let addr = std::sync::Arc::new(Mutex::new(String::new()));
        let addr2 = addr.clone();
        // id -> files { name: content }
        let mut gists: Vec<(String, Map<String, Value>)> = vec![("other".into(), Map::new())];
        let (base, log) = mock_http(move |method, path, auth, body| {
            if auth != "Bearer tok" {
                return ("401 Unauthorized", br#"{"message":"Bad credentials"}"#.to_vec());
            }
            let base = addr2.lock().unwrap().clone();
            let view = |id: &str, files: &Map<String, Value>, full: bool| {
                let files: Map<String, Value> = files
                    .iter()
                    .map(|(name, content)| {
                        let text = content.as_str().unwrap_or_default();
                        let mut f = json!({ "filename": name, "raw_url": format!("{base}/raw/{id}/{name}") });
                        if full {
                            f["truncated"] = json!(text.len() > 64);
                            f["content"] = json!(text.chars().take(64).collect::<String>());
                        }
                        (name.clone(), f)
                    })
                    .collect();
                json!({ "id": id, "files": files })
            };
            let path = path.split('?').next().unwrap_or_default();
            let parts: Vec<&str> = path.trim_matches('/').split('/').collect();
            match (method, parts.as_slice()) {
                ("GET", ["gists"]) => ("200 OK", Value::Array(gists.iter().map(|(id, f)| view(id, f, false)).collect()).to_string().into_bytes()),
                ("GET", ["gists", id]) => match gists.iter().find(|(g, _)| g == id) {
                    Some((id, f)) => ("200 OK", view(id, f, true).to_string().into_bytes()),
                    None => ("404 Not Found", Vec::new()),
                },
                ("GET", ["raw", id, name]) => match gists.iter().find(|(g, _)| g == id).and_then(|(_, f)| f.get(*name)) {
                    Some(c) => ("200 OK", c.as_str().unwrap_or_default().as_bytes().to_vec()),
                    None => ("404 Not Found", Vec::new()),
                },
                ("POST", ["gists"]) | ("PATCH", ["gists", _]) => {
                    let req: Value = serde_json::from_slice(&body).unwrap();
                    if method == "POST" {
                        assert_eq!(req["public"], json!(false));
                    }
                    let id = parts.get(1).map(|s| s.to_string()).unwrap_or_else(|| format!("g{}", gists.len()));
                    if !gists.iter().any(|(g, _)| *g == id) {
                        gists.push((id.clone(), Map::new()));
                    }
                    let entry = &mut gists.iter_mut().find(|(g, _)| *g == id).unwrap().1;
                    for (name, f) in req["files"].as_object().unwrap() {
                        entry.insert(name.clone(), f["content"].clone());
                    }
                    let (id, f) = gists.iter().find(|(g, _)| *g == id).unwrap();
                    ("201 Created", view(id, f, true).to_string().into_bytes())
                }
                _ => ("404 Not Found", Vec::new()),
            }
        })
        .await;
        *addr.lock().unwrap() = base.clone();
        (base, log)
    }

    #[tokio::test]
    async fn gist_creates_finds_and_updates() {
        let (api, log) = mock_github().await;
        let mut cfg = SyncConfig {
            provider: "gist".into(),
            gist: GistConfig { token: "bad".into(), gist_id: String::new(), api_url: api.clone() },
            ..Default::default()
        };
        assert!(remote_get(&cfg).await.unwrap_err().contains("401"));
        cfg.gist.token = "tok".into();
        assert_eq!(remote_get(&cfg).await.unwrap(), None);

        // First upload creates a secret gist; later reads find it by file name.
        remote_put(&cfg, b"short".to_vec()).await.unwrap();
        assert_eq!(remote_get(&cfg).await.unwrap().as_deref(), Some(&b"short"[..]));
        // Large file: truncated content, read through raw_url; the same gist is updated.
        let big = "x".repeat(200);
        remote_put(&cfg, big.clone().into_bytes()).await.unwrap();
        assert_eq!(remote_get(&cfg).await.unwrap(), Some(big.into_bytes()));
        let log = log.lock().unwrap().clone();
        assert_eq!(log.iter().filter(|l| l.starts_with("POST")).count(), 1);
        assert!(log.iter().any(|l| l == "PATCH /gists/g1"));
        assert!(log.iter().any(|l| l == "GET /raw/g1/nexterm-config.json"));

        // A given gist id is used directly; an unknown one is an error.
        cfg.gist.gist_id = "g1".into();
        assert!(remote_get(&cfg).await.unwrap().is_some());
        cfg.gist.gist_id = "missing".into();
        assert!(remote_get(&cfg).await.unwrap_err().contains("not found"));
    }

    #[tokio::test]
    async fn webdav_roundtrip_creates_folder() {
        let (url, log) = mock_webdav().await;
        let mut cfg = SyncConfig {
            provider: "webdav".into(),
            webdav: WebDavConfig { url, username: "u".into(), password: "bad".into() },
            ..Default::default()
        };
        assert!(remote_get(&cfg).await.unwrap_err().contains("401"));
        cfg.webdav.password = "p".into();
        assert_eq!(remote_get(&cfg).await.unwrap(), None);
        remote_put(&cfg, b"hello".to_vec()).await.unwrap();
        assert_eq!(remote_get(&cfg).await.unwrap().as_deref(), Some(&b"hello"[..]));
        let log = log.lock().unwrap().clone();
        assert_eq!(
            &log[2..5],
            ["PUT /dav/nexterm/nexterm-config.json", "MKCOL /dav/nexterm/", "PUT /dav/nexterm/nexterm-config.json"]
        );
    }

    /// Real GitHub: `NEXTERM_GITHUB_TOKEN=... cargo test --lib sync::tests::github_e2e -- --ignored`.
    /// Creates its own secret gist (unique file name) and deletes it at the end.
    #[tokio::test]
    #[ignore]
    async fn github_e2e() {
        let token = std::env::var("NEXTERM_GITHUB_TOKEN").expect("NEXTERM_GITHUB_TOKEN");
        let name = format!("nexterm-e2e-{}.json", uuid::Uuid::new_v4());
        let (a, b) = (tmp_dir("gh-a"), tmp_dir("gh-b"));
        write_json(&a.join("sessions.json"), &json!([session("a1")])).unwrap();
        write_json(&b.join("sessions.json"), &json!([session("b1")])).unwrap();
        let store_a = Mutex::new(Storage::new(a.clone()).unwrap());
        let store_b = Mutex::new(Storage::new(b.clone()).unwrap());
        let cfg = SyncConfig {
            provider: "gist".into(),
            gist: GistConfig { token: token.clone(), ..Default::default() },
            file_name: name.clone(),
            password: "e2e-secret".into(),
            categories: vec!["sessions".into()],
            ..Default::default()
        };
        let res = |o: Result<SyncOutcome, String>| o.unwrap().result;

        let outcome = async {
            assert_eq!(remote_get(&cfg).await.unwrap(), None);
            assert_eq!(res(run(&store_a, &cfg, SyncAction::Auto).await), "uploaded");
            assert_eq!(res(run(&store_b, &cfg, SyncAction::Auto).await), "conflict");
            assert_eq!(res(run(&store_b, &cfg, SyncAction::Merge).await), "merged");
            assert_eq!(sessions_of(&b), vec!["b1", "a1"]);
            assert_eq!(res(run(&store_a, &cfg, SyncAction::Auto).await), "downloaded");
            assert_eq!(sessions_of(&a), vec!["b1", "a1"]);
            assert_eq!(res(run(&store_a, &cfg, SyncAction::Auto).await), "upToDate");
            let stored = String::from_utf8(remote_get(&cfg).await.unwrap().unwrap()).unwrap();
            assert!(stored.contains("ciphertext") && !stored.contains("\"b1\""));
            let wrong = SyncConfig { password: "nope".into(), ..cfg.clone() };
            assert_eq!(run(&store_b, &wrong, SyncAction::Pull).await.unwrap_err(), code::BAD_PASSWORD);
        };
        // Clean up even when an assertion fails.
        let result = futures_util::FutureExt::catch_unwind(std::panic::AssertUnwindSafe(outcome)).await;
        let client = client().unwrap();
        if let Some(gist) = cfg.gist.find(&client, &name).await.unwrap() {
            let id = gist["id"].as_str().unwrap().to_string();
            println!("gist used: {id} (public: {})", gist["public"]);
            assert_eq!(gist["public"], json!(false));
            let resp = cfg.gist.request(&client, reqwest::Method::DELETE, &format!("{}/gists/{id}", cfg.gist.api())).send().await.unwrap();
            assert_eq!(resp.status().as_u16(), 204, "delete gist {id}");
            println!("gist {id} deleted");
        }
        for d in [a, b] {
            let _ = fs::remove_dir_all(d);
        }
        if let Err(e) = result {
            std::panic::resume_unwind(e);
        }
    }

    #[test]
    fn decide_cases() {
        let st = SyncState { target: "t".into(), local_hash: "L".into(), remote_hash: "R".into(), ..Default::default() };
        assert_eq!(decide(&st, "t", "L", None), Decision::Push);
        assert_eq!(decide(&st, "t", "X", Some("X")), Decision::UpToDate);
        assert_eq!(decide(&st, "t", "L2", Some("R")), Decision::Push);
        assert_eq!(decide(&st, "t", "L", Some("R2")), Decision::Pull);
        assert_eq!(decide(&st, "t", "L2", Some("R2")), Decision::Conflict);
        assert_eq!(decide(&st, "other", "L", Some("R2")), Decision::Conflict);
        assert_eq!(decide(&SyncState::default(), "t", "L", Some("R")), Decision::Conflict);
    }
}
