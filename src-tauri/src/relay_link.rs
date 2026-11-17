//! One host connection to the relay (`relay/server.js`), shared by remote access
//! (`remote.rs`, the pairing room) and session shares (`share.rs`, one room per share).
//!
//! Host <-> relay frames: `[kind u8][client id u32 BE][payload]`. The relay announces
//! clients (JOIN / LEAVE) and forwards their frames (DATA); the host answers with DATA
//! for one client, or KICK to send it away.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

pub const R_JOIN: u8 = 1;
pub const R_LEAVE: u8 = 2;
pub const R_DATA: u8 = 3;
pub const R_KICK: u8 = 4;

pub type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// `https://host/path` -> (`wss://host/path/ws`, `https://host/path/`). Plain http / ws for LAN tests.
pub fn relay_urls(base: &str) -> Option<(String, String)> {
    let base = base.trim().trim_end_matches('/');
    let (ws, page) = if let Some(rest) = base.strip_prefix("https://") {
        (format!("wss://{rest}"), format!("https://{rest}"))
    } else if let Some(rest) = base.strip_prefix("http://") {
        (format!("ws://{rest}"), format!("http://{rest}"))
    } else if let Some(rest) = base.strip_prefix("wss://") {
        (format!("wss://{rest}"), format!("https://{rest}"))
    } else if let Some(rest) = base.strip_prefix("ws://") {
        (format!("ws://{rest}"), format!("http://{rest}"))
    } else {
        return None;
    };
    if page.split("://").nth(1).is_none_or(|h| h.is_empty()) {
        return None;
    }
    Some((format!("{ws}/ws"), format!("{page}/")))
}

/// Where the host registers for `room`.
pub fn host_url(ws_url: &str, room: &str, host_token: &str) -> String {
    let mut url = format!("{ws_url}?role=host&room={room}");
    if !host_token.is_empty() {
        url.push_str(&format!("&token={}", percent_encode(host_token)));
    }
    url
}

pub fn percent_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

pub fn computer_name() -> String {
    std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_else(|_| "Nexterm".into())
}

pub fn envelope(kind: u8, client: u32, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(5 + payload.len());
    out.push(kind);
    out.extend_from_slice(&client.to_be_bytes());
    out.extend_from_slice(payload);
    out
}

/// A pairing / share link as a QR code.
pub fn qr_svg(url: &str) -> String {
    qrcode::QrCode::with_error_correction_level(url.as_bytes(), qrcode::EcLevel::M)
        .map(|code| {
            code.render::<qrcode::render::svg::Color>()
                .min_dimensions(220, 220)
                .quiet_zone(true)
                .dark_color(qrcode::render::svg::Color("#000000"))
                .light_color(qrcode::render::svg::Color("#ffffff"))
                .build()
        })
        .unwrap_or_default()
}

fn describe(e: &tokio_tungstenite::tungstenite::Error) -> String {
    use tokio_tungstenite::tungstenite::Error;
    match e {
        Error::Http(resp) if resp.status() == 401 => "relay refused the host token".into(),
        Error::Http(resp) => format!("relay answered HTTP {}", resp.status()),
        other => other.to_string(),
    }
}

pub async fn connect(url: &str) -> Result<Ws, String> {
    match tokio::time::timeout(Duration::from_secs(15), tokio_tungstenite::connect_async(url)).await {
        Ok(Ok((ws, _))) => Ok(ws),
        Ok(Err(e)) => Err(describe(&e)),
        Err(_) => Err("connection timed out".into()),
    }
}

/// Runs a connected link until it fails, or until every sender of `rx` is gone and the
/// frames queued before went out (then it closes the link). Frames go out in order; `queued` counts the bytes not written yet
/// (callers add when they queue), and `written` runs after every frame went out.
pub async fn serve(
    ws: Ws,
    mut rx: mpsc::UnboundedReceiver<Vec<u8>>,
    queued: Arc<AtomicUsize>,
    mut on_frame: impl FnMut(&[u8]),
    written: impl Fn(),
) -> Result<(), String> {
    let (mut sink, mut stream) = ws.split();
    let writer = async move {
        let mut ping = tokio::time::interval(Duration::from_secs(30));
        ping.tick().await;
        loop {
            tokio::select! {
                frame = rx.recv() => {
                    let Some(frame) = frame else {
                        // The owner let go (a share stopped): everything queued went out.
                        let _ = sink.close().await;
                        return Ok(());
                    };
                    let len = frame.len();
                    let res = sink.send(Message::Binary(frame.into())).await;
                    let _ = queued.try_update(Ordering::Relaxed, Ordering::Relaxed, |q| Some(q.saturating_sub(len)));
                    res.map_err(|e| e.to_string())?;
                    written();
                }
                _ = ping.tick() => sink.send(Message::Ping(Vec::new().into())).await.map_err(|e| e.to_string())?,
            }
        }
    };
    let reader = async {
        loop {
            // The relay pings every 25 s; silence means the link is dead.
            let next = tokio::time::timeout(Duration::from_secs(70), stream.next()).await;
            match next {
                Err(_) => return Err("relay stopped answering".to_string()),
                Ok(None) => return Err("relay closed the connection".to_string()),
                Ok(Some(Err(e))) => return Err(e.to_string()),
                Ok(Some(Ok(Message::Binary(b)))) => on_frame(&b),
                Ok(Some(Ok(Message::Close(frame)))) => {
                    let why = frame.map(|f| f.reason.to_string()).filter(|s| !s.is_empty());
                    return Err(why.unwrap_or_else(|| "relay closed the connection".into()));
                }
                Ok(Some(Ok(_))) => {}
            }
        }
    };
    tokio::select! {
        res = writer => res.and(Err("relay connection lost".into())),
        res = reader => res,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relay_addresses() {
        assert_eq!(
            relay_urls("https://relay.example.com/"),
            Some(("wss://relay.example.com/ws".into(), "https://relay.example.com/".into()))
        );
        assert_eq!(
            relay_urls(" http://10.0.0.2:8080/wt "),
            Some(("ws://10.0.0.2:8080/wt/ws".into(), "http://10.0.0.2:8080/wt/".into()))
        );
        assert_eq!(relay_urls("relay.example.com"), None);
        assert_eq!(relay_urls("https://"), None);
    }

    #[test]
    fn encodes_query_values() {
        assert_eq!(percent_encode("a b&c=d/é"), "a%20b%26c%3Dd%2F%C3%A9");
        assert_eq!(host_url("wss://r/ws", "ab", ""), "wss://r/ws?role=host&room=ab");
        assert_eq!(host_url("wss://r/ws", "ab", "t&1"), "wss://r/ws?role=host&room=ab&token=t%261");
    }
}
