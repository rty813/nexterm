use std::sync::Arc;
use std::time::{Duration, Instant};
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

/// Prompts auto login answers: the last line of output, lower case, trailing blanks trimmed.
const USER_PROMPTS: &[&str] = &[
    "login:", "username:", "user name:", "login name:", "user:", "用户名:", "用户名：", "账号:", "账号：", "帐号:", "帐号：",
];
const PASSWORD_PROMPTS: &[&str] = &["password:", "passwd:", "passcode:", "密码:", "密码："];
const SHELL_PROMPTS: &[char] = &['$', '#', '>', '%'];
/// How long a login step waits for its prompt before giving up.
const PROMPT_WAIT: Duration = Duration::from_secs(30);
/// After the password: how long to wait for a shell prompt before sending the startup command anyway.
const SHELL_WAIT: Duration = Duration::from_secs(10);
const LINE_MAX: usize = 256;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Step {
    User,
    Password,
    /// Logged in (or the user is typing the password): the startup command waits for the shell prompt.
    Shell,
    Done,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Prompt {
    User,
    Password,
    Shell,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Esc {
    None,
    Esc,
    Csi,
    Osc,
    OscEsc,
}

/// Telnet has no login of its own: answer the server's `login:` / `Password:` prompts once each
/// with the session's user name and password, then send the startup command at the shell prompt.
/// A prompt asked again means the login was refused: it stops there instead of retrying.
pub struct AutoLogin {
    user: String,
    password: Option<String>,
    startup: Option<String>,
    step: Step,
    sent_user: bool,
    /// The current (unfinished) line of output, escape sequences removed.
    line: Vec<u8>,
    esc: Esc,
    deadline: Option<Instant>,
}

fn startup_line(session: &SessionConfig) -> Option<String> {
    session.startup_command.as_ref().filter(|s| !s.trim().is_empty()).map(|s| format!("{}\r", s))
}

impl AutoLogin {
    /// None without a user name or password: the startup command then goes out right away.
    pub fn new(session: &SessionConfig, now: Instant) -> Option<Self> {
        let user = session.username.trim().to_string();
        let password = session.password.clone().filter(|p| !p.is_empty());
        if user.is_empty() && password.is_none() {
            return None;
        }
        Some(Self {
            step: if user.is_empty() { Step::Password } else { Step::User },
            user,
            password,
            startup: startup_line(session),
            sent_user: false,
            line: Vec::new(),
            esc: Esc::None,
            deadline: Some(now + PROMPT_WAIT),
        })
    }

    pub fn done(&self) -> bool {
        self.step == Step::Done
    }

    pub fn deadline(&self) -> Option<Instant> {
        if self.done() { None } else { self.deadline }
    }

    fn push(&mut self, data: &[u8]) {
        for &b in data {
            self.esc = match (self.esc, b) {
                (Esc::None, 0x1b) => Esc::Esc,
                (Esc::None, b'\r' | b'\n') => {
                    self.line.clear();
                    Esc::None
                }
                (Esc::None, 0x08) => {
                    self.line.pop();
                    Esc::None
                }
                (Esc::None, b) if b < 0x20 || b == 0x7f => Esc::None,
                (Esc::None, b) => {
                    self.line.push(b);
                    Esc::None
                }
                (Esc::Esc, b'[') => Esc::Csi,
                (Esc::Esc, b']') => Esc::Osc,
                (Esc::Esc, _) => Esc::None,
                (Esc::Csi, 0x40..=0x7e) => Esc::None,
                (Esc::Csi, _) => Esc::Csi,
                (Esc::Osc, 0x07) => Esc::None,
                (Esc::Osc, 0x1b) => Esc::OscEsc,
                (Esc::Osc, _) => Esc::Osc,
                (Esc::OscEsc, b'\\') => Esc::None,
                (Esc::OscEsc, _) => Esc::Osc,
            };
        }
        if self.line.len() > LINE_MAX {
            self.line.drain(..self.line.len() - LINE_MAX);
        }
    }

    fn prompt(&self) -> Option<Prompt> {
        let text = String::from_utf8_lossy(&self.line).trim_end().to_lowercase();
        if text.is_empty() || text.starts_with("last login") {
            return None;
        }
        if PASSWORD_PROMPTS.iter().any(|p| text.ends_with(p)) {
            Some(Prompt::Password)
        } else if USER_PROMPTS.iter().any(|p| text.ends_with(p)) {
            Some(Prompt::User)
        } else if text.ends_with(SHELL_PROMPTS) {
            Some(Prompt::Shell)
        } else {
            None
        }
    }

    /// Wait for the shell prompt (`wait`: then send the startup command anyway).
    fn to_shell(&mut self, now: Instant, wait: Option<Duration>) {
        if self.startup.is_some() {
            self.step = Step::Shell;
            self.deadline = wait.map(|w| now + w);
        } else {
            self.step = Step::Done;
        }
    }

    /// Output from the server (already decoded); returns what to type.
    pub fn feed(&mut self, data: &[u8], now: Instant) -> Option<String> {
        if self.done() {
            return None;
        }
        self.push(data);
        let prompt = self.prompt()?;
        let reply = match (self.step, prompt) {
            (Step::User, Prompt::User) => {
                self.sent_user = true;
                if self.password.is_some() {
                    self.step = Step::Password;
                    self.deadline = Some(now + PROMPT_WAIT);
                } else if self.startup.is_some() {
                    // The user types the password (if one is asked): no time limit.
                    self.step = Step::Password;
                    self.deadline = None;
                } else {
                    self.step = Step::Done;
                }
                Some(format!("{}\r", self.user))
            }
            (Step::User | Step::Password, Prompt::Password) => match self.password.clone() {
                Some(p) => {
                    self.to_shell(now, Some(SHELL_WAIT));
                    Some(format!("{}\r", p))
                }
                // The user types it: the startup command still waits for the shell.
                None => {
                    self.to_shell(now, None);
                    None
                }
            },
            // Asked for the name again: refused.
            (Step::Password, Prompt::User) if self.sent_user => {
                self.step = Step::Done;
                None
            }
            // Only a password is saved: the user types the name.
            (Step::Password, Prompt::User) => {
                self.deadline = Some(now + PROMPT_WAIT);
                None
            }
            // A login prompt after the password: refused, no startup command.
            (Step::Shell, Prompt::User | Prompt::Password) => {
                self.step = Step::Done;
                None
            }
            // Logged in with the name alone (no password asked).
            (Step::Password, Prompt::Shell) if self.sent_user && self.password.is_none() => {
                self.step = Step::Done;
                self.startup.take()
            }
            (Step::Shell, Prompt::Shell) => {
                self.step = Step::Done;
                self.startup.take()
            }
            // Not asked for a login yet (a banner line can end in '#' or '>').
            (_, Prompt::Shell) | (Step::Done, _) => return None,
        };
        self.line.clear();
        reply
    }

    /// The deadline passed: give up the login, or send the startup command without having seen the prompt.
    pub fn timeout(&mut self) -> Option<String> {
        let shell = self.step == Step::Shell;
        self.step = Step::Done;
        if shell { self.startup.take() } else { None }
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

        let mut login = AutoLogin::new(&session, Instant::now());
        if login.is_none() {
            if let Some(line) = startup_line(&session) {
                let _ = wr.write_all(&codec.encode(line.as_bytes())).await;
            }
        }

        let mut buf = vec![0u8; 64 * 1024];
        // Keys still go out while the screen is behind (see pump.rs).
        let mut pump = OutputPump::new(Arc::clone(&sink), instance_id.clone());
        loop {
            let login_wake = login.as_ref().and_then(AutoLogin::deadline);
            let mut typed = None;
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
                            typed = login.as_mut().and_then(|l| l.feed(&data, Instant::now()));
                        }
                        Err(e) => {
                            pump.state("disconnected", Some(format!("Telnet 读取错误: {}", e)));
                            break;
                        }
                    }
                }
                _ = pump.flush(), if pump.is_behind() => {}
                _ = tokio::time::sleep_until(login_wake.unwrap_or_else(Instant::now).into()), if login_wake.is_some() => {
                    typed = login.as_mut().and_then(AutoLogin::timeout);
                }
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
            if let Some(text) = typed {
                if let Err(e) = wr.write_all(&codec.encode(text.as_bytes())).await {
                    pump.state("disconnected", Some(format!("Telnet 写入错误: {}", e)));
                    break;
                }
            }
            if login.as_ref().is_some_and(AutoLogin::done) {
                login = None;
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

    fn session(user: &str, password: Option<&str>, startup: Option<&str>) -> SessionConfig {
        serde_json::from_value(serde_json::json!({
            "id": "t", "label": "t", "protocol": "telnet", "host": "h", "port": 23,
            "username": user, "password": password, "startupCommand": startup,
        }))
        .unwrap()
    }

    #[test]
    fn auto_login_answers_each_prompt_once() {
        let t0 = Instant::now();
        let mut l = AutoLogin::new(&session("root", Some("pw"), Some("uptime")), t0).unwrap();
        // A banner line ending in '#' is not a shell yet; a prompt split across reads and
        // coloured with escape sequences is still found.
        assert_eq!(l.feed(b"#####\r\nWelcome\r\n\x1b[1mrouter lo", t0), None);
        assert_eq!(l.feed(b"gin:\x1b[0m ", t0).as_deref(), Some("root\r"));
        assert_eq!(l.feed(b"root\r\nPassword: ", t0).as_deref(), Some("pw\r"));
        assert_eq!(l.feed(b"\r\nLast login: Mon\r\n", t0), None);
        assert_eq!(l.feed(b"root@router:~# ", t0).as_deref(), Some("uptime\r"));
        assert!(l.done());
        assert_eq!(l.feed(b"\r\nlogin: ", t0), None);
    }

    #[test]
    fn auto_login_stops_when_refused() {
        let t0 = Instant::now();
        let mut l = AutoLogin::new(&session("root", Some("bad"), Some("uptime")), t0).unwrap();
        assert!(l.feed(b"login: ", t0).is_some());
        assert!(l.feed(b"\r\nPassword: ", t0).is_some());
        // Refused: asked again, nothing more is typed (no retry loop, no startup command).
        assert_eq!(l.feed(b"\r\nLogin incorrect\r\n\r\nlogin: ", t0), None);
        assert!(l.done());

        // Without a password (or startup command) only the name goes out.
        let mut l = AutoLogin::new(&session("admin", None, None), t0).unwrap();
        assert_eq!(l.feed(b"Username: ", t0).as_deref(), Some("admin\r"));
        assert!(l.done());
    }

    #[test]
    fn auto_login_name_only_waits_for_the_typed_password() {
        let t0 = Instant::now();
        let mut l = AutoLogin::new(&session("admin", None, Some("show ver")), t0).unwrap();
        assert_eq!(l.feed(b"Username: ", t0).as_deref(), Some("admin\r"));
        assert_eq!(l.deadline(), None);
        // The user types it; the startup command waits for the prompt after it.
        assert_eq!(l.feed(b"admin\r\nPassword: ", t0), None);
        assert_eq!(l.feed(b"\r\n<H3C>", t0).as_deref(), Some("show ver\r"));

        // No password asked at all.
        let mut l = AutoLogin::new(&session("admin", None, Some("show ver")), t0).unwrap();
        l.feed(b"login: ", t0);
        assert_eq!(l.feed(b"admin\r\nrouter> ", t0).as_deref(), Some("show ver\r"));
    }

    #[test]
    fn auto_login_timeouts_and_partial_logins() {
        let t0 = Instant::now();
        assert!(AutoLogin::new(&session("", None, Some("ls")), t0).is_none());

        // No prompt in time: give up, nothing typed.
        let mut l = AutoLogin::new(&session("root", Some("pw"), Some("ls")), t0).unwrap();
        assert_eq!(l.deadline(), Some(t0 + PROMPT_WAIT));
        assert_eq!(l.timeout(), None);
        assert!(l.done() && l.deadline().is_none());

        // Logged in but no recognizable shell prompt: the startup command goes out at the deadline.
        let mut l = AutoLogin::new(&session("root", Some("pw"), Some("ls")), t0).unwrap();
        l.feed(b"login: ", t0);
        l.feed(b"Password: ", t0);
        assert_eq!(l.feed(b"\r\nREADY\r\n", t0), None);
        assert_eq!(l.deadline(), Some(t0 + SHELL_WAIT));
        assert_eq!(l.timeout().as_deref(), Some("ls\r"));

        // Only a password (e.g. a switch's line password): the name prompt is left to the user.
        let mut l = AutoLogin::new(&session("", Some("pw"), None), t0).unwrap();
        assert_eq!(l.feed(b"\r\nUser Access Verification\r\n\r\nPassword: ", t0).as_deref(), Some("pw\r"));
        assert!(l.done());
        let mut l = AutoLogin::new(&session("", Some("pw"), None), t0).unwrap();
        assert_eq!(l.feed(b"login: ", t0), None);
        assert!(!l.done());
        assert_eq!(l.feed("me\r\n密码：".as_bytes(), t0).as_deref(), Some("pw\r"));
    }
}
