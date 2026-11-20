//! Proxy for the app's own HTTP requests (update check and download, config sync, plugin HTTP,
//! plugin stores), from `settings.extra.httpProxy` = `{ mode, url }`:
//! - `"system"` (default): `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`, else the Windows proxy
//!   settings (Internet Settings: `ProxyEnable` / `ProxyServer` / `ProxyOverride`);
//! - `"direct"`: no proxy, environment and system settings ignored;
//! - `"custom"`: `url` (`http://`, `https://`, `socks5://`, `socks5h://`; `user:pass@` allowed),
//!   except for localhost.
//!
//! Terminal connections have their own per-session proxy (`net.rs`), not this one.

use serde_json::Value;
use std::sync::RwLock;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProxyMode {
    System,
    Direct,
    Custom(String),
}

static MODE: RwLock<ProxyMode> = RwLock::new(ProxyMode::System);

pub fn configure(mode: ProxyMode) {
    if let Ok(mut m) = MODE.write() {
        *m = mode;
    }
}

pub fn current() -> ProxyMode {
    MODE.read().map(|m| m.clone()).unwrap_or(ProxyMode::System)
}

/// `settings.extra.httpProxy` -> mode. A custom proxy without a usable address falls back to
/// the system settings rather than silently going direct.
pub fn from_settings(value: Option<&Value>) -> ProxyMode {
    let mode = value.and_then(|v| v.get("mode")).and_then(Value::as_str).unwrap_or("system");
    match mode {
        "direct" => ProxyMode::Direct,
        "custom" => {
            let url = value.and_then(|v| v.get("url")).and_then(Value::as_str).unwrap_or("");
            normalize_url(url).map(ProxyMode::Custom).unwrap_or(ProxyMode::System)
        }
        _ => ProxyMode::System,
    }
}

/// "127.0.0.1:7890" -> "http://127.0.0.1:7890"; checks the scheme, host and port.
pub fn normalize_url(input: &str) -> Result<String, String> {
    let s = input.trim();
    if s.is_empty() {
        return Err("代理地址为空".into());
    }
    let url = if s.contains("://") { s.to_string() } else { format!("http://{s}") };
    let (scheme, rest) = url.split_once("://").unwrap_or_default();
    let scheme = scheme.to_ascii_lowercase();
    if !["http", "https", "socks5", "socks5h"].contains(&scheme.as_str()) {
        return Err(format!("不支持的代理类型：{scheme}（可用 http、https、socks5、socks5h）"));
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host_port = authority.rsplit('@').next().unwrap_or("");
    let port = host_port.rsplit_once(':').map(|(_, p)| p).unwrap_or("");
    let host = host_port.strip_suffix(&format!(":{port}")).unwrap_or(host_port);
    if host.is_empty() || host.contains(char::is_whitespace) {
        return Err("代理地址缺少主机名".into());
    }
    if port.parse::<u16>().map_or(true, |p| p == 0) {
        return Err("代理地址缺少端口，例如 127.0.0.1:7890".into());
    }
    reqwest::Proxy::all(&url).map_err(|e| e.to_string())?;
    Ok(format!("{scheme}://{rest}"))
}

/// Applies `mode` to a client being built.
pub fn apply_mode(builder: reqwest::ClientBuilder, mode: &ProxyMode) -> reqwest::ClientBuilder {
    match mode {
        ProxyMode::System => builder,
        ProxyMode::Direct => builder.no_proxy(),
        ProxyMode::Custom(url) => match reqwest::Proxy::all(url) {
            Ok(p) => builder.proxy(p.no_proxy(reqwest::NoProxy::from_string("localhost,127.0.0.1,::1"))),
            Err(_) => builder,
        },
    }
}

/// Applies the configured proxy to a client being built.
pub fn apply(builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
    apply_mode(builder, &current())
}

/// Settings' "Test" button: reaches GitHub through `mode` (as the dialog has it, not yet
/// saved) and returns the round trip in milliseconds.
pub async fn test(mode: ProxyMode) -> Result<u64, String> {
    let client = apply_mode(reqwest::Client::builder(), &mode)
        .timeout(std::time::Duration::from_secs(10))
        .user_agent(concat!("Nexterm/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;
    let start = std::time::Instant::now();
    let resp = client.head("https://github.com/").send().await.map_err(|e| {
        let mut out = e.to_string();
        let mut src = std::error::Error::source(&e);
        while let Some(s) = src {
            out.push_str(": ");
            out.push_str(&s.to_string());
            src = s.source();
        }
        out
    })?;
    if resp.status().is_server_error() {
        return Err(format!("HTTP {}", resp.status()));
    }
    Ok(start.elapsed().as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalizes_urls() {
        assert_eq!(normalize_url("127.0.0.1:7890").unwrap(), "http://127.0.0.1:7890");
        assert_eq!(normalize_url(" SOCKS5://127.0.0.1:1080 ").unwrap(), "socks5://127.0.0.1:1080");
        assert_eq!(normalize_url("http://user:pass@proxy.lan:8080").unwrap(), "http://user:pass@proxy.lan:8080");
        assert_eq!(normalize_url("socks5h://[::1]:1080").unwrap(), "socks5h://[::1]:1080");
        assert!(normalize_url("").is_err());
        assert!(normalize_url("127.0.0.1").is_err());
        assert!(normalize_url("127.0.0.1:0").is_err());
        assert!(normalize_url("ftp://127.0.0.1:21").is_err());
        assert!(normalize_url("http://:8080").is_err());
    }

    #[test]
    fn reads_settings() {
        assert_eq!(from_settings(None), ProxyMode::System);
        assert_eq!(from_settings(Some(&json!({ "mode": "direct", "url": "x" }))), ProxyMode::Direct);
        assert_eq!(
            from_settings(Some(&json!({ "mode": "custom", "url": "127.0.0.1:7890" }))),
            ProxyMode::Custom("http://127.0.0.1:7890".into())
        );
        assert_eq!(from_settings(Some(&json!({ "mode": "custom", "url": "" }))), ProxyMode::System);
        assert_eq!(from_settings(Some(&json!({ "mode": "weird" }))), ProxyMode::System);
    }
}
