//! RDP server certificates, trusted on first use: SHA-256 fingerprints per `host:port` in
//! `<data>/rdp_known_certs.json`. RDP servers mostly present self-signed certificates, so a
//! CA check would reject nearly all of them; like SSH host keys, the user confirms a new or
//! changed certificate once.

use std::collections::{BTreeMap, HashSet};
use std::sync::Mutex;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::Result;

use crate::manager::{HostKeyDecision, HostKeyPrompt};

use super::SessionCtx;

fn path() -> PathBuf {
    crate::app_paths::data_dir().join("rdp_known_certs.json")
}

fn load() -> BTreeMap<String, String> {
    std::fs::read_to_string(path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save(host: &str, port: u16, fingerprint: &str) -> Result<()> {
    let mut known = load();
    known.insert(key(host, port), fingerprint.to_string());
    std::fs::write(path(), serde_json::to_string_pretty(&known)?)?;
    Ok(())
}

fn key(host: &str, port: u16) -> String {
    format!("{}:{}", host.trim().to_ascii_lowercase(), port)
}

/// `AB:CD:...` (the form Windows shows for certificate thumbprints).
pub fn fingerprint(der: &[u8]) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA256, der);
    digest.as_ref().iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(":")
}

#[derive(Debug, PartialEq, Eq)]
pub enum Known {
    Same,
    New,
    Changed,
}

pub fn lookup(known: &BTreeMap<String, String>, host: &str, port: u16, fingerprint: &str) -> Known {
    match known.get(&key(host, port)) {
        Some(f) if f == fingerprint => Known::Same,
        Some(_) => Known::Changed,
        None => Known::New,
    }
}

/// Certificates trusted once ("this time only") while the app runs, so a retry or a
/// reconnect of the same session does not ask again.
fn trusted_once() -> &'static Mutex<HashSet<String>> {
    static ONCE: std::sync::OnceLock<Mutex<HashSet<String>>> = std::sync::OnceLock::new();
    ONCE.get_or_init(Default::default)
}

/// Ask the user about a certificate not on record. `Err` = rejected.
pub async fn verify(ctx: &SessionCtx, der: &[u8]) -> Result<()> {
    let s = &ctx.session;
    let fp = fingerprint(der);
    let once_key = format!("{}={fp}", key(&s.host, s.port));
    if trusted_once().lock().unwrap_or_else(|e| e.into_inner()).contains(&once_key) {
        return Ok(());
    }
    let changed = match lookup(&load(), &s.host, s.port, &fp) {
        Known::Same => return Ok(()),
        Known::New => false,
        Known::Changed => true,
    };
    let prompt = HostKeyPrompt {
        host: s.host.trim().to_string(),
        port: s.port,
        key_type: "RDP TLS".into(),
        fingerprint: fp.clone(),
        changed,
        known_hosts: path().to_string_lossy().to_string(),
        kind: "rdp",
    };
    let rx = ctx.sink.confirm_host_key(&ctx.instance_id, prompt);
    let decision = tokio::time::timeout(Duration::from_secs(300), rx)
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or(HostKeyDecision::Reject);
    match decision {
        HostKeyDecision::Reject => anyhow::bail!("已拒绝服务器证书"),
        HostKeyDecision::AcceptOnce => {
            trusted_once().lock().unwrap_or_else(|e| e.into_inner()).insert(once_key);
            Ok(())
        }
        HostKeyDecision::AcceptAndSave => {
            save(&s.host, s.port, &fp)?;
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprints_and_lookup() {
        let fp = fingerprint(b"abc");
        assert!(fp.starts_with("BA:78:16:BF:"), "{fp}");
        assert_eq!(fp.len(), 32 * 3 - 1);
        let mut known = BTreeMap::new();
        known.insert(key("Host.Example", 3389), fp.clone());
        assert_eq!(lookup(&known, "host.example ", 3389, &fp), Known::Same);
        assert_eq!(lookup(&known, "host.example", 3389, "00"), Known::Changed);
        assert_eq!(lookup(&known, "host.example", 3390, &fp), Known::New);
    }
}
