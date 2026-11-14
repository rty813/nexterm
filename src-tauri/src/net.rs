use std::time::Duration;
use anyhow::{bail, Context, Result};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::models::ProxyConfig;

/// Open a TCP connection to `host:port`, through `proxy` when one is configured.
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
            Some(p) => {
                let mut stream = TcpStream::connect((p.host.trim(), p.port))
                    .await
                    .with_context(|| format!("无法连接到代理服务器 {}:{}", p.host, p.port))?;
                match p.kind.to_ascii_lowercase().as_str() {
                    "socks5" => socks5_handshake(&mut stream, host, port, p).await?,
                    "socks4" => socks4_handshake(&mut stream, host, port, p).await?,
                    "http" => http_connect(&mut stream, host, port, p).await?,
                    other => bail!("不支持的代理类型: {}", other),
                }
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

pub fn is_enabled(p: &ProxyConfig) -> bool {
    let kind = p.kind.to_ascii_lowercase();
    !(kind.is_empty() || kind == "none") && !p.host.trim().is_empty() && p.port != 0
}

/// RFC 1928 CONNECT with optional RFC 1929 username/password auth; the proxy resolves the name.
async fn socks5_handshake(s: &mut TcpStream, host: &str, port: u16, p: &ProxyConfig) -> Result<()> {
    let user = p.username.as_deref().unwrap_or("");
    let pass = p.password.as_deref().unwrap_or("");
    let with_auth = !user.is_empty();
    if with_auth {
        s.write_all(&[5, 2, 0, 2]).await?;
    } else {
        s.write_all(&[5, 1, 0]).await?;
    }
    let mut reply = [0u8; 2];
    s.read_exact(&mut reply).await.context("SOCKS5 代理无响应")?;
    if reply[0] != 5 {
        bail!("代理服务器不是 SOCKS5 代理");
    }
    match reply[1] {
        0 => {}
        2 if with_auth => {
            if user.len() > 255 || pass.len() > 255 {
                bail!("SOCKS5 用户名或密码过长");
            }
            let mut req = vec![1, user.len() as u8];
            req.extend_from_slice(user.as_bytes());
            req.push(pass.len() as u8);
            req.extend_from_slice(pass.as_bytes());
            s.write_all(&req).await?;
            let mut auth = [0u8; 2];
            s.read_exact(&mut auth).await?;
            if auth[1] != 0 {
                bail!("SOCKS5 代理认证失败");
            }
        }
        0xff => bail!("SOCKS5 代理拒绝了所有认证方式"),
        m => bail!("SOCKS5 代理要求不支持的认证方式 ({})", m),
    }

    if host.len() > 255 {
        bail!("目标主机名过长");
    }
    let mut req = vec![5, 1, 0];
    match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => {
            req.push(1);
            req.extend_from_slice(&ip.octets());
        }
        Ok(std::net::IpAddr::V6(ip)) => {
            req.push(4);
            req.extend_from_slice(&ip.octets());
        }
        Err(_) => {
            req.push(3);
            req.push(host.len() as u8);
            req.extend_from_slice(host.as_bytes());
        }
    }
    req.extend_from_slice(&port.to_be_bytes());
    s.write_all(&req).await?;

    let mut head = [0u8; 4];
    s.read_exact(&mut head).await.context("SOCKS5 代理连接失败")?;
    if head[1] != 0 {
        bail!("SOCKS5 代理无法连接目标: {}", socks5_error(head[1]));
    }
    let addr_len = match head[3] {
        1 => 4,
        4 => 16,
        3 => {
            let mut l = [0u8; 1];
            s.read_exact(&mut l).await?;
            l[0] as usize
        }
        _ => bail!("SOCKS5 代理返回了无效的地址类型"),
    };
    let mut rest = vec![0u8; addr_len + 2];
    s.read_exact(&mut rest).await?;
    Ok(())
}

fn socks5_error(code: u8) -> &'static str {
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

/// SOCKS4a: IPv4 directly, otherwise let the proxy resolve the host name.
async fn socks4_handshake(s: &mut TcpStream, host: &str, port: u16, p: &ProxyConfig) -> Result<()> {
    let mut req = vec![4, 1];
    req.extend_from_slice(&port.to_be_bytes());
    let ip = host.parse::<std::net::Ipv4Addr>().ok();
    match ip {
        Some(ip) => req.extend_from_slice(&ip.octets()),
        None => req.extend_from_slice(&[0, 0, 0, 1]),
    }
    req.extend_from_slice(p.username.as_deref().unwrap_or("").as_bytes());
    req.push(0);
    if ip.is_none() {
        req.extend_from_slice(host.as_bytes());
        req.push(0);
    }
    s.write_all(&req).await?;
    let mut reply = [0u8; 8];
    s.read_exact(&mut reply).await.context("SOCKS4 代理无响应")?;
    if reply[1] != 0x5a {
        bail!("SOCKS4 代理拒绝了连接 (代码 {})", reply[1]);
    }
    Ok(())
}

async fn http_connect(s: &mut TcpStream, host: &str, port: u16, p: &ProxyConfig) -> Result<()> {
    use base64::Engine;
    let target = if host.contains(':') {
        format!("[{}]:{}", host, port)
    } else {
        format!("{}:{}", host, port)
    };
    let mut req = format!("CONNECT {t} HTTP/1.1\r\nHost: {t}\r\n", t = target);
    if let Some(user) = p.username.as_deref().filter(|u| !u.is_empty()) {
        let token = base64::engine::general_purpose::STANDARD
            .encode(format!("{}:{}", user, p.password.as_deref().unwrap_or("")));
        req.push_str(&format!("Proxy-Authorization: Basic {}\r\n", token));
    }
    req.push_str("\r\n");
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
    let text = String::from_utf8_lossy(&head);
    let status_line = text.lines().next().unwrap_or("");
    let code = status_line.split_whitespace().nth(1).unwrap_or("");
    if !code.starts_with('2') {
        bail!("HTTP 代理拒绝了连接: {}", status_line.trim());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

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
