//! Server side of SOCKS4 / SOCKS4a / SOCKS5 (CONNECT only, no auth) for dynamic (-D)
//! port forwarding. The parsers are pure functions over the bytes received so far; the
//! async [`accept`] drives them over a socket.

use anyhow::{bail, Result};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Requests larger than this are refused (user id + host name are tiny in practice).
const MAX_REQUEST: usize = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SocksVersion {
    V4,
    V5,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SocksRequest {
    pub version: SocksVersion,
    pub host: String,
    pub port: u16,
}

/// Why a request was refused: the reply to send (if any) and a description.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SocksRefusal {
    pub reply: Vec<u8>,
    pub reason: &'static str,
}

impl std::fmt::Display for SocksRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.reason)
    }
}

impl std::error::Error for SocksRefusal {}

fn refuse(reply: Vec<u8>, reason: &'static str) -> SocksRefusal {
    SocksRefusal { reply, reason }
}

/// `Ok(None)`: more bytes are needed. `Ok(Some((value, consumed)))`: parsed.
pub type Parsed<T> = std::result::Result<Option<(T, usize)>, SocksRefusal>;

/// SOCKS4 / 4a request: VN=4 CD PORT(2) IP(4) USERID\0 [HOST\0 when IP is 0.0.0.x, x != 0].
pub fn parse_socks4_request(buf: &[u8]) -> Parsed<SocksRequest> {
    if buf.len() < 8 {
        return Ok(None);
    }
    if buf[0] != 4 {
        return Err(refuse(Vec::new(), "not a SOCKS4 request"));
    }
    if buf[1] != 1 {
        return Err(refuse(socks4_reply(false).to_vec(), "only CONNECT is supported"));
    }
    let port = u16::from_be_bytes([buf[2], buf[3]]);
    let ip = [buf[4], buf[5], buf[6], buf[7]];
    let Some(user_end) = buf[8..].iter().position(|&b| b == 0).map(|i| 8 + i) else {
        return Ok(None);
    };
    let is_4a = ip[0] == 0 && ip[1] == 0 && ip[2] == 0 && ip[3] != 0;
    if !is_4a {
        let host = std::net::Ipv4Addr::from(ip).to_string();
        return Ok(Some((SocksRequest { version: SocksVersion::V4, host, port }, user_end + 1)));
    }
    let start = user_end + 1;
    let Some(host_end) = buf[start..].iter().position(|&b| b == 0).map(|i| start + i) else {
        return Ok(None);
    };
    let host = String::from_utf8_lossy(&buf[start..host_end]).to_string();
    if host.is_empty() {
        return Err(refuse(socks4_reply(false).to_vec(), "empty host name"));
    }
    Ok(Some((SocksRequest { version: SocksVersion::V4, host, port }, host_end + 1)))
}

/// SOCKS5 method negotiation: VER=5 NMETHODS METHODS... Returns the offered methods.
pub fn parse_socks5_greeting(buf: &[u8]) -> Parsed<Vec<u8>> {
    if buf.len() < 2 {
        return Ok(None);
    }
    if buf[0] != 5 {
        return Err(refuse(Vec::new(), "not a SOCKS5 greeting"));
    }
    let n = buf[1] as usize;
    if buf.len() < 2 + n {
        return Ok(None);
    }
    Ok(Some((buf[2..2 + n].to_vec(), 2 + n)))
}

/// The method this server picks: 0 (no auth) when offered, else 0xFF (none acceptable).
pub fn socks5_choose_method(methods: &[u8]) -> u8 {
    if methods.contains(&0) {
        0
    } else {
        0xff
    }
}

/// SOCKS5 request: VER=5 CMD RSV ATYP ADDR PORT(2).
pub fn parse_socks5_request(buf: &[u8]) -> Parsed<SocksRequest> {
    if buf.len() < 4 {
        return Ok(None);
    }
    if buf[0] != 5 {
        return Err(refuse(socks5_reply(1).to_vec(), "bad SOCKS5 request"));
    }
    if buf[1] != 1 {
        return Err(refuse(socks5_reply(7).to_vec(), "only CONNECT is supported"));
    }
    let (host, addr_end) = match buf[3] {
        1 => {
            if buf.len() < 4 + 4 {
                return Ok(None);
            }
            (std::net::Ipv4Addr::new(buf[4], buf[5], buf[6], buf[7]).to_string(), 8)
        }
        4 => {
            if buf.len() < 4 + 16 {
                return Ok(None);
            }
            let mut ip = [0u8; 16];
            ip.copy_from_slice(&buf[4..20]);
            (std::net::Ipv6Addr::from(ip).to_string(), 20)
        }
        3 => {
            if buf.len() < 5 {
                return Ok(None);
            }
            let len = buf[4] as usize;
            if len == 0 {
                return Err(refuse(socks5_reply(1).to_vec(), "empty host name"));
            }
            if buf.len() < 5 + len {
                return Ok(None);
            }
            (String::from_utf8_lossy(&buf[5..5 + len]).to_string(), 5 + len)
        }
        _ => return Err(refuse(socks5_reply(8).to_vec(), "unsupported address type")),
    };
    if buf.len() < addr_end + 2 {
        return Ok(None);
    }
    let port = u16::from_be_bytes([buf[addr_end], buf[addr_end + 1]]);
    Ok(Some((SocksRequest { version: SocksVersion::V5, host, port }, addr_end + 2)))
}

/// SOCKS5 reply with REP `code` and an all-zero IPv4 bound address.
pub fn socks5_reply(code: u8) -> [u8; 10] {
    [5, code, 0, 1, 0, 0, 0, 0, 0, 0]
}

/// SOCKS4 reply: 0x5A granted, 0x5B rejected.
pub fn socks4_reply(ok: bool) -> [u8; 8] {
    [0, if ok { 0x5a } else { 0x5b }, 0, 0, 0, 0, 0, 0]
}

/// The reply that ends the handshake once the forward channel opened (or failed).
pub fn final_reply(version: SocksVersion, ok: bool) -> Vec<u8> {
    match version {
        SocksVersion::V4 => socks4_reply(ok).to_vec(),
        // 5 = connection refused: the closest code for "the server could not open the channel".
        SocksVersion::V5 => socks5_reply(if ok { 0 } else { 5 }).to_vec(),
    }
}

/// Read more bytes into `buf`, failing on EOF or an oversized request.
async fn fill<S: AsyncRead + Unpin>(s: &mut S, buf: &mut Vec<u8>) -> Result<()> {
    if buf.len() >= MAX_REQUEST {
        bail!("SOCKS request too large");
    }
    let mut chunk = [0u8; 512];
    let n = s.read(&mut chunk).await?;
    if n == 0 {
        bail!("client closed the connection");
    }
    buf.extend_from_slice(&chunk[..n]);
    Ok(())
}

async fn parse_or_fill<S, T>(s: &mut S, buf: &mut Vec<u8>, parse: fn(&[u8]) -> Parsed<T>) -> Result<(T, usize)>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    loop {
        match parse(buf) {
            Ok(Some(v)) => return Ok(v),
            Ok(None) => fill(s, buf).await?,
            Err(refusal) => {
                if !refusal.reply.is_empty() {
                    let _ = s.write_all(&refusal.reply).await;
                }
                return Err(refusal.into());
            }
        }
    }
}

/// Run the handshake up to (not including) the final reply. Returns the request and any
/// bytes the client already sent after it (to be forwarded first).
pub async fn accept<S: AsyncRead + AsyncWrite + Unpin>(s: &mut S) -> Result<(SocksRequest, Vec<u8>)> {
    let mut buf = Vec::with_capacity(64);
    fill(s, &mut buf).await?;
    match buf[0] {
        4 => {
            let (req, used) = parse_or_fill(s, &mut buf, parse_socks4_request).await?;
            Ok((req, buf.split_off(used)))
        }
        5 => {
            let (methods, used) = parse_or_fill(s, &mut buf, parse_socks5_greeting).await?;
            buf.drain(..used);
            let method = socks5_choose_method(&methods);
            s.write_all(&[5, method]).await?;
            if method != 0 {
                bail!("client offered no acceptable SOCKS5 auth method");
            }
            let (req, used) = parse_or_fill(s, &mut buf, parse_socks5_request).await?;
            Ok((req, buf.split_off(used)))
        }
        v => bail!("unsupported SOCKS version {}", v),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_socks4_and_4a() {
        let req = [4, 1, 0, 80, 10, 0, 0, 7, b'u', 0];
        let (r, used) = parse_socks4_request(&req).unwrap().unwrap();
        assert_eq!((r.host.as_str(), r.port, used, r.version), ("10.0.0.7", 80, 10, SocksVersion::V4));
        // Incomplete user id.
        assert_eq!(parse_socks4_request(&req[..9]).unwrap(), None);
        assert_eq!(parse_socks4_request(&req[..5]).unwrap(), None);

        let mut a = vec![4, 1, 0x1f, 0x90, 0, 0, 0, 1, 0];
        a.extend_from_slice(b"intra.lan\0extra");
        let (r, used) = parse_socks4_request(&a).unwrap().unwrap();
        assert_eq!((r.host.as_str(), r.port), ("intra.lan", 8080));
        assert_eq!(&a[used..], b"extra");
        // 4a host not terminated yet.
        assert_eq!(parse_socks4_request(&a[..12]).unwrap(), None);

        let bind = parse_socks4_request(&[4, 2, 0, 80, 1, 1, 1, 1, 0]).unwrap_err();
        assert_eq!(bind.reply, socks4_reply(false).to_vec());
    }

    #[test]
    fn test_parse_socks5_greeting_and_method() {
        assert_eq!(parse_socks5_greeting(&[5]).unwrap(), None);
        assert_eq!(parse_socks5_greeting(&[5, 2, 0]).unwrap(), None);
        let (m, used) = parse_socks5_greeting(&[5, 2, 0, 2, 9]).unwrap().unwrap();
        assert_eq!((m.clone(), used), (vec![0, 2], 4));
        assert_eq!(socks5_choose_method(&m), 0);
        assert_eq!(socks5_choose_method(&[2]), 0xff);
        assert!(parse_socks5_greeting(&[4, 1, 0]).is_err());
    }

    #[test]
    fn test_parse_socks5_request() {
        let (r, used) = parse_socks5_request(&[5, 1, 0, 1, 192, 168, 1, 2, 0, 22]).unwrap().unwrap();
        assert_eq!((r.host.as_str(), r.port, used), ("192.168.1.2", 22, 10));

        let mut d = vec![5, 1, 0, 3, 7];
        d.extend_from_slice(b"db.prod");
        d.extend_from_slice(&5432u16.to_be_bytes());
        let (r, used) = parse_socks5_request(&d).unwrap().unwrap();
        assert_eq!((r.host.as_str(), r.port, used), ("db.prod", 5432, d.len()));
        for cut in 0..d.len() {
            assert_eq!(parse_socks5_request(&d[..cut]).unwrap(), None, "cut {cut}");
        }

        let mut v6 = vec![5, 1, 0, 4];
        v6.extend_from_slice(&std::net::Ipv6Addr::LOCALHOST.octets());
        v6.extend_from_slice(&[0x01, 0xbb]);
        let (r, _) = parse_socks5_request(&v6).unwrap().unwrap();
        assert_eq!((r.host.as_str(), r.port), ("::1", 443));

        assert_eq!(parse_socks5_request(&[5, 3, 0, 1, 0, 0, 0, 0, 0, 0]).unwrap_err().reply[1], 7);
        assert_eq!(parse_socks5_request(&[5, 1, 0, 9, 0]).unwrap_err().reply[1], 8);
    }

    #[test]
    fn test_final_reply() {
        assert_eq!(final_reply(SocksVersion::V5, true), vec![5, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
        assert_eq!(final_reply(SocksVersion::V5, false)[1], 5);
        assert_eq!(final_reply(SocksVersion::V4, true)[1], 0x5a);
        assert_eq!(final_reply(SocksVersion::V4, false)[1], 0x5b);
    }

    #[tokio::test]
    async fn test_accept_socks5_in_pieces() {
        let (mut client, mut server) = tokio::io::duplex(256);
        let task = tokio::spawn(async move { accept(&mut server).await.map(|(r, rest)| (r, rest, server)) });
        client.write_all(&[5, 1]).await.unwrap();
        tokio::task::yield_now().await;
        client.write_all(&[0]).await.unwrap();
        let mut m = [0u8; 2];
        client.read_exact(&mut m).await.unwrap();
        assert_eq!(m, [5, 0]);
        client.write_all(&[5, 1, 0, 3, 4, b'h', b'o']).await.unwrap();
        tokio::task::yield_now().await;
        client.write_all(&[b's', b't', 0, 80, b'G', b'E']).await.unwrap();
        let (req, rest, _server) = task.await.unwrap().unwrap();
        assert_eq!((req.host.as_str(), req.port, req.version), ("host", 80, SocksVersion::V5));
        assert_eq!(rest, b"GE");
    }

    #[tokio::test]
    async fn test_accept_socks4a_and_refusals() {
        let (mut client, mut server) = tokio::io::duplex(256);
        let task = tokio::spawn(async move { accept(&mut server).await.map(|(r, _)| r) });
        client.write_all(&[4, 1, 0, 22, 0, 0, 0, 9, b'm', b'e', 0, b'g', b'w', 0]).await.unwrap();
        let req = task.await.unwrap().unwrap();
        assert_eq!((req.host.as_str(), req.port, req.version), ("gw", 22, SocksVersion::V4));

        // Username / password only: answered with 0xFF and refused.
        let (mut client, mut server) = tokio::io::duplex(256);
        let task = tokio::spawn(async move { accept(&mut server).await.is_err() });
        client.write_all(&[5, 1, 2]).await.unwrap();
        let mut m = [0u8; 2];
        client.read_exact(&mut m).await.unwrap();
        assert_eq!(m, [5, 0xff]);
        assert!(task.await.unwrap());

        // Unknown version.
        let (mut client, mut server) = tokio::io::duplex(256);
        let task = tokio::spawn(async move { accept(&mut server).await.is_err() });
        client.write_all(b"GET / HTTP/1.1\r\n").await.unwrap();
        assert!(task.await.unwrap());
    }
}
