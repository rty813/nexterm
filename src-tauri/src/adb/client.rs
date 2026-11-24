//! adb server requests: a 4-digit hex length + ASCII payload, answered by `OKAY` or `FAIL`
//! + a hex-length message. Device services are reached by first switching the socket to a
//! device (`host:transport:<serial>`), after which it carries that service's raw bytes.

use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;

use super::route::Route;
use super::SERVER;
use crate::net::BoxedStream;

/// One request on the wire.
pub fn encode_request(payload: &str) -> Vec<u8> {
    let mut out = format!("{:04x}", payload.len()).into_bytes();
    out.extend_from_slice(payload.as_bytes());
    out
}

async fn read_exact4<S: AsyncRead + Unpin>(s: &mut S) -> Result<[u8; 4]> {
    let mut b = [0u8; 4];
    s.read_exact(&mut b).await.context("adb server 连接中断")?;
    Ok(b)
}

/// A hex length followed by that many bytes (the body of most host replies).
pub async fn read_block<S: AsyncRead + Unpin>(s: &mut S) -> Result<String> {
    let len = read_exact4(s).await?;
    let len = usize::from_str_radix(std::str::from_utf8(&len).unwrap_or(""), 16).context("adb server 回复格式错误")?;
    let mut body = vec![0u8; len];
    s.read_exact(&mut body).await.context("adb server 连接中断")?;
    Ok(String::from_utf8_lossy(&body).into_owned())
}

/// `OKAY`, or the server's `FAIL` message as the error.
pub async fn read_status<S: AsyncRead + Unpin>(s: &mut S) -> Result<()> {
    match &read_exact4(s).await? {
        b"OKAY" => Ok(()),
        b"FAIL" => {
            let msg = read_block(s).await.unwrap_or_default();
            bail!("{}", describe_failure(&msg))
        }
        other => bail!("adb server 回复格式错误（{}）", String::from_utf8_lossy(other)),
    }
}

/// The server's messages, in the words a user would understand.
fn describe_failure(msg: &str) -> String {
    let m = msg.trim();
    if m.starts_with("device unauthorized") {
        "设备未授权：请在手机上允许 USB 调试（勾选“一律允许”）".into()
    } else if m.starts_with("device offline") {
        "设备离线：请重新插拔 USB 或重新连接".into()
    } else if (m.starts_with("device '") && m.ends_with("' not found")) || m == "device not found" {
        format!("找不到设备（{}）", m)
    } else if m.starts_with("more than one device") {
        "连接了多台设备，请在会话里选择一台".into()
    } else if m.starts_with("no devices") {
        "没有已连接的 Android 设备".into()
    } else {
        m.to_string()
    }
}

async fn send<S: AsyncWrite + Unpin>(s: &mut S, payload: &str) -> Result<()> {
    s.write_all(&encode_request(payload)).await.context("adb server 连接中断")
}

/// Serializes server starts so two panes opening at once do not both run `start-server`.
fn start_lock() -> &'static tokio::sync::Mutex<()> {
    static L: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    L.get_or_init(Default::default)
}

async fn dial() -> std::io::Result<TcpStream> {
    match tokio::time::timeout(Duration::from_secs(3), TcpStream::connect(SERVER)).await {
        Ok(r) => r,
        Err(_) => Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "timeout")),
    }
}

/// A socket to the adb server `route` points at.
pub async fn server(route: &Route) -> Result<BoxedStream> {
    match route {
        Route::Local => Ok(Box::new(connect_server().await?)),
        Route::Ssh(r) => r.connect().await,
    }
}

/// A socket to the adb server, starting it (adb.exe start-server) when nothing listens.
pub async fn connect_server() -> Result<TcpStream> {
    if let Ok(s) = dial().await {
        let _ = s.set_nodelay(true);
        return Ok(s);
    }
    let _guard = start_lock().lock().await;
    if let Ok(s) = dial().await {
        return Ok(s);
    }
    super::locate::start_server().await?;
    let s = dial().await.context("adb server 已启动，但无法连接 127.0.0.1:5037")?;
    let _ = s.set_nodelay(true);
    Ok(s)
}

/// A `host:` request whose reply is `OKAY` + a block.
pub async fn host_query(route: &Route, request: &str) -> Result<String> {
    let mut s = server(route).await?;
    send(&mut s, request).await?;
    read_status(&mut s).await?;
    read_block(&mut s).await
}

/// Server protocol version (41 for current platform-tools).
pub async fn version(route: &Route) -> Result<u32> {
    let v = host_query(route, "host:version").await?;
    u32::from_str_radix(v.trim(), 16).context("adb server 版本格式错误")
}

/// Version without starting a server: None when nothing listens on 5037.
pub async fn running_version() -> Option<u32> {
    let mut s = dial().await.ok()?;
    send(&mut s, "host:version").await.ok()?;
    read_status(&mut s).await.ok()?;
    u32::from_str_radix(read_block(&mut s).await.ok()?.trim(), 16).ok()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub serial: String,
    /// "device" (ready), "unauthorized", "offline", "recovery", "sideload", "authorizing", ...
    pub state: String,
    pub model: String,
    pub product: String,
    pub device: String,
    /// "usb" | "tcp" (WLAN / emulator over TCP)
    pub transport: String,
}

/// `host:devices-l` lines: `<serial>  <state> usb:1-1 product:x model:Pixel_7 device:y transport_id:3`.
pub fn parse_devices(text: &str) -> Vec<DeviceInfo> {
    let mut out = Vec::new();
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let (Some(serial), Some(state)) = (parts.next(), parts.next()) else { continue };
        let mut info = DeviceInfo {
            serial: serial.to_string(),
            state: state.to_string(),
            model: String::new(),
            product: String::new(),
            device: String::new(),
            transport: String::new(),
        };
        let mut usb = false;
        for p in parts {
            match p.split_once(':') {
                Some(("usb", _)) => usb = true,
                Some(("model", v)) => info.model = v.replace('_', " "),
                Some(("product", v)) => info.product = v.to_string(),
                Some(("device", v)) => info.device = v.to_string(),
                Some(_) => {}
                // "no permissions (...)" spills into more words.
                None => {
                    info.state.push(' ');
                    info.state.push_str(p);
                }
            }
        }
        info.transport = if usb || !is_network_serial(serial) { "usb" } else { "tcp" }.into();
        out.push(info);
    }
    out
}

/// "192.168.1.5:5555", "[fe80::1]:5555", or an mDNS name (`adb-XXXX._adb-tls-connect._tcp`).
pub fn is_network_serial(serial: &str) -> bool {
    if serial.contains("._adb-tls-connect.") || serial.contains("._adb._tcp") {
        return true;
    }
    match serial.rsplit_once(':') {
        Some((host, port)) => !host.is_empty() && port.parse::<u16>().is_ok(),
        None => false,
    }
}

pub async fn devices(route: &Route) -> Result<Vec<DeviceInfo>> {
    Ok(parse_devices(&host_query(route, "host:devices-l").await?))
}

/// A socket on which the server sends the device list (one block) whenever it changes.
pub async fn track_devices() -> Result<TcpStream> {
    let mut s = connect_server().await?;
    send(&mut s, "host:track-devices-l").await?;
    read_status(&mut s).await?;
    Ok(s)
}

/// `adb connect host:port`. The server answers OKAY even when the connection failed, so
/// the message decides.
pub async fn connect_network(route: &Route, addr: &str) -> Result<String> {
    let msg = host_query(route, &format!("host:connect:{}", addr)).await?;
    let lower = msg.to_ascii_lowercase();
    if lower.starts_with("connected to") || lower.starts_with("already connected") {
        Ok(msg.trim().to_string())
    } else {
        bail!("无法连接 {}：{}", addr, msg.trim())
    }
}

pub async fn disconnect_network(route: &Route, addr: &str) -> Result<String> {
    Ok(host_query(route, &format!("host:disconnect:{}", addr)).await?.trim().to_string())
}

/// Device features ("shell_v2", "stat_v2", "ls_v2", "cmd", ...).
pub async fn features(route: &Route, serial: &str) -> Result<Vec<String>> {
    let f = host_query(route, &format!("host-serial:{}:features", serial)).await?;
    Ok(f.trim().split(',').filter(|s| !s.is_empty()).map(str::to_string).collect())
}

/// Switch a fresh server socket to `serial` and open `service` there.
pub async fn open_device(route: &Route, serial: &str, service: &str) -> Result<BoxedStream> {
    let mut s = server(route).await?;
    send(&mut s, &format!("host:transport:{}", serial)).await?;
    read_status(&mut s).await?;
    send(&mut s, service).await?;
    let name = service.split([':', ',']).next().unwrap_or(service).to_string();
    read_status(&mut s).await.with_context(|| format!("设备拒绝了请求 {}", name))?;
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_has_hex_length() {
        assert_eq!(encode_request("host:version"), b"000chost:version".to_vec());
    }

    #[test]
    fn parses_devices_l() {
        let text = "R5CT10ABCDE            device usb:1-1 product:o1sxeea model:SM_G991B device:o1s transport_id:3\n\
                    192.168.1.5:5555       device product:redfin model:Pixel_5 device:redfin transport_id:4\n\
                    emulator-5554          offline transport_id:5\n\
                    0123456789             unauthorized usb:1-2 transport_id:6\n";
        let list = parse_devices(text);
        assert_eq!(list.len(), 4);
        assert_eq!(list[0].model, "SM G991B");
        assert_eq!(list[0].transport, "usb");
        assert_eq!(list[1].transport, "tcp");
        assert_eq!(list[1].state, "device");
        assert_eq!(list[2].state, "offline");
        assert_eq!(list[2].transport, "usb");
        assert_eq!(list[3].state, "unauthorized");
    }

    #[test]
    fn network_serials() {
        assert!(is_network_serial("10.0.0.2:5555"));
        assert!(is_network_serial("[fe80::1]:5555"));
        assert!(is_network_serial("adb-R5CT-abc._adb-tls-connect._tcp"));
        assert!(!is_network_serial("emulator-5554"));
        assert!(!is_network_serial("R5CT10ABCDE"));
    }

    #[tokio::test]
    async fn status_reads_fail_message() {
        let mut ok: &[u8] = b"OKAY";
        assert!(read_status(&mut ok).await.is_ok());
        let mut fail: &[u8] = b"FAIL0013device unauthorized";
        let err = read_status(&mut fail).await.unwrap_err().to_string();
        assert!(err.contains("未授权"), "{err}");
        let mut block: &[u8] = b"0004abcd";
        assert_eq!(read_block(&mut block).await.unwrap(), "abcd");
    }

    /// A fake server: checks the transport switch and the service request.
    #[tokio::test]
    async fn open_device_round_trip() {
        use tokio::net::TcpListener;
        let Ok(listener) = TcpListener::bind(SERVER).await else {
            return; // a real adb server is running here; nothing to fake.
        };
        let server = tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 4];
            s.read_exact(&mut buf).await.unwrap();
            let n = usize::from_str_radix(std::str::from_utf8(&buf).unwrap(), 16).unwrap();
            let mut req = vec![0u8; n];
            s.read_exact(&mut req).await.unwrap();
            assert_eq!(req, b"host:transport:ABC");
            s.write_all(b"OKAY").await.unwrap();
            s.read_exact(&mut buf).await.unwrap();
            let n = usize::from_str_radix(std::str::from_utf8(&buf).unwrap(), 16).unwrap();
            let mut req = vec![0u8; n];
            s.read_exact(&mut req).await.unwrap();
            assert_eq!(req, b"sync:");
            s.write_all(b"FAIL0006closed").await.unwrap();
        });
        let err = match open_device(&Route::Local, "ABC", "sync:").await {
            Ok(_) => panic!("expected FAIL"),
            Err(e) => format!("{:#}", e),
        };
        assert!(err.contains("closed"), "{err}");
        server.await.unwrap();
    }
}
