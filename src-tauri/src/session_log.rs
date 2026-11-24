use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use anyhow::{Context, Result};
use std::collections::VecDeque;
use alacritty_terminal::event::VoidListener;
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line as GridLine, Point};
use alacritty_terminal::term::{Config, Term, TermMode};
use alacritty_terminal::vte::ansi::{Color, Processor, StdSyncHandler};
use chrono::{DateTime, Local, TimeZone};
use crate::history::capture::{row_blank, row_hash, take_row, Size};
use crate::history::line::LineBuilder;

/// What a session log contains.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogMode {
    /// Plain text lines as the terminal showed them, control sequences resolved.
    Transcript,
    /// The output exactly as received, escape sequences included (replayable with `cat`).
    Raw,
}

/// When a log moves on to a new file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rotation {
    /// One file for the whole recording.
    Session,
    /// A new file each day / hour (`name_20261123.log`, `name_20261123-14.log`).
    Daily,
    Hourly,
    /// A new file once the current one reaches `max_bytes` (`name_2.log` ...).
    Size,
}

impl Rotation {
    /// `extra.logRotation`; older settings only have `logMaxSizeMb` (> 0 meant split by size).
    pub fn parse(value: &str, max_bytes: u64) -> Self {
        match value {
            "daily" => Self::Daily,
            "hourly" => Self::Hourly,
            "size" => Self::Size,
            "session" => Self::Session,
            _ if max_bytes > 0 => Self::Size,
            _ => Self::Session,
        }
    }

    fn period(self, time: &DateTime<Local>) -> Option<String> {
        match self {
            Self::Daily => Some(time.format("%Y%m%d").to_string()),
            Self::Hourly => Some(time.format("%Y%m%d-%H").to_string()),
            _ => None,
        }
    }
}

/// How a session log is written (WindTerm: session.logType / logPattern / logFileSize;
/// NyaTerm: transcript / raw recording, rotation).
#[derive(Debug, Clone)]
pub struct LogOptions {
    pub mode: LogMode,
    /// Prefix every transcript line using `line_pattern`.
    pub timestamp: bool,
    /// Line template: `%v` is the line, `%Y %m %d %H %M %S` are the time, `%f` milliseconds.
    pub line_pattern: String,
    pub rotation: Rotation,
    /// Size limit for `Rotation::Size` (0 = never split).
    pub max_bytes: u64,
    /// Raw logs: also keep the bytes of ZModem / XMODEM / YMODEM transfers.
    pub binary_payload: bool,
}

impl Default for LogOptions {
    fn default() -> Self {
        Self {
            mode: LogMode::Transcript,
            timestamp: true,
            line_pattern: default_line_pattern(),
            rotation: Rotation::Session,
            max_bytes: 0,
            binary_payload: false,
        }
    }
}

pub fn default_line_pattern() -> String {
    "[%Y-%m-%d %H:%M:%S] %v".to_string()
}

/// Rows the headless terminal may hold between two harvests.
const TERM_HISTORY: usize = 10_000;
/// Bytes parsed between harvests.
const SLICE: usize = 2048;
const CLEAR_SCROLLBACK: &[u8] = b"\x1b[3J";

/// A finished transcript line: text and when it was last written (unix ms).
struct ScreenLine {
    text: String,
    ts: i64,
}

/// Transcript source: a headless terminal follows the output like the pane does, so
/// cursor movement, redraws and line editing (fish, zsh, readline) end up as the text
/// that was really shown. A row is logged once it scrolls off the screen (or on stop).
struct Screen {
    term: Term<VoidListener>,
    parser: Processor<StdSyncHandler>,
    pending: LineBuilder,
    /// Per screen row: last write time (0: blank) and content hash.
    row_ts: VecDeque<i64>,
    row_hash: VecDeque<u64>,
}

fn now_ms() -> i64 {
    Local::now().timestamp_millis()
}

impl Screen {
    fn new(cols: u16, rows: u16) -> Self {
        let size = Size { cols: usize::from(cols.max(2)), rows: usize::from(rows.max(1)) };
        let config = Config { scrolling_history: TERM_HISTORY, ..Config::default() };
        let rows = size.rows;
        Screen {
            term: Term::new(config, &size, VoidListener),
            parser: Processor::new(),
            pending: LineBuilder::default(),
            row_ts: VecDeque::from(vec![0; rows]),
            row_hash: VecDeque::from(vec![0; rows]),
        }
    }

    fn alt_screen(&self) -> bool {
        self.term.mode().contains(TermMode::ALT_SCREEN)
    }

    fn feed(&mut self, data: &[u8], out: &mut Vec<ScreenLine>) {
        // `clear` wipes the scrollback: harvest the rows it pushed there first.
        let mut rest = data;
        while let Some(pos) = rest.windows(CLEAR_SCROLLBACK.len()).position(|w| w == CLEAR_SCROLLBACK) {
            self.advance(&rest[..pos], out);
            self.parser.advance(&mut self.term, CLEAR_SCROLLBACK);
            rest = &rest[pos + CLEAR_SCROLLBACK.len()..];
        }
        self.advance(rest, out);
        self.update_rows();
    }

    fn advance(&mut self, bytes: &[u8], out: &mut Vec<ScreenLine>) {
        for chunk in bytes.chunks(SLICE) {
            self.parser.advance(&mut self.term, chunk);
            self.harvest(out);
        }
    }

    fn take(&mut self, row: GridLine, ts: i64, out: &mut Vec<ScreenLine>) {
        let cols = self.term.grid().columns();
        take_row(&self.term.grid()[row], cols, ts, &mut self.pending, &mut |l| {
            out.push(ScreenLine { text: l.text.to_string(), ts: l.ts });
        });
    }

    /// Log the rows that scrolled into the terminal's own history.
    fn harvest(&mut self, out: &mut Vec<ScreenLine>) {
        let h = self.term.grid().history_size();
        if h == 0 {
            return;
        }
        for k in (1..=h).rev() {
            let ts = self.row_ts.pop_front().filter(|t| *t > 0).unwrap_or_else(now_ms);
            self.row_ts.push_back(0);
            self.row_hash.pop_front();
            self.row_hash.push_back(u64::MAX);
            self.take(GridLine(-(k as i32)), ts, out);
        }
        self.term.grid_mut().clear_history();
    }

    /// Stamp the rows whose content changed (main screen only).
    fn update_rows(&mut self) {
        if self.alt_screen() {
            return;
        }
        let now = now_ms();
        let grid = self.term.grid();
        let cols = grid.columns();
        let rows = grid.screen_lines();
        self.row_ts.resize(rows, 0);
        self.row_hash.resize(rows, u64::MAX);
        for r in 0..rows {
            let h = row_hash(&grid[GridLine(r as i32)], cols);
            if h != self.row_hash[r] {
                self.row_hash[r] = h;
                self.row_ts[r] = if h == 0 { 0 } else { now };
            }
        }
    }

    fn resize(&mut self, cols: u16, rows: u16, out: &mut Vec<ScreenLine>) {
        let size = Size { cols: usize::from(cols.max(2)), rows: usize::from(rows.max(1)) };
        if size.cols == self.term.columns() && size.rows == self.term.screen_lines() {
            return;
        }
        self.term.resize(size);
        self.harvest(out);
        let rows = self.term.screen_lines();
        self.row_ts = VecDeque::from(vec![0; rows]);
        self.row_hash = VecDeque::from(vec![u64::MAX; rows]);
        self.update_rows();
    }

    /// What is still on the screen (stop / pause): rows up to the last non-blank one.
    fn drain(&mut self, out: &mut Vec<ScreenLine>) {
        if !self.alt_screen() {
            let cols = self.term.grid().columns();
            let rows = self.term.grid().screen_lines();
            let last = (0..rows).rev().find(|&r| !row_blank(&self.term.grid()[GridLine(r as i32)], cols));
            if let Some(last) = last {
                for r in 0..=last {
                    let ts = self.row_ts.get(r).copied().filter(|t| *t > 0).unwrap_or_else(now_ms);
                    self.take(GridLine(r as i32), ts, out);
                }
            }
        }
        if self.pending.active {
            let l = self.pending.view();
            out.push(ScreenLine { text: l.text.to_string(), ts: l.ts });
            self.pending.active = false;
        }
        // Start over on an empty screen, cursor at the top.
        self.term.grid_mut().clear_viewport::<Color>();
        self.term.grid_mut().clear_history();
        self.term.grid_mut().cursor.point = Point::new(GridLine(0), Column(0));
        let rows = self.term.screen_lines();
        self.row_ts = VecDeque::from(vec![0; rows]);
        self.row_hash = VecDeque::from(vec![0; rows]);
    }
}

/// Session log: transcript (plain lines, optional timestamps)
/// or raw output, split by session, day, hour or size.
pub struct SessionLog {
    /// First file of the log (what the UI shows).
    path: PathBuf,
    /// File written right now (differs from `path` after a rotation).
    current: PathBuf,
    writer: BufWriter<File>,
    written: u64,
    part: u32,
    /// Day / hour of the current file (time based rotation).
    period: Option<String>,
    opts: LogOptions,
    paused: bool,
    screen: Screen,
}

fn open_append(path: &Path) -> Result<File> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("无法创建日志目录 {:?}", parent))?;
    }
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .with_context(|| format!("无法创建日志文件 {:?}", path))
}

/// `name.log` -> `name_<suffix>.log`.
fn suffixed_path(first: &Path, suffix: &str) -> PathBuf {
    let stem = first.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let name = match first.extension() {
        Some(ext) => format!("{}_{}.{}", stem, suffix, ext.to_string_lossy()),
        None => format!("{}_{}", stem, suffix),
    };
    first.with_file_name(name)
}

/// Expand the time tokens of a line pattern (`%v` is left for the caller).
fn expand_time(pattern: &str, time: &DateTime<Local>) -> String {
    let mut out = String::new();
    let mut chars = pattern.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some(spec @ ('Y' | 'm' | 'd' | 'H' | 'M' | 'S')) => out.push_str(&time.format(&format!("%{}", spec)).to_string()),
            Some('f') => out.push_str(&time.format("%3f").to_string()),
            Some('%') => out.push('%'),
            Some(other) => {
                out.push('%');
                out.push(other);
            }
            None => out.push('%'),
        }
    }
    out
}

impl SessionLog {
    pub fn create(dir: &Path, file_name: &str, opts: LogOptions) -> Result<Self> {
        fs::create_dir_all(dir).with_context(|| format!("无法创建日志目录 {:?}", dir))?;
        let path = dir.join(file_name);
        let file = open_append(&path)?;
        let written = file.metadata().map(|m| m.len()).unwrap_or(0);
        Ok(Self {
            current: path.clone(),
            path,
            writer: BufWriter::new(file),
            written,
            part: 1,
            period: opts.rotation.period(&Local::now()),
            opts,
            paused: false,
            screen: Screen::new(80, 24),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn current_path(&self) -> &Path {
        &self.current
    }

    pub fn set_paused(&mut self, paused: bool) {
        if paused && !self.paused {
            self.flush_partial();
        }
        self.paused = paused;
    }

    pub fn is_paused(&self) -> bool {
        self.paused
    }

    fn is_raw(&self) -> bool {
        self.opts.mode == LogMode::Raw
    }

    fn switch_to(&mut self, next: PathBuf) {
        let _ = self.writer.flush();
        if let Ok(file) = open_append(&next) {
            self.written = file.metadata().map(|m| m.len()).unwrap_or(0);
            self.writer = BufWriter::new(file);
            self.current = next;
        }
    }

    /// Move on to the next file when the period changed or the size limit was reached.
    /// Called only between records (transcript) or chunks (raw).
    fn rotate_if_needed(&mut self, now: &DateTime<Local>) {
        match self.opts.rotation {
            Rotation::Session => {}
            Rotation::Size => {
                if self.opts.max_bytes > 0 && self.written >= self.opts.max_bytes {
                    self.part += 1;
                    let next = suffixed_path(&self.path, &self.part.to_string());
                    self.switch_to(next);
                }
            }
            Rotation::Daily | Rotation::Hourly => {
                let period = self.opts.rotation.period(now);
                if period != self.period {
                    if let Some(key) = &period {
                        let next = suffixed_path(&self.path, key);
                        self.switch_to(next);
                    }
                    self.period = period;
                }
            }
        }
    }

    fn emit(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        let _ = self.writer.write_all(bytes);
        let _ = self.writer.flush();
        self.written += bytes.len() as u64;
    }

    /// One transcript line: `<pattern prefix>text<pattern suffix>\n`.
    fn write_record(&mut self, body: &[u8], time: DateTime<Local>) {
        self.rotate_if_needed(&Local::now());
        let mut line = Vec::with_capacity(body.len() + 32);
        if self.opts.timestamp {
            let pattern = if self.opts.line_pattern.trim().is_empty() { default_line_pattern() } else { self.opts.line_pattern.clone() };
            let (pre, post) = pattern.split_once("%v").unwrap_or((pattern.as_str(), ""));
            line.extend_from_slice(expand_time(pre, &time).as_bytes());
            line.extend_from_slice(body);
            line.extend_from_slice(expand_time(post, &time).as_bytes());
        } else {
            line.extend_from_slice(body);
        }
        line.push(b'\n');
        self.emit(&line);
    }

    fn write_lines(&mut self, lines: Vec<ScreenLine>) {
        for l in lines {
            let time = Local.timestamp_millis_opt(l.ts).single().unwrap_or_else(Local::now);
            self.write_record(l.text.as_bytes(), time);
        }
    }

    /// Write what is still on the screen (pause, stop).
    fn flush_partial(&mut self) {
        let mut out = Vec::new();
        self.screen.drain(&mut out);
        self.write_lines(out);
    }

    /// Pane size, so the headless terminal wraps and redraws like the pane.
    pub fn resize(&mut self, cols: u16, rows: u16) {
        if self.is_raw() {
            return;
        }
        let mut out = Vec::new();
        self.screen.resize(cols, rows, &mut out);
        self.write_lines(out);
    }

    /// Terminal output (UTF-8, as shown in the pane).
    pub fn write(&mut self, data: &[u8]) {
        if self.paused {
            return;
        }
        if self.is_raw() {
            self.rotate_if_needed(&Local::now());
            self.emit(data);
            return;
        }
        let mut out = Vec::new();
        self.screen.feed(data, &mut out);
        self.write_lines(out);
    }

    /// Bytes of a running ZModem / XMODEM / YMODEM transfer: only raw logs with
    /// `binary_payload` keep them, everything else leaves them out.
    pub fn write_transfer(&mut self, data: &[u8]) {
        if self.paused || !self.is_raw() || !self.opts.binary_payload {
            return;
        }
        self.rotate_if_needed(&Local::now());
        self.emit(data);
    }
}

impl Drop for SessionLog {
    fn drop(&mut self) {
        if !self.paused && !self.is_raw() {
            self.flush_partial();
        }
        let _ = self.writer.flush();
    }
}

/// Values a log file name pattern can refer to.
#[derive(Debug, Clone, Default)]
pub struct LogNameVars {
    pub label: String,
    pub host: String,
    pub user: String,
    pub protocol: String,
}

fn sanitize(value: &str) -> String {
    value
        .chars()
        .map(|c| if r#"\/:*?"<>|"#.contains(c) || c.is_control() { '_' } else { c })
        .collect()
}

/// Expand a WindTerm style log file pattern:
/// %n session name, %h host, %u user, %P protocol, %Y %m %d %H %M %S time.
/// `/` in the pattern makes sub folders (e.g. `%Y-%m/%n_%H-%M.log`).
pub fn expand_log_file_name(pattern: &str, vars: &LogNameVars) -> String {
    let now = Local::now();
    let mut out = String::new();
    let mut chars = pattern.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '%' {
            out.push(if c == '\\' { '/' } else { c });
            continue;
        }
        match chars.next() {
            Some('n') => out.push_str(&sanitize(&vars.label)),
            Some('h') => out.push_str(&sanitize(&vars.host)),
            Some('u') => out.push_str(&sanitize(&vars.user)),
            Some('P') => out.push_str(&sanitize(&vars.protocol)),
            Some(spec @ ('Y' | 'm' | 'd' | 'H' | 'M' | 'S')) => {
                out.push_str(&now.format(&format!("%{}", spec)).to_string())
            }
            Some('%') => out.push('%'),
            Some(other) => {
                out.push('%');
                out.push(other);
            }
            None => out.push('%'),
        }
    }
    // No absolute paths / parent escapes from a pattern.
    let parts: Vec<String> = out
        .split('/')
        .map(|p| p.trim())
        .filter(|p| !p.is_empty() && *p != "." && *p != "..")
        .map(|p| p.replace(':', "_"))
        .collect();
    if parts.is_empty() {
        format!("{}.log", sanitize(&vars.label))
    } else {
        parts.join("/")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        std::env::temp_dir().join(format!("wtn-log-{}", uuid::Uuid::new_v4()))
    }

    fn plain() -> LogOptions {
        LogOptions { timestamp: false, ..Default::default() }
    }

    fn read(log: SessionLog) -> String {
        let path = log.path().to_path_buf();
        drop(log);
        fs::read_to_string(path).unwrap()
    }

    #[test]
    fn test_strips_escape_sequences_and_adds_timestamps() {
        let dir = temp_dir();
        let mut log = SessionLog::create(&dir, "t.log", plain()).unwrap();
        log.write(b"\x1b[31mred\x1b[0m text\r\n\x1b]0;title\x07next");
        log.write(b" line\r\n");
        assert_eq!(read(log), "red text\nnext line\n");

        let mut stamped = SessionLog::create(&dir, "s.log", LogOptions::default()).unwrap();
        stamped.write(b"a\r\nb\r\n");
        let content = read(stamped);
        assert!(content.starts_with('['));
        assert_eq!(content.lines().count(), 2);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn test_partial_line_written_on_stop() {
        let dir = temp_dir();
        let mut log = SessionLog::create(&dir, "p.log", plain()).unwrap();
        log.write(b"done\r\nuser@host:~$ ");
        assert_eq!(read(log), "done\nuser@host:~$\n");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn test_line_pattern_with_suffix() {
        let dir = temp_dir();
        let opts = LogOptions { line_pattern: "<%v>".into(), ..Default::default() };
        let mut log = SessionLog::create(&dir, "p.log", opts).unwrap();
        log.write(b"one\r\ntwo\r\n");
        assert_eq!(read(log), "<one>\n<two>\n");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn test_line_editing_is_logged_as_shown() {
        let dir = temp_dir();
        let mut log = SessionLog::create(&dir, "io.log", plain()).unwrap();
        log.write(b"\x1b[1m$\x1b[0m ");
        // Typed one key at a time, each echoed back; a backspace erases on screen.
        for echo in [&b"l"[..], b"x", b"\x08\x1b[K", b"s"] {
            log.write(echo);
        }
        log.write(b"\r\nfile1  file2\r\n$ ");
        assert_eq!(read(log), "$ ls\nfile1  file2\n$\n");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn test_shell_redraws_are_logged_as_shown() {
        // fish: autosuggestion in grey, right prompt, each key redraws the line.
        let dir = temp_dir();
        let mut log = SessionLog::create(&dir, "fish.log", plain()).unwrap();
        log.resize(40, 5);
        log.write(b"\x1b[?2004h\r\x1b[33C[1]\r> ");
        log.write(b"d\x1b[90mocker ps\x1b[0m\x1b[8D");
        log.write(b"ocker ps");
        log.write(b"\r\n\x1b[?2004lCONTAINER ID\r\nabc123\r\n\r> ");
        assert_eq!(read(log), "> docker ps                      [1]\nCONTAINER ID\nabc123\n>\n");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn test_full_screen_programs_are_left_out() {
        let dir = temp_dir();
        let mut log = SessionLog::create(&dir, "vim.log", plain()).unwrap();
        log.resize(20, 3);
        log.write(b"$ vim\r\n\x1b[?1049h");
        for i in 0..10 {
            log.write(format!("line {i}\r\n").as_bytes());
        }
        log.write(b"\x1b[?1049l$ ");
        assert_eq!(read(log), "$ vim\n$\n");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn test_pause_raw_and_split() {
        let dir = temp_dir();
        let raw = LogOptions { mode: LogMode::Raw, ..plain() };
        let mut log = SessionLog::create(&dir, "r.log", raw.clone()).unwrap();
        log.write(b"\x1b[1mA\r\n");
        log.set_paused(true);
        log.write(b"hidden\r\n");
        log.set_paused(false);
        log.write(b"B");
        assert_eq!(fs::read(log.path()).unwrap(), b"\x1b[1mA\r\nB");

        let opts = LogOptions { rotation: Rotation::Size, max_bytes: 10, ..plain() };
        let mut split = SessionLog::create(&dir, "big.log", opts).unwrap();
        split.resize(20, 1);
        split.write(b"0123456789\r\nabc\r\n");
        assert_eq!(split.current_path(), dir.join("big_2.log"));
        drop(split);
        assert_eq!(fs::read_to_string(dir.join("big.log")).unwrap(), "0123456789\n");
        assert_eq!(fs::read_to_string(dir.join("big_2.log")).unwrap(), "abc\n");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn test_time_rotation_and_binary_payload() {
        let dir = temp_dir();
        let opts = LogOptions { rotation: Rotation::Daily, ..plain() };
        let mut log = SessionLog::create(&dir, "d.log", opts).unwrap();
        log.period = Some("19700101".into());
        log.resize(20, 1);
        log.write(b"today\r\n");
        let key = Local::now().format("%Y%m%d").to_string();
        assert_eq!(log.current_path(), dir.join(format!("d_{}.log", key)));
        drop(log);
        assert_eq!(fs::read_to_string(dir.join(format!("d_{}.log", key))).unwrap(), "today\n");

        let raw = LogOptions { mode: LogMode::Raw, ..plain() };
        let mut without = SessionLog::create(&dir, "nb.log", raw.clone()).unwrap();
        without.write(b"rz\r\n");
        without.write_transfer(b"**\x18B00");
        assert_eq!(fs::read(without.path()).unwrap(), b"rz\r\n");
        let mut with = SessionLog::create(&dir, "b.log", LogOptions { binary_payload: true, ..raw }).unwrap();
        with.write_transfer(b"**\x18B00");
        assert_eq!(fs::read(with.path()).unwrap(), b"**\x18B00");
        assert_eq!(Rotation::parse("", 5), Rotation::Size);
        assert_eq!(Rotation::parse("hourly", 0), Rotation::Hourly);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn test_expand_log_file_name() {
        let vars = LogNameVars { label: "a/b:c".into(), host: "10.0.0.1".into(), user: "root".into(), protocol: "ssh".into() };
        let name = expand_log_file_name("%n_%Y.log", &vars);
        assert!(name.starts_with("a_b_c_20"));
        assert!(name.ends_with(".log"));
        assert_eq!(expand_log_file_name("%P/%u-%h.log", &vars), "ssh/root-10.0.0.1.log");
        assert_eq!(expand_log_file_name("../../x.log", &vars), "x.log");
    }
}
