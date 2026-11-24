//! Logcat tabs: `logcat -v threadtime -v uid` on a shell v2 stream, parsed into entries and
//! sent to the tab in batches (one JSON array per ~50 ms) over its own `Channel`.
//!
//! Filtering happens in the tab (utils/logcatFilter.ts) so changing a filter never loses
//! lines; only the buffers and the starting point are chosen here.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::io::AsyncReadExt;
use tokio::sync::oneshot;

use super::shell::{PacketDecoder, ID_EXIT, ID_STDERR, ID_STDOUT};
use super::AdbDevice;
use crate::manager::TerminalSink;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    /// "11-23 10:00:00.123"
    pub ts: String,
    pub pid: u32,
    pub tid: u32,
    /// Numeric uid ("u0_a123" -> 10123), None when the device does not print it.
    pub uid: Option<u32>,
    /// V D I W E F (S for markers such as "--------- beginning of main").
    pub level: char,
    pub tag: String,
    pub msg: String,
}

/// "u0_a123" -> 10123, "u10_a5" -> 1010005, "system" -> 1000, "1000" -> 1000.
pub fn parse_uid(s: &str) -> Option<u32> {
    if let Ok(n) = s.parse() {
        return Some(n);
    }
    let named = match s {
        "root" => Some(0),
        "system" => Some(1000),
        "radio" => Some(1001),
        "bluetooth" => Some(1002),
        "wifi" => Some(1010),
        "media" => Some(1013),
        "nfc" => Some(1027),
        "shell" => Some(2000),
        "nobody" => Some(9999),
        _ => None,
    };
    if named.is_some() {
        return named;
    }
    let rest = s.strip_prefix('u')?;
    let (user, app) = rest.split_once('_')?;
    let user: u32 = user.parse().ok()?;
    let base = if let Some(n) = app.strip_prefix('a') {
        10000 + n.parse::<u32>().ok()?
    } else if let Some(n) = app.strip_prefix('i') {
        90000 + n.parse::<u32>().ok()?
    } else {
        return None;
    };
    Some(user * 100000 + base)
}

fn is_level(s: &str) -> Option<char> {
    let mut c = s.chars();
    let l = c.next()?;
    (c.next().is_none() && "VDIWEFS".contains(l)).then_some(l)
}

/// One threadtime line, with or without the uid column:
/// `11-23 10:00:00.123  u0_a12  1234  1250 I Tag: message` /
/// `11-23 10:00:00.123  1234  1250 I Tag: message`.
pub fn parse_line(line: &str) -> Option<LogEntry> {
    let line = line.trim_end_matches(['\r', '\n']);
    if let Some(buffer) = line.strip_prefix("--------- ") {
        return Some(LogEntry { ts: String::new(), pid: 0, tid: 0, uid: None, level: 'S', tag: "logcat".into(), msg: buffer.to_string() });
    }
    let fields: Vec<&str> = line.split_whitespace().collect();
    if fields.len() < 5 {
        return None;
    }
    let ts = format!("{} {}", fields[0], fields[1]);
    if !fields[0].contains('-') || !fields[1].contains(':') {
        return None;
    }
    // Without uid the level letter is field 4; with it, field 5. A one-letter tag ("D")
    // could make both look like levels, so field 4 being a number wins.
    let has_uid = is_level(fields[4]).is_none() && fields.get(5).and_then(|f| is_level(f)).is_some();
    let (uid, pid_i) = if has_uid { (parse_uid(fields[2]), 3) } else { (None, 2) };
    let pid = fields.get(pid_i)?.parse().ok()?;
    let tid = fields.get(pid_i + 1)?.parse().ok()?;
    let level = is_level(fields.get(pid_i + 2)?)?;
    // The rest of the line after the level letter: "Tag: message" (tags may hold spaces).
    let level_pos = nth_field_end(line, pid_i + 2)?;
    let rest = line[level_pos..].trim_start();
    let (tag, msg) = match rest.find(": ") {
        Some(i) => (rest[..i].trim_end(), &rest[i + 2..]),
        None => match rest.strip_suffix(':') {
            Some(t) => (t.trim_end(), ""),
            None => ("", rest),
        },
    };
    Some(LogEntry { ts, pid, tid, uid, level, tag: tag.to_string(), msg: msg.to_string() })
}

/// Byte offset just past the `n`th (0-based) whitespace-separated field.
fn nth_field_end(line: &str, n: usize) -> Option<usize> {
    let mut count = 0;
    let mut in_field = false;
    for (i, c) in line.char_indices() {
        if c.is_whitespace() {
            if in_field {
                if count == n {
                    return Some(i);
                }
                count += 1;
                in_field = false;
            }
        } else {
            in_field = true;
        }
    }
    (in_field && count == n).then_some(line.len())
}

/// Splits the byte stream into lines; a line that does not parse (a message with an
/// embedded newline on old devices) is appended to the previous entry.
#[derive(Default)]
pub struct LineParser {
    partial: Vec<u8>,
}

impl LineParser {
    pub fn feed(&mut self, data: &[u8], out: &mut Vec<LogEntry>) {
        self.partial.extend_from_slice(data);
        while let Some(i) = memchr::memchr(b'\n', &self.partial) {
            let line: Vec<u8> = self.partial.drain(..=i).collect();
            let text = String::from_utf8_lossy(&line);
            let text = text.trim_end_matches(['\r', '\n']);
            if text.is_empty() {
                continue;
            }
            match parse_line(text) {
                Some(e) => out.push(e),
                None => {
                    if let Some(last) = out.last_mut() {
                        last.msg.push('\n');
                        last.msg.push_str(text);
                    } else {
                        out.push(LogEntry { ts: String::new(), pid: 0, tid: 0, uid: None, level: 'I', tag: String::new(), msg: text.to_string() });
                    }
                }
            }
        }
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LogcatOptions {
    /// "main", "system", "crash", "events", "radio" (empty: the device default).
    #[serde(default)]
    pub buffers: Vec<String>,
    /// Start with the last N lines (0: everything in the buffer).
    #[serde(default)]
    pub tail: u32,
}

pub fn command(opts: &LogcatOptions) -> String {
    let mut cmd = String::from("logcat -v threadtime -v uid");
    for b in &opts.buffers {
        if ["main", "system", "crash", "events", "radio", "kernel", "all", "default"].contains(&b.as_str()) {
            cmd.push_str(" -b ");
            cmd.push_str(b);
        }
    }
    if opts.tail > 0 {
        cmd.push_str(&format!(" -T {}", opts.tail));
    }
    cmd
}

fn running() -> &'static Mutex<HashMap<String, oneshot::Sender<()>>> {
    static R: OnceLock<Mutex<HashMap<String, oneshot::Sender<()>>>> = OnceLock::new();
    R.get_or_init(Default::default)
}

/// Start streaming for a tab (replaces a stream it already had). State changes go out as
/// `terminal-state` so the tab shows the usual status dot.
pub fn start(instance_id: String, device: AdbDevice, opts: LogcatOptions, channel: Channel<InvokeResponseBody>, sink: Arc<dyn TerminalSink>) {
    let (stop_tx, mut stop_rx) = oneshot::channel();
    if let Ok(mut r) = running().lock() {
        r.insert(instance_id.clone(), stop_tx);
    }
    tauri::async_runtime::spawn(async move {
        sink.emit_state(&instance_id, "connecting", None);
        let run = async {
            let v2 = super::shell::has_v2(&device).await;
            let mut s = device.open(&super::shell::service(v2, false, "dumb", &command(&opts))).await?;
            sink.emit_state(&instance_id, "connected", None);
            let mut dec = PacketDecoder::default();
            let mut lines = LineParser::default();
            let mut errors = LineParser::default();
            let mut batch: Vec<LogEntry> = Vec::new();
            let mut buf = vec![0u8; 64 * 1024];
            let mut tick = tokio::time::interval(Duration::from_millis(50));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tokio::select! {
                    // Stopped on purpose (tab closed, or restarted with other buffers): no state
                    // change, which could land after the replacement stream's "connected".
                    _ = &mut stop_rx => return anyhow::Ok(None),
                    _ = tick.tick() => {
                        if !batch.is_empty() {
                            send_batch(&channel, &mut batch)?;
                        }
                    }
                    r = s.read(&mut buf) => {
                        let n = r?;
                        if n == 0 {
                            break;
                        }
                        if !v2 {
                            lines.feed(&buf[..n], &mut batch);
                        } else {
                            for (id, body) in dec.feed(&buf[..n]) {
                                match id {
                                    ID_STDOUT => lines.feed(&body, &mut batch),
                                    ID_STDERR => errors.feed(&body, &mut batch),
                                    ID_EXIT => {
                                        if !batch.is_empty() { send_batch(&channel, &mut batch)?; }
                                        return Ok(Some(format!("logcat 已退出（{}）", body.first().copied().unwrap_or(0))));
                                    }
                                    _ => {}
                                }
                            }
                        }
                        if batch.len() >= 2000 {
                            send_batch(&channel, &mut batch)?;
                        }
                    }
                }
            }
            if !batch.is_empty() {
                send_batch(&channel, &mut batch)?;
            }
            Ok(Some("设备已断开".to_string()))
        };
        match run.await {
            Ok(None) => {}
            Ok(msg) => sink.emit_state(&instance_id, "disconnected", msg),
            Err(e) => sink.emit_state(&instance_id, "error", Some(format!("{:#}", e))),
        }
    });
}

fn send_batch(channel: &Channel<InvokeResponseBody>, batch: &mut Vec<LogEntry>) -> Result<()> {
    let json = serde_json::to_string(&*batch)?;
    batch.clear();
    channel.send(InvokeResponseBody::Json(json)).map_err(|e| anyhow::anyhow!("日志窗格已关闭: {e}"))
}

pub fn stop(instance_id: &str) {
    if let Some(tx) = running().lock().ok().and_then(|mut r| r.remove(instance_id)) {
        let _ = tx.send(());
    }
}

/// `logcat -c`: empties the device's buffers.
pub async fn clear(device: &AdbDevice, buffers: &[String]) -> Result<()> {
    let mut cmd = String::from("logcat -c");
    for b in buffers {
        if ["main", "system", "crash", "events", "radio", "all"].contains(&b.as_str()) {
            cmd.push_str(" -b ");
            cmd.push_str(b);
        }
    }
    device.exec_output(&cmd).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uids() {
        assert_eq!(parse_uid("u0_a123"), Some(10123));
        assert_eq!(parse_uid("u10_a5"), Some(1_010_005));
        assert_eq!(parse_uid("system"), Some(1000));
        assert_eq!(parse_uid("1000"), Some(1000));
        assert_eq!(parse_uid("u0_i3"), Some(90003));
        assert_eq!(parse_uid("whatever"), None);
    }

    #[test]
    fn threadtime_with_uid() {
        let e = parse_line("11-23 10:00:00.123  u0_a12  1234  1250 I ActivityManager: Start proc 1234: x").unwrap();
        assert_eq!(e.ts, "11-23 10:00:00.123");
        assert_eq!(e.uid, Some(10012));
        assert_eq!((e.pid, e.tid, e.level), (1234, 1250, 'I'));
        assert_eq!(e.tag, "ActivityManager");
        assert_eq!(e.msg, "Start proc 1234: x");
    }

    #[test]
    fn threadtime_numeric_uid() {
        let e = parse_line("11-23 10:00:00.123  1000   567   890 W System Server: low memory").unwrap();
        assert_eq!(e.uid, Some(1000));
        assert_eq!((e.pid, e.tid, e.level), (567, 890, 'W'));
        assert_eq!(e.tag, "System Server");
    }

    #[test]
    fn threadtime_without_uid() {
        let e = parse_line("11-23 10:00:00.123  1234  1250 E chromium: [ERROR] boom").unwrap();
        assert_eq!(e.uid, None);
        assert_eq!((e.pid, e.tid, e.level), (1234, 1250, 'E'));
        assert_eq!(e.tag, "chromium");
        assert_eq!(e.msg, "[ERROR] boom");
    }

    #[test]
    fn markers_and_continuations() {
        let mut p = LineParser::default();
        let mut out = Vec::new();
        p.feed(b"--------- beginning of main\n11-23 10:00:00.123  1234  1250 D Tag: first\nsecond line\n11-23 10:0", &mut out);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].level, 'S');
        assert_eq!(out[1].msg, "first\nsecond line");
        p.feed(b"0:01.000  1  2 V T: x\r\n", &mut out);
        assert_eq!(out.len(), 3);
        assert_eq!(out[2].msg, "x");
    }

    #[test]
    fn logcat_command() {
        let c = command(&LogcatOptions { buffers: vec!["main".into(), "crash".into(), "; rm".into()], tail: 500 });
        assert_eq!(c, "logcat -v threadtime -v uid -b main -b crash -T 500");
    }
}
