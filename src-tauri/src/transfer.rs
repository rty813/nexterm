//! File transfer queue of the SSH file browser: SFTP (or SCP when the server has no SFTP)
//! uploads and downloads with pause / resume / cancel / retry, duplicate-target handling and
//! kept timestamps. ZModem / X/YMODEM results are recorded here as well, so every transfer
//! and the local file it produced shows in one list.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::Result;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{oneshot, Notify};

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Seconds since the epoch of a local file time.
pub fn unix_secs(t: std::io::Result<SystemTime>) -> Option<u64> {
    t.ok()?.duration_since(UNIX_EPOCH).ok().map(|d| d.as_secs())
}

/// The target of a transfer already exists.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictInfo {
    /// The existing target (local path or remote path).
    pub path: String,
    pub is_dir: bool,
    pub src_size: u64,
    pub src_mtime: Option<u64>,
    pub dst_size: u64,
    pub dst_mtime: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferInfo {
    pub id: String,
    pub instance_id: String,
    /// Session name at the time of the transfer (the pane may be gone later).
    pub label: String,
    /// "upload" | "download".
    pub direction: String,
    /// "sftp" | "scp" | "zmodem" | "xmodem" | "ymodem" ("" until the engine is chosen).
    pub protocol: String,
    pub name: String,
    /// Local file or folder: the source of an upload, the target of a download. None for
    /// files dropped on a terminal (the webview only had their contents).
    pub local_path: Option<String>,
    pub remote_path: String,
    pub is_dir: bool,
    /// queued | running | paused | conflict | done | error | cancelled
    pub state: String,
    pub total: u64,
    pub transferred: u64,
    pub files_total: u32,
    pub files_done: u32,
    /// Files left alone because the target existed (skip / not newer).
    pub skipped: u32,
    /// File being transferred inside a folder job.
    pub current: Option<String>,
    /// Bytes per second over the last seconds.
    pub speed: u64,
    pub error: Option<String>,
    pub conflict: Option<ConflictInfo>,
    pub created_at: u64,
    pub finished_at: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TransferOptions {
    /// ask | overwrite | skip | rename | newer
    pub conflict: String,
    pub preserve_times: bool,
    /// auto | sftp | scp
    pub protocol: String,
    /// Staging folder of files dropped on the file browser, deleted once the job is over.
    pub cleanup: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferRequest {
    pub instance_id: String,
    pub direction: String,
    /// Upload: the source. Download: the full target path (folder + name).
    pub local_path: String,
    /// Upload: the full target path. Download: the source.
    pub remote_path: String,
    #[serde(default)]
    pub is_dir: bool,
    #[serde(default)]
    pub options: TransferOptions,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictAnswer {
    /// overwrite | skip | rename | cancel
    pub action: String,
    /// Same answer for the rest of this job.
    #[serde(default)]
    pub apply_all: bool,
}

// ---------------------------------------------------------------------------------------
// Pause / cancel

const RUN: u8 = 0;
const PAUSE: u8 = 1;
const CANCEL: u8 = 2;

#[derive(Debug)]
pub struct Cancelled;

impl std::fmt::Display for Cancelled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("传输已取消")
    }
}

impl std::error::Error for Cancelled {}

pub fn is_cancelled(e: &anyhow::Error) -> bool {
    e.downcast_ref::<Cancelled>().is_some()
}

/// Shared between a running job and the commands that pause / cancel it.
#[derive(Default)]
pub struct Ctl {
    state: AtomicU8,
    wake: Notify,
}

#[cfg(test)]
pub mod tests_support {
    pub const RUN: u8 = super::RUN;
    pub const PAUSE: u8 = super::PAUSE;
    pub const CANCEL: u8 = super::CANCEL;
}

impl Ctl {
    pub(crate) fn set(&self, state: u8) {
        self.state.store(state, Ordering::Release);
        self.wake.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.state.load(Ordering::Acquire) == CANCEL
    }

    /// Between chunks: wait while paused, fail once cancelled.
    pub async fn checkpoint(&self) -> Result<()> {
        loop {
            // Registered before the check, so a resume in between is not missed.
            let woken = self.wake.notified();
            match self.state.load(Ordering::Acquire) {
                RUN => return Ok(()),
                CANCEL => return Err(Cancelled.into()),
                _ => woken.await,
            }
        }
    }
}

// ---------------------------------------------------------------------------------------
// Duplicate targets

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Policy {
    Ask,
    Overwrite,
    Skip,
    Rename,
    /// Overwrite only when the source is newer, else skip.
    Newer,
}

impl Policy {
    pub fn parse(s: &str) -> Self {
        match s {
            "overwrite" => Self::Overwrite,
            "skip" => Self::Skip,
            "rename" => Self::Rename,
            "newer" => Self::Newer,
            _ => Self::Ask,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Resolution {
    Overwrite,
    Skip,
    Rename,
}

/// What a policy does with an existing target; None: ask the user.
pub fn decide(policy: Policy, src_mtime: Option<u64>, dst_mtime: Option<u64>) -> Option<Resolution> {
    match policy {
        Policy::Ask => None,
        Policy::Overwrite => Some(Resolution::Overwrite),
        Policy::Skip => Some(Resolution::Skip),
        Policy::Rename => Some(Resolution::Rename),
        Policy::Newer => Some(match (src_mtime, dst_mtime) {
            (Some(s), Some(d)) if s <= d => Resolution::Skip,
            _ => Resolution::Overwrite,
        }),
    }
}

/// `name` with a counter before the extension: "a.tar.gz", 1 -> "a (1).tar.gz".
pub fn numbered_name(name: &str, n: u32) -> String {
    // A leading dot is part of the name (".bashrc"), not an extension.
    let split = name
        .char_indices()
        .skip(1)
        .find(|&(_, c)| c == '.')
        .map(|(i, _)| i)
        .filter(|&i| {
            // Keep compound extensions of archives together.
            let ext = &name[i..];
            ext.len() <= 8 || ext.starts_with(".tar.")
        });
    match split {
        Some(i) => format!("{} ({}){}", &name[..i], n, &name[i..]),
        None => format!("{} ({})", name, n),
    }
}

// ---------------------------------------------------------------------------------------
// Progress of one job

/// Counts a job's progress, reports it (throttled) and asks about existing targets.
pub struct Meter {
    pub ctl: Arc<Ctl>,
    job: Option<String>,
    pub policy: Policy,
    pub preserve_times: bool,
    pub transferred: u64,
    pub total: u64,
    pub files_total: u32,
    pub files_done: u32,
    pub skipped: u32,
    current: Option<String>,
    samples: VecDeque<(Instant, u64)>,
    last_emit: Instant,
}

impl Meter {
    /// Not attached to a queued job (tests): existing targets follow the policy, asking
    /// means overwriting.
    pub fn detached(policy: Policy, preserve_times: bool) -> Self {
        Self::new(None, Arc::default(), policy, preserve_times)
    }

    fn new(job: Option<String>, ctl: Arc<Ctl>, policy: Policy, preserve_times: bool) -> Self {
        Self {
            ctl,
            job,
            policy,
            preserve_times,
            transferred: 0,
            total: 0,
            files_total: 0,
            files_done: 0,
            skipped: 0,
            current: None,
            samples: VecDeque::new(),
            last_emit: Instant::now(),
        }
    }

    pub async fn checkpoint(&self) -> Result<()> {
        self.ctl.checkpoint().await
    }

    pub fn set_total(&mut self, bytes: u64, files: u32) {
        self.total = bytes;
        self.files_total = files;
        self.flush();
    }

    /// SCP downloads learn sizes file by file.
    pub fn grow_total(&mut self, bytes: u64, files: u32) {
        self.total += bytes;
        self.files_total += files;
    }

    pub fn begin_file(&mut self, name: &str) {
        self.current = Some(name.to_string());
        self.flush();
    }

    pub fn end_file(&mut self) {
        self.files_done += 1;
        self.flush();
    }

    pub fn skip_file(&mut self, size: u64) {
        self.skipped += 1;
        self.files_done += 1;
        self.transferred += size;
        self.flush();
    }

    pub fn add(&mut self, n: u64) {
        self.transferred += n;
        let now = Instant::now();
        self.samples.push_back((now, self.transferred));
        while self.samples.len() > 2 && now.duration_since(self.samples[0].0) > Duration::from_secs(3) {
            self.samples.pop_front();
        }
        if now.duration_since(self.last_emit) >= Duration::from_millis(250) {
            self.flush();
        }
    }

    pub fn speed(&self) -> u64 {
        let (Some(first), Some(last)) = (self.samples.front(), self.samples.back()) else {
            return 0;
        };
        // Paused or stalled: the last sample is old.
        if last.0.elapsed() > Duration::from_secs(2) {
            return 0;
        }
        let secs = last.0.duration_since(first.0).as_secs_f64();
        if secs < 0.2 {
            return 0;
        }
        ((last.1 - first.1) as f64 / secs) as u64
    }

    pub fn flush(&mut self) {
        self.last_emit = Instant::now();
        let (Some(id), Some(hub)) = (self.job.as_deref(), hub()) else {
            return;
        };
        let speed = self.speed();
        hub.patch(id, |i| {
            i.transferred = self.transferred;
            i.total = self.total.max(self.transferred);
            i.files_total = self.files_total;
            i.files_done = self.files_done;
            i.skipped = self.skipped;
            i.current = self.current.clone();
            i.speed = speed;
        });
    }

    /// The target exists: overwrite, skip or pick another name (asking the user when the
    /// policy says so).
    pub async fn resolve(&mut self, info: ConflictInfo) -> Result<Resolution> {
        if let Some(r) = decide(self.policy, info.src_mtime, info.dst_mtime) {
            return Ok(r);
        }
        let (Some(id), Some(hub)) = (self.job.clone(), hub()) else {
            return Ok(Resolution::Overwrite);
        };
        let (tx, rx) = oneshot::channel();
        hub.ask(&id, info, tx);
        let answer = rx.await.unwrap_or(ConflictAnswer { action: "cancel".into(), apply_all: false });
        hub.patch(&id, |i| {
            if i.state == "conflict" {
                i.state = "running".into();
            }
            i.conflict = None;
        });
        let (resolution, policy) = match answer.action.as_str() {
            "overwrite" => (Resolution::Overwrite, Policy::Overwrite),
            "skip" => (Resolution::Skip, Policy::Skip),
            "rename" => (Resolution::Rename, Policy::Rename),
            _ => return Err(Cancelled.into()),
        };
        if answer.apply_all {
            self.policy = policy;
        }
        self.checkpoint().await?;
        Ok(resolution)
    }
}

// ---------------------------------------------------------------------------------------
// Local files

pub struct LocalFile {
    /// Path components below the root.
    pub rel: Vec<String>,
    pub path: PathBuf,
    pub size: u64,
}

#[derive(Default)]
pub struct LocalTree {
    /// Folders below the root, parents first.
    pub dirs: Vec<(Vec<String>, PathBuf)>,
    pub files: Vec<LocalFile>,
    pub total: u64,
}

/// Everything below a local folder. Linked folders (junctions) are not followed.
pub fn walk_local(root: &Path) -> std::io::Result<LocalTree> {
    let mut tree = LocalTree::default();
    let mut stack: Vec<(Vec<String>, PathBuf)> = vec![(Vec::new(), root.to_path_buf())];
    while let Some((rel, dir)) = stack.pop() {
        let mut entries: Vec<_> = std::fs::read_dir(&dir)?.filter_map(|e| e.ok()).collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let name = entry.file_name().to_string_lossy().to_string();
            let path = entry.path();
            let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
            let mut child = rel.clone();
            child.push(name);
            if meta.is_dir() {
                tree.dirs.push((child.clone(), path.clone()));
                stack.push((child, path));
            } else if meta.is_file() || meta.file_type().is_symlink() {
                // A link to a file is sent as the file it points to.
                let Ok(meta) = std::fs::metadata(&path) else { continue };
                if !meta.is_file() {
                    continue;
                }
                tree.total += meta.len();
                tree.files.push(LocalFile { rel: child, path, size: meta.len() });
            }
        }
    }
    tree.dirs.sort_by_key(|(rel, _)| rel.len());
    Ok(tree)
}

/// A name from the remote that is safe as one local path component on Windows.
pub fn local_component(name: &str) -> Option<String> {
    let clean: String = name
        .chars()
        .map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { '_' } else { c })
        .collect();
    let clean = clean.trim_end_matches([' ', '.']).to_string();
    (!clean.is_empty() && clean != "." && clean != "..").then_some(clean)
}

/// The local file `path` with a free "name (n).ext".
pub fn free_local_path(path: &Path) -> PathBuf {
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let parent = path.parent().map(Path::to_path_buf).unwrap_or_default();
    (1..10000)
        .map(|n| parent.join(numbered_name(&name, n)))
        .find(|p| std::fs::symlink_metadata(p).is_err())
        .unwrap_or_else(|| path.to_path_buf())
}

/// Local target of a download: None when the existing file is skipped.
pub async fn resolve_local(path: &Path, src_size: u64, src_mtime: Option<u64>, is_dir: bool, m: &mut Meter) -> Result<Option<PathBuf>> {
    let Ok(dst) = std::fs::metadata(path) else {
        return Ok(Some(path.to_path_buf()));
    };
    // Folders merge into an existing folder; their files are checked one by one.
    if is_dir && dst.is_dir() {
        return Ok(Some(path.to_path_buf()));
    }
    let info = ConflictInfo {
        path: path.to_string_lossy().to_string(),
        is_dir: dst.is_dir(),
        src_size,
        src_mtime,
        dst_size: if dst.is_dir() { 0 } else { dst.len() },
        dst_mtime: unix_secs(dst.modified()),
    };
    match m.resolve(info).await? {
        Resolution::Skip => Ok(None),
        Resolution::Rename => Ok(Some(free_local_path(path))),
        Resolution::Overwrite if dst.is_dir() != is_dir => {
            anyhow::bail!("目标 {} 已存在且类型不同，无法覆盖", path.display())
        }
        Resolution::Overwrite => Ok(Some(path.to_path_buf())),
    }
}

/// Local file times from remote seconds (download with kept timestamps).
pub fn set_local_times(path: &Path, mtime: Option<u64>, atime: Option<u64>) {
    let Some(mtime) = mtime else { return };
    let to = |s: u64| UNIX_EPOCH + Duration::from_secs(s);
    let times = std::fs::FileTimes::new().set_modified(to(mtime)).set_accessed(to(atime.unwrap_or(mtime)));
    if let Ok(f) = std::fs::OpenOptions::new().write(true).open(path) {
        let _ = f.set_times(times);
    }
}

/// Where a download is written until it is complete.
pub fn part_path(target: &Path) -> PathBuf {
    let mut name = target.file_name().unwrap_or_default().to_os_string();
    name.push(".nxpart");
    target.with_file_name(name)
}

// ---------------------------------------------------------------------------------------
// Remote paths (POSIX)

pub fn join_remote(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_string()
    } else if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

/// ("/a/b", "c") of "/a/b/c"; ("/", "c") of "/c".
pub fn split_remote(path: &str) -> (String, String) {
    let trimmed = if path.len() > 1 { path.trim_end_matches('/') } else { path };
    match trimmed.rfind('/') {
        Some(0) => ("/".into(), trimmed[1..].into()),
        Some(i) => (trimmed[..i].into(), trimmed[i + 1..].into()),
        None => (".".into(), trimmed.into()),
    }
}

/// Single-quoted for the remote login shell (sh, bash, zsh, fish, csh).
pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

// ---------------------------------------------------------------------------------------
// The queue

struct Job {
    info: TransferInfo,
    req: TransferRequest,
    ctl: Arc<Ctl>,
    /// Has a task (a paused job either waits in the queue or holds its open files).
    started: bool,
    conflict_tx: Option<oneshot::Sender<ConflictAnswer>>,
}

pub struct Hub {
    app: AppHandle,
    jobs: Mutex<Vec<Job>>,
    limit: AtomicUsize,
    next: AtomicUsize,
}

static HUB: OnceLock<Hub> = OnceLock::new();

pub fn init(app: AppHandle) {
    let _ = HUB.set(Hub { app, jobs: Mutex::new(Vec::new()), limit: AtomicUsize::new(3), next: AtomicUsize::new(1) });
}

pub fn hub() -> Option<&'static Hub> {
    HUB.get()
}

fn is_finished(state: &str) -> bool {
    matches!(state, "done" | "error" | "cancelled")
}

impl Hub {
    fn emit(&self, info: &TransferInfo) {
        let _ = self.app.emit("transfer-update", info);
    }

    fn patch(&self, id: &str, f: impl FnOnce(&mut TransferInfo)) {
        let mut jobs = lock(&self.jobs);
        if let Some(job) = jobs.iter_mut().find(|j| j.info.id == id) {
            f(&mut job.info);
            self.emit(&job.info);
        }
    }

    fn ask(&self, id: &str, info: ConflictInfo, tx: oneshot::Sender<ConflictAnswer>) {
        let mut jobs = lock(&self.jobs);
        if let Some(job) = jobs.iter_mut().find(|j| j.info.id == id) {
            job.info.state = "conflict".into();
            job.info.conflict = Some(info);
            job.info.speed = 0;
            job.conflict_tx = Some(tx);
            self.emit(&job.info);
        }
    }

    fn new_id(&self) -> String {
        format!("t{}", self.next.fetch_add(1, Ordering::Relaxed))
    }

    pub fn list(&self) -> Vec<TransferInfo> {
        lock(&self.jobs).iter().map(|j| j.info.clone()).collect()
    }

    pub fn set_limit(&'static self, n: usize) {
        self.limit.store(n.clamp(1, 16), Ordering::Relaxed);
        self.schedule();
    }

    pub fn enqueue(&'static self, reqs: Vec<TransferRequest>) -> Vec<TransferInfo> {
        let ctx = self.app.state::<crate::AppContext>();
        let mut added = Vec::new();
        {
            let mut jobs = lock(&self.jobs);
            for req in reqs {
                let upload = req.direction == "upload";
                let (name, is_dir) = if upload {
                    let p = Path::new(&req.local_path);
                    (
                        p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                        p.is_dir(),
                    )
                } else {
                    (split_remote(&req.remote_path).1, req.is_dir)
                };
                let info = TransferInfo {
                    id: self.new_id(),
                    instance_id: req.instance_id.clone(),
                    label: ctx.connections.pane_label(&req.instance_id).unwrap_or_default(),
                    direction: if upload { "upload" } else { "download" }.into(),
                    protocol: String::new(),
                    name,
                    // Dropped files live in a staging folder that is deleted afterwards.
                    local_path: req.options.cleanup.is_none().then(|| req.local_path.clone()),
                    remote_path: req.remote_path.clone(),
                    is_dir,
                    state: "queued".into(),
                    total: 0,
                    transferred: 0,
                    files_total: 0,
                    files_done: 0,
                    skipped: 0,
                    current: None,
                    speed: 0,
                    error: None,
                    conflict: None,
                    created_at: now_ms(),
                    finished_at: None,
                };
                self.emit(&info);
                added.push(info.clone());
                jobs.push(Job { info, req, ctl: Arc::default(), started: false, conflict_tx: None });
            }
        }
        self.schedule();
        added
    }

    /// Start queued jobs while fewer than the limit run.
    fn schedule(&'static self) {
        let mut jobs = lock(&self.jobs);
        let limit = self.limit.load(Ordering::Relaxed);
        let mut running = jobs.iter().filter(|j| matches!(j.info.state.as_str(), "running" | "conflict")).count();
        for job in jobs.iter_mut() {
            if running >= limit {
                break;
            }
            if job.info.state != "queued" {
                continue;
            }
            running += 1;
            job.started = true;
            job.info.state = "running".into();
            job.info.error = None;
            self.emit(&job.info);
            let id = job.info.id.clone();
            tauri::async_runtime::spawn(async move { self.run(id).await });
        }
    }

    async fn run(&'static self, id: String) {
        let Some((req, ctl)) = lock(&self.jobs)
            .iter()
            .find(|j| j.info.id == id)
            .map(|j| (j.req.clone(), Arc::clone(&j.ctl)))
        else {
            return;
        };
        let opts = &req.options;
        let mut meter = Meter::new(Some(id.clone()), ctl, Policy::parse(&opts.conflict), opts.preserve_times);
        let result = self.execute(&id, &req, &mut meter).await;
        meter.flush();
        let (state, error) = match &result {
            Ok(()) => ("done", None),
            Err(e) if is_cancelled(e) => ("cancelled", None),
            Err(e) => ("error", Some(format!("{:#}", e))),
        };
        let mut cleanup = None;
        {
            let mut jobs = lock(&self.jobs);
            if let Some(job) = jobs.iter_mut().find(|j| j.info.id == id) {
                job.started = false;
                job.conflict_tx = None;
                job.info.state = state.into();
                job.info.error = error;
                job.info.speed = 0;
                job.info.current = None;
                job.info.conflict = None;
                job.info.finished_at = Some(now_ms());
                if state != "error" {
                    cleanup = job.req.options.cleanup.take();
                }
                self.emit(&job.info);
            }
        }
        if let Some(dir) = cleanup {
            remove_staging(&dir);
        }
        self.schedule();
    }

    async fn execute(&self, id: &str, req: &TransferRequest, m: &mut Meter) -> Result<()> {
        let link = self.app.state::<crate::AppContext>().connections.ssh_link(&req.instance_id)?;
        let sftp = match req.options.protocol.as_str() {
            "scp" => None,
            "sftp" => Some(crate::sftp::session(&req.instance_id, &link).await?),
            // SFTP when the server has it, else SCP.
            _ => match crate::sftp::fs(&req.instance_id, &link).await? {
                crate::sftp::Fs::Sftp(s) => Some(s),
                crate::sftp::Fs::Shell(_) => None,
            },
        };
        self.patch(id, |i| i.protocol = if sftp.is_some() { "sftp" } else { "scp" }.into());
        let local = Path::new(&req.local_path);
        let result = match (&sftp, req.direction == "upload") {
            (Some(s), true) => crate::sftp::upload(s, local, &req.remote_path, m).await,
            (Some(s), false) => crate::sftp::download(s, &req.remote_path, local, m).await,
            (None, true) => crate::scp::upload(&link, local, &req.remote_path, m).await,
            (None, false) => crate::scp::download(&link, &req.remote_path, local, m).await,
        };
        if let (Err(e), Some(_)) = (&result, &sftp) {
            if !is_cancelled(e) && crate::sftp::is_link_error(e) {
                crate::sftp::forget(&req.instance_id);
            }
        }
        result
    }

    pub fn pause(&'static self, id: &str) {
        let mut jobs = lock(&self.jobs);
        if let Some(job) = jobs.iter_mut().find(|j| j.info.id == id) {
            if matches!(job.info.state.as_str(), "running" | "queued") {
                job.ctl.set(PAUSE);
                job.info.state = "paused".into();
                job.info.speed = 0;
                self.emit(&job.info);
            }
        }
        drop(jobs);
        // A paused job gives its slot to the next one.
        self.schedule();
    }

    pub fn resume(&'static self, id: &str) {
        let mut jobs = lock(&self.jobs);
        if let Some(job) = jobs.iter_mut().find(|j| j.info.id == id && j.info.state == "paused") {
            job.ctl.set(RUN);
            job.info.state = if job.started { "running" } else { "queued" }.into();
            self.emit(&job.info);
        }
        drop(jobs);
        self.schedule();
    }

    pub fn cancel(&'static self, id: &str) {
        let mut cleanup = None;
        {
            let mut jobs = lock(&self.jobs);
            if let Some(job) = jobs.iter_mut().find(|j| j.info.id == id && !is_finished(&j.info.state)) {
                job.ctl.set(CANCEL);
                if let Some(tx) = job.conflict_tx.take() {
                    let _ = tx.send(ConflictAnswer { action: "cancel".into(), apply_all: false });
                }
                if !job.started {
                    job.info.state = "cancelled".into();
                    job.info.finished_at = Some(now_ms());
                    cleanup = job.req.options.cleanup.take();
                    self.emit(&job.info);
                }
            }
        }
        if let Some(dir) = cleanup {
            remove_staging(&dir);
        }
        self.schedule();
    }

    pub fn retry(&'static self, id: &str) {
        let mut jobs = lock(&self.jobs);
        if let Some(job) = jobs
            .iter_mut()
            .find(|j| j.info.id == id && matches!(j.info.state.as_str(), "error" | "cancelled"))
        {
            // Recorded ZModem results and cleaned-up drops cannot run again.
            if !matches!(job.info.protocol.as_str(), "" | "sftp" | "scp") {
                return;
            }
            if job.req.options.cleanup.is_none() && job.info.direction == "upload" && !Path::new(&job.req.local_path).exists() {
                return;
            }
            job.ctl = Arc::default();
            let i = &mut job.info;
            i.state = "queued".into();
            i.transferred = 0;
            i.total = 0;
            i.files_done = 0;
            i.files_total = 0;
            i.skipped = 0;
            i.error = None;
            i.finished_at = None;
            self.emit(&job.info);
        }
        drop(jobs);
        self.schedule();
    }

    pub fn answer(&self, id: &str, answer: ConflictAnswer) {
        let mut jobs = lock(&self.jobs);
        if let Some(tx) = jobs.iter_mut().find(|j| j.info.id == id).and_then(|j| j.conflict_tx.take()) {
            let _ = tx.send(answer);
        }
    }

    /// Drop finished jobs from the list (`ids`: these, else every finished one).
    pub fn remove(&self, ids: Option<Vec<String>>) -> Vec<String> {
        let mut removed = Vec::new();
        let mut cleanups = Vec::new();
        lock(&self.jobs).retain_mut(|j| {
            let wanted = ids.as_ref().is_none_or(|ids| ids.contains(&j.info.id));
            if wanted && is_finished(&j.info.state) {
                removed.push(j.info.id.clone());
                cleanups.extend(j.req.options.cleanup.take());
                false
            } else {
                true
            }
        });
        for dir in cleanups {
            remove_staging(&dir);
        }
        let _ = self.app.emit("transfer-removed", &removed);
        removed
    }

    /// The pane closed: its unfinished transfers stop.
    pub fn forget_instance(&'static self, instance_id: &str) {
        let ids: Vec<String> = lock(&self.jobs)
            .iter()
            .filter(|j| j.info.instance_id == instance_id && !is_finished(&j.info.state))
            .map(|j| j.info.id.clone())
            .collect();
        for id in ids {
            self.cancel(&id);
        }
    }

    /// A finished ZModem / X/YMODEM transfer, one entry per file.
    pub fn record(&self, mut info: TransferInfo) {
        info.id = self.new_id();
        let req = TransferRequest {
            instance_id: info.instance_id.clone(),
            direction: info.direction.clone(),
            local_path: info.local_path.clone().unwrap_or_default(),
            remote_path: String::new(),
            is_dir: false,
            options: TransferOptions::default(),
        };
        self.emit(&info);
        lock(&self.jobs).push(Job { info, req, ctl: Arc::default(), started: false, conflict_tx: None });
    }
}

/// Folders below this hold files dropped on the file browser until they are uploaded.
pub fn staging_root() -> PathBuf {
    crate::app_paths::data_dir().join("sftp-drop")
}

fn remove_staging(dir: &str) {
    let path = PathBuf::from(dir);
    // Only folders of our own staging area.
    if path.starts_with(staging_root()) {
        let _ = std::fs::remove_dir_all(path);
    }
}

/// Record the files of a finished ZModem / X/YMODEM transfer.
#[allow(clippy::too_many_arguments)]
pub fn record_modem(
    instance_id: &str,
    label: &str,
    protocol: &str,
    receive: bool,
    state: &str,
    message: &str,
    files: &[PathBuf],
) {
    let Some(hub) = hub() else { return };
    let base = TransferInfo {
        id: String::new(),
        instance_id: instance_id.to_string(),
        label: label.to_string(),
        direction: if receive { "download" } else { "upload" }.into(),
        protocol: protocol.to_string(),
        name: String::new(),
        local_path: None,
        remote_path: String::new(),
        is_dir: false,
        state: state.to_string(),
        total: 0,
        transferred: 0,
        files_total: 1,
        files_done: 0,
        skipped: 0,
        current: None,
        speed: 0,
        error: None,
        conflict: None,
        created_at: now_ms(),
        finished_at: Some(now_ms()),
    };
    if files.is_empty() {
        hub.record(TransferInfo {
            name: protocol.to_uppercase(),
            files_total: 0,
            error: (state == "error").then(|| message.to_string()),
            ..base
        });
        return;
    }
    for f in files {
        let size = std::fs::metadata(f).map(|m| m.len()).unwrap_or(0);
        // Files dropped on a terminal were copied to a temporary folder first.
        let staged = f.components().any(|c| c.as_os_str() == "zmodem-drop");
        hub.record(TransferInfo {
            name: f.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
            local_path: (!staged).then(|| f.to_string_lossy().to_string()),
            total: size,
            transferred: size,
            files_done: 1,
            ..base.clone()
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbered_names_keep_extensions() {
        assert_eq!(numbered_name("a.txt", 1), "a (1).txt");
        assert_eq!(numbered_name("a.tar.gz", 2), "a (2).tar.gz");
        assert_eq!(numbered_name(".bashrc", 1), ".bashrc (1)");
        assert_eq!(numbered_name("Makefile", 3), "Makefile (3)");
        // A dot inside a long name is not an extension.
        assert_eq!(numbered_name("release.2026-11-14-final", 1), "release.2026-11-14-final (1)");
    }

    #[test]
    fn newer_policy_compares_times() {
        assert_eq!(decide(Policy::Newer, Some(10), Some(5)), Some(Resolution::Overwrite));
        assert_eq!(decide(Policy::Newer, Some(5), Some(5)), Some(Resolution::Skip));
        assert_eq!(decide(Policy::Newer, None, Some(5)), Some(Resolution::Overwrite));
        assert_eq!(decide(Policy::Ask, Some(1), Some(2)), None);
    }

    #[test]
    fn remote_paths() {
        assert_eq!(split_remote("/a/b/c"), ("/a/b".into(), "c".into()));
        assert_eq!(split_remote("/c"), ("/".into(), "c".into()));
        assert_eq!(split_remote("/a/dir/"), ("/a".into(), "dir".into()));
        assert_eq!(join_remote("/", "x"), "/x");
        assert_eq!(join_remote("/a", "x"), "/a/x");
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
    }

    #[test]
    fn remote_names_become_safe_local_names() {
        assert_eq!(local_component("a:b?.txt").as_deref(), Some("a_b_.txt"));
        assert_eq!(local_component("..").as_deref(), None);
        assert_eq!(local_component("x/../y").as_deref(), Some("x_.._y"));
        assert_eq!(local_component("trail. ").as_deref(), Some("trail"));
    }

    #[test]
    fn checkpoint_waits_while_paused() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let ctl = Arc::new(Ctl::default());
            ctl.set(PAUSE);
            let waiter = {
                let ctl = Arc::clone(&ctl);
                tokio::spawn(async move { ctl.checkpoint().await.is_ok() })
            };
            tokio::time::sleep(Duration::from_millis(50)).await;
            assert!(!waiter.is_finished());
            ctl.set(RUN);
            assert!(waiter.await.unwrap());
            ctl.set(CANCEL);
            assert!(is_cancelled(&ctl.checkpoint().await.unwrap_err()));
        });
    }

    #[test]
    fn walks_a_local_tree() {
        let root = std::env::temp_dir().join(format!("nx-walk-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("a/b")).unwrap();
        std::fs::write(root.join("top.txt"), b"12345").unwrap();
        std::fs::write(root.join("a/b/deep.bin"), b"xy").unwrap();
        let tree = walk_local(&root).unwrap();
        assert_eq!(tree.total, 7);
        let dirs: Vec<String> = tree.dirs.iter().map(|(r, _)| r.join("/")).collect();
        assert_eq!(dirs, vec!["a", "a/b"]);
        let mut files: Vec<String> = tree.files.iter().map(|f| f.rel.join("/")).collect();
        files.sort();
        assert_eq!(files, vec!["a/b/deep.bin", "top.txt"]);
        std::fs::remove_dir_all(root).unwrap();
    }
}
