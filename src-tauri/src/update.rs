//! Update check against the GitHub Releases of the project.
//!
//! Only checks: the newest published (non-draft, non-prerelease) release is compared
//! with this build's version, and the frontend offers to open its download page.

use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::time::Duration;

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
    let release = match from_api().await {
        Ok(r) => r,
        Err(api_err) => {
            let mut r = from_redirect().await.map_err(|e| format!("{api_err}; {e}"))?;
            if compare_versions(&r.tag_name, env!("CARGO_PKG_VERSION")) == Some(Ordering::Greater) {
                r.body = feed_notes(&r.tag_name).await.ok();
            }
            r
        }
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
