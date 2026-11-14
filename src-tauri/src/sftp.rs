//! SFTP file browser of SSH panes: one SFTP session per pane on its live connection,
//! directory operations, transfers for the queue (transfer.rs), previews and editing
//! remote files with a local program (uploaded again on save).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use russh_sftp::client::error::Error as SftpError;
use russh_sftp::client::fs::Metadata;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, OpenFlags, StatusCode};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::ssh_conn::SshLink;
use crate::transfer::{
    join_remote, local_component, numbered_name, part_path, resolve_local, set_local_times, split_remote, unix_secs,
    walk_local, ConflictInfo, Meter, Resolution,
};

const CHUNK: usize = 256 * 1024;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

// ---------------------------------------------------------------------------------------
// Sessions

struct Cached {
    /// The connection it runs on: a reconnected pane gets a new one.
    link: std::sync::Weak<crate::ssh_conn::SshShared>,
    sftp: Arc<SftpSession>,
}

fn sessions() -> &'static Mutex<HashMap<String, Cached>> {
    static S: OnceLock<Mutex<HashMap<String, Cached>>> = OnceLock::new();
    S.get_or_init(Default::default)
}

/// Serializes opening, so a burst of requests starts one subsystem per pane.
fn opening() -> &'static tokio::sync::Mutex<()> {
    static O: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    O.get_or_init(Default::default)
}

/// The pane's SFTP session, opened on first use.
pub async fn session(instance_id: &str, link: &SshLink) -> Result<Arc<SftpSession>> {
    let cached = || {
        lock(sessions())
            .get(instance_id)
            .filter(|c| c.link.upgrade().is_some_and(|l| Arc::ptr_eq(&l, link)))
            .map(|c| Arc::clone(&c.sftp))
    };
    if let Some(s) = cached() {
        return Ok(s);
    }
    let _guard = opening().lock().await;
    if let Some(s) = cached() {
        return Ok(s);
    }
    let sftp = Arc::new(link.open_sftp().await?);
    lock(sessions()).insert(instance_id.to_string(), Cached { link: Arc::downgrade(link), sftp: Arc::clone(&sftp) });
    Ok(sftp)
}

/// Connections whose server has no SFTP subsystem (browsed with shell commands instead).
fn no_sftp() -> &'static Mutex<Vec<std::sync::Weak<crate::ssh_conn::SshShared>>> {
    static N: OnceLock<Mutex<Vec<std::sync::Weak<crate::ssh_conn::SshShared>>>> = OnceLock::new();
    N.get_or_init(Default::default)
}

/// How the browser reaches a pane's files.
pub enum Fs {
    Sftp(Arc<SftpSession>),
    /// No SFTP on the server: shell commands on exec channels (transfers use SCP).
    Shell(SshLink),
}

/// SFTP when the server has it, else shell commands. The answer is kept per connection.
pub async fn fs(instance_id: &str, link: &SshLink) -> Result<Fs> {
    let known = {
        let mut list = lock(no_sftp());
        list.retain(|w| w.strong_count() > 0);
        list.iter().any(|w| w.upgrade().is_some_and(|l| Arc::ptr_eq(&l, link)))
    };
    if known {
        return Ok(Fs::Shell(Arc::clone(link)));
    }
    match session(instance_id, link).await {
        Ok(s) => Ok(Fs::Sftp(s)),
        Err(e) => {
            // The connection works (it runs the shell), so the subsystem is what is missing.
            if crate::scp::shell_home(link).await.is_err() {
                return Err(e);
            }
            lock(no_sftp()).push(Arc::downgrade(link));
            Ok(Fs::Shell(Arc::clone(link)))
        }
    }
}

impl Fs {
    pub async fn home(&self) -> Result<String> {
        match self {
            Fs::Sftp(s) => home(s).await,
            Fs::Shell(l) => crate::scp::shell_home(l).await,
        }
    }
    pub async fn list(&self, path: &str) -> Result<Listing> {
        match self {
            Fs::Sftp(s) => list(s, path).await,
            Fs::Shell(l) => crate::scp::shell_list(l, path).await,
        }
    }
    pub async fn stat(&self, path: &str) -> Result<RemoteEntry> {
        match self {
            Fs::Sftp(s) => stat(s, path).await,
            Fs::Shell(l) => crate::scp::shell_stat(l, path).await,
        }
    }
    pub async fn mkdir(&self, path: &str) -> Result<()> {
        match self {
            Fs::Sftp(s) => mkdir(s, path).await,
            Fs::Shell(l) => crate::scp::shell_mkdir(l, path).await,
        }
    }
    pub async fn touch(&self, path: &str) -> Result<()> {
        match self {
            Fs::Sftp(s) => touch(s, path).await,
            Fs::Shell(l) => crate::scp::shell_touch(l, path).await,
        }
    }
    pub async fn rename(&self, from: &str, to: &str) -> Result<()> {
        match self {
            Fs::Sftp(s) => rename(s, from, to).await,
            Fs::Shell(l) => crate::scp::shell_rename(l, from, to).await,
        }
    }
    pub async fn remove(&self, path: &str) -> Result<()> {
        match self {
            Fs::Sftp(s) => remove(s, path).await,
            Fs::Shell(l) => crate::scp::shell_remove(l, path).await,
        }
    }
    pub async fn chmod(&self, path: &str, mode: u32) -> Result<()> {
        match self {
            Fs::Sftp(s) => chmod(s, path, mode).await,
            Fs::Shell(l) => crate::scp::shell_chmod(l, path, mode).await,
        }
    }
    pub async fn symlink(&self, path: &str, target: &str) -> Result<()> {
        match self {
            Fs::Sftp(s) => symlink(s, path, target).await,
            Fs::Shell(l) => crate::scp::shell_symlink(l, path, target).await,
        }
    }
    pub fn sftp(&self) -> Result<&Arc<SftpSession>> {
        match self {
            Fs::Sftp(s) => Ok(s),
            Fs::Shell(_) => bail!("服务器不支持 SFTP，预览和本地编辑不可用（上传 / 下载会使用 SCP）"),
        }
    }
}

/// Close the pane's session (pane closed, or its channel broke).
pub fn forget(instance_id: &str) {
    if let Some(c) = lock(sessions()).remove(instance_id) {
        tauri::async_runtime::spawn(async move {
            let _ = c.sftp.close().await;
        });
    }
}

/// The channel is gone (not a refusal of one request): the next call opens a new session.
pub fn is_link_error(e: &anyhow::Error) -> bool {
    e.chain().any(|c| match c.downcast_ref::<SftpError>() {
        Some(SftpError::Status(_)) => false,
        Some(_) => true,
        None => false,
    })
}

fn no_such_file(e: &SftpError) -> bool {
    matches!(e, SftpError::Status(s) if s.status_code == StatusCode::NoSuchFile)
}

/// Readable message of an SFTP error ("Permission denied" instead of a debug dump).
fn describe(e: SftpError) -> anyhow::Error {
    match e {
        SftpError::Status(s) => {
            let msg = s.error_message.trim().to_string();
            anyhow::anyhow!(if msg.is_empty() { format!("{:?}", s.status_code) } else { msg })
        }
        other => anyhow::Error::new(other),
    }
}

trait SftpContext<T> {
    fn ctx(self, what: impl FnOnce() -> String) -> Result<T>;
}

impl<T> SftpContext<T> for std::result::Result<T, SftpError> {
    fn ctx(self, what: impl FnOnce() -> String) -> Result<T> {
        self.map_err(|e| describe(e).context(what()))
    }
}

// ---------------------------------------------------------------------------------------
// Listing

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    pub name: String,
    pub path: String,
    /// "dir" | "file" | "link" | "other"
    pub kind: String,
    /// A link that points to a folder (opens like one).
    pub link_dir: bool,
    pub link_target: Option<String>,
    pub size: u64,
    pub mtime: Option<u64>,
    pub atime: Option<u64>,
    /// Permission bits (07777).
    pub mode: Option<u32>,
    pub uid: Option<u32>,
    pub gid: Option<u32>,
    pub user: Option<String>,
    pub group: Option<String>,
}

fn kind_of(meta: &Metadata) -> &'static str {
    let t = meta.file_type();
    if t.is_dir() {
        "dir"
    } else if t.is_symlink() {
        "link"
    } else if t.is_file() {
        "file"
    } else {
        "other"
    }
}

fn entry(path: String, name: String, meta: &Metadata) -> RemoteEntry {
    RemoteEntry {
        name,
        path,
        kind: kind_of(meta).into(),
        link_dir: false,
        link_target: None,
        size: meta.size.unwrap_or(0),
        mtime: meta.mtime.map(u64::from),
        atime: meta.atime.map(u64::from),
        mode: meta.permissions.map(|p| p & 0o7777),
        uid: meta.uid,
        gid: meta.gid,
        user: meta.user.clone(),
        group: meta.group.clone(),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    /// Canonical path of the folder.
    pub path: String,
    pub entries: Vec<RemoteEntry>,
    /// "sftp", or "scp" when the server has no SFTP (listed with shell commands).
    pub mode: String,
}

pub async fn list(sftp: &SftpSession, path: &str) -> Result<Listing> {
    let path = if path.trim().is_empty() { "." } else { path.trim() };
    let canonical = sftp.canonicalize(path).await.ctx(|| format!("无法打开 {}", path))?;
    let dir = sftp.read_dir(canonical.as_str()).await.ctx(|| format!("无法列出 {}", canonical))?;
    let mut entries = Vec::new();
    for e in dir {
        let name = e.file_name();
        if name == "." || name == ".." {
            continue;
        }
        entries.push(entry(join_remote(&canonical, &name), name, &e.metadata()));
    }
    // Links: what they point to, and whether that is a folder.
    for e in entries.iter_mut().filter(|e| e.kind == "link") {
        e.link_target = sftp.read_link(e.path.as_str()).await.ok();
        if let Ok(target) = sftp.metadata(e.path.as_str()).await {
            e.link_dir = target.file_type().is_dir();
            if !e.link_dir {
                e.size = target.size.unwrap_or(0);
            }
        }
    }
    Ok(Listing { path: canonical, entries, mode: "sftp".into() })
}

pub async fn stat(sftp: &SftpSession, path: &str) -> Result<RemoteEntry> {
    let meta = sftp.symlink_metadata(path).await.ctx(|| format!("无法读取 {}", path))?;
    let mut e = entry(path.to_string(), split_remote(path).1, &meta);
    if e.kind == "link" {
        e.link_target = sftp.read_link(path).await.ok();
        e.link_dir = sftp.metadata(path).await.map(|m| m.file_type().is_dir()).unwrap_or(false);
    }
    Ok(e)
}

/// Home folder of the login user (the browser's starting point).
pub async fn home(sftp: &SftpSession) -> Result<String> {
    sftp.canonicalize(".").await.ctx(|| "无法获取远程主目录".into())
}

// ---------------------------------------------------------------------------------------
// Changes

pub async fn mkdir(sftp: &SftpSession, path: &str) -> Result<()> {
    sftp.create_dir(path).await.ctx(|| format!("无法创建文件夹 {}", path))
}

/// A new empty file; fails when something is already there.
pub async fn touch(sftp: &SftpSession, path: &str) -> Result<()> {
    let file = sftp
        .open_with_flags(path, OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE)
        .await
        .ctx(|| format!("无法创建文件 {}", path))?;
    file.close().await?;
    Ok(())
}

pub async fn rename(sftp: &SftpSession, from: &str, to: &str) -> Result<()> {
    if sftp.symlink_metadata(to).await.is_ok() {
        bail!("{} 已存在", to);
    }
    sftp.rename(from, to).await.ctx(|| format!("无法将 {} 移动到 {}", from, to))
}

/// Delete files and folders (folders with everything inside; links are removed, never followed).
pub async fn remove(sftp: &SftpSession, path: &str) -> Result<()> {
    let meta = sftp.symlink_metadata(path).await.ctx(|| format!("无法读取 {}", path))?;
    if !meta.file_type().is_dir() {
        return sftp.remove_file(path).await.ctx(|| format!("无法删除 {}", path));
    }
    // Depth first without recursion: folders are removed after their contents.
    let mut stack = vec![(path.to_string(), false)];
    while let Some((dir, emptied)) = stack.pop() {
        if emptied {
            sftp.remove_dir(dir.as_str()).await.ctx(|| format!("无法删除文件夹 {}", dir))?;
            continue;
        }
        stack.push((dir.clone(), true));
        for e in sftp.read_dir(dir.as_str()).await.ctx(|| format!("无法列出 {}", dir))? {
            let name = e.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let child = join_remote(&dir, &name);
            if e.file_type().is_dir() {
                stack.push((child, false));
            } else {
                sftp.remove_file(child.as_str()).await.ctx(|| format!("无法删除 {}", child))?;
            }
        }
    }
    Ok(())
}

pub async fn chmod(sftp: &SftpSession, path: &str, mode: u32) -> Result<()> {
    let attrs = FileAttributes { permissions: Some(mode & 0o7777), ..FileAttributes::empty() };
    sftp.set_metadata(path, attrs).await.ctx(|| format!("无法修改 {} 的权限", path))
}

/// `link` pointing at `target`. OpenSSH's sftp-server takes the two paths of SYMLINK in
/// the opposite order of the draft (target first); other servers follow the draft.
pub async fn symlink(sftp: &SftpSession, link: &str, target: &str) -> Result<()> {
    if sftp.symlink_metadata(link).await.is_ok() {
        bail!("{} 已存在", link);
    }
    // russh-sftp sends (path, target) in draft order: swapped for OpenSSH.
    let openssh = sftp.symlink(target, link).await;
    if openssh.is_ok() {
        if sftp.symlink_metadata(link).await.is_ok() {
            return Ok(());
        }
        // A draft-order server made `target` a link to `link`: undo that.
        if sftp.read_link(target).await.ok().as_deref() == Some(link) {
            let _ = sftp.remove_file(target).await;
        }
    }
    match sftp.symlink(link, target).await {
        Ok(()) if sftp.symlink_metadata(link).await.is_ok() => Ok(()),
        Ok(()) => bail!("服务器未能创建符号链接 {}", link),
        Err(e) => Err(describe(e).context(format!("无法创建符号链接 {}", link))),
    }
}

// ---------------------------------------------------------------------------------------
// Transfers

/// Existing remote target: None when it is skipped, else the path to write.
async fn resolve_remote(sftp: &SftpSession, path: &str, size: u64, mtime: Option<u64>, is_dir: bool, m: &mut Meter) -> Result<Option<String>> {
    let dst = match sftp.metadata(path).await {
        Ok(d) => d,
        Err(e) if no_such_file(&e) => return Ok(Some(path.to_string())),
        Err(e) => return Err(describe(e).context(format!("无法读取 {}", path))),
    };
    let dst_dir = dst.file_type().is_dir();
    if is_dir && dst_dir {
        return Ok(Some(path.to_string()));
    }
    let info = ConflictInfo {
        path: path.to_string(),
        is_dir: dst_dir,
        src_size: size,
        src_mtime: mtime,
        dst_size: if dst_dir { 0 } else { dst.size.unwrap_or(0) },
        dst_mtime: dst.mtime.map(u64::from),
    };
    match m.resolve(info).await? {
        Resolution::Skip => Ok(None),
        Resolution::Overwrite if dst_dir != is_dir => bail!("目标 {} 已存在且类型不同，无法覆盖", path),
        Resolution::Overwrite => Ok(Some(path.to_string())),
        Resolution::Rename => {
            let (dir, name) = split_remote(path);
            for n in 1..10000 {
                let candidate = join_remote(&dir, &numbered_name(&name, n));
                if matches!(sftp.symlink_metadata(candidate.as_str()).await, Err(ref e) if no_such_file(e)) {
                    return Ok(Some(candidate));
                }
            }
            bail!("找不到可用的文件名 {}", path)
        }
    }
}

async fn ensure_remote_dir(sftp: &SftpSession, path: &str) -> Result<()> {
    match sftp.metadata(path).await {
        Ok(m) if m.file_type().is_dir() => Ok(()),
        Ok(_) => bail!("{} 已存在且不是文件夹", path),
        Err(_) => mkdir(sftp, path).await,
    }
}

/// Copy one local file to `remote` (written in place; the old file is replaced).
async fn put_file(sftp: &SftpSession, local: &Path, remote: &str, m: &mut Meter) -> Result<()> {
    let meta = std::fs::metadata(local).with_context(|| format!("无法读取 {}", local.display()))?;
    let mut src = tokio::fs::File::open(local).await.with_context(|| format!("无法读取 {}", local.display()))?;
    let mut dst = sftp
        .open_with_flags(remote, OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE)
        .await
        .ctx(|| format!("无法写入 {}", remote))?;
    let mut buf = vec![0u8; CHUNK];
    loop {
        m.checkpoint().await?;
        let n = src.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n]).await.with_context(|| format!("写入 {} 失败", remote))?;
        m.add(n as u64);
    }
    dst.shutdown().await.with_context(|| format!("写入 {} 失败", remote))?;
    drop(dst);
    if m.preserve_times {
        if let (Some(mtime), atime) = (unix_secs(meta.modified()), unix_secs(meta.accessed())) {
            let attrs = FileAttributes {
                mtime: Some(mtime as u32),
                atime: Some(atime.unwrap_or(mtime) as u32),
                ..FileAttributes::empty()
            };
            let _ = sftp.set_metadata(remote, attrs).await;
        }
    }
    Ok(())
}

/// Upload a local file or folder to the remote path `remote` (folder + name).
pub async fn upload(sftp: &SftpSession, local: &Path, remote: &str, m: &mut Meter) -> Result<()> {
    let meta = std::fs::metadata(local).with_context(|| format!("无法读取 {}", local.display()))?;
    if meta.is_file() {
        m.set_total(meta.len(), 1);
        let Some(target) = resolve_remote(sftp, remote, meta.len(), unix_secs(meta.modified()), false, m).await? else {
            m.skip_file(meta.len());
            return Ok(());
        };
        m.begin_file(&split_remote(&target).1);
        put_file(sftp, local, &target, m).await?;
        m.end_file();
        return Ok(());
    }
    let tree = walk_local(local).with_context(|| format!("无法读取 {}", local.display()))?;
    m.set_total(tree.total, tree.files.len() as u32);
    let Some(root) = resolve_remote(sftp, remote, 0, None, true, m).await? else {
        m.skip_file(tree.total);
        return Ok(());
    };
    ensure_remote_dir(sftp, &root).await?;
    for (rel, _) in &tree.dirs {
        m.checkpoint().await?;
        ensure_remote_dir(sftp, &join_remote(&root, &rel.join("/"))).await?;
    }
    for f in &tree.files {
        m.checkpoint().await?;
        let target = join_remote(&root, &f.rel.join("/"));
        let mtime = std::fs::metadata(&f.path).ok().and_then(|x| unix_secs(x.modified()));
        let Some(target) = resolve_remote(sftp, &target, f.size, mtime, false, m).await? else {
            m.skip_file(f.size);
            continue;
        };
        m.begin_file(&f.rel.join("/"));
        put_file(sftp, &f.path, &target, m).await?;
        m.end_file();
    }
    if m.preserve_times {
        // Folders last: writing their files changed their times.
        for (rel, path) in tree.dirs.iter().rev() {
            set_remote_times(sftp, &join_remote(&root, &rel.join("/")), path).await;
        }
        set_remote_times(sftp, &root, local).await;
    }
    Ok(())
}

async fn set_remote_times(sftp: &SftpSession, remote: &str, local: &Path) {
    let Ok(meta) = std::fs::metadata(local) else { return };
    let Some(mtime) = unix_secs(meta.modified()) else { return };
    let attrs = FileAttributes {
        mtime: Some(mtime as u32),
        atime: Some(unix_secs(meta.accessed()).unwrap_or(mtime) as u32),
        ..FileAttributes::empty()
    };
    let _ = sftp.set_metadata(remote, attrs).await;
}

/// Copy one remote file to `local` through a temporary file.
async fn get_file(sftp: &SftpSession, remote: &str, local: &Path, meta: &Metadata, m: &mut Meter) -> Result<()> {
    let mut src = sftp.open(remote).await.ctx(|| format!("无法读取 {}", remote))?;
    let part = part_path(local);
    let mut dst = tokio::fs::File::create(&part).await.with_context(|| format!("无法写入 {}", local.display()))?;
    let mut buf = vec![0u8; CHUNK];
    let copied: Result<()> = async {
        loop {
            m.checkpoint().await?;
            let n = src.read(&mut buf).await.with_context(|| format!("读取 {} 失败", remote))?;
            if n == 0 {
                break;
            }
            dst.write_all(&buf[..n]).await?;
            m.add(n as u64);
        }
        dst.flush().await?;
        Ok(())
    }
    .await;
    drop(dst);
    if let Err(e) = copied {
        let _ = std::fs::remove_file(&part);
        return Err(e);
    }
    if std::fs::metadata(local).is_ok() {
        std::fs::remove_file(local).with_context(|| format!("无法覆盖 {}", local.display()))?;
    }
    std::fs::rename(&part, local).with_context(|| format!("无法写入 {}", local.display()))?;
    if m.preserve_times {
        set_local_times(local, meta.mtime.map(u64::from), meta.atime.map(u64::from));
    }
    Ok(())
}

/// Download a remote file or folder to the local path `local` (folder + name).
pub async fn download(sftp: &SftpSession, remote: &str, local: &Path, m: &mut Meter) -> Result<()> {
    let meta = sftp.metadata(remote).await.ctx(|| format!("无法读取 {}", remote))?;
    if !meta.file_type().is_dir() {
        let size = meta.size.unwrap_or(0);
        m.set_total(size, 1);
        let Some(target) = resolve_local(local, size, meta.mtime.map(u64::from), false, m).await? else {
            m.skip_file(size);
            return Ok(());
        };
        m.begin_file(&split_remote(remote).1);
        get_file(sftp, remote, &target, &meta, m).await?;
        m.end_file();
        return Ok(());
    }

    // Folder: list everything first for the totals. Links inside are not followed.
    let mut dirs: Vec<(String, PathBuf, Metadata)> = Vec::new();
    let mut files: Vec<(String, PathBuf, Metadata, String)> = Vec::new();
    let Some(root) = resolve_local(local, 0, None, true, m).await? else {
        m.skip_file(0);
        return Ok(());
    };
    let mut stack = vec![(remote.to_string(), root.clone(), String::new())];
    let mut total = 0u64;
    while let Some((dir, target, rel)) = stack.pop() {
        m.checkpoint().await?;
        for e in sftp.read_dir(dir.as_str()).await.ctx(|| format!("无法列出 {}", dir))? {
            let name = e.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let Some(local_name) = local_component(&name) else { continue };
            let child = join_remote(&dir, &name);
            let child_rel = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            let meta = e.metadata();
            if meta.file_type().is_dir() {
                dirs.push((child.clone(), target.join(&local_name), meta));
                stack.push((child, target.join(&local_name), child_rel));
            } else if meta.file_type().is_file() {
                total += meta.size.unwrap_or(0);
                files.push((child, target.join(&local_name), meta, child_rel));
            }
        }
    }
    m.set_total(total, files.len() as u32);
    std::fs::create_dir_all(&root).with_context(|| format!("无法创建文件夹 {}", root.display()))?;
    for (_, path, _) in &dirs {
        std::fs::create_dir_all(path).with_context(|| format!("无法创建文件夹 {}", path.display()))?;
    }
    for (remote_path, path, meta, rel) in &files {
        m.checkpoint().await?;
        let size = meta.size.unwrap_or(0);
        let Some(target) = resolve_local(path, size, meta.mtime.map(u64::from), false, m).await? else {
            m.skip_file(size);
            continue;
        };
        m.begin_file(rel);
        get_file(sftp, remote_path, &target, meta, m).await?;
        m.end_file();
    }
    if m.preserve_times {
        for (_, path, meta) in dirs.iter().rev() {
            set_local_dir_times(path, meta);
        }
        set_local_dir_times(&root, &meta);
    }
    Ok(())
}

fn set_local_dir_times(path: &Path, meta: &Metadata) {
    let Some(mtime) = meta.mtime else { return };
    let to = |s: u32| std::time::UNIX_EPOCH + Duration::from_secs(s as u64);
    let times = std::fs::FileTimes::new().set_modified(to(mtime)).set_accessed(to(meta.atime.unwrap_or(mtime)));
    // Folders open with backup semantics on Windows.
    #[cfg(windows)]
    let opened = {
        use std::os::windows::fs::OpenOptionsExt;
        std::fs::OpenOptions::new().write(true).custom_flags(0x0200_0000).open(path)
    };
    #[cfg(not(windows))]
    let opened = std::fs::File::open(path);
    if let Ok(f) = opened {
        let _ = f.set_times(times);
    }
}

// ---------------------------------------------------------------------------------------
// Preview

/// At most `limit` bytes of a remote file; fails above it (the frontend sets the limit per
/// format and says so).
pub async fn read_limited(sftp: &SftpSession, path: &str, limit: u64) -> Result<Vec<u8>> {
    let meta = sftp.metadata(path).await.ctx(|| format!("无法读取 {}", path))?;
    if meta.file_type().is_dir() {
        bail!("{} 是文件夹", path);
    }
    let size = meta.size.unwrap_or(0);
    if size > limit {
        bail!("TOO_LARGE:{}", size);
    }
    let file = sftp.open(path).await.ctx(|| format!("无法读取 {}", path))?;
    let mut out = Vec::with_capacity(size as usize);
    // A file that grew since stat still stops at the limit.
    file.take(limit + 1).read_to_end(&mut out).await.with_context(|| format!("读取 {} 失败", path))?;
    if out.len() as u64 > limit {
        bail!("TOO_LARGE:{}", out.len());
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------
// Editing with a local program

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditInfo {
    pub id: String,
    pub instance_id: String,
    pub remote_path: String,
    pub local_path: String,
    /// watching | uploading | error | stopped
    pub state: String,
    pub uploads: u32,
    pub last_upload: Option<u64>,
    pub error: Option<String>,
}

struct Edit {
    info: EditInfo,
    stop: Arc<tokio::sync::Notify>,
}

fn edits() -> &'static Mutex<Vec<Edit>> {
    static E: OnceLock<Mutex<Vec<Edit>>> = OnceLock::new();
    E.get_or_init(Default::default)
}

fn edit_root() -> PathBuf {
    crate::app_paths::data_dir().join("sftp-edit")
}

fn emit_edit(app: &AppHandle, info: &EditInfo) {
    let _ = app.emit("sftp-edit", info);
}

fn patch_edit(app: &AppHandle, id: &str, f: impl FnOnce(&mut EditInfo)) {
    let mut list = lock(edits());
    if let Some(e) = list.iter_mut().find(|e| e.info.id == id) {
        f(&mut e.info);
        emit_edit(app, &e.info);
    }
}

pub fn edit_list() -> Vec<EditInfo> {
    lock(edits()).iter().map(|e| e.info.clone()).collect()
}

/// (modified, size) of a local file, to notice saves.
fn stamp(path: &Path) -> Option<(std::time::SystemTime, u64)> {
    let m = std::fs::metadata(path).ok()?;
    Some((m.modified().ok()?, m.len()))
}

/// Download a remote file to a private folder, open it with the program Windows uses for
/// it, and upload it again whenever it is saved, until stopped or the pane closes.
pub async fn edit_start(app: AppHandle, instance_id: &str, link: &SshLink, remote: &str, open_with: Option<String>) -> Result<EditInfo> {
    let existing = lock(edits())
        .iter()
        .find(|e| e.info.instance_id == instance_id && e.info.remote_path == remote && e.info.state != "stopped")
        .map(|e| e.info.clone());
    if let Some(info) = existing {
        open_local(&info.local_path, open_with.as_deref())?;
        return Ok(info);
    }
    let sftp = Arc::clone(fs(instance_id, link).await?.sftp()?);
    let meta = sftp.metadata(remote).await.ctx(|| format!("无法读取 {}", remote))?;
    if meta.file_type().is_dir() {
        bail!("{} 是文件夹", remote);
    }
    let id = uuid::Uuid::new_v4().simple().to_string()[..12].to_string();
    let name = local_component(&split_remote(remote).1).unwrap_or_else(|| "file".into());
    let dir = edit_root().join(&id);
    std::fs::create_dir_all(&dir)?;
    let local = dir.join(name);
    let mut m = Meter::detached(crate::transfer::Policy::Overwrite, true);
    get_file(&sftp, remote, &local, &meta, &mut m).await?;

    let info = EditInfo {
        id: id.clone(),
        instance_id: instance_id.to_string(),
        remote_path: remote.to_string(),
        local_path: local.to_string_lossy().to_string(),
        state: "watching".into(),
        uploads: 0,
        last_upload: None,
        error: None,
    };
    let stop = Arc::new(tokio::sync::Notify::new());
    lock(edits()).push(Edit { info: info.clone(), stop: Arc::clone(&stop) });
    emit_edit(&app, &info);
    open_local(&info.local_path, open_with.as_deref())?;

    let instance = instance_id.to_string();
    let remote = remote.to_string();
    tauri::async_runtime::spawn(async move {
        let mut seen = stamp(&local);
        loop {
            tokio::select! {
                _ = stop.notified() => break,
                _ = tokio::time::sleep(Duration::from_millis(700)) => {}
            }
            let now = stamp(&local);
            if now.is_none() || now == seen {
                continue;
            }
            // Editors write in steps: wait until the file holds still.
            tokio::time::sleep(Duration::from_millis(400)).await;
            let settled = stamp(&local);
            if settled != now {
                continue;
            }
            seen = settled;
            // Looked up each time: the pane may have reconnected.
            let Ok(link) = app.state::<crate::AppContext>().connections.ssh_link(&instance) else {
                patch_edit(&app, &id, |i| {
                    i.state = "error".into();
                    i.error = Some("SSH 连接已断开，修改未上传（重新连接后点重试）".into());
                });
                continue;
            };
            patch_edit(&app, &id, |i| i.state = "uploading".into());
            let result = async {
                let sftp = session(&instance, &link).await?;
                let mut m = Meter::detached(crate::transfer::Policy::Overwrite, false);
                put_file(&sftp, &local, &remote, &mut m).await
            }
            .await;
            if let Err(e) = &result {
                if is_link_error(e) {
                    forget(&instance);
                }
            }
            patch_edit(&app, &id, |i| match result {
                Ok(()) => {
                    i.state = "watching".into();
                    i.uploads += 1;
                    i.last_upload = Some(crate::transfer::now_ms());
                    i.error = None;
                }
                Err(e) => {
                    i.state = "error".into();
                    i.error = Some(format!("{:#}", e));
                }
            });
        }
    });
    Ok(info)
}

/// Stop watching (the local copy is deleted).
pub fn edit_stop(app: &AppHandle, id: &str) {
    let removed = {
        let mut list = lock(edits());
        list.iter().position(|e| e.info.id == id).map(|i| list.remove(i))
    };
    if let Some(mut e) = removed {
        e.stop.notify_one();
        e.info.state = "stopped".into();
        emit_edit(app, &e.info);
        let _ = std::fs::remove_dir_all(edit_root().join(&e.info.id));
    }
}

/// Upload the local copy again now (after an error).
pub fn edit_retry(id: &str) {
    if let Some(e) = lock(edits()).iter().find(|e| e.info.id == id) {
        // Touching the file makes the watcher see a change.
        if let Ok(f) = std::fs::OpenOptions::new().write(true).open(&e.info.local_path) {
            let _ = f.set_modified(std::time::SystemTime::now());
        }
    }
}

/// Leftover copies of edits from an earlier run.
pub fn edit_cleanup() {
    let _ = std::fs::remove_dir_all(edit_root());
}

/// The pane closed: its edits and its SFTP session end.
pub fn forget_instance(app: &AppHandle, instance_id: &str) {
    let ids: Vec<String> = lock(edits())
        .iter()
        .filter(|e| e.info.instance_id == instance_id)
        .map(|e| e.info.id.clone())
        .collect();
    for id in ids {
        edit_stop(app, &id);
    }
    forget(instance_id);
}

/// Open a local file with its default program, or with `program`.
pub fn open_local(path: &str, program: Option<&str>) -> Result<()> {
    let program = program.map(str::trim).filter(|p| !p.is_empty());
    let mut cmd = match program {
        Some(p) => {
            let mut c = std::process::Command::new(p);
            c.arg(path);
            c
        }
        None => {
            #[cfg(windows)]
            {
                let mut c = std::process::Command::new("explorer");
                c.arg(path.replace('/', "\\"));
                c
            }
            #[cfg(not(windows))]
            {
                let mut c = std::process::Command::new("xdg-open");
                c.arg(path);
                c
            }
        }
    };
    cmd.spawn().map(|_| ()).with_context(|| format!("无法打开 {}", path))
}

/// Against real servers: `NX_SFTP_KEY=path NX_SFTP_USER=me cargo test --lib sftp_e2e -- --ignored --nocapture`.
/// Port 2222: sshd with the SFTP subsystem; port 2223: sshd without it (SCP fallback).
#[cfg(test)]
mod sftp_e2e {
    use super::*;
    use crate::manager::{SshSlot, TerminalSink};
    use crate::models::SessionConfig;
    use crate::transfer::tests_support::{CANCEL, PAUSE};
    use crate::transfer::Policy;

    struct Quiet;
    impl TerminalSink for Quiet {
        fn emit_output(&self, _id: &str, _data: &[u8]) {}
        fn emit_state(&self, _id: &str, status: &str, message: Option<String>) {
            eprintln!("state {status} {message:?}");
        }
    }

    fn connect(port: u16) -> (SshLink, crate::manager::RuntimeControl) {
        let env = |k: &str| std::env::var(k).unwrap_or_default();
        let session: SessionConfig = serde_json::from_value(serde_json::json!({
            "id": "t", "label": "t", "protocol": "ssh", "host": "127.0.0.1", "port": port,
            "username": env("NX_SFTP_USER"), "authType": "privatekey", "privateKeyPath": env("NX_SFTP_KEY"),
            "skipHostKeyCheck": true,
        }))
        .unwrap();
        let slot: SshSlot = Arc::default();
        let ctl = crate::ssh_conn::spawn_ssh_session(format!("e2e{port}"), session, 80, 24, Arc::new(Quiet), Arc::clone(&slot), None);
        for _ in 0..200 {
            if let Some(link) = slot.lock().unwrap().clone() {
                return (link, ctl);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("no connection on port {port}");
    }

    fn local_tree(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("nx-e2e-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("src/sub/empty")).unwrap();
        std::fs::write(root.join("src/a.txt"), b"alpha").unwrap();
        std::fs::write(root.join("src/sub/big.bin"), (0..3_000_000u32).map(|i| (i % 251) as u8).collect::<Vec<_>>()).unwrap();
        let old = std::time::UNIX_EPOCH + Duration::from_secs(1_500_000_000);
        std::fs::File::options().write(true).open(root.join("src/a.txt")).unwrap().set_modified(old).unwrap();
        root
    }

    fn same_tree(a: &Path, b: &Path) {
        let ta = walk_local(a).unwrap();
        let tb = walk_local(b).unwrap();
        let names = |t: &crate::transfer::LocalTree| {
            let mut v: Vec<String> = t.files.iter().map(|f| f.rel.join("/")).collect();
            v.sort();
            v
        };
        assert_eq!(names(&ta), names(&tb));
        for f in &ta.files {
            assert_eq!(std::fs::read(&f.path).unwrap(), std::fs::read(b.join(f.rel.join("/"))).unwrap(), "{:?}", f.rel);
        }
    }

    fn mtime(p: &Path) -> Option<u64> {
        unix_secs(std::fs::metadata(p).unwrap().modified())
    }

    #[test]
    #[ignore]
    fn sftp_browse_and_transfer() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let (link, ctl) = connect(2222);
        let root = local_tree("sftp");
        rt.block_on(async {
            let fs = fs("e2e2222", &link).await.unwrap();
            let s = Arc::clone(fs.sftp().expect("SFTP expected on 2222"));
            let home = fs.home().await.unwrap();
            let base = join_remote(&home, &format!("nx-e2e-{}", uuid::Uuid::new_v4().simple()));
            fs.mkdir(&base).await.unwrap();
            fs.touch(&join_remote(&base, "new.txt")).await.unwrap();
            assert!(fs.touch(&join_remote(&base, "new.txt")).await.is_err(), "touch must not clobber");
            fs.rename(&join_remote(&base, "new.txt"), &join_remote(&base, "renamed.txt")).await.unwrap();
            fs.chmod(&join_remote(&base, "renamed.txt"), 0o640).await.unwrap();
            // OpenSSH swaps the SYMLINK arguments: the link must point at the target.
            fs.symlink(&join_remote(&base, "ln"), &join_remote(&base, "renamed.txt")).await.unwrap();
            let listing = fs.list(&base).await.unwrap();
            let ln = listing.entries.iter().find(|e| e.name == "ln").unwrap();
            assert_eq!((ln.kind.as_str(), ln.link_target.as_deref()), ("link", Some(join_remote(&base, "renamed.txt").as_str())));
            let f = listing.entries.iter().find(|e| e.name == "renamed.txt").unwrap();
            assert_eq!(f.mode, Some(0o640));

            // Folder upload with times, then again: "rename" picks a free name.
            let mut m = Meter::detached(Policy::Overwrite, true);
            upload(&s, &root.join("src"), &join_remote(&base, "up"), &mut m).await.unwrap();
            assert_eq!((m.files_done, m.transferred), (2, 3_000_005));
            let a = s.metadata(join_remote(&base, "up/a.txt")).await.unwrap();
            assert_eq!(a.mtime, Some(1_500_000_000));
            assert!(s.metadata(join_remote(&base, "up/sub/empty")).await.unwrap().file_type().is_dir());
            let mut m = Meter::detached(Policy::Rename, true);
            upload(&s, &root.join("src/a.txt"), &join_remote(&base, "up/a.txt"), &mut m).await.unwrap();
            assert!(s.metadata(join_remote(&base, "up/a (1).txt")).await.is_ok());
            let mut m = Meter::detached(Policy::Newer, true);
            upload(&s, &root.join("src/a.txt"), &join_remote(&base, "up/a.txt"), &mut m).await.unwrap();
            assert_eq!(m.skipped, 1, "same time: not newer");

            // Folder download, then compare.
            let mut m = Meter::detached(Policy::Overwrite, true);
            download(&s, &join_remote(&base, "up"), &root.join("down"), &mut m).await.unwrap();
            std::fs::remove_file(root.join("down/a (1).txt")).unwrap();
            same_tree(&root.join("src"), &root.join("down"));
            assert_eq!(mtime(&root.join("down/a.txt")), Some(1_500_000_000));
            assert!(root.join("down/sub/empty").is_dir());

            // Preview reads stop at the limit.
            assert_eq!(read_limited(&s, &join_remote(&base, "up/a.txt"), 100).await.unwrap(), b"alpha");
            let big = read_limited(&s, &join_remote(&base, "up/sub/big.bin"), 1000).await.unwrap_err();
            assert!(big.to_string().starts_with("TOO_LARGE:3000000"), "{big}");

            // Pause, then cancel a transfer in flight.
            let mut m = Meter::detached(Policy::Overwrite, false);
            let job_ctl = Arc::clone(&m.ctl);
            let s2 = Arc::clone(&s);
            let target = join_remote(&base, "cancelled.bin");
            let src = root.join("src/sub/big.bin");
            job_ctl.set(PAUSE);
            let job = tokio::spawn(async move { upload(&s2, &src, &target, &mut m).await });
            tokio::time::sleep(Duration::from_millis(300)).await;
            assert!(!job.is_finished(), "paused job must wait");
            job_ctl.set(CANCEL);
            let err = job.await.unwrap().unwrap_err();
            assert!(crate::transfer::is_cancelled(&err));

            fs.remove(&base).await.unwrap();
            assert!(s.metadata(base.as_str()).await.is_err());
        });
        ctl.send_close();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[ignore]
    fn scp_fallback_without_sftp() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let (link, ctl) = connect(2223);
        let root = local_tree("scp");
        rt.block_on(async {
            let fs = fs("e2e2223", &link).await.unwrap();
            assert!(matches!(fs, Fs::Shell(_)), "no SFTP on 2223: shell mode expected");
            let home = fs.home().await.unwrap();
            let base = join_remote(&home, &format!("nx-e2e-{}", uuid::Uuid::new_v4().simple()));
            fs.mkdir(&base).await.unwrap();
            fs.touch(&join_remote(&base, "it's here.txt")).await.unwrap();
            fs.symlink(&join_remote(&base, "ln"), "it's here.txt").await.unwrap();
            fs.chmod(&join_remote(&base, "it's here.txt"), 0o600).await.unwrap();

            let mut m = Meter::detached(Policy::Overwrite, true);
            crate::scp::upload(&link, &root.join("src"), &join_remote(&base, "up"), &mut m).await.unwrap();
            assert_eq!(m.files_done, 2);
            let listing = fs.list(&join_remote(&base, "up")).await.unwrap();
            assert_eq!(listing.mode, "scp");
            let a = listing.entries.iter().find(|e| e.name == "a.txt").unwrap();
            assert_eq!((a.size, a.mtime), (5, Some(1_500_000_000)));
            let top = fs.list(&base).await.unwrap();
            let ln = top.entries.iter().find(|e| e.name == "ln").unwrap();
            assert_eq!(ln.link_target.as_deref(), Some("it's here.txt"));
            assert_eq!(top.entries.iter().find(|e| e.name == "it's here.txt").unwrap().mode, Some(0o600));

            let mut m = Meter::detached(Policy::Overwrite, true);
            crate::scp::download(&link, &join_remote(&base, "up"), &root.join("down"), &mut m).await.unwrap();
            same_tree(&root.join("src"), &root.join("down"));
            assert_eq!(mtime(&root.join("down/a.txt")), Some(1_500_000_000));

            // A single file whose target exists: skip leaves it alone.
            std::fs::write(root.join("down/a.txt"), b"local").unwrap();
            let mut m = Meter::detached(Policy::Skip, true);
            crate::scp::download(&link, &join_remote(&base, "up/a.txt"), &root.join("down/a.txt"), &mut m).await.unwrap();
            assert_eq!(std::fs::read(root.join("down/a.txt")).unwrap(), b"local");

            fs.rename(&join_remote(&base, "up"), &join_remote(&base, "moved")).await.unwrap();
            fs.remove(&base).await.unwrap();
            assert!(fs.stat(&base).await.is_err());
        });
        ctl.send_close();
        std::fs::remove_dir_all(root).unwrap();
    }
}
