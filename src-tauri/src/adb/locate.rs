//! Finding adb.exe (only needed to start the server and to pair over WLAN), and fetching
//! Google's platform-tools when the machine has none. Not bundled: the platform-tools
//! license does not allow redistributing it in our installer.

use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde::Serialize;

const DOWNLOAD_URL: &str = "https://dl.google.com/android/repository/platform-tools-latest-windows.zip";

/// `settings.extra.adbPath` (machine-local, not synced).
static CONFIGURED: RwLock<String> = RwLock::new(String::new());

pub fn configure(path: &str) {
    if let Ok(mut p) = CONFIGURED.write() {
        *p = path.trim().to_string();
    }
}

fn exe_name() -> &'static str {
    if cfg!(windows) {
        "adb.exe"
    } else {
        "adb"
    }
}

/// Where we put a downloaded copy.
pub fn download_dir() -> PathBuf {
    crate::app_paths::data_dir().join("platform-tools")
}

/// Candidates in order: the setting, our download, PATH, the SDK variables, Android
/// Studio's default SDK folder.
fn candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let configured = CONFIGURED.read().map(|p| p.clone()).unwrap_or_default();
    if !configured.is_empty() {
        let p = PathBuf::from(&configured);
        out.push(if p.is_dir() { p.join(exe_name()) } else { p });
    }
    out.push(download_dir().join(exe_name()));
    if let Some(path) = std::env::var_os("PATH") {
        out.extend(std::env::split_paths(&path).map(|d| d.join(exe_name())));
    }
    for var in ["ANDROID_HOME", "ANDROID_SDK_ROOT"] {
        if let Some(root) = std::env::var_os(var) {
            out.push(Path::new(&root).join("platform-tools").join(exe_name()));
        }
    }
    if let Some(local) = dirs::data_local_dir() {
        out.push(local.join("Android").join("Sdk").join("platform-tools").join(exe_name()));
    }
    out
}

pub fn find() -> Option<PathBuf> {
    candidates().into_iter().find(|p| p.is_file())
}

fn command(exe: &Path) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(exe);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    cmd.stdin(std::process::Stdio::null());
    cmd
}

/// Run adb.exe with `args`; stdout + stderr, or an error with them when it failed.
pub async fn run(args: &[&str], timeout: Duration) -> Result<String> {
    let exe = find().context("找不到 adb.exe：请在设置里指定路径，或下载 Android platform-tools")?;
    let out = tokio::time::timeout(timeout, command(&exe).args(args).kill_on_drop(true).output())
        .await
        .with_context(|| format!("adb {} 超时", args.first().unwrap_or(&"")))?
        .with_context(|| format!("无法运行 {}", exe.display()))?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    if !out.status.success() {
        bail!("{}", text.trim());
    }
    Ok(text.trim().to_string())
}

/// `adb start-server` (the daemon keeps running after we exit, as with Android Studio).
pub async fn start_server() -> Result<()> {
    run(&["start-server"], Duration::from_secs(20)).await.context("无法启动 adb server")?;
    Ok(())
}

/// Android 11+ wireless debugging: pair with the code shown on the phone. The pairing
/// handshake (SPAKE2 + TLS) is left to adb itself.
pub async fn pair(addr: &str, code: &str) -> Result<String> {
    let addr = addr.trim();
    let code = code.trim();
    if addr.is_empty() || !code.chars().all(|c| c.is_ascii_digit()) || code.is_empty() {
        bail!("请填写配对地址（IP:端口）和 6 位配对码");
    }
    let out = run(&["pair", addr, code], Duration::from_secs(30)).await?;
    if out.contains("Successfully paired") {
        Ok(out)
    } else {
        bail!("{}", out)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdbStatus {
    /// adb.exe found (None: offer the download).
    pub path: Option<String>,
    /// A server is listening on 5037 (its protocol version).
    pub server_version: Option<u32>,
}

pub async fn status() -> AdbStatus {
    AdbStatus {
        path: find().map(|p| p.display().to_string()),
        server_version: super::client::running_version().await,
    }
}

/// Download platform-tools into `<data>/platform-tools`. `progress(received, total)`.
pub async fn download(progress: impl Fn(u64, u64)) -> Result<PathBuf> {
    let client = crate::http_proxy::apply(reqwest::Client::builder())
        .connect_timeout(Duration::from_secs(20))
        .build()?;
    let mut resp = client
        .get(DOWNLOAD_URL)
        .send()
        .await
        .context("无法下载 platform-tools")?
        .error_for_status()
        .context("无法下载 platform-tools")?;
    let total = resp.content_length().unwrap_or(0);
    let mut data = Vec::with_capacity(total as usize);
    while let Some(chunk) = resp.chunk().await.context("下载中断")? {
        data.extend_from_slice(&chunk);
        progress(data.len() as u64, total);
    }
    let dest = download_dir();
    let staging = dest.with_extension("part");
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging)?;
    extract(&data, &staging)?;
    if !staging.join(exe_name()).is_file() {
        let _ = std::fs::remove_dir_all(&staging);
        bail!("下载的压缩包里没有 {}", exe_name());
    }
    // A running adb.exe from an older download keeps its files locked: leave it be then.
    if dest.exists() && std::fs::remove_dir_all(&dest).is_err() {
        let _ = run(&["kill-server"], Duration::from_secs(10)).await;
        std::fs::remove_dir_all(&dest).context("旧的 platform-tools 正在使用，无法替换")?;
    }
    std::fs::rename(&staging, &dest)?;
    Ok(dest.join(exe_name()))
}

/// The zip has everything under `platform-tools/`; that prefix is dropped.
fn extract(data: &[u8], dest: &Path) -> Result<()> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(data)).context("压缩包已损坏")?;
    for i in 0..zip.len() {
        let mut file = zip.by_index(i)?;
        let Some(rel) = file.enclosed_name() else { continue };
        let rel: PathBuf = rel.components().skip(1).collect();
        if rel.as_os_str().is_empty() {
            continue;
        }
        let out = dest.join(&rel);
        if file.is_dir() {
            std::fs::create_dir_all(&out)?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut w = std::fs::File::create(&out)?;
        std::io::copy(&mut file, &mut w)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn extract_drops_top_folder() {
        let mut buf = Vec::new();
        {
            let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opts = zip::write::SimpleFileOptions::default();
            w.add_directory("platform-tools/", opts).unwrap();
            w.start_file("platform-tools/adb.exe", opts).unwrap();
            w.write_all(b"MZ").unwrap();
            w.start_file("platform-tools/lib64/x", opts).unwrap();
            w.write_all(b"1").unwrap();
            w.finish().unwrap();
        }
        let dir = tempfile::tempdir().unwrap();
        extract(&buf, dir.path()).unwrap();
        assert_eq!(std::fs::read(dir.path().join("adb.exe")).unwrap(), b"MZ");
        assert!(dir.path().join("lib64").join("x").is_file());
    }
}
