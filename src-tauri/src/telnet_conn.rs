use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

use crate::manager::{AsyncChannels, RuntimeControl, TerminalSink};
use crate::models::SessionConfig;
use crate::net::connect_tcp;
use crate::pump::OutputPump;

const IAC: u8 = 255;
const DONT: u8 = 254;
const DO: u8 = 253;
const WONT: u8 = 252;
const WILL: u8 = 251;
const SB: u8 = 250;
const SE: u8 = 240;

const OPT_BINARY: u8 = 0;
const OPT_ECHO: u8 = 1;
const OPT_SGA: u8 = 3;
const OPT_TTYPE: u8 = 24;
const OPT_NAWS: u8 = 31;

const TTYPE_IS: u8 = 0;
const TTYPE_SEND: u8 = 1;

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Data,
    Iac,
    Verb(u8),
    Sub,
    SubIac,
}

/// RFC 854 option negotiation: we offer TTYPE, NAWS, SGA and BINARY and let the
/// server echo; everything else is refused.
pub struct TelnetCodec {
    state: State,
    sub: Vec<u8>,
    term: String,
    cols: u16,
    rows: u16,
    naws_on: bool,
    /// Options we already answered, so a repeated request does not loop.
    local_on: [bool; 256],
    remote_on: [bool; 256],
    binary_out: bool,
}

impl TelnetCodec {
    pub fn new(term: &str, cols: u16, rows: u16) -> Self {
        Self {
            state: State::Data,
            sub: Vec::new(),
            term: if term.trim().is_empty() { "XTERM-256COLOR".into() } else { term.trim().to_ascii_uppercase() },
            cols,
            rows,
            naws_on: false,
            local_on: [false; 256],
            remote_on: [false; 256],
            binary_out: false,
        }
    }

    /// Our opening offers.
    pub fn greeting(&mut self) -> Vec<u8> {
        self.local_on[OPT_NAWS as usize] = true;
        self.local_on[OPT_TTYPE as usize] = true;
        vec![IAC, WILL, OPT_NAWS, IAC, WILL, OPT_TTYPE, IAC, DO, OPT_SGA, IAC, DO, OPT_ECHO]
    }

    fn naws(&self) -> Vec<u8> {
        let mut v = vec![IAC, SB, OPT_NAWS];
        for b in self.cols.to_be_bytes().into_iter().chain(self.rows.to_be_bytes()) {
            v.push(b);
            if b == IAC {
                v.push(IAC);
            }
        }
        v.extend_from_slice(&[IAC, SE]);
        v
    }

    pub fn resize(&mut self, cols: u16, rows: u16) -> Vec<u8> {
        self.cols = cols;
        self.rows = rows;
        if self.naws_on { self.naws() } else { Vec::new() }
    }

    /// Split received bytes into terminal data and negotiation replies.
    pub fn decode(&mut self, input: &[u8]) -> (Vec<u8>, Vec<u8>) {
        let mut data = Vec::with_capacity(input.len());
        let mut reply = Vec::new();
        for &b in input {
            self.state = match self.state {
                State::Data => {
                    if b == IAC {
                        State::Iac
                    } else {
                        data.push(b);
                        State::Data
                    }
                }
                State::Iac => match b {
                    IAC => {
                        data.push(IAC);
                        State::Data
                    }
                    DO | DONT | WILL | WONT => State::Verb(b),
                    SB => {
                        self.sub.clear();
                        State::Sub
                    }
                    _ => State::Data, // NOP, GA, AYT ... ignored
                },
                State::Verb(verb) => {
                    self.negotiate(verb, b, &mut reply);
                    State::Data
                }
                State::Sub => {
                    if b == IAC {
                        State::SubIac
                    } else {
                        self.sub.push(b);
                        State::Sub
                    }
                }
                State::SubIac => match b {
                    SE => {
                        self.subnegotiation(&mut reply);
                        State::Data
                    }
                    IAC => {
                        self.sub.push(IAC);
                        State::Sub
                    }
                    _ => State::Data,
                },
            };
        }
        (data, reply)
    }

    fn negotiate(&mut self, verb: u8, opt: u8, reply: &mut Vec<u8>) {
        let o = opt as usize;
        match verb {
            DO => {
                let supported = matches!(opt, OPT_NAWS | OPT_TTYPE | OPT_SGA | OPT_BINARY);
                if supported {
                    if !self.local_on[o] {
                        self.local_on[o] = true;
                        reply.extend_from_slice(&[IAC, WILL, opt]);
                    }
                    if opt == OPT_NAWS {
                        self.naws_on = true;
                        reply.extend_from_slice(&self.naws());
                    }
                    if opt == OPT_BINARY {
                        self.binary_out = true;
                    }
                } else {
                    reply.extend_from_slice(&[IAC, WONT, opt]);
                }
            }
            DONT => {
                if self.local_on[o] {
                    self.local_on[o] = false;
                    reply.extend_from_slice(&[IAC, WONT, opt]);
                }
                if opt == OPT_NAWS {
                    self.naws_on = false;
                }
                if opt == OPT_BINARY {
                    self.binary_out = false;
                }
            }
            WILL => {
                let accept = matches!(opt, OPT_ECHO | OPT_SGA | OPT_BINARY);
                if accept {
                    if !self.remote_on[o] {
                        self.remote_on[o] = true;
                        reply.extend_from_slice(&[IAC, DO, opt]);
                    }
                } else {
                    reply.extend_from_slice(&[IAC, DONT, opt]);
                }
            }
            WONT => {
                if self.remote_on[o] {
                    self.remote_on[o] = false;
                    reply.extend_from_slice(&[IAC, DONT, opt]);
                }
            }
            _ => {}
        }
    }

    fn subnegotiation(&mut self, reply: &mut Vec<u8>) {
        if self.sub.first() == Some(&OPT_TTYPE) && self.sub.get(1) == Some(&TTYPE_SEND) {
            reply.extend_from_slice(&[IAC, SB, OPT_TTYPE, TTYPE_IS]);
            reply.extend_from_slice(self.term.as_bytes());
            reply.extend_from_slice(&[IAC, SE]);
        }
    }

    /// Escape IAC and turn a bare CR (Enter) into CR LF unless in binary mode.
    pub fn encode(&self, input: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(input.len() + 4);
        let mut i = 0;
        while i < input.len() {
            let b = input[i];
            match b {
                IAC => out.extend_from_slice(&[IAC, IAC]),
                b'\r' if !self.binary_out => {
                    out.extend_from_slice(b"\r\n");
                    if input.get(i + 1) == Some(&b'\n') {
                        i += 1;
                    }
                }
                _ => out.push(b),
            }
            i += 1;
        }
        out
    }
}

pub fn spawn_telnet_session(
    instance_id: String,
    session: SessionConfig,
    cols: u16,
    rows: u16,
    sink: Arc<dyn TerminalSink>,
) -> RuntimeControl {
    let (write_tx, mut write_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let (resize_tx, mut resize_rx) = mpsc::unbounded_channel::<(u16, u16)>();
    let (close_tx, mut close_rx) = mpsc::unbounded_channel::<()>();

    tauri::async_runtime::spawn(async move {
        sink.emit_state(&instance_id, "connecting", None);
        let port = if session.port == 0 { 23 } else { session.port };
        let stream = match connect_tcp(session.host.trim(), port, session.proxy.as_ref(), Duration::from_secs(15)).await {
            Ok(s) => s,
            Err(e) => {
                let msg = format!("{:#}", e);
                sink.emit_output(&instance_id, format!("\x1b[31m[Telnet 连接错误]\x1b[0m {}\r\n", msg).as_bytes());
                sink.emit_state(&instance_id, "error", Some(msg));
                return;
            }
        };
        let (mut rd, mut wr) = stream.into_split();
        let mut codec = TelnetCodec::new(&session.term, cols.max(10), rows.max(2));
        if wr.write_all(&codec.greeting()).await.is_err() {
            sink.emit_state(&instance_id, "error", Some("Telnet 握手失败".into()));
            return;
        }
        sink.emit_state(&instance_id, "connected", None);

        if let Some(startup) = session.startup_command.as_ref().filter(|s| !s.trim().is_empty()) {
            let line = format!("{}\r", startup);
            let _ = wr.write_all(&codec.encode(line.as_bytes())).await;
        }

        let mut buf = vec![0u8; 64 * 1024];
        // Keys still go out while the screen is behind (see pump.rs).
        let mut pump = OutputPump::new(Arc::clone(&sink), instance_id.clone());
        loop {
            tokio::select! {
                read_res = rd.read(&mut buf), if !pump.is_behind() => {
                    match read_res {
                        Ok(0) => {
                            pump.state("disconnected", Some("远端已关闭连接".into()));
                            break;
                        }
                        Ok(n) => {
                            let (data, reply) = codec.decode(&buf[..n]);
                            if !reply.is_empty() && wr.write_all(&reply).await.is_err() {
                                break;
                            }
                            pump.output(&data);
                        }
                        Err(e) => {
                            pump.state("disconnected", Some(format!("Telnet 读取错误: {}", e)));
                            break;
                        }
                    }
                }
                _ = pump.flush(), if pump.is_behind() => {}
                Some(data) = write_rx.recv() => {
                    if let Err(e) = wr.write_all(&codec.encode(&data)).await {
                        pump.state("disconnected", Some(format!("Telnet 写入错误: {}", e)));
                        break;
                    }
                }
                Some((c, r)) = resize_rx.recv() => {
                    let msg = codec.resize(c.max(10), r.max(2));
                    if !msg.is_empty() {
                        let _ = wr.write_all(&msg).await;
                    }
                }
                Some(()) = close_rx.recv() => {
                    let _ = wr.shutdown().await;
                    pump.state("disconnected", Some("已断开连接".into()));
                    break;
                }
            }
        }
        pump.finish().await;
    });

    RuntimeControl::Async(AsyncChannels { write_tx, resize_tx, close_tx, exec_tx: None,
        tunnel_tx: None, })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_negotiation_and_escaping() {
        let mut c = TelnetCodec::new("xterm-256color", 120, 40);
        let _ = c.greeting();
        // Server: DO NAWS, WILL ECHO, DO LINEMODE(34), "hi", IAC IAC, SB TTYPE SEND SE
        let input = [
            IAC, DO, OPT_NAWS, IAC, WILL, OPT_ECHO, IAC, DO, 34, b'h', b'i', IAC, IAC, IAC, SB, OPT_TTYPE,
            TTYPE_SEND, IAC, SE,
        ];
        let (data, reply) = c.decode(&input);
        assert_eq!(data, vec![b'h', b'i', IAC]);
        let naws = [IAC, SB, OPT_NAWS, 0, 120, 0, 40, IAC, SE];
        assert!(reply.windows(naws.len()).any(|w| w == naws), "NAWS sent");
        assert!(reply.windows(3).any(|w| w == [IAC, DO, OPT_ECHO]));
        assert!(reply.windows(3).any(|w| w == [IAC, WONT, 34]));
        let mut ttype = vec![IAC, SB, OPT_TTYPE, TTYPE_IS];
        ttype.extend_from_slice(b"XTERM-256COLOR");
        ttype.extend_from_slice(&[IAC, SE]);
        assert!(reply.windows(ttype.len()).any(|w| w == ttype.as_slice()));

        // Split IAC across reads.
        let (d1, _) = c.decode(&[b'a', IAC]);
        let (d2, _) = c.decode(&[IAC, b'b']);
        assert_eq!([d1, d2].concat(), vec![b'a', IAC, b'b']);

        assert_eq!(c.encode(&[b'l', b's', b'\r', IAC]), vec![b'l', b's', b'\r', b'\n', IAC, IAC]);
        assert_eq!(c.resize(80, 255), vec![IAC, SB, OPT_NAWS, 0, 80, 0, 255, 255, IAC, SE]);
    }
}
