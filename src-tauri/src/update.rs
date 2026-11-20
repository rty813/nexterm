//! Update check and installer against the GitHub Releases of the project.
//!
//! The newest published (non-draft, non-prerelease) release is compared with this build's
//! version. Where this copy was installed by the NSIS setup or the MSI, or runs as the plain
//! exe, the matching asset of the release is downloaded (checked against the SHA-256 GitHub
//! lists for it), then the setup runs and restarts the app, or the exe replaces this one.
//! Otherwise (a dev build, another OS) the frontend opens the release page instead.

use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const LATEST_URL: &str = "https://api.github.com/repos/rty813/nexterm/releases/latest";
const RELEASES_PAGE: &str = "https://github.com/rty813/nexterm/releases/latest";
/// Release notes as HTML, not subject to the API's rate limit.
const RELEASES_FEED: &str = "https://github.com/rty813/nexterm/releases.atom";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// This build's version, e.g. "0.1.2".
    pub current: String,
    /// Newest release's version without the leading "v".
    pub latest: String,
    /// The newest release is newer than this build.
    pub available: bool,
    /// Release page to open in the browser.
    pub url: String,
    /// Release notes (markdown), possibly empty.
    pub notes: String,
    pub published_at: Option<String>,
    /// The update can be downloaded and installed from the app.
    pub can_install: bool,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
struct Asset {
    name: String,
    browser_download_url: String,
    /// Bytes; 0 when unknown.
    #[serde(default)]
    size: u64,
    /// "sha256:<hex>" (GitHub fills it in for newer uploads).
    #[serde(default)]
    digest: Option<String>,
}

/// How this copy of the app was installed, which decides the asset and how it is applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallKind {
    /// NSIS setup (`uninstall.exe` next to the exe).
    Nsis,
    /// MSI (under Program Files without the NSIS uninstaller).
    Msi,
    /// The plain `nexterm.exe` anywhere else.
    Portable,
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    #[serde(default)]
    html_url: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<Asset>,
}

/// What the last check found to install, for `download` / `apply`.
struct Pending {
    version: String,
    kind: InstallKind,
    asset: Asset,
    /// Downloaded and verified file.
    file: Option<PathBuf>,
}

fn pending() -> &'static Mutex<Option<Pending>> {
    static P: Mutex<Option<Pending>> = Mutex::new(None);
    &P
}

/// "v1.2.3" / "1.2.3-beta.1" -> numeric parts and pre-release tag.
fn parse_version(s: &str) -> Option<(Vec<u64>, Option<String>)> {
    let s = s.trim().trim_start_matches(['v', 'V']);
    let s = s.split('+').next().unwrap_or(s);
    let (core, pre) = match s.split_once('-') {
        Some((c, p)) => (c, Some(p.to_string())),
        None => (s, None),
    };
    let nums = core.split('.').map(|p| p.parse::<u64>().ok()).collect::<Option<Vec<_>>>()?;
    if nums.is_empty() {
        return None;
    }
    Some((nums, pre))
}

/// Semver-like comparison; `None` when either side is not a version.
pub fn compare_versions(a: &str, b: &str) -> Option<Ordering> {
    let (an, ap) = parse_version(a)?;
    let (bn, bp) = parse_version(b)?;
    let len = an.len().max(bn.len());
    for i in 0..len {
        let (x, y) = (an.get(i).copied().unwrap_or(0), bn.get(i).copied().unwrap_or(0));
        match x.cmp(&y) {
            Ordering::Equal => {}
            o => return Some(o),
        }
    }
    // A release ranks above its own pre-releases.
    Some(match (ap, bp) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(x), Some(y)) => x.cmp(&y),
    })
}

fn info_from(release: Release, current: &str) -> Result<UpdateInfo, String> {
    let latest = release.tag_name.trim().trim_start_matches(['v', 'V']).to_string();
    let newer = compare_versions(&latest, current).ok_or_else(|| format!("无法识别的版本号：{}", release.tag_name))?;
    Ok(UpdateInfo {
        current: current.to_string(),
        available: newer == Ordering::Greater && !release.draft && !release.prerelease,
        latest,
        url: release.html_url.filter(|u| u.starts_with("https://")).unwrap_or_else(|| RELEASES_PAGE.to_string()),
        notes: release.body.unwrap_or_default(),
        published_at: release.published_at,
        can_install: false,
    })
}

/// The installation of the running exe; `None` for dev builds and other systems.
pub fn install_kind() -> Option<InstallKind> {
    if cfg!(debug_assertions) || !cfg!(windows) {
        return None;
    }
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let program_files: Vec<PathBuf> = ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]
        .iter()
        .filter_map(|v| std::env::var_os(v).map(PathBuf::from))
        .collect();
    Some(classify(dir, dir.join("uninstall.exe").is_file(), &program_files))
}

fn classify(dir: &Path, has_uninstaller: bool, program_files: &[PathBuf]) -> InstallKind {
    let lower = |p: &Path| p.to_string_lossy().to_lowercase().trim_end_matches(['\\', '/']).to_string();
    let d = format!("{}\\", lower(dir));
    if has_uninstaller {
        InstallKind::Nsis
    } else if program_files.iter().map(|p| lower(p)).any(|p| !p.is_empty() && d.starts_with(&format!("{p}\\"))) {
        InstallKind::Msi
    } else {
        InstallKind::Portable
    }
}

/// The release asset that updates an installation of `kind` (x64 builds preferred).
fn pick_asset(kind: InstallKind, assets: &[Asset]) -> Option<&Asset> {
    let found: Vec<&Asset> = assets
        .iter()
        .filter(|a| {
            let n = a.name.to_lowercase();
            match kind {
                InstallKind::Nsis => n.ends_with("-setup.exe"),
                InstallKind::Msi => n.ends_with(".msi"),
                InstallKind::Portable => n == "nexterm.exe",
            }
        })
        .collect();
    found.iter().copied().find(|a| a.name.to_lowercase().contains("x64")).or_else(|| found.first().copied())
}

/// Asset names the CI release uploads (tauri's bundle names), for when only the tag is known.
fn guessed_assets(tag: &str) -> Vec<Asset> {
    let v = tag.trim_start_matches(['v', 'V']);
    [format!("Nexterm_{v}_x64-setup.exe"), format!("Nexterm_{v}_x64_en-US.msi"), "nexterm.exe".to_string()]
        .into_iter()
        .map(|name| Asset {
            browser_download_url: format!("https://github.com/rty813/nexterm/releases/download/{tag}/{name}"),
            name,
            size: 0,
            digest: None,
        })
        .collect()
}

/// reqwest's message plus its causes ("error sending request: ... connection reset").
fn describe(e: reqwest::Error) -> String {
    let mut out = e.to_string();
    let mut src = std::error::Error::source(&e);
    while let Some(s) = src {
        out.push_str(": ");
        out.push_str(&s.to_string());
        src = s.source();
    }
    out
}

fn client(redirects: bool) -> Result<reqwest::Client, String> {
    crate::http_proxy::apply(reqwest::Client::builder())
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(10))
        .user_agent(concat!("Nexterm/", env!("CARGO_PKG_VERSION")))
        .redirect(if redirects { reqwest::redirect::Policy::limited(5) } else { reqwest::redirect::Policy::none() })
        .build()
        .map_err(|e| e.to_string())
}

/// Release (with notes) from the GitHub API.
async fn from_api() -> Result<Release, String> {
    let resp = client(true)?
        .get(LATEST_URL)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(describe)?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    resp.json().await.map_err(describe)
}

/// ".../releases/tag/v0.1.3" -> "v0.1.3".
fn tag_from_location(location: &str) -> Option<String> {
    let tag = location.split("/releases/tag/").nth(1)?.split(['?', '#']).next()?;
    (!tag.is_empty()).then(|| tag.to_string())
}

/// Tag only, from where the "latest release" page redirects (no API rate limit).
async fn from_redirect() -> Result<Release, String> {
    let resp = client(false)?.get(RELEASES_PAGE).send().await.map_err(describe)?;
    let location = resp
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| format!("HTTP {}", resp.status()))?;
    let tag = tag_from_location(location).ok_or_else(|| format!("没有找到发布版本：{location}"))?;
    Ok(Release {
        html_url: Some(format!("https://github.com/rty813/nexterm/releases/tag/{tag}")),
        assets: guessed_assets(&tag),
        tag_name: tag,
        body: None,
        published_at: None,
        draft: false,
        prerelease: false,
    })
}

/// Decodes the XML / HTML character references used by GitHub's feed.
fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let Some(end) = rest.bytes().take(12).position(|b| b == b';') else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let name = &rest[1..end];
        let ch = match name {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some(' '),
            _ => name
                .strip_prefix("#x")
                .or_else(|| name.strip_prefix("#X"))
                .and_then(|h| u32::from_str_radix(h, 16).ok())
                .or_else(|| name.strip_prefix('#').and_then(|d| d.parse().ok()))
                .and_then(char::from_u32),
        };
        match ch {
            Some(c) => {
                out.push(c);
                rest = &rest[end + 1..];
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

/// GitHub's rendered release notes -> the markdown subset the dialog shows
/// (headings, list items, line breaks, **bold**, `code`; images and link targets dropped).
fn html_to_markdown(html: &str) -> String {
    use regex::Regex;
    use std::sync::OnceLock;
    static RULES: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    let rules = RULES.get_or_init(|| {
        [
            (r"\s*\n\s*", " "),
            (r"(?i)<br\s*/?>\s*", "\n"),
            (r"(?i)<h[12][^>]*>", "\n\n## "),
            (r"(?i)<h[3-6][^>]*>", "\n\n### "),
            (r"(?i)<li[^>]*>", "\n- "),
            (r"(?i)</(h[1-6]|p|ul|ol|li|div|blockquote)>", "\n"),
            (r"(?i)<(p|ul|ol|div|blockquote)(\s[^>]*)?>", "\n\n"),
            (r"(?i)</?(strong|b)>", "**"),
            (r"(?i)</?(code|tt)>", "`"),
            (r"(?i)<img[^>]*>", ""),
            (r"<[^>]*>", ""),
            (r"[ \t]+\n", "\n"),
            (r"\n{3,}", "\n\n"),
        ]
        .into_iter()
        .map(|(p, r)| (Regex::new(p).unwrap(), r))
        .collect()
    });
    let mut s = html.to_string();
    for (re, rep) in rules {
        s = re.replace_all(&s, *rep).into_owned();
    }
    decode_entities(s.trim())
}

/// The notes of release `tag` from the Atom feed (the feed lists recent releases only).
fn notes_from_feed(feed: &str, tag: &str) -> Option<String> {
    let suffix = format!("/releases/tag/{tag}\"");
    feed.split("<entry>").skip(1).find(|e| e.contains(&suffix)).and_then(|entry| {
        let start = entry.find("<content")?;
        let body = &entry[start..];
        let body = &body[body.find('>')? + 1..body.find("</content>")?];
        Some(html_to_markdown(&decode_entities(body)))
    })
}

async fn feed_notes(tag: &str) -> Result<String, String> {
    let resp = client(true)?.get(RELEASES_FEED).send().await.map_err(describe)?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let feed = resp.text().await.map_err(describe)?;
    notes_from_feed(&feed, tag).ok_or_else(|| format!("{tag} not in feed"))
}

pub async fn check() -> Result<UpdateInfo, String> {
    // The API allows 60 unauthenticated requests per hour per IP, which a shared
    // network can use up; the release page redirect still gives the version, and
    // the releases feed its notes.
    let mut release = match from_api().await {
        Ok(r) => r,
        Err(api_err) => {
            let mut r = from_redirect().await.map_err(|e| format!("{api_err}; {e}"))?;
            if compare_versions(&r.tag_name, env!("CARGO_PKG_VERSION")) == Some(Ordering::Greater) {
                r.body = feed_notes(&r.tag_name).await.ok();
            }
            r
        }
    };
    let assets = std::mem::take(&mut release.assets);
    let mut info = info_from(release, env!("CARGO_PKG_VERSION"))?;
    let install = install_kind()
        .filter(|_| info.available)
        .and_then(|kind| Some((kind, pick_asset(kind, &assets)?.clone())));
    let mut slot = pending().lock().map_err(|e| e.to_string())?;
    match install {
        Some((kind, asset)) => {
            info.can_install = true;
            // A file already downloaded for this version is kept.
            let same = slot.as_ref().is_some_and(|p| p.version == info.latest && p.asset.name == asset.name);
            if !same {
                *slot = Some(Pending { version: info.latest.clone(), kind, asset, file: None });
            }
        }
        None => *slot = None,
    }
    Ok(info)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub received: u64,
    /// 0 when the size is not known.
    pub total: u64,
}

fn download_dir() -> PathBuf {
    std::env::temp_dir().join("nexterm-update")
}

/// "sha256:<hex>" -> lowercase hex.
fn sha256_of(digest: &Option<String>) -> Option<String> {
    digest.as_deref()?.strip_prefix("sha256:").map(|h| h.trim().to_ascii_lowercase())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The downloaded bytes are the asset: size and SHA-256 where GitHub gives them, and the file
/// format (a Windows exe starts with "MZ", an MSI is an OLE compound file).
fn verify(asset: &Asset, size: u64, sha256: &str, head: &[u8]) -> Result<(), String> {
    if asset.size > 0 && size != asset.size {
        return Err(format!("下载不完整（{size} / {} 字节）", asset.size));
    }
    if let Some(want) = sha256_of(&asset.digest) {
        if want != sha256 {
            return Err(format!("校验失败：SHA-256 不符（{sha256}）"));
        }
    }
    let msi = asset.name.to_lowercase().ends_with(".msi");
    let ok = if msi {
        head.starts_with(&[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1])
    } else {
        head.starts_with(b"MZ")
    };
    if !ok {
        return Err("下载的文件不是安装包".into());
    }
    Ok(())
}

fn verify_file(asset: &Asset, path: &Path) -> Result<(), String> {
    let data = std::fs::read(path).map_err(|e| e.to_string())?;
    let sum = hex(ring::digest::digest(&ring::digest::SHA256, &data).as_ref());
    verify(asset, data.len() as u64, &sum, &data[..data.len().min(16)])
}

static CANCEL: AtomicBool = AtomicBool::new(false);

/// The error `download` returns when `cancel` stopped it (the frontend shows no error for it).
pub const CANCELLED: &str = "cancelled";

/// Stops a download in progress; its partial file is removed.
pub fn cancel() {
    CANCEL.store(true, AtomicOrdering::Relaxed);
}

/// Downloads the update the last check found, reporting progress; a file already downloaded
/// (and still matching) is used as is.
pub async fn download(on_progress: impl Fn(Progress)) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    CANCEL.store(false, AtomicOrdering::Relaxed);
    let asset = {
        let slot = pending().lock().map_err(|e| e.to_string())?;
        let p = slot.as_ref().ok_or("没有可安装的更新")?;
        if let Some(file) = &p.file {
            if verify_file(&p.asset, file).is_ok() {
                return Ok(());
            }
        }
        p.asset.clone()
    };
    if !asset.browser_download_url.starts_with("https://") {
        return Err("下载地址无效".into());
    }
    let name = Path::new(&asset.name).file_name().ok_or("文件名无效")?.to_string_lossy().to_string();
    let dir = download_dir();
    tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
    let target = dir.join(&name);
    let part = dir.join(format!("{name}.part"));

    let client = crate::http_proxy::apply(reqwest::Client::builder())
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(60))
        .user_agent(concat!("Nexterm/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;
    let mut resp = client.get(&asset.browser_download_url).send().await.map_err(describe)?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let total = if asset.size > 0 { asset.size } else { resp.content_length().unwrap_or(0) };
    let mut file = tokio::fs::File::create(&part).await.map_err(|e| e.to_string())?;
    let mut ctx = ring::digest::Context::new(&ring::digest::SHA256);
    let mut head = Vec::with_capacity(16);
    let mut received = 0u64;
    let mut last = Instant::now();
    on_progress(Progress { received, total });
    let result: Result<(), String> = async {
        while let Some(chunk) = resp.chunk().await.map_err(describe)? {
            if CANCEL.load(AtomicOrdering::Relaxed) {
                return Err(CANCELLED.to_string());
            }
            if head.len() < 16 {
                head.extend_from_slice(&chunk[..chunk.len().min(16 - head.len())]);
            }
            ctx.update(&chunk);
            file.write_all(&chunk).await.map_err(|e| e.to_string())?;
            received += chunk.len() as u64;
            if last.elapsed() >= Duration::from_millis(150) {
                last = Instant::now();
                on_progress(Progress { received, total });
            }
        }
        file.flush().await.map_err(|e| e.to_string())?;
        verify(&asset, received, &hex(ctx.finish().as_ref()), &head)
    }
    .await;
    drop(file);
    if let Err(e) = result {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(e);
    }
    on_progress(Progress { received, total });
    let _ = tokio::fs::remove_file(&target).await;
    tokio::fs::rename(&part, &target).await.map_err(|e| e.to_string())?;
    let mut slot = pending().lock().map_err(|e| e.to_string())?;
    match slot.as_mut() {
        Some(p) if p.asset == asset => p.file = Some(target),
        _ => return Err("更新已变化，请重新检查".into()),
    }
    Ok(())
}

/// Starts the downloaded update; the caller quits the app right after. The setup / MSI
/// replaces the installed files and starts the new version; the plain exe is swapped in place
/// and started once this process has exited.
pub fn apply() -> Result<(), String> {
    let slot = pending().lock().map_err(|e| e.to_string())?;
    let p = slot.as_ref().ok_or("没有可安装的更新")?;
    let file = p.file.as_ref().ok_or("更新还没有下载")?;
    verify_file(&p.asset, file)?;
    let path = file.to_string_lossy().to_string();
    match p.kind {
        // /P: passive (progress only), /R: start the app when done, /UPDATE: an update, not a new install.
        InstallKind::Nsis => shell_execute(&path, "/P /R /UPDATE"),
        InstallKind::Msi => shell_execute("msiexec.exe", &format!("/i \"{path}\" /passive AUTOLAUNCHAPP=True")),
        InstallKind::Portable => replace_exe(file),
    }
}

/// Runs a program the way Explorer does, so a setup that needs elevation gets the UAC prompt.
#[cfg(windows)]
fn shell_execute(program: &str, args: &str) -> Result<(), String> {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let (verb, file, params) = (wide("open"), wide(program), wide(args));
    let code = unsafe {
        ShellExecuteW(0, verb.as_ptr(), file.as_ptr(), params.as_ptr(), std::ptr::null(), SW_SHOWNORMAL as i32)
    };
    // ShellExecute returns a value > 32 on success.
    if code as isize <= 32 {
        return Err(format!("无法启动安装程序（错误 {}）", code as isize));
    }
    Ok(())
}

#[cfg(not(windows))]
fn shell_execute(_program: &str, _args: &str) -> Result<(), String> {
    Err("只支持 Windows".into())
}

/// The running exe can be renamed but not overwritten: it moves aside to `<exe>.old` (removed
/// at the next start), the new one takes its name, and a hidden PowerShell starts it once this
/// process has exited (before that, the single-instance check would hand it back to us).
fn replace_exe(new_exe: &Path) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let old = old_exe_path(&exe);
    let _ = std::fs::remove_file(&old);
    std::fs::rename(&exe, &old).map_err(|e| format!("无法替换程序文件：{e}"))?;
    if let Err(e) = std::fs::copy(new_exe, &exe) {
        let _ = std::fs::remove_file(&exe);
        let _ = std::fs::rename(&old, &exe);
        return Err(format!("无法写入新版本：{e}"));
    }
    let script = format!(
        "Wait-Process -Id {} -ErrorAction SilentlyContinue; Start-Process -FilePath '{}'",
        std::process::id(),
        exe.to_string_lossy().replace('\'', "''")
    );
    let mut cmd = std::process::Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &script]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.spawn().map_err(|e| format!("无法重新启动：{e}"))?;
    Ok(())
}

fn old_exe_path(exe: &Path) -> PathBuf {
    let mut s = exe.as_os_str().to_owned();
    s.push(".old");
    PathBuf::from(s)
}

/// At startup: the exe a portable update replaced, and installers from earlier updates.
pub fn cleanup() {
    if let Ok(exe) = std::env::current_exe() {
        let _ = std::fs::remove_file(old_exe_path(&exe));
    }
    let _ = std::fs::remove_dir_all(download_dir());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_versions() {
        assert_eq!(compare_versions("v0.1.3", "0.1.2"), Some(Ordering::Greater));
        assert_eq!(compare_versions("0.1.2", "0.1.2"), Some(Ordering::Equal));
        assert_eq!(compare_versions("0.1.10", "0.1.9"), Some(Ordering::Greater));
        assert_eq!(compare_versions("1.0", "1.0.0"), Some(Ordering::Equal));
        assert_eq!(compare_versions("0.2.0", "0.10.0"), Some(Ordering::Less));
        assert_eq!(compare_versions("1.0.0-beta.1", "1.0.0"), Some(Ordering::Less));
        assert_eq!(compare_versions("1.0.0+build5", "1.0.0"), Some(Ordering::Equal));
        assert_eq!(compare_versions("nightly", "1.0.0"), None);
    }

    #[test]
    fn reads_tag_from_redirect() {
        assert_eq!(tag_from_location("https://github.com/rty813/nexterm/releases/tag/v0.1.3").as_deref(), Some("v0.1.3"));
        assert_eq!(tag_from_location("/rty813/nexterm/releases/tag/v1.0.0?x=1").as_deref(), Some("v1.0.0"));
        assert_eq!(tag_from_location("https://github.com/rty813/nexterm/releases"), None);
    }

    /// Hits the network: `cargo test --lib update::tests::live -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        println!("{:?}", rt.block_on(check()));
        println!("{:?}", rt.block_on(from_redirect()).map(|r| r.tag_name));
        println!("{}", rt.block_on(feed_notes("v0.1.3")).unwrap());
    }

    #[test]
    fn reads_notes_from_feed() {
        let feed = r#"<feed><title>Release notes</title>
  <entry>
    <link rel="alternate" type="text/html" href="https://github.com/rty813/nexterm/releases/tag/v0.1.4"/>
    <content type="html">&lt;h2&gt;新功能 / What&amp;#39;s new&lt;/h2&gt;
&lt;ul&gt;
&lt;li&gt;&lt;strong&gt;数据解释器&lt;/strong&gt;：A &amp;amp; B &lt;code&gt;x&lt;/code&gt;。&lt;br&gt;
&lt;strong&gt;Data interpreter&lt;/strong&gt;: a &amp;lt;b&amp;gt;.&lt;/li&gt;
&lt;/ul&gt;
&lt;p&gt;&lt;a href=&quot;https://x/a.jpg&quot;&gt;&lt;img src=&quot;https://x/a.jpg&quot; alt=&quot;pic&quot;&gt;&lt;/a&gt;&lt;/p&gt;
&lt;p&gt;&lt;strong&gt;Full Changelog&lt;/strong&gt;: &lt;a href=&quot;https://x&quot;&gt;&lt;tt&gt;v0.1.3...v0.1.4&lt;/tt&gt;&lt;/a&gt;&lt;/p&gt;</content>
  </entry>
  <entry>
    <link rel="alternate" type="text/html" href="https://github.com/rty813/nexterm/releases/tag/v0.1.3"/>
    <content type="html">&lt;p&gt;old&lt;/p&gt;</content>
  </entry>
</feed>"#;
        assert_eq!(
            notes_from_feed(feed, "v0.1.4").unwrap(),
            "## 新功能 / What's new\n\n- **数据解释器**：A & B `x`。\n**Data interpreter**: a <b>.\n\n**Full Changelog**: `v0.1.3...v0.1.4`"
        );
        assert_eq!(notes_from_feed(feed, "v0.1.3").unwrap(), "old");
        assert_eq!(notes_from_feed(feed, "v0.1.2"), None);
    }

    fn release(tag: &str) -> Release {
        Release {
            tag_name: tag.into(),
            html_url: Some("https://github.com/rty813/nexterm/releases/tag/v9".into()),
            body: Some("notes".into()),
            published_at: None,
            draft: false,
            prerelease: false,
            assets: Vec::new(),
        }
    }

    fn asset(name: &str) -> Asset {
        Asset { name: name.into(), browser_download_url: format!("https://x/{name}"), size: 0, digest: None }
    }

    #[test]
    fn classifies_installations() {
        let pf = [PathBuf::from(r"C:\Program Files"), PathBuf::from(r"C:\Program Files (x86)\")];
        let at = |d: &str, uninstaller: bool| classify(Path::new(d), uninstaller, &pf);
        assert_eq!(at(r"C:\Users\me\AppData\Local\Nexterm", true), InstallKind::Nsis);
        assert_eq!(at(r"C:\Program Files\Nexterm", true), InstallKind::Nsis);
        assert_eq!(at(r"C:\Program Files\Nexterm", false), InstallKind::Msi);
        assert_eq!(at(r"c:\program files (x86)\Nexterm", false), InstallKind::Msi);
        assert_eq!(at(r"C:\Program Files Tools\Nexterm", false), InstallKind::Portable);
        assert_eq!(at(r"D:\tools", false), InstallKind::Portable);
    }

    #[test]
    fn picks_assets() {
        let assets = [
            asset("Nexterm_0.2.0_arm64-setup.exe"),
            asset("Nexterm_0.2.0_x64-setup.exe"),
            asset("Nexterm_0.2.0_x64_en-US.msi"),
            asset("nexterm.exe"),
        ];
        let name = |k| pick_asset(k, &assets).map(|a| a.name.as_str());
        assert_eq!(name(InstallKind::Nsis), Some("Nexterm_0.2.0_x64-setup.exe"));
        assert_eq!(name(InstallKind::Msi), Some("Nexterm_0.2.0_x64_en-US.msi"));
        assert_eq!(name(InstallKind::Portable), Some("nexterm.exe"));
        assert_eq!(pick_asset(InstallKind::Msi, &assets[..2]), None);
        let guessed = guessed_assets("v0.2.0");
        assert_eq!(
            pick_asset(InstallKind::Nsis, &guessed).unwrap().browser_download_url,
            "https://github.com/rty813/nexterm/releases/download/v0.2.0/Nexterm_0.2.0_x64-setup.exe"
        );
    }

    #[test]
    fn verifies_downloads() {
        let data = b"MZ\x90\x00rest of the exe";
        let sum = hex(ring::digest::digest(&ring::digest::SHA256, data).as_ref());
        let mut a = asset("nexterm.exe");
        a.size = data.len() as u64;
        a.digest = Some(format!("sha256:{}", sum.to_uppercase()));
        assert!(verify(&a, data.len() as u64, &sum, data).is_ok());
        assert!(verify(&a, 3, &sum, data).is_err());
        assert!(verify(&a, data.len() as u64, &"0".repeat(64), data).is_err());
        a.digest = None;
        a.size = 0;
        assert!(verify(&a, 9, "x", b"<html>").is_err());
        let msi = asset("a.msi");
        assert!(verify(&msi, 9, "x", &[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]).is_ok());
        assert!(verify(&msi, 9, "x", b"MZ").is_err());
    }

    #[test]
    fn builds_info() {
        let info = info_from(release("v0.2.0"), "0.1.2").unwrap();
        assert!(info.available);
        assert_eq!(info.latest, "0.2.0");
        assert!(!info_from(release("v0.1.2"), "0.1.2").unwrap().available);
        assert!(!info_from(release("v0.1.0"), "0.1.2").unwrap().available);
        let mut pre = release("v0.3.0");
        pre.prerelease = true;
        assert!(!info_from(pre, "0.1.2").unwrap().available);
        let mut bad_url = release("v0.3.0");
        bad_url.html_url = Some("javascript:alert(1)".into());
        assert_eq!(info_from(bad_url, "0.1.2").unwrap().url, RELEASES_PAGE);
        assert!(info_from(release("latest"), "0.1.2").is_err());
    }
}
