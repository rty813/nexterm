//! `shell,v2:` — the device shell with separate stdout / stderr, an exit code and window
//! size changes, framed as packets: id (u8), length (u32 LE), data. Devices without the
//! `shell_v2` feature (Android < 7) get the legacy `shell:` stream: raw bytes, no exit code.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::AdbDevice;

pub const ID_STDIN: u8 = 0;
pub const ID_STDOUT: u8 = 1;
pub const ID_STDERR: u8 = 2;
pub const ID_EXIT: u8 = 3;
pub const ID_CLOSE_STDIN: u8 = 4;
pub const ID_WINDOW_SIZE: u8 = 5;

pub fn encode_packet(id: u8, data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(5 + data.len());
    out.push(id);
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    out.extend_from_slice(data);
    out
}

/// Window size packet: "rowsxcols,xpixelsxypixels".
pub fn encode_resize(cols: u16, rows: u16) -> Vec<u8> {
    encode_packet(ID_WINDOW_SIZE, format!("{}x{},0x0\0", rows, cols).as_bytes())
}

/// Turns the byte stream back into packets, whatever the read boundaries were.
#[derive(Default)]
pub struct PacketDecoder {
    buf: Vec<u8>,
}

impl PacketDecoder {
    pub fn feed(&mut self, data: &[u8]) -> Vec<(u8, Vec<u8>)> {
        self.buf.extend_from_slice(data);
        let mut out = Vec::new();
        loop {
            if self.buf.len() < 5 {
                break;
            }
            let len = u32::from_le_bytes([self.buf[1], self.buf[2], self.buf[3], self.buf[4]]) as usize;
            if self.buf.len() < 5 + len {
                break;
            }
            let id = self.buf[0];
            let body = self.buf[5..5 + len].to_vec();
            self.buf.drain(..5 + len);
            out.push((id, body));
        }
        out
    }
}

fn features_cache() -> &'static Mutex<HashMap<String, Vec<String>>> {
    static C: OnceLock<Mutex<HashMap<String, Vec<String>>>> = OnceLock::new();
    C.get_or_init(Default::default)
}

/// Device features, asked once per serial (a reconnected device may have updated: callers
/// that open a new pane call `forget_features`).
pub async fn features(device: &AdbDevice) -> Vec<String> {
    let key = format!("{}/{}", device.route.key(), device.serial);
    if let Some(f) = features_cache().lock().ok().and_then(|c| c.get(&key).cloned()) {
        return f;
    }
    let f = super::client::features(&device.route, &device.serial).await.unwrap_or_default();
    if let Ok(mut c) = features_cache().lock() {
        c.insert(key, f.clone());
    }
    f
}

pub fn forget_features(device: &AdbDevice) {
    let key = format!("{}/{}", device.route.key(), device.serial);
    if let Ok(mut c) = features_cache().lock() {
        c.remove(&key);
    }
}

pub async fn has_v2(device: &AdbDevice) -> bool {
    features(device).await.iter().any(|f| f == "shell_v2")
}

/// The service string for a command without a PTY (`raw`), or the interactive shell.
pub fn service(v2: bool, pty: bool, term: &str, command: &str) -> String {
    if v2 {
        format!("shell,v2,TERM={},{}:{}", term, if pty { "pty" } else { "raw" }, command)
    } else {
        format!("shell:{}", command)
    }
}

/// What a finished command produced.
pub struct ExecResult {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    /// None on legacy devices.
    pub code: Option<u8>,
}

pub async fn exec(device: &AdbDevice, command: &str, timeout: Duration) -> Result<ExecResult> {
    let v2 = has_v2(device).await;
    let mut s = device.open(&service(v2, false, "dumb", command)).await?;
    let work = async {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut code = None;
        let mut dec = PacketDecoder::default();
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = s.read(&mut buf).await.context("设备连接中断")?;
            if n == 0 {
                break;
            }
            if !v2 {
                stdout.extend_from_slice(&buf[..n]);
                continue;
            }
            for (id, body) in dec.feed(&buf[..n]) {
                match id {
                    ID_STDOUT => stdout.extend_from_slice(&body),
                    ID_STDERR => stderr.extend_from_slice(&body),
                    ID_EXIT => code = body.first().copied(),
                    _ => {}
                }
            }
            if code.is_some() {
                break;
            }
        }
        anyhow::Ok(ExecResult { stdout, stderr, code })
    };
    tokio::time::timeout(timeout, work).await.context("设备命令执行超时")?
}

/// stdout of a command; a non-zero exit is an error with stderr (like `SshLink::exec_output`).
pub async fn exec_output(device: &AdbDevice, command: &str) -> Result<String> {
    exec_output_timeout(device, command, Duration::from_secs(15)).await
}

pub async fn exec_output_timeout(device: &AdbDevice, command: &str, timeout: Duration) -> Result<String> {
    let r = exec(device, command, timeout).await?;
    let text = String::from_utf8_lossy(&r.stdout).to_string();
    match r.code {
        Some(0) | None => Ok(text),
        Some(code) => {
            let stderr = String::from_utf8_lossy(&r.stderr);
            bail!("命令退出码 {}: {}", code, format!("{}\n{}", stderr.trim(), text.trim()).trim())
        }
    }
}

/// Write stdin then close it (v2 only), e.g. to feed a file to `sh`.
pub async fn send_stdin(stream: &mut crate::net::BoxedStream, v2: bool, data: &[u8]) -> Result<()> {
    if v2 {
        stream.write_all(&encode_packet(ID_STDIN, data)).await?;
    } else {
        stream.write_all(data).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packets_round_trip_across_splits() {
        let mut wire = encode_packet(ID_STDOUT, b"hello");
        wire.extend(encode_packet(ID_STDERR, b""));
        wire.extend(encode_packet(ID_EXIT, &[3]));
        let mut dec = PacketDecoder::default();
        let mut got = Vec::new();
        for chunk in wire.chunks(3) {
            got.extend(dec.feed(chunk));
        }
        assert_eq!(got, vec![(ID_STDOUT, b"hello".to_vec()), (ID_STDERR, vec![]), (ID_EXIT, vec![3])]);
    }

    #[test]
    fn resize_packet() {
        let p = encode_resize(120, 40);
        assert_eq!(p[0], ID_WINDOW_SIZE);
        assert_eq!(&p[5..], b"40x120,0x0\0");
        assert_eq!(u32::from_le_bytes([p[1], p[2], p[3], p[4]]) as usize, p.len() - 5);
    }

    #[test]
    fn services() {
        assert_eq!(service(true, true, "xterm-256color", ""), "shell,v2,TERM=xterm-256color,pty:");
        assert_eq!(service(true, false, "dumb", "ls"), "shell,v2,TERM=dumb,raw:ls");
        assert_eq!(service(false, false, "dumb", "ls"), "shell:ls");
    }
}
