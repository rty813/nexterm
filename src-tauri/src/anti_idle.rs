//! Anti-idle: when nothing has been typed into a pane for a while, send a short string so
//! the server does not log the user out for inactivity (bash/zsh `TMOUT`, csh `autologout`,
//! a router's `exec-timeout`). SSH keepalives never reach the shell, so they cannot help there.
//!
//! Runs in the backend (see `manager.rs`), not on a frontend timer: WebView2 throttles
//! timers while the window is minimized, which is exactly when this is needed.
//!
//! Session options (in `SessionConfig.extra`, frontend `SessionConfig`):
//! - `antiIdleSecs`: seconds without input before sending; 0 / missing = off.
//! - `antiIdleString`: what to send, with escapes (`\0 \n \r \t \b \e \\ \xHH`);
//!   empty = [`DEFAULT_STRING`].

use std::time::{Duration, Instant};

use crate::models::SessionConfig;

/// NUL (Ctrl-@): counts as input for the server's idle timer, and the shells' line
/// editors bind it to "set mark", which changes nothing on screen.
pub const DEFAULT_STRING: &str = "\\0";

/// Shortest interval accepted, so a typo cannot flood the remote.
pub const MIN_SECS: u64 = 5;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AntiIdle {
    pub interval: Duration,
    pub bytes: Vec<u8>,
}

impl AntiIdle {
    pub fn from_config(config: &SessionConfig) -> Option<Self> {
        let secs = config.extra.get("antiIdleSecs").and_then(|v| v.as_u64()).unwrap_or(0);
        if secs == 0 {
            return None;
        }
        let raw = config.extra.get("antiIdleString").and_then(|v| v.as_str()).unwrap_or("");
        let bytes = unescape(if raw.is_empty() { DEFAULT_STRING } else { raw });
        if bytes.is_empty() {
            return None;
        }
        Some(Self { interval: Duration::from_secs(secs.max(MIN_SECS)), bytes })
    }

    /// Time to send: connected, nothing typed for `interval`, and the shell is at its
    /// prompt as far as we can tell (no full-screen program, no command running).
    pub fn due(&self, now: Instant, last_input: Instant, pane: PaneState) -> bool {
        pane.connected && !pane.busy && now.saturating_duration_since(last_input) >= self.interval
    }
}

/// What the timer needs to know about the pane right now.
#[derive(Debug, Clone, Copy, Default)]
pub struct PaneState {
    pub connected: bool,
    /// Alternate screen (vim, less, top), a command running (OSC 133), a file transfer or
    /// a shell integration load: input would go to something other than an idle prompt.
    pub busy: bool,
}

/// `\0 \n \r \t \b \e \\ \xHH` to bytes; any other backslash stays as typed.
pub fn unescape(s: &str) -> Vec<u8> {
    let src = s.as_bytes();
    let mut out = Vec::with_capacity(src.len());
    let mut i = 0;
    while i < src.len() {
        let b = src[i];
        if b != b'\\' || i + 1 >= src.len() {
            out.push(b);
            i += 1;
            continue;
        }
        let esc = match src[i + 1] {
            b'0' => Some(0x00),
            b'n' => Some(b'\n'),
            b'r' => Some(b'\r'),
            b't' => Some(b'\t'),
            b'b' => Some(0x08),
            b'e' => Some(0x1b),
            b'\\' => Some(b'\\'),
            _ => None,
        };
        if let Some(e) = esc {
            out.push(e);
            i += 2;
            continue;
        }
        if src[i + 1] == b'x' && i + 4 <= src.len() {
            let hex = &src[i + 2..i + 4];
            if hex.iter().all(u8::is_ascii_hexdigit) {
                let v = u8::from_str_radix(std::str::from_utf8(hex).unwrap_or("0"), 16).unwrap_or(0);
                out.push(v);
                i += 4;
                continue;
            }
        }
        out.push(b);
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn config(secs: Option<u64>, s: Option<&str>) -> SessionConfig {
        let mut c = SessionConfig::default();
        if let Some(secs) = secs {
            c.extra.insert("antiIdleSecs".into(), json!(secs));
        }
        if let Some(s) = s {
            c.extra.insert("antiIdleString".into(), json!(s));
        }
        c
    }

    #[test]
    fn unescapes() {
        assert_eq!(unescape(r"\0"), vec![0]);
        assert_eq!(unescape(r"ls\r\n"), b"ls\r\n".to_vec());
        assert_eq!(unescape(r" \b"), vec![b' ', 8]);
        assert_eq!(unescape(r"\x1b[A\e"), b"\x1b[A\x1b".to_vec());
        assert_eq!(unescape(r"a\\b"), b"a\\b".to_vec());
        // Unknown or cut-off escapes stay as typed.
        assert_eq!(unescape(r"\q\x4"), b"\\q\\x4".to_vec());
        assert_eq!(unescape(r"\xzz\"), b"\\xzz\\".to_vec());
        assert_eq!(unescape("中"), "中".as_bytes().to_vec());
    }

    #[test]
    fn off_unless_configured() {
        assert_eq!(AntiIdle::from_config(&config(None, Some(r"\n"))), None);
        assert_eq!(AntiIdle::from_config(&config(Some(0), None)), None);
    }

    #[test]
    fn defaults_and_minimum() {
        let a = AntiIdle::from_config(&config(Some(1), None)).unwrap();
        assert_eq!(a.interval, Duration::from_secs(MIN_SECS));
        assert_eq!(a.bytes, vec![0]);
        let b = AntiIdle::from_config(&config(Some(300), Some(r"\n"))).unwrap();
        assert_eq!(b.interval, Duration::from_secs(300));
        assert_eq!(b.bytes, b"\n".to_vec());
    }

    #[test]
    fn reads_the_session_as_the_frontend_saves_it() {
        let saved = json!({
            "id": "s1", "label": "box", "protocol": "ssh", "host": "h",
            "antiIdleSecs": 120, "antiIdleString": " \\b"
        });
        let c: SessionConfig = serde_json::from_value(saved).unwrap();
        let a = AntiIdle::from_config(&c).unwrap();
        assert_eq!(a.interval, Duration::from_secs(120));
        assert_eq!(a.bytes, vec![b' ', 8]);
    }

    #[test]
    fn due_only_when_idle_at_a_prompt() {
        let a = AntiIdle::from_config(&config(Some(60), None)).unwrap();
        let t0 = Instant::now();
        let idle = PaneState { connected: true, busy: false };
        assert!(!a.due(t0 + Duration::from_secs(59), t0, idle));
        assert!(a.due(t0 + Duration::from_secs(60), t0, idle));
        assert!(!a.due(t0 + Duration::from_secs(600), t0, PaneState { connected: true, busy: true }));
        assert!(!a.due(t0 + Duration::from_secs(600), t0, PaneState { connected: false, busy: false }));
    }
}
