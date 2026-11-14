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
    /// Bytes dropped from the front once `raw` hit [`CAPTURE_LIMIT`].
    pub dropped: usize,
    /// Set by OSC 133 D: `Some(exit)` (None when the shell gave no code).
    pub finished: Option<Option<i32>>,
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
            dropped: 0,
            finished: None,
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

    fn push(&mut self, b: u8) {
        if self.raw.len() >= CAPTURE_LIMIT {
            let cut = CAPTURE_LIMIT / 4;
            self.raw.drain(..cut);
            self.dropped += cut;
        }
        self.raw.push(b);
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
}

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
    pub capture: Option<SharedCapture>,
}

impl Default for ShellTracker {
    fn default() -> Self {
        Self { scan: Scan::Normal, osc: Vec::new(), osc_overflow: false, integrated: false, running: false, capture: None }
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
        for &b in data {
            if let Some(c) = cap.as_mut() {
                if c.started && c.finished.is_none() {
                    c.push(b);
                }
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
                    } else {
                        self.scan = if b == 0x1b { Scan::Esc } else { Scan::Normal };
                    }
                }
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
                if let Some(c) = cap {
                    // An empty line gives a D without a C: the command is over either way.
                    let ours = match c.mode {
                        CaptureMode::Command => c.started || !was_running,
                        CaptureMode::Watch => true,
                    };
                    if ours && c.finished.is_none() {
                        c.finished = Some(exit);
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
