//! Plugin stores: signed folders of static files (see `scripts/plugin-store.mjs`).
//!
//! Stores are public. Adding one by its address trusts the key its index declares (trust on first
//! use); from then on the store is identified by that key: every `index.json` must verify against it,
//! its `seq` must not go backwards, and every package must match the size and SHA-256 listed in the
//! verified index. The store list is synced configuration kept by the frontend in `plugin_stores.json`.

use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{redirect::Policy, Client, StatusCode, Url};
use ring::{digest, signature};
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

const MAX_INDEX: usize = 4 * 1024 * 1024;
const MAX_SIGNATURE: usize = 1024;
/// A package is at most 2 MiB of JSON plus the trailing newline written by the packer.
const MAX_PACKAGE: u64 = 2 * 1024 * 1024 + 16;
const MAX_URLS: usize = 8;

/// Errors start with a stable code (before the first `:`) that the frontend translates.
fn fail(code: &str, detail: impl std::fmt::Display) -> String { format!("{code}: {detail}") }

/// A store base URL: https, no credentials, query or fragment, path ending in `/`.
pub fn base_url(value: &str) -> Result<Url, String> {
    let mut url = Url::parse(value.trim()).map_err(|_| fail("invalidUrl", value))?;
    if url.scheme() != "https" || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
        return Err(fail("invalidUrl", "an https:// address without credentials, query or fragment is required"));
    }
    if !url.path().ends_with('/') { let path = format!("{}/", url.path()); url.set_path(&path); }
    Ok(url)
}

/// A file inside the store (`index.json`, `packages/<id>/<version>.nexterm-plugin`), never outside it.
fn store_file(base: &Url, file: &str) -> Result<Url, String> {
    let safe = !file.is_empty() && file.len() <= 300 && !file.starts_with('/') && file.split('/').all(|part| !part.is_empty() && part != "." && part != "..")
        && file.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._-/".contains(&byte));
    if !safe { return Err(fail("invalidIndex", format!("unsafe file path {file}"))); }
    let url = base.join(file).map_err(|_| fail("invalidIndex", file))?;
    if !url.as_str().starts_with(base.as_str()) { return Err(fail("invalidIndex", file)); }
    Ok(url)
}

pub fn fingerprint(public_key: &[u8]) -> String {
    digest::digest(&digest::SHA256, public_key).as_ref()[..8].iter().map(|byte| format!("{byte:02x}")).collect()
}

fn decode_key(value: &str) -> Result<Vec<u8>, String> {
    let key = STANDARD.decode(value.trim()).map_err(|_| fail("invalidIndex", "public key is not base64"))?;
    if key.len() != 32 { return Err(fail("invalidIndex", "public key must be 32 bytes")); }
    Ok(key)
}

/// Checks the signature of the exact index bytes. With `pinned`, the index must also name that key;
/// without it (first contact) the key the index declares is used and returned to be pinned.
pub fn verify_index(bytes: &[u8], signature_text: &str, pinned: Option<&str>) -> Result<(Value, String), String> {
    let index: Value = serde_json::from_slice(bytes).map_err(|_| fail("invalidIndex", "index.json is not JSON"))?;
    let declared = index.pointer("/store/publicKey").and_then(Value::as_str).ok_or_else(|| fail("invalidIndex", "missing store.publicKey"))?;
    let key = decode_key(declared)?;
    if let Some(pinned) = pinned {
        if decode_key(pinned)? != key { return Err(fail("keyMismatch", "the index is signed for another store key")); }
    }
    let sig = STANDARD.decode(signature_text.trim()).map_err(|_| fail("signature", "index.json.sig is not base64"))?;
    signature::UnparsedPublicKey::new(&signature::ED25519, &key).verify(bytes, &sig).map_err(|_| fail("signature", "index.json does not match its signature"))?;
    if index.get("schema").and_then(Value::as_u64) != Some(1) || index.get("seq").and_then(Value::as_u64).is_none() || !index.get("plugins").is_some_and(Value::is_array) {
        return Err(fail("invalidIndex", "unsupported index format"));
    }
    Ok((index, STANDARD.encode(key)))
}

fn client() -> Result<Client, String> {
    crate::http_proxy::apply(Client::builder())
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(8))
        .redirect(Policy::custom(|attempt| {
            let first = attempt.previous().first().map(|url| url.origin());
            if attempt.previous().len() >= 3 || attempt.url().scheme() != "https" || first.is_some_and(|origin| origin != attempt.url().origin()) {
                attempt.error("redirect refused")
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|error| fail("network", error))
}

async fn download(client: &Client, url: Url, limit: u64) -> Result<Vec<u8>, String> {
    let mut response = client.get(url.clone()).header("cache-control", "no-cache").send().await.map_err(|error| fail("network", format!("{url}: {}", error.without_url())))?;
    match response.status() {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => return Err(fail("unauthorized", url)),
        status if !status.is_success() => return Err(fail("http", format!("{} {url}", status.as_u16()))),
        _ => {}
    }
    if response.content_length().is_some_and(|length| length > limit) { return Err(fail("tooLarge", url)); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| fail("network", format!("{url}: {}", error.without_url())))? {
        if (bytes.len() + chunk.len()) as u64 > limit { return Err(fail("tooLarge", url)); }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn fetch_index(client: &Client, base: &Url, pinned: Option<&str>) -> Result<(Value, String), String> {
    let bytes = download(client, store_file(base, "index.json")?, MAX_INDEX as u64).await?;
    let signature = download(client, store_file(base, "index.json.sig")?, MAX_SIGNATURE as u64).await?;
    verify_index(&bytes, &String::from_utf8_lossy(&signature), pinned)
}

fn validate_store_id(store_id: &str) -> Result<(), String> {
    if store_id.len() == 16 && store_id.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')) { Ok(()) } else { Err(fail("invalidStore", "bad store id")) }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe { index: Value, public_key: String, fingerprint: String, url: String }

/// First contact when adding a store: the index must be validly signed by the key it declares, which
/// is returned for the frontend to pin.
#[tauri::command]
pub async fn plugin_store_probe(url: String) -> Result<Probe, String> {
    let base = base_url(&url)?;
    let (index, key) = fetch_index(&client()?, &base, None).await?;
    let fingerprint = fingerprint(&decode_key(&key)?);
    Ok(Probe { index, public_key: key, fingerprint, url: base.to_string() })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fetched { index: Value, url: String }

/// Loads the index of an added store from the first mirror that serves a valid one.
#[tauri::command]
pub async fn plugin_store_index(store_id: String, urls: Vec<String>, public_key: String, min_seq: u64) -> Result<Fetched, String> {
    validate_store_id(&store_id)?;
    if fingerprint(&decode_key(&public_key)?) != store_id { return Err(fail("invalidStore", "store id does not match its key")); }
    if urls.is_empty() || urls.len() > MAX_URLS { return Err(fail("invalidStore", "1 to 8 addresses are allowed")); }
    let client = client()?;
    let mut last = fail("network", "no address answered");
    for url in &urls {
        let attempt = async {
            let base = base_url(url)?;
            let (index, _) = fetch_index(&client, &base, Some(&public_key)).await?;
            let seq = index.get("seq").and_then(Value::as_u64).unwrap_or(0);
            if seq < min_seq { return Err(fail("rollback", format!("index seq {seq} is older than {min_seq} seen before"))); }
            Ok(Fetched { index, url: base.to_string() })
        };
        match attempt.await {
            Ok(fetched) => return Ok(fetched),
            // A forged or rolled-back index on one mirror must not be hidden by trying the next one.
            Err(error) if error.starts_with("signature") || error.starts_with("keyMismatch") || error.starts_with("rollback") => return Err(error),
            Err(error) => last = error,
        }
    }
    Err(last)
}

/// Downloads one package and checks it against the size and SHA-256 from the verified index.
#[tauri::command]
pub async fn plugin_store_fetch(store_id: String, base: String, file: String, sha256: String, size: u64) -> Result<String, String> {
    validate_store_id(&store_id)?;
    if !file.starts_with("packages/") || !file.ends_with(".nexterm-plugin") { return Err(fail("invalidIndex", "packages must live under packages/")); }
    if sha256.len() != 64 || !sha256.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')) || size == 0 || size > MAX_PACKAGE { return Err(fail("invalidIndex", "bad package size or hash")); }
    let base = base_url(&base)?;
    let bytes = download(&client()?, store_file(&base, &file)?, size).await?;
    let actual: String = digest::digest(&digest::SHA256, &bytes).as_ref().iter().map(|byte| format!("{byte:02x}")).collect();
    if bytes.len() as u64 != size || actual != sha256 { return Err(fail("hash", format!("{file} does not match the signed index"))); }
    String::from_utf8(bytes).map_err(|_| fail("invalidIndex", "package is not UTF-8"))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Produced by Node's crypto (the same code path as scripts/plugin-store.mjs) from a fixed seed.
    const VECTOR_KEY: &str = "6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=";
    const VECTOR_INDEX: &str = "{\"schema\":1,\"seq\":3,\"generated\":\"2026-01-01T00:00:00.000Z\",\"store\":{\"name\":\"Vector\",\"publicKey\":\"6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=\"},\"plugins\":[],\"revoked\":[]}\n";
    const VECTOR_SIG: &str = "V+Cy1JP5OQC80zinsmm+rnAkTWNZYcqYpuEfJ89Ue8e2brcmzY612wcd/3YdjRL2DUDUESHOeR1CFhrrZL7SCg==";

    #[test]
    fn verifies_signatures_made_by_the_publishing_script() {
        let (index, key) = verify_index(VECTOR_INDEX.as_bytes(), VECTOR_SIG, None).unwrap();
        assert_eq!(key, VECTOR_KEY);
        assert_eq!(index["seq"], 3);
        assert!(verify_index(VECTOR_INDEX.as_bytes(), &format!("{VECTOR_SIG}\n"), Some(VECTOR_KEY)).is_ok());
    }

    #[test]
    fn rejects_tampering_and_other_keys() {
        let tampered = VECTOR_INDEX.replace("\"seq\":3", "\"seq\":4");
        assert!(verify_index(tampered.as_bytes(), VECTOR_SIG, Some(VECTOR_KEY)).unwrap_err().starts_with("signature"));
        let other = STANDARD.encode([9u8; 32]);
        assert!(verify_index(VECTOR_INDEX.as_bytes(), VECTOR_SIG, Some(&other)).unwrap_err().starts_with("keyMismatch"));
        assert!(verify_index(VECTOR_INDEX.as_bytes(), "not base64!", None).unwrap_err().starts_with("signature"));
        assert!(verify_index(b"[]", VECTOR_SIG, None).unwrap_err().starts_with("invalidIndex"));
    }

    #[test]
    fn fingerprint_matches_the_publishing_script() {
        let key = STANDARD.decode("+U256mSOOHNxlniYqhFy5Tg0OYPDkI/127OGmH9OSgU=").unwrap();
        assert_eq!(fingerprint(&key), "2648d2bab1b4c559");
    }

    #[test]
    fn store_urls_and_paths_stay_inside_the_store() {
        assert_eq!(base_url("https://relay.example.com/store").unwrap().as_str(), "https://relay.example.com/store/");
        assert_eq!(base_url(" https://relay.example.com:8443/store/ ").unwrap().as_str(), "https://relay.example.com:8443/store/");
        assert!(base_url(concat!("https://", "a:b", "@relay.example.com/store/")).is_err());
        for bad in ["http://relay.example.com/store/", "https://relay.example.com/store/?a=1", "https://relay.example.com/store/#key=x", "ftp://x/"] {
            assert!(base_url(bad).is_err(), "{bad}");
        }
        let base = base_url("https://relay.example.com/store/").unwrap();
        assert_eq!(store_file(&base, "packages/a.b/1.0.0.nexterm-plugin").unwrap().as_str(), "https://relay.example.com/store/packages/a.b/1.0.0.nexterm-plugin");
        for bad in ["../server.js", "packages/../../x", "/etc/passwd", "packages//x", "packages/%2e%2e/x", "packages/a?b", "https://evil.example.com/x", ""] {
            assert!(store_file(&base, bad).is_err(), "{bad}");
        }
    }

    /// Against a real store: `STORE_URL=… cargo test --lib live_store -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn live_store() {
        let url = std::env::var("STORE_URL").expect("STORE_URL");
        let probe = plugin_store_probe(url.clone()).await.unwrap();
        let fetched = plugin_store_index(probe.fingerprint.clone(), vec![url], probe.public_key.clone(), 0).await.unwrap();
        let seq = fetched.index["seq"].as_u64().unwrap();
        let plugins = fetched.index["plugins"].as_array().unwrap();
        for plugin in plugins {
            let version = &plugin["versions"][0];
            let text = plugin_store_fetch(probe.fingerprint.clone(), fetched.url.clone(), version["file"].as_str().unwrap().into(), version["sha256"].as_str().unwrap().into(), version["size"].as_u64().unwrap()).await.unwrap();
            let bundle: Value = serde_json::from_str(&text).unwrap();
            assert_eq!(bundle["manifest"]["id"], plugin["id"]);
            println!("verified {} {} ({} bytes)", plugin["id"], version["version"], text.len());
        }
        println!("store {} seq {seq}, {} plugins, fingerprint {}", fetched.index["store"]["name"], plugins.len(), probe.fingerprint);
    }

    #[test]
    fn store_ids_are_key_fingerprints() {
        assert!(validate_store_id("2648d2bab1b4c559").is_ok());
        for bad in ["2648D2BAB1B4C559", "2648d2bab1b4c55", "../../x", ""] { assert!(validate_store_id(bad).is_err()); }
    }
}
