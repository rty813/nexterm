//! Remote access: view and type into this computer's tabs from a browser (phone or
//! computer), through a self-hosted relay (`relay/`). Everything past the relay is end-to-end encrypted
//! (`remote_crypto.rs`); the relay only sees room ids and ciphertext.
//!
//! The desktop xterm.js of a watched pane is the source of truth: when a phone opens a
//! tab, the window showing it serializes its screen, then forwards every chunk it has
//! parsed (`remote_feed`), so the phone sees exactly what the desktop shows. Phone input
//! goes straight to the connection. A phone can also take over the pane's size: the
//! desktop pane then shrinks to the phone's rows / columns until it is released.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, watch};

use crate::relay_link::{self as link, computer_name, envelope, percent_encode, R_DATA, R_JOIN, R_KICK, R_LEAVE};
use crate::remote_crypto::{self as rc, Session};

/// Plaintext kinds inside the encrypted frames.
pub(crate) const P_JSON: u8 = 1;
pub(crate) const P_OUTPUT: u8 = 2;
/// `[P_FILE][transfer id u32 BE][bytes]`: file contents, both ways (`remote_ops.rs`).
const P_FILE: u8 = 3;
/// Feed records from the desktop panes (`remote_feed`): output, size, and screen snapshots
/// with scrollback (for watchers waiting for one / for all) or without (shares).
pub(crate) const F_OUTPUT: u8 = 1;
pub(crate) const F_SIZE: u8 = 2;
pub(crate) const F_SNAPSHOT: u8 = 3;
pub(crate) const F_SNAPSHOT_ALL: u8 = 4;
pub(crate) const F_SCREEN: u8 = 5;
pub(crate) const F_SCREEN_ALL: u8 = 6;

pub(crate) const OUTPUT_CHUNK: usize = 128 * 1024;
/// Waiting to go out to the relay; beyond this, phones skip output and get a fresh screen.
pub(crate) const QUEUE_LIMIT: usize = 16 * 1024 * 1024;
const MAX_PHONES: usize = 8;

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RemoteConfig {
    pub enabled: bool,
    /// Base address of the relay, e.g. `https://relay.example.com` (phones open it).
    pub relay_url: String,
    /// Must match the relay's HOST_TOKEN when it sets one.
    pub host_token: String,
    /// Phones may only watch.
    pub read_only: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PhoneInfo {
    pub id: u32,
    pub name: String,
    pub watching: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    /// "off" | "connecting" | "online" | "error"
    pub state: String,
    pub message: Option<String>,
    pub phones: Vec<PhoneInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePairing {
    /// What the phone opens (secret in the fragment); empty without a relay address.
    pub url: String,
    pub qr_svg: String,
}

/// One tab as a window reports it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTab {
    pub id: String,
    pub title: String,
    pub status: String,
    pub cols: u16,
    pub rows: u16,
    pub active: bool,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub agent: String,
    #[serde(default)]
    pub protocol: String,
    #[serde(default)]
    pub window: String,
    /// Why the connection ended or failed.
    #[serde(default)]
    pub message: String,
    /// Set while the pane waits for a username / password before connecting.
    #[serde(default)]
    pub auth: Option<RemoteAuth>,
    /// SSH with password auth: after a failure the phone offers to enter another password.
    #[serde(default)]
    pub password_auth: bool,
    /// Locked on the computer: it cannot be closed (from a phone either).
    #[serde(default)]
    pub locked: bool,
}

/// What a pane's login form asks for.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAuth {
    pub user: bool,
    pub password: bool,
    /// Prefill of the username field.
    #[serde(default)]
    pub username: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SizePayload {
    pane_id: String,
    cols: Option<u16>,
    rows: Option<u16>,
}

/// Credentials a phone typed into a pane's login form (or none: just reconnect).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoginPayload {
    pane_id: String,
    username: Option<String>,
    password: Option<String>,
    remember: bool,
}

#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
enum PhoneMsg {
    Hi { name: Option<String> },
    Sub { id: Option<String> },
    In { id: String, d: String },
    Take { id: String, cols: u16, rows: u16 },
    Release { id: String },
    Ping,
    /// Sessions and files (`remote_ops.rs`).
    Req { rid: u32, op: String, #[serde(default)] a: serde_json::Value },
    FsAck { x: u32, n: u64 },
    FsEnd { x: u32 },
    FsCancel { x: u32 },
    /// Answer a pane's login form, or reconnect a failed pane (no credentials).
    Login {
        id: String,
        #[serde(default)]
        user: Option<String>,
        #[serde(default)]
        pwd: Option<String>,
        #[serde(default)]
        remember: bool,
    },
    /// Answer the SSH host key question of a pane.
    HostKey { id: String, d: crate::manager::HostKeyDecision },
}

struct Phone {
    session: Option<Session>,
    authed: bool,
    name: String,
    watching: Option<String>,
    /// Watching, but the screen snapshot has not come yet: output would be out of context.
    awaiting: bool,
}

#[derive(Default)]
struct Inner {
    status: RemoteStatus,
    config: RemoteConfig,
    secret: Option<[u8; rc::SECRET_LEN]>,
    /// To the relay writer while connected.
    out: Option<mpsc::UnboundedSender<Vec<u8>>>,
    phones: HashMap<u32, Phone>,
    /// Window label -> its tabs.
    tabs: HashMap<String, Vec<RemoteTab>>,
    /// Pane -> (phone, cols, rows) that took over its size.
    takeovers: HashMap<String, (u32, u16, u16)>,
    /// Pane -> (request id, what phones see) of an unanswered host key question.
    host_keys: HashMap<String, (String, serde_json::Value)>,
}

struct Remote {
    app: AppHandle,
    inner: Mutex<Inner>,
    /// Bytes handed to the relay writer and not yet written.
    queued: Arc<AtomicUsize>,
    /// Output was dropped for a backlog: phones get fresh screens once it drained.
    stalled: AtomicBool,
    /// Bumped on every config / pairing change: the connection loop restarts.
    generation: watch::Sender<u64>,
}

static REMOTE: OnceLock<Remote> = OnceLock::new();

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn remote() -> Option<&'static Remote> {
    REMOTE.get()
}

fn secret_path() -> std::path::PathBuf {
    crate::app_paths::data_dir().join("remote_pairing.json")
}

fn load_or_create_secret() -> [u8; rc::SECRET_LEN] {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64U;
    use base64::Engine;
    let saved = std::fs::read_to_string(secret_path())
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("secret").and_then(|s| s.as_str()).map(str::to_string))
        .and_then(|s| B64U.decode(s).ok())
        .and_then(|b| <[u8; rc::SECRET_LEN]>::try_from(b).ok());
    saved.unwrap_or_else(|| {
        let secret = rc::random::<{ rc::SECRET_LEN }>();
        save_secret(&secret);
        secret
    })
}

fn save_secret(secret: &[u8; rc::SECRET_LEN]) {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64U;
    use base64::Engine;
    let body = serde_json::json!({ "secret": B64U.encode(secret) }).to_string();
    let _ = std::fs::create_dir_all(crate::app_paths::data_dir());
    let _ = std::fs::write(secret_path(), body);
}

pub fn init(app: AppHandle, config: RemoteConfig) {
    let (generation, rx) = watch::channel(0u64);
    let r = Remote {
        app,
        inner: Mutex::new(Inner {
            status: RemoteStatus { state: "off".into(), ..Default::default() },
            config,
            ..Default::default()
        }),
        queued: Arc::new(AtomicUsize::new(0)),
        stalled: AtomicBool::new(false),
        generation,
    };
    if REMOTE.set(r).is_ok() {
        tauri::async_runtime::spawn(run(rx));
    }
}

pub fn configure(config: RemoteConfig) {
    let Some(r) = remote() else { return };
    let changed = {
        let mut inner = lock(&r.inner);
        let changed = inner.config != config;
        inner.config = config;
        changed
    };
    if changed {
        r.generation.send_modify(|g| *g += 1);
    }
}

pub fn status() -> RemoteStatus {
    remote().map(|r| lock(&r.inner).status.clone()).unwrap_or_default()
}

pub fn pairing() -> RemotePairing {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64U;
    use base64::Engine;
    let Some(r) = remote() else {
        return RemotePairing { url: String::new(), qr_svg: String::new() };
    };
    let (secret, base) = {
        let mut inner = lock(&r.inner);
        let secret = *inner.secret.get_or_insert_with(load_or_create_secret);
        (secret, inner.config.relay_url.clone())
    };
    let Some((_, page)) = link::relay_urls(&base) else {
        return RemotePairing { url: String::new(), qr_svg: String::new() };
    };
    let url = format!("{page}#k={}&n={}", B64U.encode(secret), percent_encode(&computer_name()));
    let qr_svg = link::qr_svg(&url);
    RemotePairing { url, qr_svg }
}

/// New secret: every paired phone loses access and must scan again.
pub fn reset_pairing() {
    let Some(r) = remote() else { return };
    let secret = rc::random::<{ rc::SECRET_LEN }>();
    save_secret(&secret);
    lock(&r.inner).secret = Some(secret);
    r.generation.send_modify(|g| *g += 1);
}

pub fn kick(phone: u32) {
    let Some(r) = remote() else { return };
    let mut inner = lock(&r.inner);
    if let Some(out) = &inner.out {
        let _ = out.send(envelope(R_KICK, phone, &[]));
    }
    drop_phone(r, &mut inner, phone);
    publish_status(r, &inner);
}

/// A tab as its window reported it.
pub fn tab(id: &str) -> Option<RemoteTab> {
    let r = remote()?;
    let inner = lock(&r.inner);
    let found = inner.tabs.values().flatten().find(|t| t.id == id).cloned();
    found
}

/// Every reported tab, by id.
pub fn tabs() -> HashMap<String, RemoteTab> {
    let Some(r) = remote() else { return HashMap::new() };
    let inner = lock(&r.inner);
    inner.tabs.values().flatten().map(|t| (t.id.clone(), t.clone())).collect()
}

/// Whether a window still lists the tab, and whether it is locked.
pub fn tab_locked(id: &str) -> Option<bool> {
    let r = remote()?;
    let inner = lock(&r.inner);
    let found = inner.tabs.values().flatten().find(|t| t.id == id).map(|t| t.locked);
    found
}

pub fn report_tabs(window: &str, mut tabs: Vec<RemoteTab>) {
    let Some(r) = remote() else { return };
    let mut inner = lock(&r.inner);
    for t in &mut tabs {
        t.window = window.to_string();
    }
    if inner.tabs.get(window) == Some(&tabs) {
        return;
    }
    if tabs.is_empty() {
        inner.tabs.remove(window);
    } else {
        inner.tabs.insert(window.to_string(), tabs);
    }
    // A closed pane gives its size back.
    let alive: HashSet<String> = inner.tabs.values().flatten().map(|t| t.id.clone()).collect();
    inner.takeovers.retain(|pane, _| alive.contains(pane));
    // A host key question ends with the connection attempt (answered, timed out, closed).
    let waiting: HashSet<String> =
        inner.tabs.values().flatten().filter(|t| t.status == "connecting").map(|t| t.id.clone()).collect();
    inner.host_keys.retain(|pane, _| waiting.contains(pane));
    send_tabs_all(r, &mut inner);
}

pub fn forget_window(window: &str) {
    report_tabs(window, Vec::new());
}

/// A pane's connection asks to confirm the SSH host key: phones can answer it too.
pub fn host_key_prompt(pane: &str, request_id: &str, prompt: &crate::manager::HostKeyPrompt) {
    let Some(r) = remote() else { return };
    let mut inner = lock(&r.inner);
    let view = serde_json::json!({
        "host": prompt.host, "port": prompt.port, "keyType": prompt.key_type,
        "fingerprint": prompt.fingerprint, "changed": prompt.changed,
    });
    inner.host_keys.insert(pane.to_string(), (request_id.to_string(), view));
    send_tabs_all(r, &mut inner);
}

/// The desktop answered a host key question.
pub fn host_key_done(request_id: &str) {
    let Some(r) = remote() else { return };
    let mut inner = lock(&r.inner);
    let before = inner.host_keys.len();
    inner.host_keys.retain(|_, (id, _)| id != request_id);
    if inner.host_keys.len() != before {
        send_tabs_all(r, &mut inner);
    }
}

/// Panes forwarded to remote devices and shares, by the snapshot they need.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct WatchState {
    /// Snapshots with scrollback (remote access, shares that include it).
    pub full: Vec<String>,
    /// Snapshots of the visible screen only (shares without scrollback).
    pub screen: Vec<String>,
}

#[derive(Default)]
struct Watchers {
    remote: HashSet<String>,
    share_full: HashSet<String>,
    share_screen: HashSet<String>,
}

/// Leaf lock: nothing else is locked while it is held.
static WATCHERS: LazyLock<Mutex<Watchers>> = LazyLock::new(Default::default);

/// Panes watched (a pane mounting in a window starts forwarding).
pub fn watched() -> WatchState {
    let w = lock(&WATCHERS);
    let mut full: Vec<String> = w.remote.union(&w.share_full).cloned().collect();
    let mut screen: Vec<String> = w.share_screen.iter().cloned().collect();
    full.sort();
    screen.sort();
    WatchState { full, screen }
}

fn emit_watch(app: &AppHandle) {
    let _ = app.emit("remote-watch", watched());
}

/// Shares changed what they watch (`share.rs`).
pub(crate) fn set_share_watch(app: &AppHandle, full: HashSet<String>, screen: HashSet<String>) {
    {
        let mut w = lock(&WATCHERS);
        if w.share_full == full && w.share_screen == screen {
            return;
        }
        w.share_full = full;
        w.share_screen = screen;
    }
    emit_watch(app);
}

/// Relay address and host token, for shares.
pub(crate) fn relay_config() -> (String, String) {
    remote()
        .map(|r| {
            let inner = lock(&r.inner);
            (inner.config.relay_url.clone(), inner.config.host_token.clone())
        })
        .unwrap_or_default()
}

/// Sizes taken over by phones.
pub fn takeovers() -> Vec<(String, u16, u16)> {
    remote()
        .map(|r| lock(&r.inner).takeovers.iter().map(|(p, (_, c, rw))| (p.clone(), *c, *rw)).collect())
        .unwrap_or_default()
}

/// The desktop takes the size back.
pub fn release(pane: &str) {
    let Some(r) = remote() else { return };
    let mut inner = lock(&r.inner);
    if inner.takeovers.remove(pane).is_some() {
        emit_size(r, pane, None);
        send_tabs_all(r, &mut inner);
    }
}

/// Records forwarded by the desktop pane: `[kind u8][len u32 LE][payload]...`.
pub fn feed(pane: &str, body: &[u8]) {
    let Some(r) = remote() else { return };
    let mut inner = lock(&r.inner);
    if inner.out.is_none() {
        return;
    }
    let over = r.queued.load(Ordering::Relaxed) > QUEUE_LIMIT;
    let mut at = 0;
    while at + 5 <= body.len() {
        let kind = body[at];
        let len = u32::from_le_bytes(body[at + 1..at + 5].try_into().unwrap()) as usize;
        at += 5;
        if at + len > body.len() {
            break;
        }
        let payload = &body[at..at + len];
        at += len;
        match kind {
            F_OUTPUT if over => {
                // The relay link is far behind: drop output, resync once it drained.
                for p in inner.phones.values_mut().filter(|p| p.watching.as_deref() == Some(pane)) {
                    p.awaiting = true;
                }
                r.stalled.store(true, Ordering::Relaxed);
            }
            F_OUTPUT => {
                let ids = watcher_ids(&inner, pane);
                for id in ids {
                    for chunk in payload.chunks(OUTPUT_CHUNK) {
                        send_output(r, &mut inner, id, pane, chunk);
                    }
                }
            }
            F_SIZE if len >= 4 => {
                let cols = u16::from_le_bytes([payload[0], payload[1]]);
                let rows = u16::from_le_bytes([payload[2], payload[3]]);
                let msg = serde_json::json!({ "t": "size", "id": pane, "cols": cols, "rows": rows });
                for id in watcher_ids(&inner, pane) {
                    send_json(r, &mut inner, id, &msg);
                }
            }
            F_SNAPSHOT | F_SNAPSHOT_ALL if len >= 4 && !over => {
                let cols = u16::from_le_bytes([payload[0], payload[1]]);
                let rows = u16::from_le_bytes([payload[2], payload[3]]);
                let screen = &payload[4..];
                let ids: Vec<u32> = inner
                    .phones
                    .iter()
                    .filter(|(_, p)| p.watching.as_deref() == Some(pane) && (kind == F_SNAPSHOT_ALL || p.awaiting))
                    .map(|(id, _)| *id)
                    .collect();
                let owner = inner.takeovers.get(pane).map(|(o, _, _)| *o);
                for id in ids {
                    let msg = serde_json::json!({
                        "t": "reset", "id": pane, "cols": cols, "rows": rows, "takenBy": owner.map(|o| if o == id { "me" } else { "other" }),
                    });
                    send_json(r, &mut inner, id, &msg);
                    for chunk in screen.chunks(OUTPUT_CHUNK) {
                        send_output(r, &mut inner, id, pane, chunk);
                    }
                    if let Some(p) = inner.phones.get_mut(&id) {
                        p.awaiting = false;
                    }
                }
            }
            _ => {}
        }
    }
}

fn watched_set(inner: &Inner) -> HashSet<String> {
    inner.phones.values().filter(|p| p.authed).filter_map(|p| p.watching.clone()).collect()
}

/// Phones watching the pane that already have its screen.
fn watcher_ids(inner: &Inner, pane: &str) -> Vec<u32> {
    inner
        .phones
        .iter()
        .filter(|(_, p)| p.authed && p.watching.as_deref() == Some(pane) && !p.awaiting)
        .map(|(id, _)| *id)
        .collect()
}

/// Raw (handshake) frame to a phone.
fn send_raw(r: &Remote, inner: &Inner, phone: u32, payload: &[u8]) {
    if let Some(out) = &inner.out {
        let frame = envelope(R_DATA, phone, payload);
        r.queued.fetch_add(frame.len(), Ordering::Relaxed);
        let _ = out.send(frame);
    }
}

fn send_sealed(r: &Remote, inner: &mut Inner, phone: u32, plain: &[u8]) {
    let Some(sealed) = inner.phones.get_mut(&phone).and_then(|p| p.session.as_mut()).map(|s| s.seal(plain)) else {
        return;
    };
    send_raw(r, inner, phone, &sealed);
}

fn send_json(r: &Remote, inner: &mut Inner, phone: u32, msg: &serde_json::Value) {
    let mut plain = vec![P_JSON];
    plain.extend_from_slice(msg.to_string().as_bytes());
    send_sealed(r, inner, phone, &plain);
}

fn send_output(r: &Remote, inner: &mut Inner, phone: u32, pane: &str, bytes: &[u8]) {
    let id = pane.as_bytes();
    let mut plain = Vec::with_capacity(2 + id.len() + bytes.len());
    plain.push(P_OUTPUT);
    plain.push(id.len().min(255) as u8);
    plain.extend_from_slice(&id[..id.len().min(255)]);
    plain.extend_from_slice(bytes);
    send_sealed(r, inner, phone, &plain);
}

fn tabs_json(inner: &Inner, phone: u32) -> serde_json::Value {
    let mut tabs: Vec<serde_json::Value> = Vec::new();
    // Main window first, then the others in a stable order.
    let mut windows: Vec<&String> = inner.tabs.keys().collect();
    windows.sort_by_key(|w| (w.as_str() != "main", w.as_str()));
    for w in windows {
        for t in &inner.tabs[w] {
            let mut v = serde_json::to_value(t).unwrap_or_default();
            let taken = inner.takeovers.get(&t.id).map(|(o, _, _)| if *o == phone { "me" } else { "other" });
            v["takenBy"] = serde_json::json!(taken);
            v["hostKey"] = inner.host_keys.get(&t.id).map(|(_, view)| view.clone()).unwrap_or_default();
            tabs.push(v);
        }
    }
    serde_json::json!({ "t": "tabs", "tabs": tabs, "readOnly": inner.config.read_only })
}

fn send_tabs_all(r: &Remote, inner: &mut Inner) {
    let ids: Vec<u32> = inner.phones.iter().filter(|(_, p)| p.authed).map(|(id, _)| *id).collect();
    for id in ids {
        let msg = tabs_json(inner, id);
        send_json(r, inner, id, &msg);
    }
}

fn publish_status(r: &Remote, inner: &Inner) {
    let _ = r.app.emit("remote-state", &inner.status_with_phones());
}

fn publish_watch(r: &Remote, inner: &Inner) {
    let set = watched_set(inner);
    {
        let mut w = lock(&WATCHERS);
        if w.remote == set {
            return;
        }
        w.remote = set;
    }
    emit_watch(&r.app);
}

fn needs_snapshot(r: &Remote, pane: &str) {
    let _ = r.app.emit("remote-snapshot", pane);
}

/// Ask for the screens of every pane with a phone waiting for one.
fn resync(r: &Remote) {
    let panes: HashSet<String> = lock(&r.inner)
        .phones
        .values()
        .filter(|p| p.authed && p.awaiting)
        .filter_map(|p| p.watching.clone())
        .collect();
    for pane in panes {
        needs_snapshot(r, &pane);
    }
}

fn emit_size(r: &Remote, pane: &str, size: Option<(u16, u16)>) {
    let _ = r.app.emit(
        "remote-size",
        SizePayload { pane_id: pane.to_string(), cols: size.map(|s| s.0), rows: size.map(|s| s.1) },
    );
}

impl Inner {
    fn status_with_phones(&self) -> RemoteStatus {
        let mut s = self.status.clone();
        let mut phones: Vec<PhoneInfo> = self
            .phones
            .iter()
            .filter(|(_, p)| p.authed)
            .map(|(id, p)| PhoneInfo { id: *id, name: p.name.clone(), watching: p.watching.clone() })
            .collect();
        phones.sort_by_key(|p| p.id);
        s.phones = phones;
        s
    }
}

fn set_state(r: &Remote, state: &str, message: Option<String>) {
    let mut inner = lock(&r.inner);
    inner.status.state = state.into();
    inner.status.message = message;
    inner.status = inner.status_with_phones();
    publish_status(r, &inner);
}

/// A phone left (or was dropped): stop forwarding to it, give back its sizes.
fn drop_phone(r: &Remote, inner: &mut Inner, phone: u32) {
    let Some(p) = inner.phones.remove(&phone) else { return };
    crate::remote_ops::forget_phone(phone);
    let released: Vec<String> =
        inner.takeovers.iter().filter(|(_, (o, _, _))| *o == phone).map(|(pane, _)| pane.clone()).collect();
    for pane in &released {
        inner.takeovers.remove(pane);
        emit_size(r, pane, None);
    }
    if !released.is_empty() {
        send_tabs_all(r, inner);
    }
    if p.watching.is_some() {
        publish_watch(r, inner);
    }
}

/// JSON to one phone from outside the relay loop (`remote_ops.rs`).
pub(crate) fn send_to(phone: u32, msg: &serde_json::Value) {
    let Some(r) = remote() else { return };
    let mut inner = lock(&r.inner);
    if inner.phones.get(&phone).is_some_and(|p| p.authed) {
        send_json(r, &mut inner, phone, msg);
    }
}

/// Answer to a phone's `req`.
pub(crate) fn reply(phone: u32, rid: u32, result: Result<serde_json::Value, String>) {
    let msg = match result {
        Ok(data) => serde_json::json!({ "t": "res", "rid": rid, "ok": true, "data": data }),
        Err(error) => serde_json::json!({ "t": "res", "rid": rid, "ok": false, "error": error }),
    };
    send_to(phone, &msg);
}

/// File contents to a phone; false when it is gone.
pub(crate) fn send_file(phone: u32, x: u32, bytes: &[u8]) -> bool {
    let Some(r) = remote() else { return false };
    let mut inner = lock(&r.inner);
    if inner.out.is_none() || !inner.phones.get(&phone).is_some_and(|p| p.authed) {
        return false;
    }
    let mut plain = Vec::with_capacity(5 + bytes.len());
    plain.push(P_FILE);
    plain.extend_from_slice(&x.to_be_bytes());
    plain.extend_from_slice(bytes);
    send_sealed(r, &mut inner, phone, &plain);
    true
}

fn pane_exists(inner: &Inner, pane: &str) -> bool {
    inner.tabs.values().flatten().any(|t| t.id == pane)
}

fn on_relay_frame(r: &Remote, frame: &[u8]) {
    if frame.len() < 5 {
        return;
    }
    let kind = frame[0];
    let phone = u32::from_be_bytes(frame[1..5].try_into().unwrap());
    let payload = &frame[5..];
    let mut inner = lock(&r.inner);
    match kind {
        R_JOIN => {
            if inner.phones.len() >= MAX_PHONES * 2 {
                if let Some(out) = &inner.out {
                    let _ = out.send(envelope(R_KICK, phone, &[]));
                }
                return;
            }
            inner.phones.insert(
                phone,
                Phone { session: None, authed: false, name: String::new(), watching: None, awaiting: false },
            );
        }
        R_LEAVE => {
            let was_authed = inner.phones.get(&phone).is_some_and(|p| p.authed);
            drop_phone(r, &mut inner, phone);
            if was_authed {
                publish_status(r, &inner);
            }
        }
        R_DATA => on_phone_data(r, &mut inner, phone, payload),
        _ => {}
    }
}

fn on_phone_data(r: &Remote, inner: &mut Inner, phone: u32, payload: &[u8]) {
    let Some(secret) = inner.secret else { return };
    let Some(p) = inner.phones.get_mut(&phone) else { return };
    // Handshake: a fresh nonce from each side, so every session has its own keys.
    if payload.first() == Some(&rc::HELLO) && payload.len() == 1 + rc::NONCE_LEN && !p.authed {
        let host_nonce = rc::random::<{ rc::NONCE_LEN }>();
        p.session = Some(Session::host(&secret, &payload[1..], &host_nonce));
        let mut accept = vec![rc::ACCEPT];
        accept.extend_from_slice(&host_nonce);
        send_raw(r, inner, phone, &accept);
        return;
    }
    let Some(plain) = p.session.as_mut().and_then(|s| s.open(payload)) else {
        // Wrong key (an old pairing) or a forged frame: send it away.
        if let Some(out) = &inner.out {
            let _ = out.send(envelope(R_KICK, phone, &[]));
        }
        drop_phone(r, inner, phone);
        return;
    };
    if plain.first() == Some(&P_FILE) && plain.len() >= 5 && p.authed {
        let x = u32::from_be_bytes(plain[1..5].try_into().unwrap());
        crate::remote_ops::upload_chunk(phone, x, &plain[5..]);
        return;
    }
    if plain.first() != Some(&P_JSON) {
        return;
    }
    let Ok(msg) = serde_json::from_slice::<PhoneMsg>(&plain[1..]) else { return };
    let authed = p.authed;
    match msg {
        PhoneMsg::Hi { name } => {
            if authed {
                return;
            }
            if inner.phones.values().filter(|p| p.authed).count() >= MAX_PHONES {
                send_json(r, inner, phone, &serde_json::json!({ "t": "error", "code": "too-many" }));
                if let Some(out) = &inner.out {
                    let _ = out.send(envelope(R_KICK, phone, &[]));
                }
                inner.phones.remove(&phone);
                return;
            }
            let p = inner.phones.get_mut(&phone).unwrap();
            p.authed = true;
            p.name = name.unwrap_or_default().chars().take(60).collect();
            let hello = serde_json::json!({
                "t": "hello", "computer": computer_name(), "readOnly": inner.config.read_only, "features": ["sessions", "files", "tabs"],
            });
            send_json(r, inner, phone, &hello);
            let tabs = tabs_json(inner, phone);
            send_json(r, inner, phone, &tabs);
            publish_status(r, inner);
            let label = inner.phones[&phone].name.clone();
            let _ = r.app.emit("remote-phone-joined", label);
        }
        _ if !authed => {}
        PhoneMsg::Sub { id } => {
            let id = id.filter(|id| pane_exists(inner, id));
            let p = inner.phones.get_mut(&phone).unwrap();
            p.watching = id.clone();
            p.awaiting = id.is_some();
            publish_watch(r, inner);
            publish_status(r, inner);
            if let Some(id) = id {
                needs_snapshot(r, &id);
            }
        }
        PhoneMsg::In { id, d } => {
            if inner.config.read_only || !pane_exists(inner, &id) || !crate::mcp::user_write_allowed(&id, d.as_bytes()) {
                return;
            }
            if let Some(ctx) = r.app.try_state::<crate::AppContext>() {
                let _ = ctx.connections.write(&id, d.as_bytes());
            }
        }
        PhoneMsg::Take { id, cols, rows } => {
            if inner.config.read_only || !pane_exists(inner, &id) {
                return;
            }
            let (cols, rows) = (cols.clamp(20, 500), rows.clamp(5, 300));
            inner.takeovers.insert(id.clone(), (phone, cols, rows));
            emit_size(r, &id, Some((cols, rows)));
            send_tabs_all(r, inner);
        }
        PhoneMsg::Release { id } => {
            if inner.takeovers.get(&id).is_some_and(|(o, _, _)| *o == phone) {
                inner.takeovers.remove(&id);
                emit_size(r, &id, None);
                send_tabs_all(r, inner);
            }
        }
        PhoneMsg::Ping => send_json(r, inner, phone, &serde_json::json!({ "t": "pong" })),
        PhoneMsg::Req { rid, op, a } => {
            crate::remote_ops::request(r.app.clone(), phone, rid, op, a, inner.config.read_only);
        }
        PhoneMsg::FsAck { x, n } => crate::remote_ops::ack(phone, x, n),
        PhoneMsg::FsEnd { x } => crate::remote_ops::upload_end(phone, x),
        PhoneMsg::FsCancel { x } => crate::remote_ops::cancel(phone, x),
        PhoneMsg::Login { id, user, pwd, remember } => {
            if inner.config.read_only || !pane_exists(inner, &id) {
                return;
            }
            let clip = |s: String| s.chars().take(1024).collect::<String>();
            let payload = LoginPayload { pane_id: id, username: user.map(clip), password: pwd.map(clip), remember };
            let _ = r.app.emit("remote-login", payload);
        }
        PhoneMsg::HostKey { id, d } => {
            if inner.config.read_only {
                return;
            }
            if let Some((request_id, _)) = inner.host_keys.remove(&id) {
                crate::manager::answer_host_key(&request_id, d);
                // The desktop dialog drops the question.
                let _ = r.app.emit("host-key-resolved", &request_id);
                send_tabs_all(r, inner);
            }
        }
    }
}

/// Forget every phone of a dropped relay link.
fn clear_phones(r: &Remote) {
    let mut inner = lock(&r.inner);
    inner.out = None;
    let ids: Vec<u32> = inner.phones.keys().copied().collect();
    for id in ids {
        drop_phone(r, &mut inner, id);
    }
}

async fn run(mut generation: watch::Receiver<u64>) {
    let Some(r) = remote() else { return };
    let mut backoff = Duration::from_secs(1);
    loop {
        generation.borrow_and_update();
        let config = lock(&r.inner).config.clone();
        let urls = link::relay_urls(&config.relay_url);
        if !config.enabled || urls.is_none() {
            let msg = (config.enabled && urls.is_none()).then(|| "relay address must start with https:// or http://".to_string());
            set_state(r, if msg.is_some() { "error" } else { "off" }, msg);
            let _ = generation.changed().await;
            continue;
        }
        let (ws_url, _) = urls.unwrap();
        let room = {
            let mut inner = lock(&r.inner);
            rc::room_id(inner.secret.get_or_insert_with(load_or_create_secret))
        };
        let url = link::host_url(&ws_url, &room, &config.host_token);
        set_state(r, "connecting", None);
        let result = tokio::select! {
            res = link::connect(&url) => match res {
                Ok(ws) => {
                    backoff = Duration::from_secs(1);
                    session(r, ws, &mut generation).await
                }
                Err(e) => Err(e),
            },
            _ = generation.changed() => Ok(()),
        };
        clear_phones(r);
        match result {
            // Config changed: reconnect at once.
            Ok(()) => continue,
            Err(e) => set_state(r, "error", Some(e)),
        }
        tokio::select! {
            _ = tokio::time::sleep(backoff) => {}
            _ = generation.changed() => {}
        }
        backoff = (backoff * 2).min(Duration::from_secs(30));
    }
}

/// One relay connection. `Ok` when the config changed, `Err` when the link failed.
async fn session(r: &'static Remote, ws: link::Ws, generation: &mut watch::Receiver<u64>) -> Result<(), String> {
    let (tx, rx) = mpsc::unbounded_channel::<Vec<u8>>();
    r.queued.store(0, Ordering::Relaxed);
    r.stalled.store(false, Ordering::Relaxed);
    lock(&r.inner).out = Some(tx);
    set_state(r, "online", None);
    let drained = || {
        if r.queued.load(Ordering::Relaxed) < QUEUE_LIMIT / 4 && r.stalled.swap(false, Ordering::Relaxed) {
            resync(r);
        }
    };
    tokio::select! {
        res = link::serve(ws, rx, Arc::clone(&r.queued), |frame| on_relay_frame(r, frame), drained) => res,
        _ = generation.changed() => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_and_host_key_messages() {
        let m: PhoneMsg = serde_json::from_str(r#"{"t":"login","id":"p1","user":"root","pwd":"x","remember":true}"#).unwrap();
        assert!(matches!(m, PhoneMsg::Login { ref id, user: Some(ref u), pwd: Some(ref p), remember: true } if id == "p1" && u == "root" && p == "x"));
        // Reconnect: no credentials at all.
        let m: PhoneMsg = serde_json::from_str(r#"{"t":"login","id":"p1"}"#).unwrap();
        assert!(matches!(m, PhoneMsg::Login { user: None, pwd: None, remember: false, .. }));
        let m: PhoneMsg = serde_json::from_str(r#"{"t":"login","id":"p1","user":null,"pwd":"x","remember":false}"#).unwrap();
        assert!(matches!(m, PhoneMsg::Login { user: None, pwd: Some(_), .. }));
        let m: PhoneMsg = serde_json::from_str(r#"{"t":"hostKey","id":"p1","d":"acceptAndSave"}"#).unwrap();
        assert!(matches!(m, PhoneMsg::HostKey { d: crate::manager::HostKeyDecision::AcceptAndSave, .. }));
    }

    #[test]
    fn tab_without_new_fields() {
        // Older windows (or tests) report tabs without the login fields.
        let t: RemoteTab =
            serde_json::from_str(r#"{"id":"p","title":"t","status":"connected","cols":80,"rows":24,"active":true}"#).unwrap();
        assert!(t.auth.is_none() && !t.password_auth && !t.locked && t.message.is_empty());
    }
}
