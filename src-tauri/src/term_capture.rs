//! What the MCP tools need to know about a pane's output stream, read in the backend so
//! it keeps working while the window is minimized (WebView2 throttles timers there):
//!
//! - [`ShellTracker`] follows OSC 133 (A prompt, C command started, D;<exit> finished):
//!   whether the shell reports commands at all, and whether one is running.
//! - [`Capture`] collects output for one agent request: a command's output between its
//!   C and D, or everything from now on (waiting for some text / for output to go quiet).
//! - [`plain_text`] turns captured bytes into what a person would read (no escape
//!   sequences, carriage-return overwrites applied).

use std::sync::{Arc, Mutex};
use std::time::Instant;

/// Captured bytes kept per request; older output is dropped (the tail matters most).
const CAPTURE_LIMIT: usize = 2 * 1024 * 1024;
/// OSC payloads longer than this are not ours (images, clipboard): skip them.
const OSC_LIMIT: usize = 4096;
/// Output kept from before a command's C (its echo, a syntax error, a continuation prompt).
const PRE_LIMIT: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureMode {
    /// A command typed by the agent: output counts from its OSC 133 C up to the D.
    Command,
    /// Everything from now on.
    Watch,
}

#[derive(Debug)]
pub struct Capture {
    pub mode: CaptureMode,
    /// Collecting (always for Watch; after the C for Command).
    pub started: bool,
    pub raw: Vec<u8>,
    /// Command mode, before the C: what the shell printed after the command was typed. When
    /// it never starts the command (syntax error, waiting for more input) this explains why.
    pub pre: Vec<u8>,
    /// Bytes dropped from the front once `raw` hit [`CAPTURE_LIMIT`].
    pub dropped: usize,
    /// Set by OSC 133 D: `Some(exit)` (None when the shell gave no code).
    pub finished: Option<Option<i32>>,
    /// The D said the shell rejected the line (`err=syntax`, fish): nothing was run.
    pub syntax_error: bool,
    pub armed_at: Instant,
    pub last_output: Option<Instant>,
    /// Stream offset (counting dropped bytes) already handed to the agent: a later call
    /// continuing this capture returns only what came after.
    pub reported: usize,
}

impl Capture {
    pub fn new(mode: CaptureMode, now: Instant) -> Self {
        Self {
            mode,
            started: mode == CaptureMode::Watch,
            raw: Vec::new(),
            pre: Vec::new(),
            dropped: 0,
            finished: None,
            syntax_error: false,
            armed_at: now,
            last_output: None,
            reported: 0,
        }
    }

    /// Output not handed to the agent yet; marks it handed over.
    pub fn take_unreported(&mut self) -> &[u8] {
        let from = self.reported.saturating_sub(self.dropped).min(self.raw.len());
        self.reported = self.dropped + self.raw.len();
        &self.raw[from..]
    }

    /// Start of the unreported part within `raw`.
    pub fn unreported_start(&self) -> usize {
        self.reported.saturating_sub(self.dropped).min(self.raw.len())
    }

    /// Output after the command started goes to `raw`; before it (command mode) to `pre`.
    fn record(&mut self, mut bytes: &[u8]) {
        if self.finished.is_some() {
            return;
        }
        if self.started {
            while !bytes.is_empty() {
                if self.raw.len() >= CAPTURE_LIMIT {
                    let cut = CAPTURE_LIMIT / 4;
                    self.raw.drain(..cut);
                    self.dropped += cut;
                }
                let n = (CAPTURE_LIMIT - self.raw.len()).min(bytes.len());
                self.raw.extend_from_slice(&bytes[..n]);
                bytes = &bytes[n..];
            }
        } else if self.mode == CaptureMode::Command {
            while !bytes.is_empty() {
                if self.pre.len() >= PRE_LIMIT {
                    self.pre.drain(..PRE_LIMIT / 4);
                }
                let n = (PRE_LIMIT - self.pre.len()).min(bytes.len());
                self.pre.extend_from_slice(&bytes[..n]);
                bytes = &bytes[n..];
            }
        }
    }

    /// What the shell printed for a command it did not start, without the echo of the
    /// typed line (everything up to the first newline).
    pub fn pre_text(&self) -> String {
        let after = self.pre.iter().position(|&b| b == b'\n').map_or(&[][..], |i| &self.pre[i + 1..]);
        plain_text(after)
    }

    /// How long no output arrived (counted from arming when nothing came yet).
    pub fn quiet_for(&self, now: Instant) -> std::time::Duration {
        now.saturating_duration_since(self.last_output.unwrap_or(self.armed_at).max(self.armed_at))
    }
}

pub type SharedCapture = Arc<Mutex<Capture>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Scan {
    Normal,
    Esc,
    Osc,
    OscEsc,
    /// After `ESC [`: collecting parameters up to the final byte.
    Csi,
}

/// CSI parameters longer than this are not a mode switch: stop collecting.
const CSI_LIMIT: usize = 32;

/// OSC 133 state of one connection, fed with every output chunk (already UTF-8).
#[derive(Debug)]
pub struct ShellTracker {
    scan: Scan,
    osc: Vec<u8>,
    osc_overflow: bool,
    /// The shell has reported prompts / commands (shell integration is loaded).
    pub integrated: bool,
    /// Between an OSC 133 C and its D.
    pub running: bool,
    /// A full-screen program switched to the alternate screen (DECSET 1049 / 1047 / 47).
    pub alt_screen: bool,
    csi: Vec<u8>,
    pub capture: Option<SharedCapture>,
}

impl Default for ShellTracker {
    fn default() -> Self {
        Self {
            scan: Scan::Normal,
            osc: Vec::new(),
            osc_overflow: false,
            integrated: false,
            running: false,
            alt_screen: false,
            csi: Vec::new(),
            capture: None,
        }
    }
}

impl ShellTracker {
    pub fn feed(&mut self, data: &[u8], now: Instant) {
        let capture = self.capture.clone();
        let mut cap = capture.as_ref().map(|c| c.lock().unwrap_or_else(|e| e.into_inner()));
        if let Some(c) = cap.as_mut() {
            if !data.is_empty() {
                c.last_output = Some(now);
            }
        }
        let mut i = 0;
        while i < data.len() {
            // Plain text (most of the output): jump to the next ESC, recording the run at once.
            if self.scan == Scan::Normal {
                let end = memchr::memchr(0x1b, &data[i..]).map_or(data.len(), |o| i + o);
                if end > i {
                    if let Some(c) = cap.as_mut() {
                        c.record(&data[i..end]);
                    }
                    i = end;
                    continue;
                }
            }
            let b = data[i];
            i += 1;
            // Recorded before the byte is handled: an OSC 133 C it ends starts the capture after it.
            if let Some(c) = cap.as_mut() {
                c.record(std::slice::from_ref(&b));
            }
            match self.scan {
                Scan::Normal => {
                    if b == 0x1b {
                        self.scan = Scan::Esc;
                    }
                }
                Scan::Esc => {
                    if b == b']' {
                        self.scan = Scan::Osc;
                        self.osc.clear();
                        self.osc_overflow = false;
                    } else if b == b'[' {
                        self.scan = Scan::Csi;
                        self.csi.clear();
                    } else {
                        self.scan = if b == 0x1b { Scan::Esc } else { Scan::Normal };
                    }
                }
                Scan::Csi => match b {
                    0x40..=0x7e => {
                        self.scan = Scan::Normal;
                        self.csi_done(b);
                    }
                    0x1b => self.scan = Scan::Esc,
                    _ => {
                        if self.csi.len() < CSI_LIMIT {
                            self.csi.push(b);
                        }
                    }
                },
                Scan::Osc => match b {
                    0x07 => {
                        self.scan = Scan::Normal;
                        self.osc_done(cap.as_deref_mut());
                    }
                    0x1b => self.scan = Scan::OscEsc,
                    _ => {
                        if self.osc.len() < OSC_LIMIT {
                            self.osc.push(b);
                        } else {
                            self.osc_overflow = true;
                        }
                    }
                },
                Scan::OscEsc => {
                    if b == b'\\' {
                        self.scan = Scan::Normal;
                        self.osc_done(cap.as_deref_mut());
                    } else {
                        // ESC inside an OSC that is not ST: the sequence was cut off.
                        self.scan = if b == b']' { Scan::Osc } else { Scan::Normal };
                        self.osc.clear();
                        self.osc_overflow = false;
                    }
                }
            }
        }
    }

    /// DECSET / DECRST of the alternate screen (`ESC [ ? 1049 h`, also in a list: `?1;1049h`).
    fn csi_done(&mut self, final_byte: u8) {
        if !matches!(final_byte, b'h' | b'l') || self.csi.len() >= CSI_LIMIT {
            return;
        }
        let Some(params) = self.csi.strip_prefix(b"?") else { return };
        if params.split(|&b| b == b';').any(|p| matches!(p, b"1049" | b"1047" | b"47")) {
            self.alt_screen = final_byte == b'h';
        }
    }

    fn osc_done(&mut self, cap: Option<&mut Capture>) {
        if self.osc_overflow {
            return;
        }
        let Some(rest) = self.osc.strip_prefix(b"133;") else { return };
        let rest = String::from_utf8_lossy(rest).into_owned();
        let mut parts = rest.split(';');
        let kind = parts.next().unwrap_or("");
        match kind {
            "A" | "B" => self.integrated = true,
            "C" => {
                self.integrated = true;
                self.running = true;
                if let Some(c) = cap {
                    if c.mode == CaptureMode::Command && !c.started && c.finished.is_none() {
                        c.started = true;
                        c.raw.clear();
                    }
                }
            }
            "D" => {
                self.integrated = true;
                let was_running = std::mem::replace(&mut self.running, false);
                let exit = parts.next().and_then(|s| s.trim().parse::<i32>().ok());
                let syntax_error = parts.any(|p| p == "err=syntax");
                if let Some(c) = cap {
                    // An empty line gives a D without a C: the command is over either way.
                    let ours = match c.mode {
                        CaptureMode::Command => c.started || !was_running,
                        CaptureMode::Watch => true,
                    };
                    if ours && c.finished.is_none() {
                        c.finished = Some(exit);
                        c.syntax_error = syntax_error && !c.started;
                    }
                }
            }
            _ => {}
        }
    }
}

/// Bytes a terminal itself sends back (cursor position, device attributes, OSC / DCS
/// answers, focus reports): these still go through while the AI holds the keyboard,
/// otherwise programs the agent runs would wait for them forever.
pub fn is_terminal_reply(data: &[u8]) -> bool {
    if data.len() < 3 || data[0] != 0x1b {
        return false;
    }
    match data[1] {
        b'[' => {
            let body = &data[2..];
            let (last, params) = body.split_last().unwrap();
            if data == b"\x1b[I" || data == b"\x1b[O" {
                return true;
            }
            // CPR (R), DA (c), DSR answers (n), window reports (t), DECRQM ($y), mode reports.
            let final_ok = matches!(last, b'R' | b'c' | b'n' | b't' | b'y');
            final_ok && params.iter().all(|b| b.is_ascii_digit() || matches!(b, b';' | b'?' | b'>' | b'$' | b'='))
        }
        // OSC answers (colors, clipboard) and DCS answers (XTVERSION, DECRQSS).
        b']' | b'P' => data.ends_with(b"\x07") || data.ends_with(b"\x1b\\"),
        _ => false,
    }
}

/// Captured output as plain text: escape sequences removed, `\r` / backspace / erase-line
/// applied the way a terminal shows them, trailing blanks trimmed.
pub fn plain_text(raw: &[u8]) -> String {
    let text = String::from_utf8_lossy(raw);
    let mut lines: Vec<String> = Vec::new();
    let mut line: Vec<char> = Vec::new();
    let mut col = 0usize;
    let mut chars = text.chars().peekable();

    fn put(line: &mut Vec<char>, col: &mut usize, c: char) {
        while line.len() < *col {
            line.push(' ');
        }
        if *col < line.len() {
            line[*col] = c;
        } else {
            line.push(c);
        }
        *col += 1;
    }

    while let Some(c) = chars.next() {
        match c {
            '\n' => {
                lines.push(line.iter().collect::<String>().trim_end().to_string());
                line.clear();
                col = 0;
            }
            '\r' => col = 0,
            '\x08' => col = col.saturating_sub(1),
            '\t' => {
                let next = (col / 8 + 1) * 8;
                while col < next {
                    put(&mut line, &mut col, ' ');
                }
            }
            '\x1b' => match chars.next() {
                Some('[') => {
                    let mut params = String::new();
                    let mut fin = None;
                    for p in chars.by_ref() {
                        if ('\x40'..='\x7e').contains(&p) {
                            fin = Some(p);
                            break;
                        }
                        params.push(p);
                    }
                    let n = params.trim_start_matches(['?', '>', '=']).split(';').next().and_then(|s| s.parse::<usize>().ok());
                    match fin {
                        // Erase in line: 0 / none = to the end, 2 = whole line.
                        Some('K') => match n.unwrap_or(0) {
                            0 => line.truncate(col),
                            2 => line.clear(),
                            _ => {}
                        },
                        Some('C') => col += n.unwrap_or(1).max(1),
                        Some('D') => col = col.saturating_sub(n.unwrap_or(1).max(1)),
                        Some('G') => col = n.unwrap_or(1).max(1) - 1,
                        _ => {}
                    }
                }
                // OSC / DCS / SOS / PM / APC: skip to BEL or ST.
                Some(']' | 'P' | 'X' | '^' | '_') => {
                    while let Some(p) = chars.next() {
                        if p == '\x07' {
                            break;
                        }
                        if p == '\x1b' {
                            chars.next();
                            break;
                        }
                    }
                }
                // Charset designations take one more character.
                Some('(' | ')' | '*' | '+' | '#' | '%') => {
                    chars.next();
                }
                _ => {}
            },
            c if (c as u32) < 0x20 || c == '\x7f' => {}
            c => put(&mut line, &mut col, c),
        }
    }
    if !line.is_empty() {
        lines.push(line.iter().collect::<String>().trim_end().to_string());
    }
    while lines.last().is_some_and(|l| l.is_empty()) {
        lines.pop();
    }
    while lines.first().is_some_and(|l| l.is_empty()) {
        lines.remove(0);
    }
    lines.join("\n")
}

/// Keep long output readable for a model: the head and the (more useful) tail.
pub fn clip(text: &str, head: usize, tail: usize) -> String {
    let count = text.chars().count();
    if count <= head + tail {
        return text.to_string();
    }
    let first: String = text.chars().take(head).collect();
    let last: String = text.chars().skip(count - tail).collect();
    format!("{first}\n… [省略 {} 个字符] …\n{last}", count - head - tail)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tracker_with(mode: CaptureMode) -> (ShellTracker, SharedCapture) {
        let mut t = ShellTracker::default();
        let cap = Arc::new(Mutex::new(Capture::new(mode, Instant::now())));
        t.capture = Some(Arc::clone(&cap));
        (t, cap)
    }

    /// Plain text is skipped in runs; the result must not depend on where chunks split.
    #[test]
    fn chunking_does_not_change_the_capture() {
        let mut stream = Vec::new();
        stream.extend_from_slice(b"$ make\r\n\x1b]133;C\x07");
        for i in 0..3000 {
            stream.extend_from_slice(format!("line {i} \x1b[1;31mred\x1b[0m plain\r\n").as_bytes());
        }
        stream.extend_from_slice(b"\x1b[?1049h full screen \x1b[?1049l\x1b]133;D;2\x1b\\$ ");
        let run = |size: usize| {
            let (mut t, cap) = tracker_with(CaptureMode::Command);
            for c in stream.chunks(size) {
                t.feed(c, Instant::now());
            }
            let c = cap.lock().unwrap();
            (c.raw.clone(), c.pre.clone(), c.dropped, c.finished, t.integrated, t.running, t.alt_screen)
        };
        let whole = run(stream.len());
        assert_eq!(whole.3, Some(Some(2)));
        assert!(whole.0.starts_with(b"line 0 ") && whole.0.ends_with(b"\x1b]133;D;2\x1b\\"));
        assert_eq!(whole.1, b"$ make\r\n\x1b]133;C\x07");
        for size in [1, 2, 3, 7, 64, 4096] {
            assert_eq!(run(size), whole, "chunks of {size}");
        }
    }

    #[test]
    fn command_output_between_c_and_d() {
        let (mut t, cap) = tracker_with(CaptureMode::Command);
        let now = Instant::now();
        t.feed(b"ls -l\r\n\x1b]633;E;ls -l\x07\x1b]13", now);
        t.feed(b"3;C\x07total 0\r\nfile\r\n\x1b]133;D;", now);
        assert!(t.running);
        t.feed(b"2\x07\x1b]133;A\x07me$ ", now);
        let c = cap.lock().unwrap();
        assert_eq!(c.finished, Some(Some(2)));
        assert_eq!(plain_text(&c.raw), "total 0\nfile");
        assert!(t.integrated && !t.running);
    }

    #[test]
    fn empty_line_finishes_without_c() {
        let (mut t, cap) = tracker_with(CaptureMode::Command);
        t.feed(b"\r\n\x1b]133;D\x1b\\\x1b]133;A\x1b\\$ ", Instant::now());
        assert_eq!(cap.lock().unwrap().finished, Some(None));
    }

    #[test]
    fn fish_syntax_error_finishes_with_the_message() {
        // As fish 3.7 prints it: no C, the error, then the posterror handler's D.
        let (mut t, cap) = tracker_with(CaptureMode::Command);
        t.feed(b"true \r\x1b[45C&\r\x1b[46C&\r\x1b[47C S=sudo;\r\x1b[61C\r\n", Instant::now());
        t.feed(b"fish: Unsupported use of '='. In fish, please use 'set S sudo'.\r\n", Instant::now());
        t.feed(b"true && S=sudo\r\n        ^~~~~^\r\n\x1b]133;D;;err=syntax\x07\x1b]133;A\x07me> true && S=sudo", Instant::now());
        let c = cap.lock().unwrap();
        assert_eq!(c.finished, Some(None));
        assert!(c.syntax_error && !c.started && c.raw.is_empty());
        assert_eq!(c.pre_text(), "fish: Unsupported use of '='. In fish, please use 'set S sudo'.\ntrue && S=sudo\n        ^~~~~^");
    }

    #[test]
    fn bash_syntax_error_keeps_the_message() {
        let (mut t, cap) = tracker_with(CaptureMode::Command);
        t.feed(b"if then\r\nbash: syntax error near unexpected token `then'\r\n\x1b]133;D;2\x07\x1b]133;A\x07$ ", Instant::now());
        let c = cap.lock().unwrap();
        assert_eq!(c.finished, Some(Some(2)));
        assert!(!c.syntax_error);
        assert_eq!(c.pre_text(), "bash: syntax error near unexpected token `then'");
    }

    #[test]
    fn d_of_previous_command_is_not_ours() {
        let mut t = ShellTracker::default();
        t.feed(b"\x1b]133;C\x07", Instant::now());
        assert!(t.running);
        let cap = Arc::new(Mutex::new(Capture::new(CaptureMode::Command, Instant::now())));
        t.capture = Some(Arc::clone(&cap));
        t.feed(b"\x1b]133;D;0\x07", Instant::now());
        assert_eq!(cap.lock().unwrap().finished, None);
    }

    #[test]
    fn follows_the_alternate_screen() {
        let mut t = ShellTracker::default();
        let now = Instant::now();
        t.feed(b"\x1b[1;1H\x1b[?25l\x1b[?10", now);
        assert!(!t.alt_screen);
        t.feed(b"49h\x1b[H", now);
        assert!(t.alt_screen);
        t.feed(b"\x1b[?1;47l", now);
        assert!(!t.alt_screen);
        t.feed(b"\x1b[?1047h", now);
        assert!(t.alt_screen);
        // A CSI cut off by another escape does not count; neither does one without `?`.
        t.feed(b"\x1b[?10\x1b[?1049l", now);
        assert!(!t.alt_screen);
        t.feed(b"\x1b[1049h", now);
        assert!(!t.alt_screen);
    }

    #[test]
    fn continued_capture_returns_only_new_output() {
        let (mut t, cap) = tracker_with(CaptureMode::Watch);
        t.feed(b"tick 1\r\n", Instant::now());
        assert_eq!(plain_text(cap.lock().unwrap().take_unreported()), "tick 1");
        t.feed(b"tick 2\r\n", Instant::now());
        let mut c = cap.lock().unwrap();
        assert_eq!(c.unreported_start(), 8);
        assert_eq!(plain_text(c.take_unreported()), "tick 2");
        assert!(c.take_unreported().is_empty());
    }

    #[test]
    fn watch_collects_everything() {
        let (mut t, cap) = tracker_with(CaptureMode::Watch);
        t.feed(b"\x1b[32mok\x1b[0m\r\n", Instant::now());
        assert_eq!(plain_text(&cap.lock().unwrap().raw), "ok");
    }

    #[test]
    fn plain_text_applies_overwrites() {
        assert_eq!(plain_text(b"10%\r50%\r100%\r\ndone\r\n"), "100%\ndone");
        assert_eq!(plain_text(b"abcdef\r\x1b[Kxy\n"), "xy");
        assert_eq!(plain_text(b"ab\x08c\n"), "ac");
        assert_eq!(plain_text(b"\x1b]0;title\x07\x1b(Bhi\x1bP1$r0m\x1b\\!"), "hi!");
        assert_eq!(plain_text(b"a\tb"), "a       b");
    }

    #[test]
    fn replies_are_recognised() {
        assert!(is_terminal_reply(b"\x1b[12;40R"));
        assert!(is_terminal_reply(b"\x1b[?1;2c"));
        assert!(is_terminal_reply(b"\x1b[>0;276;0c"));
        assert!(is_terminal_reply(b"\x1b]11;rgb:0000/0000/0000\x1b\\"));
        assert!(is_terminal_reply(b"\x1b[I"));
        assert!(!is_terminal_reply(b"ls\r"));
        assert!(!is_terminal_reply(b"\x1b[A"));
        assert!(!is_terminal_reply(b"\x1b[<0;10;5M"));
        assert!(!is_terminal_reply(b"\x03"));
    }

    #[test]
    fn clip_keeps_head_and_tail() {
        let s = "a".repeat(10) + &"b".repeat(10);
        assert_eq!(clip(&s, 3, 4), "aaa\n… [省略 13 个字符] …\nbbbb");
        assert_eq!(clip("short", 3, 4), "short");
    }
}
