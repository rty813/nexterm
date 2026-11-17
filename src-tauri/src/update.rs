//! Update check against the GitHub Releases of the project.
//!
//! Only checks: the newest published (non-draft, non-prerelease) release is compared
//! with this build's version, and the frontend offers to open its download page.

use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::time::Duration;

const LATEST_URL: &str = "https://api.github.com/repos/rty813/nexterm/releases/latest";
const RELEASES_PAGE: &str = "https://github.com/rty813/nexterm/releases/latest";

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
    })
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
    reqwest::Client::builder()
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
        tag_name: tag,
        body: None,
        published_at: None,
        draft: false,
        prerelease: false,
    })
}

pub async fn check() -> Result<UpdateInfo, String> {
    // The API allows 60 unauthenticated requests per hour per IP, which a shared
    // network can use up; the release page redirect still gives the version.
    let release = match from_api().await {
        Ok(r) => r,
        Err(api_err) => from_redirect().await.map_err(|e| format!("{api_err}; {e}"))?,
    };
    info_from(release, env!("CARGO_PKG_VERSION"))
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
    }

    fn release(tag: &str) -> Release {
        Release {
            tag_name: tag.into(),
            html_url: Some("https://github.com/rty813/nexterm/releases/tag/v9".into()),
            body: Some("notes".into()),
            published_at: None,
            draft: false,
            prerelease: false,
        }
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
