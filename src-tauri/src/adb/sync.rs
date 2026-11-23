//! The adb `sync:` service: file stat / list / pull / push. Requests are a 4-byte id + u32
//! LE length + path; replies are fixed records (`STAT`, `DENT` ... `DONE`) or `DATA`
//! chunks of at most 64 KB, ended by `DONE`, with `FAIL` + message on error.
//!
//! Uploads and downloads take a `transfer::Meter` and follow the SFTP versions in
//! `sftp.rs` (conflict prompts, `.part` files locally, pause / cancel at checkpoints).

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::AdbDevice;
use crate::net::BoxedStream;
use crate::transfer::{
    join_remote, local_component, numbered_name, part_path, resolve_local, set_local_times, split_remote, unix_secs, walk_local,
    ConflictInfo, Meter, Resolution,
};

const MAX_DATA: usize = 64 * 1024;

pub const S_IFMT: u32 = 0o170000;
pub const S_IFDIR: u32 = 0o040000;
pub const S_IFREG: u32 = 0o100000;
pub const S_IFLNK: u32 = 0o120000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Stat {
    pub mode: u32,
    pub size: u32,
    pub mtime: u32,
}

impl Stat {
    /// The v1 STAT reply is all zeros when the path does not exist.
    pub fn exists(&self) -> bool {
        self.mode != 0 || self.size != 0 || self.mtime != 0
    }
    pub fn is_dir(&self) -> bool {
        self.mode & S_IFMT == S_IFDIR
    }
    pub fn is_file(&self) -> bool {
        self.mode & S_IFMT == S_IFREG
    }
}

pub fn encode_request(id: &[u8; 4], arg: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + arg.len());
    out.extend_from_slice(id);
    out.extend_from_slice(&(arg.len() as u32).to_le_bytes());
    out.extend_from_slice(arg);
    out
}

fn le(b: &[u8]) -> u32 {
    u32::from_le_bytes([b[0], b[1], b[2], b[3]])
}

/// One open `sync:` socket; requests run one after another on it.
pub struct SyncConn {
    s: BoxedStream,
}

impl SyncConn {
    pub async fn open(device: &AdbDevice) -> Result<Self> {
        Ok(SyncConn { s: device.open("sync:").await? })
    }

    async fn header(&mut self) -> Result<([u8; 4], u32)> {
        let mut h = [0u8; 8];
        self.s.read_exact(&mut h).await.context("设备连接中断")?;
        Ok(([h[0], h[1], h[2], h[3]], le(&h[4..])))
    }

    async fn fail(&mut self, len: u32) -> anyhow::Error {
        let mut msg = vec![0u8; len as usize];
        let _ = self.s.read_exact(&mut msg).await;
        anyhow::anyhow!("{}", String::from_utf8_lossy(&msg).trim().to_string())
    }

    /// lstat (links are not followed).
    pub async fn lstat(&mut self, path: &str) -> Result<Stat> {
        self.s.write_all(&encode_request(b"STAT", path.as_bytes())).await?;
        let mut r = [0u8; 16];
        self.s.read_exact(&mut r).await.context("设备连接中断")?;
        if &r[..4] != b"STAT" {
            bail!("sync 协议错误（STAT）");
        }
        Ok(Stat { mode: le(&r[4..]), size: le(&r[8..]), mtime: le(&r[12..]) })
    }

    /// stat that follows a link: v1 has no such request, so `path/` is asked instead,
    /// which only says whether the target is a folder.
    pub async fn is_dir_following(&mut self, path: &str) -> Result<bool> {
        let p = if path.ends_with('/') { path.to_string() } else { format!("{path}/") };
        Ok(self.lstat(&p).await?.is_dir())
    }

    /// Entries of a folder (without "." and "..").
    pub async fn list(&mut self, path: &str) -> Result<Vec<(String, Stat)>> {
        self.s.write_all(&encode_request(b"LIST", path.as_bytes())).await?;
        let mut out = Vec::new();
        loop {
            let mut r = [0u8; 20];
            self.s.read_exact(&mut r).await.context("设备连接中断")?;
            match &r[..4] {
                b"DONE" => break,
                b"DENT" => {
                    let st = Stat { mode: le(&r[4..]), size: le(&r[8..]), mtime: le(&r[12..]) };
                    let mut name = vec![0u8; le(&r[16..]) as usize];
                    self.s.read_exact(&mut name).await?;
                    let name = String::from_utf8_lossy(&name).into_owned();
                    if name != "." && name != ".." {
                        out.push((name, st));
                    }
                }
                b"FAIL" => {
                    let len = le(&r[4..]);
                    // FAIL's header is 8 bytes: 12 of the 20 read belong to the message.
                    let mut msg = r[8..].to_vec();
                    msg.truncate(len as usize);
                    if len as usize > 12 {
                        let mut rest = vec![0u8; len as usize - 12];
                        self.s.read_exact(&mut rest).await?;
                        msg.extend(rest);
                    }
                    bail!("无法列出 {}：{}", path, String::from_utf8_lossy(&msg).trim());
                }
                _ => bail!("sync 协议错误（LIST）"),
            }
        }
        Ok(out)
    }

    /// Start pulling a file; read it with `recv_chunk`.
    pub async fn recv_start(&mut self, path: &str) -> Result<()> {
        self.s.write_all(&encode_request(b"RECV", path.as_bytes())).await?;
        Ok(())
    }

    /// The next chunk of a pull into `buf` (grown as needed): Some(len), None at the end.
    pub async fn recv_chunk(&mut self, buf: &mut Vec<u8>) -> Result<Option<usize>> {
        let (id, len) = self.header().await?;
        match &id {
            b"DATA" => {
                let len = len as usize;
                if len > buf.len() {
                    buf.resize(len, 0);
                }
                self.s.read_exact(&mut buf[..len]).await.context("设备连接中断")?;
                Ok(Some(len))
            }
            b"DONE" => Ok(None),
            b"FAIL" => Err(self.fail(len).await),
            _ => bail!("sync 协议错误（RECV）"),
        }
    }

    /// Start pushing: `SEND path,mode`, then `send_data`..., then `send_finish`.
    pub async fn send_start(&mut self, path: &str, mode: u32) -> Result<()> {
        let arg = format!("{},{}", path, mode);
        self.s.write_all(&encode_request(b"SEND", arg.as_bytes())).await?;
        Ok(())
    }

    pub async fn send_data(&mut self, data: &[u8]) -> Result<()> {
        for chunk in data.chunks(MAX_DATA) {
            self.s.write_all(&encode_request(b"DATA", chunk)).await.context("设备连接中断")?;
        }
        Ok(())
    }

    /// `DONE mtime`, then the device's `OKAY` / `FAIL`.
    pub async fn send_finish(&mut self, path: &str, mtime: u32) -> Result<()> {
        let mut done = b"DONE".to_vec();
        done.extend_from_slice(&mtime.to_le_bytes());
        self.s.write_all(&done).await?;
        let (id, len) = self.header().await?;
        match &id {
            b"OKAY" => Ok(()),
            b"FAIL" => Err(self.fail(len).await.context(format!("无法写入 {}", path))),
            _ => bail!("sync 协议错误（SEND）"),
        }
    }

    pub async fn quit(mut self) {
        let _ = self.s.write_all(&encode_request(b"QUIT", b"")).await;
    }
}

// ---------------------------------------------------------------------------------------
// Whole files

/// At most `limit` bytes of a file (the preview).
pub async fn read_limited(device: &AdbDevice, path: &str, limit: u64) -> Result<Vec<u8>> {
    let mut c = SyncConn::open(device).await?;
    let st = c.lstat(path).await?;
    if st.is_dir() || c.is_dir_following(path).await.unwrap_or(false) {
        bail!("{} 是文件夹", path);
    }
    if st.is_file() && st.size as u64 > limit {
        bail!("TOO_LARGE:{}", st.size);
    }
    let mut out = Vec::new();
    let mut buf = vec![0u8; MAX_DATA];
    c.recv_start(path).await?;
    while let Some(n) = c.recv_chunk(&mut buf).await.with_context(|| format!("无法读取 {}", path))? {
        out.extend_from_slice(&buf[..n]);
        if out.len() as u64 > limit {
            bail!("TOO_LARGE:{}", out.len());
        }
    }
    c.quit().await;
    Ok(out)
}

/// Write `data` to `path` (local editing saves).
pub async fn write_all(device: &AdbDevice, path: &str, mode: u32, data: &[u8]) -> Result<()> {
    let mut c = SyncConn::open(device).await?;
    c.send_start(path, mode).await?;
    c.send_data(data).await?;
    c.send_finish(path, now_secs()).await?;
    c.quit().await;
    Ok(())
}

/// Push a local file without a meter (scrcpy server, APKs).
pub async fn push_file(device: &AdbDevice, local: &Path, remote: &str, mode: u32) -> Result<()> {
    let mut src = tokio::fs::File::open(local).await.with_context(|| format!("无法读取 {}", local.display()))?;
    let mut c = SyncConn::open(device).await?;
    c.send_start(remote, mode).await?;
    let mut buf = vec![0u8; MAX_DATA];
    loop {
        let n = src.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        c.send_data(&buf[..n]).await?;
    }
    c.send_finish(remote, now_secs()).await?;
    c.quit().await;
    Ok(())
}

/// Pull a file to a local path without a meter (APK export, local editing).
pub async fn pull_file(device: &AdbDevice, remote: &str, local: &Path) -> Result<()> {
    let mut c = SyncConn::open(device).await?;
    let part = part_path(local);
    let mut dst = tokio::fs::File::create(&part).await.with_context(|| format!("无法写入 {}", local.display()))?;
    let copied: Result<()> = async {
        let mut buf = vec![0u8; MAX_DATA];
        c.recv_start(remote).await?;
        while let Some(n) = c.recv_chunk(&mut buf).await.with_context(|| format!("无法读取 {}", remote))? {
            dst.write_all(&buf[..n]).await?;
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
    let _ = std::fs::remove_file(local);
    std::fs::rename(&part, local).with_context(|| format!("无法写入 {}", local.display()))?;
    c.quit().await;
    Ok(())
}

fn now_secs() -> u32 {
    unix_secs(Ok(std::time::SystemTime::now())).unwrap_or(0) as u32
}

// ---------------------------------------------------------------------------------------
// Transfers (transfer queue)

/// Existing remote target: None when skipped, else the path to write.
async fn resolve_remote(c: &mut SyncConn, path: &str, size: u64, mtime: Option<u64>, is_dir: bool, m: &mut Meter) -> Result<Option<String>> {
    let dst = c.lstat(path).await?;
    if !dst.exists() {
        return Ok(Some(path.to_string()));
    }
    let dst_dir = dst.is_dir();
    if is_dir && dst_dir {
        return Ok(Some(path.to_string()));
    }
    let info = ConflictInfo {
        path: path.to_string(),
        is_dir: dst_dir,
        src_size: size,
        src_mtime: mtime,
        dst_size: if dst_dir { 0 } else { dst.size as u64 },
        dst_mtime: Some(dst.mtime as u64),
    };
    match m.resolve(info).await? {
        Resolution::Skip => Ok(None),
        Resolution::Overwrite if dst_dir != is_dir => bail!("目标 {} 已存在且类型不同，无法覆盖", path),
        Resolution::Overwrite => Ok(Some(path.to_string())),
        Resolution::Rename => {
            let (dir, name) = split_remote(path);
            for n in 1..10000 {
                let candidate = join_remote(&dir, &numbered_name(&name, n));
                if !c.lstat(&candidate).await?.exists() {
                    return Ok(Some(candidate));
                }
            }
            bail!("找不到可用的文件名 {}", path)
        }
    }
}

async fn put_file(c: &mut SyncConn, local: &Path, remote: &str, m: &mut Meter) -> Result<()> {
    let meta = std::fs::metadata(local).with_context(|| format!("无法读取 {}", local.display()))?;
    let mtime = if m.preserve_times { unix_secs(meta.modified()).unwrap_or(0) as u32 } else { now_secs() };
    let mut src = tokio::fs::File::open(local).await.with_context(|| format!("无法读取 {}", local.display()))?;
    c.send_start(remote, 0o644).await?;
    let mut buf = vec![0u8; MAX_DATA];
    loop {
        m.checkpoint().await?;
        let n = src.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        c.send_data(&buf[..n]).await.with_context(|| format!("写入 {} 失败", remote))?;
        m.add(n as u64);
    }
    c.send_finish(remote, mtime).await
}

/// Upload a local file or folder to `remote` (folder + name). Folders are created with
/// `mkdir -p` on the shell (sync has no mkdir; SEND creates parents of files itself).
pub async fn upload(device: &AdbDevice, local: &Path, remote: &str, m: &mut Meter) -> Result<()> {
    let meta = std::fs::metadata(local).with_context(|| format!("无法读取 {}", local.display()))?;
    let mut c = SyncConn::open(device).await?;
    if meta.is_file() {
        m.set_total(meta.len(), 1);
        let Some(target) = resolve_remote(&mut c, remote, meta.len(), unix_secs(meta.modified()), false, m).await? else {
            m.skip_file(meta.len());
            return Ok(());
        };
        m.begin_file(&split_remote(&target).1);
        put_file(&mut c, local, &target, m).await?;
        m.end_file();
        c.quit().await;
        return Ok(());
    }
    let tree = walk_local(local).with_context(|| format!("无法读取 {}", local.display()))?;
    m.set_total(tree.total, tree.files.len() as u32);
    let Some(root) = resolve_remote(&mut c, remote, 0, None, true, m).await? else {
        m.skip_file(tree.total);
        return Ok(());
    };
    let mut mk = format!("mkdir -p -- {}", crate::transfer::shell_quote(&root));
    for (rel, _) in &tree.dirs {
        mk.push(' ');
        mk.push_str(&crate::transfer::shell_quote(&join_remote(&root, &rel.join("/"))));
    }
    device.exec_output(&mk).await.with_context(|| format!("无法创建文件夹 {}", root))?;
    for f in &tree.files {
        m.checkpoint().await?;
        let target = join_remote(&root, &f.rel.join("/"));
        let mtime = std::fs::metadata(&f.path).ok().and_then(|x| unix_secs(x.modified()));
        let Some(target) = resolve_remote(&mut c, &target, f.size, mtime, false, m).await? else {
            m.skip_file(f.size);
            continue;
        };
        m.begin_file(&f.rel.join("/"));
        put_file(&mut c, &f.path, &target, m).await?;
        m.end_file();
    }
    c.quit().await;
    Ok(())
}

async fn get_file(c: &mut SyncConn, remote: &str, local: &Path, st: Stat, m: &mut Meter) -> Result<()> {
    let part = part_path(local);
    let mut dst = tokio::fs::File::create(&part).await.with_context(|| format!("无法写入 {}", local.display()))?;
    let copied: Result<()> = async {
        let mut buf = vec![0u8; MAX_DATA];
        m.checkpoint().await?;
        c.recv_start(remote).await?;
        while let Some(n) = c.recv_chunk(&mut buf).await.with_context(|| format!("无法读取 {}", remote))? {
            dst.write_all(&buf[..n]).await?;
            m.add(n as u64);
            // A cancelled pull leaves the socket mid-file; the job drops it.
            m.checkpoint().await?;
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
        set_local_times(local, Some(st.mtime as u64), Some(st.mtime as u64));
    }
    Ok(())
}

/// Download a remote file or folder to `local` (folder + name). Links inside folders are
/// not followed; a link given directly is.
pub async fn download(device: &AdbDevice, remote: &str, local: &Path, m: &mut Meter) -> Result<()> {
    let mut c = SyncConn::open(device).await?;
    let st = c.lstat(remote).await?;
    if !st.exists() {
        bail!("{} 不存在", remote);
    }
    let is_dir = st.is_dir() || (st.mode & S_IFMT == S_IFLNK && c.is_dir_following(remote).await.unwrap_or(false));
    if !is_dir {
        m.set_total(st.size as u64, 1);
        let Some(target) = resolve_local(local, st.size as u64, Some(st.mtime as u64), false, m).await? else {
            m.skip_file(st.size as u64);
            return Ok(());
        };
        m.begin_file(&split_remote(remote).1);
        get_file(&mut c, remote, &target, st, m).await?;
        m.end_file();
        c.quit().await;
        return Ok(());
    }
    let Some(root) = resolve_local(local, 0, None, true, m).await? else {
        m.skip_file(0);
        return Ok(());
    };
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut files: Vec<(String, PathBuf, Stat, String)> = Vec::new();
    let mut stack = vec![(remote.to_string(), root.clone(), String::new())];
    let mut total = 0u64;
    while let Some((dir, target, rel)) = stack.pop() {
        m.checkpoint().await?;
        for (name, st) in c.list(&dir).await? {
            let Some(local_name) = local_component(&name) else { continue };
            let child = join_remote(&dir, &name);
            let child_rel = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            if st.is_dir() {
                dirs.push(target.join(&local_name));
                stack.push((child, target.join(&local_name), child_rel));
            } else if st.is_file() {
                total += st.size as u64;
                files.push((child, target.join(&local_name), st, child_rel));
            }
        }
    }
    m.set_total(total, files.len() as u32);
    std::fs::create_dir_all(&root).with_context(|| format!("无法创建文件夹 {}", root.display()))?;
    for d in &dirs {
        std::fs::create_dir_all(d).with_context(|| format!("无法创建文件夹 {}", d.display()))?;
    }
    for (remote_path, path, st, rel) in &files {
        m.checkpoint().await?;
        let Some(target) = resolve_local(path, st.size as u64, Some(st.mtime as u64), false, m).await? else {
            m.skip_file(st.size as u64);
            continue;
        };
        m.begin_file(rel);
        get_file(&mut c, remote_path, &target, *st, m).await?;
        m.end_file();
    }
    c.quit().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_layout() {
        assert_eq!(encode_request(b"STAT", b"/sdcard"), b"STAT\x07\x00\x00\x00/sdcard".to_vec());
    }

    #[test]
    fn stat_kinds() {
        let d = Stat { mode: S_IFDIR | 0o755, size: 4096, mtime: 1 };
        assert!(d.is_dir() && d.exists() && !d.is_file());
        assert!(!Stat::default().exists());
    }

    /// A fake device side: LIST answers two entries (plus "." which is dropped), RECV two chunks.
    #[tokio::test]
    async fn list_and_recv_over_a_pipe() {
        let (client, mut server) = tokio::io::duplex(1 << 16);
        let mut c = SyncConn { s: Box::new(client) };
        let dev = tokio::spawn(async move {
            let mut h = [0u8; 8];
            server.read_exact(&mut h).await.unwrap();
            assert_eq!(&h[..4], b"LIST");
            let mut p = vec![0u8; le(&h[4..]) as usize];
            server.read_exact(&mut p).await.unwrap();
            for (name, mode) in [(".", S_IFDIR), ("a.txt", S_IFREG | 0o644), ("Music", S_IFDIR | 0o771)] {
                let mut r = b"DENT".to_vec();
                r.extend(mode.to_le_bytes());
                r.extend(5u32.to_le_bytes());
                r.extend(7u32.to_le_bytes());
                r.extend((name.len() as u32).to_le_bytes());
                r.extend(name.as_bytes());
                server.write_all(&r).await.unwrap();
            }
            server.write_all(b"DONE\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0").await.unwrap();
            server.read_exact(&mut h).await.unwrap();
            assert_eq!(&h[..4], b"RECV");
            let mut p = vec![0u8; le(&h[4..]) as usize];
            server.read_exact(&mut p).await.unwrap();
            for chunk in [&b"hel"[..], b"lo"] {
                server.write_all(&encode_request(b"DATA", chunk)).await.unwrap();
            }
            server.write_all(b"DONE\0\0\0\0").await.unwrap();
        });
        let list = c.list("/sdcard").await.unwrap();
        assert_eq!(list.iter().map(|x| x.0.as_str()).collect::<Vec<_>>(), ["a.txt", "Music"]);
        assert!(list[1].1.is_dir());
        let mut got = Vec::new();
        let mut buf = vec![0u8; 4];
        c.recv_start("/sdcard/a.txt").await.unwrap();
        while let Some(n) = c.recv_chunk(&mut buf).await.unwrap() {
            got.extend_from_slice(&buf[..n]);
        }
        assert_eq!(got, b"hello");
        dev.await.unwrap();
    }

    #[tokio::test]
    async fn list_fail_message() {
        let (client, mut server) = tokio::io::duplex(1 << 16);
        let mut c = SyncConn { s: Box::new(client) };
        tokio::spawn(async move {
            let mut h = [0u8; 13];
            server.read_exact(&mut h).await.unwrap();
            server.write_all(&encode_request(b"FAIL", b"Permission denied")).await.unwrap();
        });
        let err = c.list("/data").await.unwrap_err().to_string();
        assert!(err.contains("Permission denied"), "{err}");
    }
}
