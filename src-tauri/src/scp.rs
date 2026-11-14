//! SCP for servers without SFTP (dropbear, embedded boxes): the rcp protocol spoken with
//! the remote `scp -t` (upload) / `scp -f` (download), files and folders, times and modes
//! kept with `-p`.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};

use crate::ssh_conn::SshLink;
use crate::transfer::{
    local_component, numbered_name, part_path, resolve_local, set_local_times, shell_quote, split_remote, unix_secs,
    walk_local, ConflictInfo, Meter, Resolution,
};

const CHUNK: usize = 256 * 1024;

/// One reply of the other side: 0 = ok, 1 / 2 + message = warning / error.
async fn read_ack<S: AsyncRead + Unpin>(s: &mut BufReader<S>) -> Result<()> {
    let mut b = [0u8; 1];
    s.read_exact(&mut b).await.context("SCP 连接意外关闭")?;
    match b[0] {
        0 => Ok(()),
        1 | 2 => {
            let mut line = Vec::new();
            s.read_until(b'\n', &mut line).await?;
            bail!("{}", String::from_utf8_lossy(&line).trim())
        }
        other => bail!("SCP 协议错误（应答 0x{:02x}），远程可能没有 scp 程序", other),
    }
}

async fn send_line<S: AsyncRead + AsyncWrite + Unpin>(s: &mut BufReader<S>, line: &str) -> Result<()> {
    s.get_mut().write_all(line.as_bytes()).await?;
    s.get_mut().flush().await?;
    read_ack(s).await
}

async fn ok<S: AsyncRead + AsyncWrite + Unpin>(s: &mut BufReader<S>) -> Result<()> {
    s.get_mut().write_all(&[0]).await?;
    s.get_mut().flush().await?;
    Ok(())
}

fn times_of(meta: &std::fs::Metadata) -> (u64, u64) {
    let mtime = unix_secs(meta.modified()).unwrap_or(0);
    (mtime, unix_secs(meta.accessed()).unwrap_or(mtime))
}

enum Step {
    Enter(PathBuf, String),
    File(PathBuf, String),
    Leave,
}

/// D / C / E messages for a local file or folder, in protocol order.
fn plan(path: &Path, name: &str, out: &mut Vec<Step>) -> std::io::Result<()> {
    let meta = std::fs::metadata(path)?;
    if meta.is_file() {
        out.push(Step::File(path.to_path_buf(), name.to_string()));
    } else if meta.is_dir() {
        out.push(Step::Enter(path.to_path_buf(), name.to_string()));
        let mut children: Vec<_> = std::fs::read_dir(path)?.filter_map(|e| e.ok()).collect();
        children.sort_by_key(|e| e.file_name());
        for child in children {
            let p = child.path();
            // Linked folders (junctions) are not followed.
            if std::fs::symlink_metadata(&p).map(|m| m.file_type().is_symlink() && p.is_dir()).unwrap_or(true) {
                continue;
            }
            plan(&p, &child.file_name().to_string_lossy(), out)?;
        }
        out.push(Step::Leave);
    }
    Ok(())
}

/// Upload `local` as `name` into the sink's target folder.
pub async fn send<S: AsyncRead + AsyncWrite + Unpin>(s: &mut BufReader<S>, local: &Path, name: &str, m: &mut Meter) -> Result<()> {
    read_ack(s).await.context("远程 scp 未就绪")?;
    if local.is_dir() {
        let tree = walk_local(local)?;
        m.set_total(tree.total, tree.files.len() as u32);
    } else {
        m.set_total(std::fs::metadata(local)?.len(), 1);
    }
    let mut steps = Vec::new();
    plan(local, name, &mut steps)?;
    let mut buf = vec![0u8; CHUNK];
    for step in steps {
        m.checkpoint().await?;
        match step {
            Step::Enter(path, name) => {
                if m.preserve_times {
                    let (mtime, atime) = times_of(&std::fs::metadata(&path)?);
                    send_line(s, &format!("T{} 0 {} 0\n", mtime, atime)).await?;
                }
                send_line(s, &format!("D0755 0 {}\n", name)).await?;
            }
            Step::Leave => send_line(s, "E\n").await?,
            Step::File(path, name) => {
                let meta = std::fs::metadata(&path)?;
                m.begin_file(&name);
                if m.preserve_times {
                    let (mtime, atime) = times_of(&meta);
                    send_line(s, &format!("T{} 0 {} 0\n", mtime, atime)).await?;
                }
                let size = meta.len();
                send_line(s, &format!("C0644 {} {}\n", size, name)).await?;
                let mut file = tokio::fs::File::open(&path).await?;
                let mut left = size;
                while left > 0 {
                    m.checkpoint().await?;
                    let want = (left as usize).min(CHUNK);
                    let n = file.read(&mut buf[..want]).await?;
                    if n == 0 {
                        bail!("{} 在传输中变短了", path.display());
                    }
                    s.get_mut().write_all(&buf[..n]).await?;
                    left -= n as u64;
                    m.add(n as u64);
                }
                ok(s).await?;
                read_ack(s).await?;
                m.end_file();
            }
        }
    }
    Ok(())
}

/// Download what the source sends; the first file or folder becomes `target`.
pub async fn receive<S: AsyncRead + AsyncWrite + Unpin>(s: &mut BufReader<S>, target: &Path, m: &mut Meter) -> Result<()> {
    ok(s).await?;
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut times: Option<(u64, u64)> = None;
    let mut received = false;
    let mut warnings: Vec<String> = Vec::new();
    let mut buf = vec![0u8; CHUNK];
    loop {
        let mut line = Vec::new();
        if s.read_until(b'\n', &mut line).await? == 0 {
            break;
        }
        let text = String::from_utf8_lossy(&line[1..]).trim_end_matches(['\n', '\r']).to_string();
        let place = |name: &str| -> Result<PathBuf> {
            match dirs.last() {
                None => Ok(target.to_path_buf()),
                Some(dir) => Ok(dir.join(local_component(name).with_context(|| format!("远程文件名无效: {}", name))?)),
            }
        };
        match line[0] {
            1 => warnings.push(text),
            2 => bail!("{}", text),
            b'T' => {
                let mut parts = text.split_whitespace().map(|p| p.parse::<u64>().unwrap_or(0));
                let mtime = parts.next().unwrap_or(0);
                let _ = parts.next();
                times = Some((mtime, parts.next().unwrap_or(mtime)));
                ok(s).await?;
            }
            b'D' => {
                let name = text.splitn(3, ' ').nth(2).unwrap_or("").to_string();
                let path = place(&name)?;
                std::fs::create_dir_all(&path).with_context(|| format!("无法创建文件夹 {}", path.display()))?;
                dirs.push(path);
                times = None;
                received = true;
                ok(s).await?;
            }
            b'E' => {
                dirs.pop();
                ok(s).await?;
            }
            b'C' => {
                let mut parts = text.splitn(3, ' ');
                let _mode = parts.next();
                let size: u64 = parts.next().and_then(|p| p.parse().ok()).context("SCP 协议错误（文件大小）")?;
                let name = parts.next().unwrap_or("").to_string();
                let path = place(&name)?;
                m.grow_total(size, 1);
                m.begin_file(&name);
                ok(s).await?;
                let part = part_path(&path);
                let mut file = tokio::fs::File::create(&part)
                    .await
                    .with_context(|| format!("无法写入 {}", path.display()))?;
                let mut left = size;
                let copied: Result<()> = async {
                    while left > 0 {
                        m.checkpoint().await?;
                        let want = (left as usize).min(CHUNK);
                        let n = s.read(&mut buf[..want]).await?;
                        if n == 0 {
                            bail!("SCP 连接意外关闭");
                        }
                        file.write_all(&buf[..n]).await?;
                        left -= n as u64;
                        m.add(n as u64);
                    }
                    file.flush().await?;
                    Ok(())
                }
                .await;
                drop(file);
                if let Err(e) = copied {
                    let _ = std::fs::remove_file(&part);
                    return Err(e);
                }
                read_ack(s).await?;
                std::fs::rename(&part, &path).with_context(|| format!("无法写入 {}", path.display()))?;
                if m.preserve_times {
                    if let Some((mtime, atime)) = times {
                        set_local_times(&path, Some(mtime), Some(atime));
                    }
                }
                times = None;
                received = true;
                m.end_file();
                ok(s).await?;
            }
            other => bail!("SCP 协议错误（消息 0x{:02x}）", other),
        }
    }
    if !received {
        bail!("{}", if warnings.is_empty() { "远程没有发送任何文件".to_string() } else { warnings.join("; ") });
    }
    Ok(())
}

/// What is at a remote path: (is_dir, size, mtime), None when nothing is.
async fn probe(link: &SshLink, path: &str) -> Option<(bool, u64, Option<u64>)> {
    let q = shell_quote(path);
    let script = format!("if [ -d {q} ]; then echo d; elif [ -e {q} ]; then echo f $(stat -c '%s %Y' {q} 2>/dev/null); fi");
    let out = link.exec_output(&script).await.ok()?;
    let mut parts = out.split_whitespace();
    match parts.next()? {
        "d" => Some((true, 0, None)),
        _ => Some((false, parts.next().and_then(|p| p.parse().ok()).unwrap_or(0), parts.next().and_then(|p| p.parse().ok()))),
    }
}

pub async fn upload(link: &SshLink, local: &Path, remote: &str, m: &mut Meter) -> Result<()> {
    let (dir, mut name) = split_remote(remote);
    let meta = std::fs::metadata(local).with_context(|| format!("无法读取 {}", local.display()))?;
    if let Some((dst_dir, dst_size, dst_mtime)) = probe(link, remote).await {
        // A folder merges into an existing folder (scp -r does that by itself).
        if !(dst_dir && meta.is_dir()) {
            let info = ConflictInfo {
                path: remote.to_string(),
                is_dir: dst_dir,
                src_size: meta.len(),
                src_mtime: unix_secs(meta.modified()),
                dst_size,
                dst_mtime,
            };
            match m.resolve(info).await? {
                Resolution::Skip => {
                    m.skip_file(if meta.is_dir() { 0 } else { meta.len() });
                    return Ok(());
                }
                Resolution::Overwrite if dst_dir != meta.is_dir() => bail!("目标 {} 已存在且类型不同，无法覆盖", remote),
                Resolution::Overwrite => {}
                Resolution::Rename => {
                    for n in 1..1000 {
                        let candidate = numbered_name(&name, n);
                        if probe(link, &crate::transfer::join_remote(&dir, &candidate)).await.is_none() {
                            name = candidate;
                            break;
                        }
                    }
                }
            }
        }
    }
    let cmd = format!(
        "scp {}{}-t {}",
        if meta.is_dir() { "-r " } else { "" },
        if m.preserve_times { "-p " } else { "" },
        shell_quote(&dir)
    );
    let ch = link.open_exec(&cmd).await?;
    let mut s = BufReader::new(ch.into_stream());
    send(&mut s, local, &name, m).await?;
    let _ = s.get_mut().shutdown().await;
    Ok(())
}

pub async fn download(link: &SshLink, remote: &str, local: &Path, m: &mut Meter) -> Result<()> {
    let (is_dir, size, mtime) = probe(link, remote).await.unwrap_or((false, 0, None));
    let Some(target) = resolve_local(local, size, mtime, is_dir, m).await? else {
        m.skip_file(size);
        return Ok(());
    };
    let cmd = format!("scp -r {}-f {}", if m.preserve_times { "-p " } else { "" }, shell_quote(remote));
    let ch = link.open_exec(&cmd).await?;
    let mut s = BufReader::new(ch.into_stream());
    receive(&mut s, &target, m).await
}

// ---------------------------------------------------------------------------------------
// Browsing without SFTP: POSIX shell commands on exec channels (busybox works too).

use crate::sftp::{Listing, RemoteEntry};

/// One line per entry: `raw mode hex|size|mtime|atime|uid|gid|user|group|name`, then
/// `L|target` and `D` (points to a folder) after links.
const LIST_SCRIPT: &str = r#"
show() {
  stat -c '%f|%s|%Y|%X|%u|%g|%U|%G|%n' -- "$1" 2>/dev/null || return 0
  if [ -L "$1" ]; then printf 'L|%s\n' "$(readlink -- "$1")"; [ -d "$1" ] && echo D; fi
  return 0
}
"#;

fn parse_listing(dir: &str, out: &str) -> Vec<RemoteEntry> {
    let mut entries: Vec<RemoteEntry> = Vec::new();
    for line in out.lines() {
        if let Some(target) = line.strip_prefix("L|") {
            if let Some(e) = entries.last_mut() {
                e.link_target = Some(target.to_string());
            }
            continue;
        }
        if line == "D" {
            if let Some(e) = entries.last_mut() {
                e.link_dir = true;
            }
            continue;
        }
        let parts: Vec<&str> = line.splitn(9, '|').collect();
        if parts.len() < 9 {
            continue;
        }
        let raw = u32::from_str_radix(parts[0], 16).unwrap_or(0);
        let kind = match raw & 0o170000 {
            0o040000 => "dir",
            0o120000 => "link",
            0o100000 => "file",
            _ => "other",
        };
        let name = parts[8].rsplit('/').next().unwrap_or(parts[8]).to_string();
        if name == "." || name == ".." {
            continue;
        }
        let num = |s: &str| s.parse::<u64>().ok();
        entries.push(RemoteEntry {
            path: crate::transfer::join_remote(dir, &name),
            name,
            kind: kind.into(),
            link_dir: false,
            link_target: None,
            size: num(parts[1]).unwrap_or(0),
            mtime: num(parts[2]),
            atime: num(parts[3]),
            mode: Some(raw & 0o7777),
            uid: parts[4].parse().ok(),
            gid: parts[5].parse().ok(),
            user: Some(parts[6].to_string()).filter(|u| u != "UNKNOWN"),
            group: Some(parts[7].to_string()).filter(|g| g != "UNKNOWN"),
        });
    }
    entries
}

pub async fn shell_home(link: &SshLink) -> Result<String> {
    Ok(link.exec_output("cd && pwd").await?.trim().to_string())
}

pub async fn shell_list(link: &SshLink, path: &str) -> Result<Listing> {
    let path = if path.trim().is_empty() { "." } else { path.trim() };
    let script = format!(
        "{LIST_SCRIPT}cd -- {} || exit 1\npwd\nfor f in .* *; do [ \"$f\" = . ] || [ \"$f\" = .. ] && continue; [ -e \"$f\" ] || [ -L \"$f\" ] || continue; show \"$f\"; done",
        shell_quote(path)
    );
    let out = link.exec_output(&script).await.with_context(|| format!("无法列出 {}", path))?;
    let (dir, rest) = out.split_once('\n').unwrap_or((out.as_str(), ""));
    let dir = dir.trim().to_string();
    Ok(Listing { entries: parse_listing(&dir, rest), path: dir, mode: "scp".into() })
}

pub async fn shell_stat(link: &SshLink, path: &str) -> Result<RemoteEntry> {
    let (dir, _) = split_remote(path);
    let out = link.exec_output(&format!("{LIST_SCRIPT}show {}", shell_quote(path))).await?;
    parse_listing(&dir, &out).into_iter().next().with_context(|| format!("{} 不存在", path))
}

/// A one-line shell command; `what` names it in errors.
async fn shell_run(link: &SshLink, script: String, what: String) -> Result<()> {
    link.exec_output(&script).await.map(|_| ()).context(what)
}

pub async fn shell_mkdir(link: &SshLink, path: &str) -> Result<()> {
    shell_run(link, format!("mkdir -- {}", shell_quote(path)), format!("无法创建文件夹 {}", path)).await
}

pub async fn shell_touch(link: &SshLink, path: &str) -> Result<()> {
    let q = shell_quote(path);
    shell_run(link, format!("if [ -e {q} ]; then echo exists >&2; exit 1; fi; : > {q}"), format!("无法创建文件 {}", path)).await
}

pub async fn shell_rename(link: &SshLink, from: &str, to: &str) -> Result<()> {
    let (f, t) = (shell_quote(from), shell_quote(to));
    shell_run(
        link,
        format!("if [ -e {t} ] || [ -L {t} ]; then echo exists >&2; exit 1; fi; mv -- {f} {t}"),
        format!("无法将 {} 移动到 {}", from, to),
    )
    .await
}

pub async fn shell_remove(link: &SshLink, path: &str) -> Result<()> {
    shell_run(link, format!("rm -rf -- {}", shell_quote(path)), format!("无法删除 {}", path)).await
}

pub async fn shell_chmod(link: &SshLink, path: &str, mode: u32) -> Result<()> {
    shell_run(link, format!("chmod {:o} -- {}", mode & 0o7777, shell_quote(path)), format!("无法修改 {} 的权限", path)).await
}

pub async fn shell_symlink(link: &SshLink, path: &str, target: &str) -> Result<()> {
    let p = shell_quote(path);
    shell_run(
        link,
        format!("if [ -e {p} ] || [ -L {p} ]; then echo exists >&2; exit 1; fi; ln -s -- {} {p}", shell_quote(target)),
        format!("无法创建符号链接 {}", path),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transfer::Policy;
    use std::collections::BTreeMap;
    use tokio::io::DuplexStream;

    fn temp(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("nx-scp-{}-{}", tag, uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    /// A minimal `scp -t`: records "path" -> contents, folders as "path/".
    async fn fake_sink(stream: DuplexStream) -> BTreeMap<String, Vec<u8>> {
        let mut s = BufReader::new(stream);
        let mut out = BTreeMap::new();
        let mut dirs: Vec<String> = Vec::new();
        s.get_mut().write_all(&[0]).await.unwrap();
        loop {
            let mut line = Vec::new();
            if s.read_until(b'\n', &mut line).await.unwrap() == 0 {
                break;
            }
            let text = String::from_utf8_lossy(&line[1..]).trim_end().to_string();
            let prefix = if dirs.is_empty() { String::new() } else { format!("{}/", dirs.join("/")) };
            match line[0] {
                b'T' => {}
                b'D' => {
                    let name = text.splitn(3, ' ').nth(2).unwrap().to_string();
                    out.insert(format!("{prefix}{name}/"), Vec::new());
                    dirs.push(name);
                }
                b'E' => {
                    dirs.pop();
                }
                b'C' => {
                    let mut parts = text.splitn(3, ' ');
                    let _ = parts.next();
                    let size: usize = parts.next().unwrap().parse().unwrap();
                    let name = parts.next().unwrap().to_string();
                    s.get_mut().write_all(&[0]).await.unwrap();
                    let mut data = vec![0u8; size];
                    s.read_exact(&mut data).await.unwrap();
                    let mut end = [0u8; 1];
                    s.read_exact(&mut end).await.unwrap();
                    out.insert(format!("{prefix}{name}"), data);
                }
                _ => panic!("unexpected {:?}", line),
            }
            s.get_mut().write_all(&[0]).await.unwrap();
        }
        out
    }

    #[test]
    fn uploads_a_folder() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let root = temp("up");
        std::fs::create_dir_all(root.join("dir/sub")).unwrap();
        std::fs::write(root.join("dir/a.txt"), b"hello").unwrap();
        std::fs::write(root.join("dir/sub/b.bin"), vec![7u8; 300_000]).unwrap();
        let got = rt.block_on(async {
            let (ours, theirs) = tokio::io::duplex(64 * 1024);
            let sink = tokio::spawn(fake_sink(theirs));
            let mut m = Meter::detached(Policy::Overwrite, true);
            let mut s = BufReader::new(ours);
            send(&mut s, &root.join("dir"), "renamed", &mut m).await.unwrap();
            assert_eq!((m.transferred, m.files_done), (300_005, 2));
            drop(s);
            sink.await.unwrap()
        });
        assert_eq!(got.keys().cloned().collect::<Vec<_>>(), ["renamed/", "renamed/a.txt", "renamed/sub/", "renamed/sub/b.bin"]);
        assert_eq!(got["renamed/a.txt"], b"hello");
        assert_eq!(got["renamed/sub/b.bin"].len(), 300_000);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn downloads_a_folder_with_times() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let root = temp("down");
        let target = root.join("local-name");
        rt.block_on(async {
            let (ours, theirs) = tokio::io::duplex(64 * 1024);
            let source = tokio::spawn(async move {
                let mut s = BufReader::new(theirs);
                read_ack(&mut s).await.unwrap();
                for msg in ["T1600000000 0 1600000000 0\n", "D0755 0 remote-name\n", "T1500000000 0 1500000001 0\n", "C0644 3 x.txt\n"] {
                    s.get_mut().write_all(msg.as_bytes()).await.unwrap();
                    read_ack(&mut s).await.unwrap();
                }
                s.get_mut().write_all(b"abc\0").await.unwrap();
                read_ack(&mut s).await.unwrap();
                // A bad name from the server must not escape the target folder.
                s.get_mut().write_all(b"C0644 1 ../evil\n").await.unwrap();
                read_ack(&mut s).await.unwrap();
                s.get_mut().write_all(b"z\0").await.unwrap();
                read_ack(&mut s).await.unwrap();
                s.get_mut().write_all(b"E\n").await.unwrap();
                read_ack(&mut s).await.unwrap();
            });
            let mut m = Meter::detached(Policy::Overwrite, true);
            let mut s = BufReader::new(ours);
            receive(&mut s, &target, &mut m).await.unwrap();
            source.await.unwrap();
            assert_eq!(m.files_done, 2);
        });
        assert_eq!(std::fs::read(target.join("x.txt")).unwrap(), b"abc");
        assert_eq!(std::fs::read(target.join(".._evil")).unwrap(), b"z");
        let mtime = std::fs::metadata(target.join("x.txt")).unwrap().modified().unwrap();
        assert_eq!(unix_secs(Ok(mtime)), Some(1_500_000_000));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn parses_a_shell_listing() {
        let out = "41ed|4096|1700000000|1700000001|0|0|root|root|etc\n\
                   81a4|12|1600000000|1600000000|1000|1000|me|UNKNOWN|a|b.txt\n\
                   a1ff|7|1|1|0|0|root|root|lib\nL|usr/lib\nD\n";
        let list = parse_listing("/", out);
        assert_eq!(list.len(), 3);
        assert_eq!((list[0].kind.as_str(), list[0].mode, list[0].path.as_str()), ("dir", Some(0o755), "/etc"));
        // `|` inside a name is kept (the name is the last field).
        assert_eq!((list[1].name.as_str(), list[1].size, list[1].group.as_deref()), ("a|b.txt", 12, None));
        assert_eq!((list[2].kind.as_str(), list[2].link_dir, list[2].link_target.as_deref()), ("link", true, Some("usr/lib")));
    }

    #[test]
    fn reports_the_remote_error() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let root = temp("err");
        let err = rt.block_on(async {
            let (ours, theirs) = tokio::io::duplex(1024);
            tokio::spawn(async move {
                let mut s = BufReader::new(theirs);
                read_ack(&mut s).await.unwrap();
                s.get_mut().write_all(b"\x01scp: /nope: No such file or directory\n").await.unwrap();
            });
            let mut m = Meter::detached(Policy::Overwrite, false);
            receive(&mut BufReader::new(ours), &root.join("x"), &mut m).await.unwrap_err()
        });
        assert!(err.to_string().contains("No such file"), "{err}");
        std::fs::remove_dir_all(root).unwrap();
    }
}
