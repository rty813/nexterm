//! Session shares: one pane shown to whoever opens a one-off link, through the same
//! relay as remote access (`remote.rs`) but in a room of its own, so a share sees
//! nothing else on this computer: no other tabs, sessions, files or login forms.
//!
//! Each share has a fresh secret kept only in memory; the link (`<relay>/s#k=…`) stops
//! working for good when the share stops, its pane closes, it expires or the app exits.
//! Viewers only watch; the one viewer granted control may type as well, and may take over
//! the pane's size (given back as soon as it loses control). Everything a viewer may do is
//! checked here, not on the page.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, watch};

use crate::relay_link::{self as link, envelope, percent_encode, R_DATA, R_JOIN, R_KICK, R_LEAVE};
use crate::remote::{read_size, F_OUTPUT, F_SCREEN, F_SCREEN_ALL, F_SIZE, F_SNAPSHOT, F_SNAPSHOT_ALL, OUTPUT_CHUNK, P_JSON, P_OUTPUT};
use crate::remote_crypto::{self as rc, Session};

const MAX_SHARES: usize = 4;
const MAX_VIEWERS: usize = 8;
/// Waiting to go out to the relay; beyond this, viewers skip output and get a fresh screen.
const QUEUE_LIMIT: usize = 8 * 1024 * 1024;
/// A pane missing this long closed (moving a tab to another window takes less).
const GONE_AFTER_MS: u64 = 3000;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ShareOptions {
    /// 0: until stopped.
    pub expires_minutes: u32,
    /// Viewers get the scrollback too, not only the visible screen.
    pub scrollback: bool,
    /// New viewers wait until the computer lets them in.
    pub approve: bool,
    /// Only the first viewer (who may come back after losing the connection).
    pub single: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareViewer {
    pub id: u32,
    pub name: String,
    /// Waiting to be let in.
    pub pending: bool,
    pub control: bool,
    /// Asked for control.
    pub asking: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareInfo {
    pub id: String,
    pub pane_id: String,
    pub title: String,
    pub url: String,
    pub qr_svg: String,
    /// "connecting" | "online" | "error"
    pub state: String,
    pub message: Option<String>,
    /// Milliseconds since the epoch.
    pub expires_at: Option<u64>,
    pub options: ShareOptions,
    pub viewers: Vec<ShareViewer>,
}

/// A viewer asks to join, or for control (toast on the computer).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SharePrompt {
    share_id: String,
    pane_id: String,
    viewer: u32,
    name: String,
    /// "join" | "control"
    kind: &'static str,
}

#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
enum ViewerMsg {
    Hi {
        #[serde(default)]
        name: Option<String>,
        /// Given to every viewer let in: it comes back without asking again.
        #[serde(default)]
        token: Option<String>,
    },
    In { d: String },
    Ask,
    Drop,
    /// The viewer with control fits the pane to its window.
    Take { cols: u16, rows: u16 },
    Release,
    Ping,
}

#[derive(Default)]
struct Viewer {
    session: Option<Session>,
    /// Said hi (has a name).
    joined: bool,
    /// Let in: gets the screen.
    admitted: bool,
    name: String,
    asking: bool,
    /// Admitted, but the screen snapshot has not come yet.
    awaiting: bool,
    /// What it comes back with after a dropped connection.
    token: Option<String>,
}

struct Share {
    id: String,
    pane: String,
    title: String,
    status: String,
    secret: [u8; rc::SECRET_LEN],
    url: String,
    qr_svg: String,
    options: ShareOptions,
    expires_at: Option<u64>,
    state: String,
    message: Option<String>,
    out: Option<mpsc::UnboundedSender<Vec<u8>>>,
    queued: Arc<AtomicUsize>,
    stalled: Arc<AtomicBool>,
    viewers: HashMap<u32, Viewer>,
    controller: Option<u32>,
    /// (viewer, cols, rows) while the viewer with control holds the pane's size.
    size: Option<(u32, u16, u16)>,
    /// Tokens of the viewers let in so far (removed or denied ones lose theirs).
    tokens: HashSet<String>,
    /// No window lists the pane since then (ms): it closed, or is moving between windows.
    missing_since: Option<u64>,
    /// Dropped with the share: its connection loop stops.
    _alive: watch::Sender<()>,
}

struct Shares {
    app: AppHandle,
    list: Mutex<HashMap<String, Share>>,
}

static SHARES: OnceLock<Shares> = OnceLock::new();

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn shares() -> Option<&'static Shares> {
    SHARES.get()
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn expiry(minutes: u32) -> Option<u64> {
    (minutes > 0).then(|| now_ms() + minutes as u64 * 60_000)
}

pub fn init(app: AppHandle) {
    if SHARES.set(Shares { app, list: Mutex::new(HashMap::new()) }).is_ok() {
        tauri::async_runtime::spawn(async {
            let mut tick = tokio::time::interval(Duration::from_secs(1));
            loop {
                tick.tick().await;
                expire_due();
            }
        });
    }
}

/// The link of a share: the secret, the tab title and the computer stay in the fragment.
fn share_url(page: &str, secret: &[u8], title: &str) -> String {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64U;
    use base64::Engine;
    format!(
        "{page}s#k={}&n={}&c={}",
        B64U.encode(secret),
        percent_encode(title),
        percent_encode(&link::computer_name())
    )
}

/// Whether the relay serves the share page (older relays answer 404).
async fn relay_serves_shares(page: &str) -> bool {
    let Ok(client) = reqwest::Client::builder().timeout(Duration::from_secs(6)).build() else { return true };
    match client.head(format!("{page}s")).send().await {
        Ok(resp) => resp.status() != reqwest::StatusCode::NOT_FOUND,
        // Unreachable right now: the link loop reports it.
        Err(_) => true,
    }
}

/// Share a pane (or return its share when it has one).
pub async fn start(pane: String, options: ShareOptions) -> Result<ShareInfo, String> {
    let s = shares().ok_or("not ready")?;
    if let Some(info) = lock(&s.list).values().find(|sh| sh.pane == pane).map(info_of) {
        return Ok(info);
    }
    let (relay, token) = crate::remote::relay_config();
    let (ws_url, page) = link::relay_urls(&relay).ok_or("no-relay")?;
    let tab = crate::remote::tab(&pane).ok_or("no-pane")?;
    if lock(&s.list).len() >= MAX_SHARES {
        return Err("too-many".into());
    }
    if !relay_serves_shares(&page).await {
        return Err("old-relay".into());
    }
    let secret = rc::random::<{ rc::SECRET_LEN }>();
    let id = hex(&rc::random::<6>());
    let url = share_url(&page, &secret, &tab.title);
    let (alive, alive_rx) = watch::channel(());
    let share = Share {
        id: id.clone(),
        pane: pane.clone(),
        title: tab.title.clone(),
        status: tab.status.clone(),
        secret,
        qr_svg: link::qr_svg(&url),
        url,
        expires_at: expiry(options.expires_minutes),
        options,
        state: "connecting".into(),
        message: None,
        out: None,
        queued: Arc::new(AtomicUsize::new(0)),
        stalled: Arc::new(AtomicBool::new(false)),
        viewers: HashMap::new(),
        controller: None,
        size: None,
        tokens: HashSet::new(),
        missing_since: None,
        _alive: alive,
    };
    let host = link::host_url(&ws_url, &rc::room_id(&secret), &token);
    let info = {
        let mut list = lock(&s.list);
        // Two clicks at once: the first one wins.
        if let Some(existing) = list.values().find(|sh| sh.pane == pane) {
            return Ok(info_of(existing));
        }
        let info = info_of(&share);
        list.insert(id.clone(), share);
        publish(s, &list);
        info
    };
    tauri::async_runtime::spawn(run(id, host, alive_rx));
    Ok(info)
}

/// Stop a share; its viewers are told why and sent away.
pub fn stop(id: &str) {
    end(id, "stopped");
}

fn end(id: &str, reason: &str) {
    let Some(s) = shares() else { return };
    let mut list = lock(&s.list);
    let Some(mut sh) = list.remove(id) else { return };
    if sh.size.take().is_some() {
        emit_size(&sh.pane, None);
    }
    let ids: Vec<u32> = sh.viewers.keys().copied().collect();
    for v in ids {
        send_json(&mut sh, v, &serde_json::json!({ "t": "end", "reason": reason }));
        if let Some(out) = &sh.out {
            let _ = out.send(envelope(R_KICK, v, &[]));
        }
    }
    // Dropping `sh` drops its sender: the link sends what is queued, then closes.
    publish(s, &list);
    publish_watch(s, &list);
}

pub fn update(id: &str, options: ShareOptions) {
    let Some(s) = shares() else { return };
    let mut list = lock(&s.list);
    let Some(sh) = list.get_mut(id) else { return };
    if sh.options.expires_minutes != options.expires_minutes {
        sh.expires_at = expiry(options.expires_minutes);
    }
    let scrollback_changed = sh.options.scrollback != options.scrollback;
    sh.options = options;
    if scrollback_changed {
        // The viewers get the screen again, the way they now should see it.
        for v in sh.viewers.values_mut().filter(|v| v.admitted) {
            v.awaiting = true;
        }
    }
    let pane = sh.pane.clone();
    publish(s, &list);
    publish_watch(s, &list);
    if scrollback_changed {
        needs_snapshot(s, &pane);
    }
}

/// Give a viewer control (taking it from whoever had it), or take it back.
pub fn grant(id: &str, viewer: u32, on: bool) {
    let Some(s) = shares() else { return };
    let mut list = lock(&s.list);
    let Some(sh) = list.get_mut(id) else { return };
    if on {
        if !sh.viewers.get(&viewer).is_some_and(|v| v.admitted) {
            return;
        }
        sh.controller = Some(viewer);
    } else if sh.controller == Some(viewer) {
        sh.controller = None;
    }
    if let Some(v) = sh.viewers.get_mut(&viewer) {
        v.asking = false;
    }
    send_control_all(sh);
    publish(s, &list);
}

/// Let a waiting viewer in, or turn it away.
pub fn approve(id: &str, viewer: u32, allow: bool) {
    let Some(s) = shares() else { return };
    let mut list = lock(&s.list);
    let Some(sh) = list.get_mut(id) else { return };
    if !sh.viewers.get(&viewer).is_some_and(|v| v.joined && !v.admitted) {
        return;
    }
    if allow {
        admit(sh, viewer);
    } else {
        send_away(sh, viewer, "denied");
    }
    publish(s, &list);
    publish_watch(s, &list);
    if let Some(sh) = list.get(id) {
        resync(s, sh);
    }
}

pub fn kick(id: &str, viewer: u32) {
    let Some(s) = shares() else { return };
    let mut list = lock(&s.list);
    let Some(sh) = list.get_mut(id) else { return };
    send_away(sh, viewer, "kicked");
    send_control_all(sh);
    publish(s, &list);
    publish_watch(s, &list);
}

/// The desktop takes the pane's size back from a viewer.
pub fn release_pane(pane: &str) {
    let Some(s) = shares() else { return };
    let mut list = lock(&s.list);
    let mut released = false;
    for sh in list.values_mut().filter(|sh| sh.pane == pane) {
        if let Some((owner, _, _)) = sh.size.take() {
            released = true;
            let msg = control_json(sh, owner);
            send_json(sh, owner, &msg);
        }
    }
    if released {
        emit_size(pane, None);
    }
}

/// Sizes held by viewers, for a pane that mounts later.
pub fn takeovers() -> Vec<(String, u16, u16)> {
    let Some(s) = shares() else { return Vec::new() };
    let list = lock(&s.list);
    list.values().filter_map(|sh| sh.size.map(|(_, c, r)| (sh.pane.clone(), c, r))).collect()
}

pub fn list() -> Vec<ShareInfo> {
    let Some(s) = shares() else { return Vec::new() };
    let list = lock(&s.list);
    infos(&list)
}

/// Tabs changed: shares follow title and state; a share whose pane stays gone ends.
pub fn tabs_changed() {
    let Some(s) = shares() else { return };
    let tabs = crate::remote::tabs();
    let mut list = lock(&s.list);
    let mut changed = false;
    let now = now_ms();
    for sh in list.values_mut() {
        let Some(tab) = tabs.get(&sh.pane) else {
            sh.missing_since.get_or_insert(now);
            continue;
        };
        sh.missing_since = None;
        if tab.title != sh.title || tab.status != sh.status {
            sh.title = tab.title.clone();
            sh.status = tab.status.clone();
            let msg = serde_json::json!({ "t": "tab", "title": sh.title, "status": sh.status });
            for v in admitted_ids(sh) {
                send_json(sh, v, &msg);
            }
            changed = true;
        }
    }
    if changed {
        publish(s, &list);
    }
}

fn expire_due() {
    let Some(s) = shares() else { return };
    let now = now_ms();
    let due: Vec<(String, &'static str)> = lock(&s.list)
        .values()
        .filter_map(|sh| {
            if sh.missing_since.is_some_and(|t| now >= t + GONE_AFTER_MS) {
                Some((sh.id.clone(), "closed"))
            } else if sh.expires_at.is_some_and(|t| t <= now) {
                Some((sh.id.clone(), "expired"))
            } else {
                None
            }
        })
        .collect();
    for (id, reason) in due {
        end(&id, reason);
    }
}

/// Records forwarded by a desktop pane (see `remote::feed`).
pub fn feed(pane: &str, body: &[u8]) {
    let Some(s) = shares() else { return };
    let mut list = lock(&s.list);
    for sh in list.values_mut().filter(|sh| sh.pane == pane && sh.out.is_some()) {
        feed_share(sh, body);
    }
}

fn feed_share(sh: &mut Share, body: &[u8]) {
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
        let over = sh.queued.load(Ordering::Relaxed) > QUEUE_LIMIT;
        // Snapshots with or without scrollback, as this share shows them.
        let (snap, snap_all) = if sh.options.scrollback { (F_SNAPSHOT, F_SNAPSHOT_ALL) } else { (F_SCREEN, F_SCREEN_ALL) };
        match kind {
            F_OUTPUT if over => {
                for v in sh.viewers.values_mut().filter(|v| v.admitted) {
                    v.awaiting = true;
                }
                sh.stalled.store(true, Ordering::Relaxed);
            }
            F_OUTPUT => {
                for v in in_sync_ids(sh) {
                    for chunk in payload.chunks(OUTPUT_CHUNK) {
                        send_output(sh, v, chunk);
                    }
                }
            }
            F_SIZE if len >= 4 => {
                let (cols, rows, wide) = read_size(payload);
                let msg = serde_json::json!({ "t": "size", "cols": cols, "rows": rows, "wide": wide });
                for v in in_sync_ids(sh) {
                    send_json(sh, v, &msg);
                }
            }
            k if (k == snap || k == snap_all) && len >= 4 && !over => {
                let (cols, rows, wide) = read_size(payload);
                let screen = &payload[4..];
                let ids: Vec<u32> = sh
                    .viewers
                    .iter()
                    .filter(|(_, v)| v.admitted && (k == snap_all || v.awaiting))
                    .map(|(id, _)| *id)
                    .collect();
                let msg = serde_json::json!({ "t": "reset", "cols": cols, "rows": rows, "wide": wide });
                for v in ids {
                    send_json(sh, v, &msg);
                    for chunk in screen.chunks(OUTPUT_CHUNK) {
                        send_output(sh, v, chunk);
                    }
                    if let Some(v) = sh.viewers.get_mut(&v) {
                        v.awaiting = false;
                    }
                }
            }
            _ => {}
        }
    }
}

fn admitted_ids(sh: &Share) -> Vec<u32> {
    sh.viewers.iter().filter(|(_, v)| v.admitted).map(|(id, _)| *id).collect()
}

/// Admitted viewers that already have the screen.
fn in_sync_ids(sh: &Share) -> Vec<u32> {
    sh.viewers.iter().filter(|(_, v)| v.admitted && !v.awaiting).map(|(id, _)| *id).collect()
}

fn info_of(sh: &Share) -> ShareInfo {
    let mut viewers: Vec<ShareViewer> = sh
        .viewers
        .iter()
        .filter(|(_, v)| v.joined)
        .map(|(id, v)| ShareViewer {
            id: *id,
            name: v.name.clone(),
            pending: !v.admitted,
            control: sh.controller == Some(*id),
            asking: v.asking,
        })
        .collect();
    viewers.sort_by_key(|v| v.id);
    ShareInfo {
        id: sh.id.clone(),
        pane_id: sh.pane.clone(),
        title: sh.title.clone(),
        url: sh.url.clone(),
        qr_svg: sh.qr_svg.clone(),
        state: sh.state.clone(),
        message: sh.message.clone(),
        expires_at: sh.expires_at,
        options: sh.options.clone(),
        viewers,
    }
}

fn infos(list: &HashMap<String, Share>) -> Vec<ShareInfo> {
    let mut all: Vec<ShareInfo> = list.values().map(info_of).collect();
    all.sort_by(|a, b| a.id.cmp(&b.id));
    all
}

fn publish(s: &Shares, list: &HashMap<String, Share>) {
    let _ = s.app.emit("share-state", infos(list));
}

/// Panes with someone let in, by the snapshot they need.
fn publish_watch(s: &Shares, list: &HashMap<String, Share>) {
    let mut full = HashSet::new();
    let mut screen = HashSet::new();
    for sh in list.values().filter(|sh| sh.viewers.values().any(|v| v.admitted)) {
        if sh.options.scrollback {
            full.insert(sh.pane.clone());
        } else {
            screen.insert(sh.pane.clone());
        }
    }
    crate::remote::set_share_watch(&s.app, full, screen);
}

fn needs_snapshot(s: &Shares, pane: &str) {
    let _ = s.app.emit("remote-snapshot", pane);
}

fn send_raw(sh: &Share, viewer: u32, payload: &[u8]) {
    if let Some(out) = &sh.out {
        let frame = envelope(R_DATA, viewer, payload);
        sh.queued.fetch_add(frame.len(), Ordering::Relaxed);
        let _ = out.send(frame);
    }
}

fn send_sealed(sh: &mut Share, viewer: u32, plain: &[u8]) {
    let Some(sealed) = sh.viewers.get_mut(&viewer).and_then(|v| v.session.as_mut()).map(|s| s.seal(plain)) else {
        return;
    };
    send_raw(sh, viewer, &sealed);
}

fn send_json(sh: &mut Share, viewer: u32, msg: &serde_json::Value) {
    let mut plain = vec![P_JSON];
    plain.extend_from_slice(msg.to_string().as_bytes());
    send_sealed(sh, viewer, &plain);
}

/// Same framing as remote access (`[P_OUTPUT][id len][id][bytes]`), so the pages share it.
fn send_output(sh: &mut Share, viewer: u32, bytes: &[u8]) {
    let id = sh.pane.as_bytes()[..sh.pane.len().min(255)].to_vec();
    let mut plain = Vec::with_capacity(2 + id.len() + bytes.len());
    plain.push(P_OUTPUT);
    plain.push(id.len() as u8);
    plain.extend_from_slice(&id);
    plain.extend_from_slice(bytes);
    send_sealed(sh, viewer, &plain);
}

fn control_json(sh: &Share, viewer: u32) -> serde_json::Value {
    let control = sh.controller.map(|c| if c == viewer { "me" } else { "other" });
    let asking = sh.viewers.get(&viewer).is_some_and(|v| v.asking);
    let size = sh.size.is_some_and(|(o, _, _)| o == viewer);
    serde_json::json!({ "t": "control", "control": control, "asking": asking, "size": size })
}

/// The pane's size: a viewer's, or back to the computer (or to a remote device holding it).
fn emit_size(pane: &str, size: Option<(u16, u16)>) {
    let Some(s) = shares() else { return };
    let size = size.or_else(|| crate::remote::takeovers().into_iter().find(|(p, _, _)| p == pane).map(|(_, c, r)| (c, r)));
    let _ = s.app.emit(
        "remote-size",
        serde_json::json!({ "paneId": pane, "cols": size.map(|s| s.0), "rows": size.map(|s| s.1) }),
    );
}

/// Only the viewer with control holds the size: it goes back once that viewer lost control.
fn size_follows_control(sh: &mut Share) {
    if sh.size.is_some_and(|(owner, _, _)| !may_type(sh.controller, owner)) {
        sh.size = None;
        emit_size(&sh.pane, None);
    }
}

/// Control changed: the viewers learn who has it (and the size goes back when needed).
fn send_control_all(sh: &mut Share) {
    size_follows_control(sh);
    for v in admitted_ids(sh) {
        let msg = control_json(sh, v);
        send_json(sh, v, &msg);
    }
}

fn admit(sh: &mut Share, viewer: u32) {
    let Some(v) = sh.viewers.get_mut(&viewer) else { return };
    v.admitted = true;
    v.awaiting = true;
    let token = v.token.get_or_insert_with(|| hex(&rc::random::<16>())).clone();
    sh.tokens.insert(token.clone());
    let hello = serde_json::json!({
        "t": "hello", "title": sh.title, "status": sh.status, "computer": link::computer_name(), "token": token,
    });
    send_json(sh, viewer, &hello);
    let control = control_json(sh, viewer);
    send_json(sh, viewer, &control);
}

/// Viewers let in that wait for the screen get it. Call after `publish_watch`: the
/// window only snapshots panes it knows are watched.
fn resync(s: &Shares, sh: &Share) {
    if sh.viewers.values().any(|v| v.admitted && v.awaiting) {
        needs_snapshot(s, &sh.pane);
    }
}

/// Tell a viewer why, and have the relay drop it. It cannot come back with its token.
fn send_away(sh: &mut Share, viewer: u32, reason: &str) {
    send_json(sh, viewer, &serde_json::json!({ "t": "end", "reason": reason }));
    if let Some(out) = &sh.out {
        let _ = out.send(envelope(R_KICK, viewer, &[]));
    }
    if let Some(token) = sh.viewers.get(&viewer).and_then(|v| v.token.clone()) {
        sh.tokens.remove(&token);
    }
    forget_viewer(sh, viewer);
}

fn forget_viewer(sh: &mut Share, viewer: u32) {
    sh.viewers.remove(&viewer);
    if sh.controller == Some(viewer) {
        sh.controller = None;
        send_control_all(sh);
    }
}

fn on_frame(id: &str, frame: &[u8]) {
    if frame.len() < 5 {
        return;
    }
    let Some(s) = shares() else { return };
    let kind = frame[0];
    let viewer = u32::from_be_bytes(frame[1..5].try_into().unwrap());
    let payload = &frame[5..];
    let mut list = lock(&s.list);
    let Some(sh) = list.get_mut(id) else { return };
    match kind {
        R_JOIN => {
            if sh.viewers.len() >= MAX_VIEWERS * 2 {
                if let Some(out) = &sh.out {
                    let _ = out.send(envelope(R_KICK, viewer, &[]));
                }
                return;
            }
            sh.viewers.insert(viewer, Viewer::default());
        }
        R_LEAVE => {
            let was = sh.viewers.get(&viewer).map(|v| (v.joined, v.admitted));
            forget_viewer(sh, viewer);
            if let Some((joined, admitted)) = was {
                if joined {
                    publish(s, &list);
                }
                if admitted {
                    publish_watch(s, &list);
                }
            }
        }
        R_DATA => {
            let (state, watch) = on_viewer_data(s, sh, viewer, payload);
            if state {
                publish(s, &list);
            }
            if watch {
                publish_watch(s, &list);
                if let Some(sh) = list.get(id) {
                    resync(s, sh);
                }
            }
        }
        _ => {}
    }
}

/// Returns whether the desktop's view of the share and what it watches changed.
fn on_viewer_data(s: &Shares, sh: &mut Share, viewer: u32, payload: &[u8]) -> (bool, bool) {
    let secret = sh.secret;
    let Some(v) = sh.viewers.get_mut(&viewer) else { return (false, false) };
    if payload.first() == Some(&rc::HELLO) && payload.len() == 1 + rc::NONCE_LEN && !v.joined {
        let host_nonce = rc::random::<{ rc::NONCE_LEN }>();
        v.session = Some(Session::host(&secret, &payload[1..], &host_nonce));
        let mut accept = vec![rc::ACCEPT];
        accept.extend_from_slice(&host_nonce);
        send_raw(sh, viewer, &accept);
        return (false, false);
    }
    let Some(plain) = v.session.as_mut().and_then(|s| s.open(payload)) else {
        // Wrong key or a forged frame.
        if let Some(out) = &sh.out {
            let _ = out.send(envelope(R_KICK, viewer, &[]));
        }
        let was = v.joined;
        forget_viewer(sh, viewer);
        return (was, was);
    };
    if plain.first() != Some(&P_JSON) {
        return (false, false);
    }
    let Ok(msg) = serde_json::from_slice::<ViewerMsg>(&plain[1..]) else { return (false, false) };
    let (joined, admitted) = (v.joined, v.admitted);
    match msg {
        ViewerMsg::Hi { name, token } => {
            if joined {
                return (false, false);
            }
            let name: String = name.unwrap_or_default().trim().chars().take(40).collect();
            let inside = sh.viewers.values().filter(|v| v.admitted).count();
            if inside >= MAX_VIEWERS {
                send_away(sh, viewer, "full");
                return (false, false);
            }
            let returning = token.as_ref().is_some_and(|t| sh.tokens.contains(t));
            let decision = join_decision(&sh.options, !sh.tokens.is_empty(), returning);
            if decision == Join::Refuse {
                send_away(sh, viewer, "used");
                return (false, false);
            }
            let v = sh.viewers.get_mut(&viewer).unwrap();
            v.joined = true;
            v.name = name.clone();
            v.token = token.filter(|_| returning);
            if decision == Join::Wait {
                send_json(sh, viewer, &serde_json::json!({ "t": "wait", "title": sh.title }));
                let prompt = SharePrompt { share_id: sh.id.clone(), pane_id: sh.pane.clone(), viewer, name, kind: "join" };
                let _ = s.app.emit("share-prompt", prompt);
                return (true, false);
            }
            admit(sh, viewer);
            (true, true)
        }
        _ if !admitted => (false, false),
        ViewerMsg::In { d } => {
            if !may_type(sh.controller, viewer) || !crate::mcp::user_write_allowed(&sh.pane, d.as_bytes()) {
                return (false, false);
            }
            if let Some(ctx) = s.app.try_state::<crate::AppContext>() {
                let _ = ctx.connections.write(&sh.pane, d.as_bytes());
            }
            (false, false)
        }
        ViewerMsg::Ask => {
            let v = sh.viewers.get_mut(&viewer).unwrap();
            if sh.controller == Some(viewer) || v.asking {
                return (false, false);
            }
            v.asking = true;
            let name = v.name.clone();
            let msg = control_json(sh, viewer);
            send_json(sh, viewer, &msg);
            let prompt = SharePrompt { share_id: sh.id.clone(), pane_id: sh.pane.clone(), viewer, name, kind: "control" };
            let _ = s.app.emit("share-prompt", prompt);
            (true, false)
        }
        ViewerMsg::Drop => {
            let v = sh.viewers.get_mut(&viewer).unwrap();
            let was_asking = std::mem::take(&mut v.asking);
            if sh.controller == Some(viewer) {
                sh.controller = None;
            } else if !was_asking {
                return (false, false);
            }
            send_control_all(sh);
            (true, false)
        }
        ViewerMsg::Take { cols, rows } => {
            if !may_type(sh.controller, viewer) {
                return (false, false);
            }
            let (cols, rows) = (cols.clamp(20, 500), rows.clamp(5, 300));
            sh.size = Some((viewer, cols, rows));
            emit_size(&sh.pane, Some((cols, rows)));
            let msg = control_json(sh, viewer);
            send_json(sh, viewer, &msg);
            (false, false)
        }
        ViewerMsg::Release => {
            if sh.size.is_some_and(|(owner, _, _)| owner == viewer) {
                sh.size = None;
                emit_size(&sh.pane, None);
                let msg = control_json(sh, viewer);
                send_json(sh, viewer, &msg);
            }
            (false, false)
        }
        ViewerMsg::Ping => {
            send_json(sh, viewer, &serde_json::json!({ "t": "pong" }));
            (false, false)
        }
    }
}

#[derive(Debug, PartialEq)]
enum Join {
    Admit,
    /// Until the computer lets it in.
    Wait,
    /// A single-viewer link someone already uses.
    Refuse,
}

/// What happens to a viewer that says hi: `returning` = it brought the token of a viewer
/// let in before; `anyone_in` = some viewer was let in and not removed since.
fn join_decision(options: &ShareOptions, anyone_in: bool, returning: bool) -> Join {
    if returning {
        Join::Admit
    } else if options.single && anyone_in {
        Join::Refuse
    } else if options.approve {
        Join::Wait
    } else {
        Join::Admit
    }
}

/// Only the viewer holding control types.
fn may_type(controller: Option<u32>, viewer: u32) -> bool {
    controller == Some(viewer)
}

/// Connection state of a share; false once it is gone.
fn set_state(id: &str, state: &str, message: Option<String>) -> bool {
    let Some(s) = shares() else { return false };
    let mut list = lock(&s.list);
    let Some(sh) = list.get_mut(id) else { return false };
    sh.state = state.into();
    sh.message = message;
    publish(s, &list);
    true
}

/// The link is up: frames go out through `tx`.
fn attach(id: &str, tx: mpsc::UnboundedSender<Vec<u8>>) -> Option<(Arc<AtomicUsize>, Arc<AtomicBool>)> {
    let s = shares()?;
    let mut list = lock(&s.list);
    let sh = list.get_mut(id)?;
    sh.queued.store(0, Ordering::Relaxed);
    sh.stalled.store(false, Ordering::Relaxed);
    sh.out = Some(tx);
    sh.state = "online".into();
    sh.message = None;
    let handles = (Arc::clone(&sh.queued), Arc::clone(&sh.stalled));
    publish(s, &list);
    Some(handles)
}

/// The link dropped: the viewers reconnect once it is back. False once the share is gone.
fn detach(id: &str, error: String) -> bool {
    let Some(s) = shares() else { return false };
    let mut list = lock(&s.list);
    let Some(sh) = list.get_mut(id) else { return false };
    sh.out = None;
    sh.viewers.clear();
    sh.controller = None;
    if sh.size.take().is_some() {
        emit_size(&sh.pane, None);
    }
    sh.state = "error".into();
    sh.message = Some(error);
    publish(s, &list);
    publish_watch(s, &list);
    true
}

async fn run(id: String, url: String, mut alive: watch::Receiver<()>) {
    let mut backoff = Duration::from_secs(1);
    loop {
        if !set_state(&id, "connecting", None) {
            return;
        }
        let ws = tokio::select! {
            ws = link::connect(&url) => ws,
            _ = alive.changed() => return,
        };
        match ws {
            Ok(ws) => {
                backoff = Duration::from_secs(1);
                let (tx, rx) = mpsc::unbounded_channel::<Vec<u8>>();
                let Some((queued, stalled)) = attach(&id, tx) else { return };
                let watch_queued = Arc::clone(&queued);
                let drained = || {
                    if watch_queued.load(Ordering::Relaxed) < QUEUE_LIMIT / 4 && stalled.swap(false, Ordering::Relaxed) {
                        if let (Some(s), Some(pane)) = (shares(), pane_of(&id)) {
                            needs_snapshot(s, &pane);
                        }
                    }
                };
                // Ends when the link fails, or once the share stopped and its goodbyes went out.
                let res = link::serve(ws, rx, queued, |frame| on_frame(&id, frame), drained).await;
                if !detach(&id, res.err().unwrap_or_default()) {
                    return;
                }
            }
            Err(e) => {
                if !set_state(&id, "error", Some(e)) {
                    return;
                }
            }
        }
        tokio::select! {
            _ = tokio::time::sleep(backoff) => {}
            _ = alive.changed() => return,
        }
        backoff = (backoff * 2).min(Duration::from_secs(30));
    }
}

fn pane_of(id: &str) -> Option<String> {
    let s = shares()?;
    let list = lock(&s.list);
    list.get(id).map(|sh| sh.pane.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn viewer_messages() {
        let m: ViewerMsg = serde_json::from_str(r#"{"t":"hi","name":"Ann"}"#).unwrap();
        assert!(matches!(m, ViewerMsg::Hi { name: Some(ref n), token: None } if n == "Ann"));
        let m: ViewerMsg = serde_json::from_str(r#"{"t":"hi","token":"x"}"#).unwrap();
        assert!(matches!(m, ViewerMsg::Hi { name: None, token: Some(_) }));
        assert!(matches!(serde_json::from_str::<ViewerMsg>(r#"{"t":"ask"}"#).unwrap(), ViewerMsg::Ask));
        assert!(matches!(serde_json::from_str::<ViewerMsg>(r#"{"t":"drop"}"#).unwrap(), ViewerMsg::Drop));
        assert!(matches!(serde_json::from_str::<ViewerMsg>(r#"{"t":"in","d":"ls\r"}"#).unwrap(), ViewerMsg::In { .. }));
        assert!(matches!(
            serde_json::from_str::<ViewerMsg>(r#"{"t":"take","cols":90,"rows":30}"#).unwrap(),
            ViewerMsg::Take { cols: 90, rows: 30 }
        ));
        assert!(matches!(serde_json::from_str::<ViewerMsg>(r#"{"t":"release"}"#).unwrap(), ViewerMsg::Release));
        // Remote access messages mean nothing here.
        assert!(serde_json::from_str::<ViewerMsg>(r#"{"t":"sub","id":"p1"}"#).is_err());
        assert!(serde_json::from_str::<ViewerMsg>(r#"{"t":"req","rid":1,"op":"sessions"}"#).is_err());
    }

    #[test]
    fn options_default_and_camel_case() {
        let o: ShareOptions = serde_json::from_str("{}").unwrap();
        assert_eq!(o, ShareOptions::default());
        let o: ShareOptions = serde_json::from_str(r#"{"expiresMinutes":60,"approve":true}"#).unwrap();
        assert_eq!(o.expires_minutes, 60);
        assert!(o.approve && !o.single && !o.scrollback);
    }

    #[test]
    fn link_keeps_secrets_in_the_fragment() {
        let url = share_url("https://relay.example.com/wt/", &[7u8; 32], "prod web");
        let (page, fragment) = url.split_once('#').unwrap();
        assert_eq!(page, "https://relay.example.com/wt/s");
        assert!(fragment.starts_with("k=BwcH"));
        assert!(fragment.contains("&n=prod%20web&c="));
    }

    #[test]
    fn who_joins() {
        let open = ShareOptions::default();
        let approve = ShareOptions { approve: true, ..Default::default() };
        let single = ShareOptions { single: true, ..Default::default() };
        let both = ShareOptions { single: true, approve: true, ..Default::default() };
        assert_eq!(join_decision(&open, true, false), Join::Admit);
        assert_eq!(join_decision(&approve, false, false), Join::Wait);
        // Coming back after a dropped connection: no new question.
        assert_eq!(join_decision(&approve, true, true), Join::Admit);
        assert_eq!(join_decision(&single, false, false), Join::Admit);
        assert_eq!(join_decision(&single, true, false), Join::Refuse);
        assert_eq!(join_decision(&single, true, true), Join::Admit);
        assert_eq!(join_decision(&both, false, false), Join::Wait);
        assert_eq!(join_decision(&both, true, false), Join::Refuse);
    }

    #[test]
    fn only_the_controller_types() {
        assert!(may_type(Some(3), 3));
        assert!(!may_type(Some(3), 4));
        assert!(!may_type(None, 3));
    }

    #[test]
    fn expiry_from_minutes() {
        assert_eq!(expiry(0), None);
        let t = expiry(60).unwrap();
        assert!(t >= now_ms() + 59 * 60_000 && t <= now_ms() + 60 * 60_000);
    }
}
