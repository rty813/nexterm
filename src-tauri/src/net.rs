use std::pin::Pin;
use std::task::{Context as TaskContext, Poll};
use std::time::Duration;
use anyhow::{bail, Context, Result};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::TcpStream;

use crate::models::ProxyConfig;

/// A byte stream an SSH connection can run over (TCP socket or ProxyCommand pipes).
pub trait ByteStream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> ByteStream for T {}

pub type BoxedStream = Box<dyn ByteStream>;

/// Open a TCP connection to `host:port`, through `proxy` when one is configured.
/// ProxyCommand proxies are not TCP; use [`connect_stream`] for those.
pub async fn connect_tcp(
    host: &str,
    port: u16,
    proxy: Option<&ProxyConfig>,
    timeout: Duration,
) -> Result<TcpStream> {
    let work = async {
        match proxy.filter(|p| is_enabled(p)) {
            None => TcpStream::connect((host, port))
                .await
                .with_context(|| format!("无法连接到 {}:{}", host, port)),
            Some(p) if is_command(p) => bail!("ProxyCommand 只能用于 SSH 会话"),
            Some(p) => {
                let mut stream = TcpStream::connect((p.host.trim(), p.port))
                    .await
                    .with_context(|| format!("无法连接到代理服务器 {}:{}", p.host, p.port))?;
                proxy_handshake(&mut stream, host, port, p).await?;
                Ok(stream)
            }
        }
    };
    let stream = tokio::time::timeout(timeout, work)
        .await
        .with_context(|| format!("连接超时 ({}:{})", host, port))??;
    let _ = stream.set_nodelay(true);
    Ok(stream)
}

/// The first hop of an SSH connection: a TCP connection (direct or through a SOCKS / HTTP
/// proxy), or the stdin / stdout of a ProxyCommand.
pub async fn connect_stream(
    host: &str,
    port: u16,
    user: &str,
    proxy: Option<&ProxyConfig>,
    timeout: Duration,
) -> Result<BoxedStream> {
    match proxy.filter(|p| is_enabled(p)) {
        Some(p) if is_command(p) => {
            let cmd = expand_proxy_command(p.command.as_deref().unwrap_or(""), host, port, user);
            Ok(Box::new(CommandStream::spawn(&cmd)?))
        }
        other => Ok(Box::new(connect_tcp(host, port, other, timeout).await?)),
    }
}

pub fn is_enabled(p: &ProxyConfig) -> bool {
    let kind = p.kind.to_ascii_lowercase();
    if kind == "command" {
        return p.command.as_deref().is_some_and(|c| !c.trim().is_empty());
    }
    !(kind.is_empty() || kind == "none") && !p.host.trim().is_empty() && p.port != 0
}

fn is_command(p: &ProxyConfig) -> bool {
    p.kind.eq_ignore_ascii_case("command")
}

async fn proxy_handshake<S: AsyncRead + AsyncWrite + Unpin>(
    s: &mut S,
    host: &str,
    port: u16,
    p: &ProxyConfig,
) -> Result<()> {
    match p.kind.to_ascii_lowercase().as_str() {
        "socks5" => socks5_handshake(s, host, port, p).await,
        "socks4" => socks4_handshake(s, host, port, p).await,
        "http" => http_connect(s, host, port, p).await,
        other => bail!("不支持的代理类型: {}", other),
    }
}

// ---- SOCKS5 client (RFC 1928, username / password auth RFC 1929) ----

/// Method negotiation: no auth, plus username / password when credentials are set.
pub fn socks5_greeting(with_auth: bool) -> Vec<u8> {
    if with_auth {
        vec![5, 2, 0, 2]
    } else {
        vec![5, 1, 0]
    }
}

pub fn socks5_auth_request(user: &str, pass: &str) -> Result<Vec<u8>> {
    if user.len() > 255 || pass.len() > 255 {
        bail!("SOCKS5 用户名或密码过长");
    }
    let mut req = vec![1, user.len() as u8];
    req.extend_from_slice(user.as_bytes());
    req.push(pass.len() as u8);
    req.extend_from_slice(pass.as_bytes());
    Ok(req)
}

/// CONNECT request; host names are sent as is so the proxy resolves them.
pub fn socks5_connect_request(host: &str, port: u16) -> Result<Vec<u8>> {
    let mut req = vec![5, 1, 0];
    match host.trim_matches(|c| c == '[' || c == ']').parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => {
            req.push(1);
            req.extend_from_slice(&ip.octets());
        }
        Ok(std::net::IpAddr::V6(ip)) => {
            req.push(4);
            req.extend_from_slice(&ip.octets());
        }
        Err(_) => {
            if host.is_empty() || host.len() > 255 {
                bail!("目标主机名无效");
            }
            req.push(3);
            req.push(host.len() as u8);
            req.extend_from_slice(host.as_bytes());
        }
    }
    req.extend_from_slice(&port.to_be_bytes());
    Ok(req)
}

/// Length of the bound address that follows the 4-byte reply head (including the port).
pub fn socks5_reply_addr_len(head: &[u8; 4], domain_len: Option<u8>) -> Result<usize> {
    if head[0] != 5 {
        bail!("代理服务器不是 SOCKS5 代理");
    }
    if head[1] != 0 {
        bail!("SOCKS5 代理无法连接目标: {}", socks5_error(head[1]));
    }
    Ok(match head[3] {
        1 => 4 + 2,
        4 => 16 + 2,
        3 => domain_len.context("缺少域名长度")? as usize + 2,
        _ => bail!("SOCKS5 代理返回了无效的地址类型"),
    })
}

async fn socks5_handshake<S: AsyncRead + AsyncWrite + Unpin>(s: &mut S, host: &str, port: u16, p: &ProxyConfig) -> Result<()> {
    let user = p.username.as_deref().unwrap_or("");
    let pass = p.password.as_deref().unwrap_or("");
    let with_auth = !user.is_empty();
    s.write_all(&socks5_greeting(with_auth)).await?;
    let mut reply = [0u8; 2];
    s.read_exact(&mut reply).await.context("SOCKS5 代理无响应")?;
    if reply[0] != 5 {
        bail!("代理服务器不是 SOCKS5 代理");
    }
    match reply[1] {
        0 => {}
        2 if with_auth => {
            s.write_all(&socks5_auth_request(user, pass)?).await?;
            let mut auth = [0u8; 2];
            s.read_exact(&mut auth).await?;
            if auth[1] != 0 {
                bail!("SOCKS5 代理认证失败");
            }
        }
        2 => bail!("SOCKS5 代理要求用户名和密码"),
        0xff => bail!("SOCKS5 代理拒绝了所有认证方式"),
        m => bail!("SOCKS5 代理要求不支持的认证方式 ({})", m),
    }

    s.write_all(&socks5_connect_request(host, port)?).await?;
    let mut head = [0u8; 4];
    s.read_exact(&mut head).await.context("SOCKS5 代理连接失败")?;
    let domain_len = if head[3] == 3 && head[1] == 0 {
        let mut l = [0u8; 1];
        s.read_exact(&mut l).await?;
        Some(l[0])
    } else {
        None
    };
    let len = socks5_reply_addr_len(&head, domain_len)?;
    let mut rest = vec![0u8; len];
    s.read_exact(&mut rest).await?;
    Ok(())
}

pub fn socks5_error(code: u8) -> &'static str {
    match code {
        1 => "代理服务器内部错误",
        2 => "规则不允许该连接",
        3 => "网络不可达",
        4 => "主机不可达",
        5 => "连接被拒绝",
        6 => "TTL 过期",
        7 => "不支持的命令",
        8 => "不支持的地址类型",
        _ => "未知错误",
    }
}

// ---- SOCKS4 / 4a client ----

/// SOCKS4 CONNECT for an IPv4 address, SOCKS4a (0.0.0.1 + host name) otherwise.
pub fn socks4_connect_request(host: &str, port: u16, user: &str) -> Vec<u8> {
    let mut req = vec![4, 1];
    req.extend_from_slice(&port.to_be_bytes());
    let ip = host.parse::<std::net::Ipv4Addr>().ok();
    match ip {
        Some(ip) => req.extend_from_slice(&ip.octets()),
        None => req.extend_from_slice(&[0, 0, 0, 1]),
    }
    req.extend_from_slice(user.as_bytes());
    req.push(0);
    if ip.is_none() {
        req.extend_from_slice(host.as_bytes());
        req.push(0);
    }
    req
}

pub fn socks4_check_reply(reply: &[u8; 8]) -> Result<()> {
    if reply[1] != 0x5a {
        bail!("SOCKS4 代理拒绝了连接 (代码 {:#x})", reply[1]);
    }
    Ok(())
}

async fn socks4_handshake<S: AsyncRead + AsyncWrite + Unpin>(s: &mut S, host: &str, port: u16, p: &ProxyConfig) -> Result<()> {
    s.write_all(&socks4_connect_request(host, port, p.username.as_deref().unwrap_or(""))).await?;
    let mut reply = [0u8; 8];
    s.read_exact(&mut reply).await.context("SOCKS4 代理无响应")?;
    socks4_check_reply(&reply)
}

// ---- HTTP CONNECT ----

pub fn http_connect_request(host: &str, port: u16, user: Option<&str>, pass: Option<&str>) -> String {
    use base64::Engine;
    let target = if host.contains(':') && !host.starts_with('[') {
        format!("[{}]:{}", host, port)
    } else {
        format!("{}:{}", host, port)
    };
    let mut req = format!("CONNECT {t} HTTP/1.1\r\nHost: {t}\r\n", t = target);
    if let Some(user) = user.filter(|u| !u.is_empty()) {
        let token = base64::engine::general_purpose::STANDARD.encode(format!("{}:{}", user, pass.unwrap_or("")));
        req.push_str(&format!("Proxy-Authorization: Basic {}\r\n", token));
    }
    req.push_str("\r\n");
    req
}

/// Check the response head (status line + headers, up to and including the blank line).
pub fn parse_http_connect_response(head: &[u8]) -> Result<()> {
    let text = String::from_utf8_lossy(head);
    let status_line = text.lines().next().unwrap_or("").trim();
    let mut parts = status_line.split_whitespace();
    let version = parts.next().unwrap_or("");
    if !version.starts_with("HTTP/") {
        bail!("HTTP 代理返回了无效的响应: {}", status_line);
    }
    let code: u16 = parts.next().and_then(|c| c.parse().ok()).unwrap_or(0);
    match code {
        200..=299 => Ok(()),
        407 => bail!("HTTP 代理需要认证或认证失败: {}", status_line),
        _ => bail!("HTTP 代理拒绝了连接: {}", status_line),
    }
}

async fn http_connect<S: AsyncRead + AsyncWrite + Unpin>(s: &mut S, host: &str, port: u16, p: &ProxyConfig) -> Result<()> {
    let req = http_connect_request(host, port, p.username.as_deref(), p.password.as_deref());
    s.write_all(req.as_bytes()).await?;

    // Read the response head byte by byte so no tunnelled data is consumed.
    let mut head = Vec::with_capacity(256);
    let mut b = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if s.read(&mut b).await? == 0 {
            bail!("HTTP 代理关闭了连接");
        }
        head.push(b[0]);
        if head.len() > 16 * 1024 {
            bail!("HTTP 代理响应过长");
        }
    }
    parse_http_connect_response(&head)
}

// ---- ProxyCommand ----

/// OpenSSH tokens: %h host, %p port, %r remote user, %% a literal percent sign.
pub fn expand_proxy_command(cmd: &str, host: &str, port: u16, user: &str) -> String {
    let mut out = String::with_capacity(cmd.len() + 16);
    let mut chars = cmd.chars();
    while let Some(c) = chars.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('h') => out.push_str(host),
            Some('p') => out.push_str(&port.to_string()),
            Some('r') => out.push_str(user),
            Some('%') => out.push('%'),
            Some(other) => {
                out.push('%');
                out.push(other);
            }
            None => out.push('%'),
        }
    }
    out.trim().to_string()
}

/// A child process whose stdout / stdin are the connection (killed when dropped).
pub struct CommandStream {
    _child: tokio::process::Child,
    stdin: tokio::process::ChildStdin,
    stdout: tokio::process::ChildStdout,
}

impl CommandStream {
    pub fn spawn(command: &str) -> Result<Self> {
        if command.trim().is_empty() {
            bail!("未设置 ProxyCommand");
        }
        #[cfg(windows)]
        let mut cmd = {
            let mut c = tokio::process::Command::new("cmd.exe");
            // Passed verbatim: cmd.exe does its own parsing of quotes.
            c.raw_arg(format!("/D /S /C \"{}\"", command));
            c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
            c
        };
        #[cfg(not(windows))]
        let mut cmd = {
            let mut c = tokio::process::Command::new("/bin/sh");
            c.arg("-c").arg(command);
            c
        };
        cmd.stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        let mut child = cmd.spawn().with_context(|| format!("无法启动 ProxyCommand: {}", command))?;
        let stdin = child.stdin.take().context("ProxyCommand 没有标准输入")?;
        let stdout = child.stdout.take().context("ProxyCommand 没有标准输出")?;
        Ok(Self { _child: child, stdin, stdout })
    }
}

impl AsyncRead for CommandStream {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>, buf: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stdout).poll_read(cx, buf)
    }
}

impl AsyncWrite for CommandStream {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>, buf: &[u8]) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.stdin).poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stdin).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stdin).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[test]
    fn test_socks5_request_building() {
        assert_eq!(socks5_greeting(false), vec![5, 1, 0]);
        assert_eq!(socks5_greeting(true), vec![5, 2, 0, 2]);
        assert_eq!(socks5_auth_request("ab", "xyz").unwrap(), vec![1, 2, b'a', b'b', 3, b'x', b'y', b'z']);
        assert!(socks5_auth_request(&"u".repeat(256), "").is_err());

        assert_eq!(socks5_connect_request("10.1.2.3", 22).unwrap(), vec![5, 1, 0, 1, 10, 1, 2, 3, 0, 22]);
        let v6 = socks5_connect_request("[::1]", 443).unwrap();
        assert_eq!((v6[3], v6.len()), (4, 4 + 16 + 2));
        assert_eq!(v6[19], 1);
        let name = socks5_connect_request("example.com", 8080).unwrap();
        assert_eq!(&name[..5], &[5, 1, 0, 3, 11]);
        assert_eq!(&name[5..16], b"example.com");
        assert_eq!(&name[16..], &8080u16.to_be_bytes());
        assert!(socks5_connect_request("", 1).is_err());
    }

    #[test]
    fn test_socks5_reply_parsing() {
        assert_eq!(socks5_reply_addr_len(&[5, 0, 0, 1], None).unwrap(), 6);
        assert_eq!(socks5_reply_addr_len(&[5, 0, 0, 4], None).unwrap(), 18);
        assert_eq!(socks5_reply_addr_len(&[5, 0, 0, 3], Some(9)).unwrap(), 11);
        let err = socks5_reply_addr_len(&[5, 5, 0, 1], None).unwrap_err().to_string();
        assert!(err.contains("连接被拒绝"), "{err}");
        assert!(socks5_reply_addr_len(&[4, 0, 0, 1], None).is_err());
        assert!(socks5_reply_addr_len(&[5, 0, 0, 9], None).is_err());
    }

    #[test]
    fn test_socks4_request_and_reply() {
        assert_eq!(socks4_connect_request("1.2.3.4", 80, "bob"), vec![4, 1, 0, 80, 1, 2, 3, 4, b'b', b'o', b'b', 0]);
        // 4a: 0.0.0.1, empty user id, host name.
        assert_eq!(socks4_connect_request("h.io", 22, ""), vec![4, 1, 0, 22, 0, 0, 0, 1, 0, b'h', b'.', b'i', b'o', 0]);
        assert!(socks4_check_reply(&[0, 0x5a, 0, 0, 0, 0, 0, 0]).is_ok());
        assert!(socks4_check_reply(&[0, 0x5b, 0, 0, 0, 0, 0, 0]).is_err());
    }

    #[test]
    fn test_http_connect_request_and_response() {
        assert_eq!(
            http_connect_request("srv", 22, None, None),
            "CONNECT srv:22 HTTP/1.1\r\nHost: srv:22\r\n\r\n"
        );
        assert_eq!(
            http_connect_request("::1", 22, Some(""), None),
            "CONNECT [::1]:22 HTTP/1.1\r\nHost: [::1]:22\r\n\r\n"
        );
        // base64("user:pa:ss")
        let req = http_connect_request("srv", 22, Some("user"), Some("pa:ss"));
        assert!(req.contains("Proxy-Authorization: Basic dXNlcjpwYTpzcw==\r\n"), "{req}");
        assert!(req.ends_with("\r\n\r\n"));

        assert!(parse_http_connect_response(b"HTTP/1.1 200 Connection established\r\n\r\n").is_ok());
        assert!(parse_http_connect_response(b"HTTP/1.0 200 OK\r\nProxy-Agent: x\r\n\r\n").is_ok());
        let e = parse_http_connect_response(b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n").unwrap_err();
        assert!(e.to_string().contains("认证"));
        assert!(parse_http_connect_response(b"HTTP/1.1 403 Forbidden\r\n\r\n").is_err());
        assert!(parse_http_connect_response(b"SSH-2.0-OpenSSH\r\n\r\n").is_err());
    }

    #[test]
    fn test_expand_proxy_command_and_enabled() {
        assert_eq!(
            expand_proxy_command("ncat --proxy p:8080 %h %p -u %r 100%%", "srv", 2222, "root"),
            "ncat --proxy p:8080 srv 2222 -u root 100%"
        );
        assert_eq!(expand_proxy_command("x %z %", "h", 1, "u"), "x %z %");
        let mut p = ProxyConfig { kind: "command".into(), ..Default::default() };
        assert!(!is_enabled(&p));
        p.command = Some("ssh -W %h:%p bastion".into());
        assert!(is_enabled(&p));
        assert!(!is_enabled(&ProxyConfig { kind: "socks5".into(), host: "h".into(), ..Default::default() }));
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn test_proxy_command_stream_round_trip() {
        let mut s = CommandStream::spawn("cat").unwrap();
        s.write_all(b"ping").await.unwrap();
        let mut buf = [0u8; 4];
        s.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"ping");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn test_proxy_command_stream_round_trip() {
        let mut s = CommandStream::spawn("echo ping").unwrap();
        let mut buf = [0u8; 4];
        tokio::time::timeout(Duration::from_secs(10), s.read_exact(&mut buf)).await.unwrap().unwrap();
        assert_eq!(&buf, b"ping");
    }

    /// Minimal SOCKS5 + HTTP CONNECT proxies that forward to an echo server.
    async fn spawn_echo() -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut c, _)) = l.accept().await {
                tokio::spawn(async move {
                    let mut buf = [0u8; 64];
                    while let Ok(n) = c.read(&mut buf).await {
                        if n == 0 || c.write_all(&buf[..n]).await.is_err() {
                            break;
                        }
                    }
                });
            }
        });
        port
    }

    #[tokio::test]
    async fn test_socks5_and_http_proxy_tunnel() {
        let echo = spawn_echo().await;

        let socks = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let socks_port = socks.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut c, _) = socks.accept().await.unwrap();
            let mut greet = [0u8; 3];
            c.read_exact(&mut greet).await.unwrap();
            c.write_all(&[5, 0]).await.unwrap();
            let mut head = [0u8; 4];
            c.read_exact(&mut head).await.unwrap();
            assert_eq!(head[3], 3, "domain name should be sent to the proxy");
            let mut len = [0u8; 1];
            c.read_exact(&mut len).await.unwrap();
            let mut rest = vec![0u8; len[0] as usize + 2];
            c.read_exact(&mut rest).await.unwrap();
            let port = u16::from_be_bytes([rest[rest.len() - 2], rest[rest.len() - 1]]);
            let mut up = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            c.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await.unwrap();
            let _ = tokio::io::copy_bidirectional(&mut c, &mut up).await;
        });
        let p = ProxyConfig { kind: "socks5".into(), host: "127.0.0.1".into(), port: socks_port, ..Default::default() };
        let mut s = connect_tcp("localhost", echo, Some(&p), Duration::from_secs(5)).await.unwrap();
        s.write_all(b"via-socks").await.unwrap();
        let mut buf = [0u8; 9];
        s.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"via-socks");

        let http = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let http_port = http.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut c, _) = http.accept().await.unwrap();
            let mut head = Vec::new();
            let mut b = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") {
                c.read_exact(&mut b).await.unwrap();
                head.push(b[0]);
            }
            let line = String::from_utf8_lossy(&head).lines().next().unwrap().to_string();
            let target = line.split_whitespace().nth(1).unwrap().to_string();
            let port: u16 = target.rsplit(':').next().unwrap().parse().unwrap();
            let mut up = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            c.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n").await.unwrap();
            let _ = tokio::io::copy_bidirectional(&mut c, &mut up).await;
        });
        let p = ProxyConfig { kind: "http".into(), host: "127.0.0.1".into(), port: http_port, ..Default::default() };
        let mut s = connect_tcp("127.0.0.1", echo, Some(&p), Duration::from_secs(5)).await.unwrap();
        s.write_all(b"via-http").await.unwrap();
        let mut buf = [0u8; 8];
        s.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"via-http");
    }
}
