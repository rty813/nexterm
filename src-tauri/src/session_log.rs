use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use anyhow::{Context, Result};
use chrono::Local;

/// How a session log is written (WindTerm: session.logType / logPattern / logFileSize).
#[derive(Debug, Clone)]
pub struct LogOptions {
    /// Prefix every line using `line_pattern`.
    pub timestamp: bool,
    /// Line template: `%v` is the line, `%Y %m %d %H %M %S %f` are the time (%f = milliseconds).
    pub line_pattern: String,
    /// Start a new file once the current one reaches this size (0 = never split).
    pub max_bytes: u64,
    /// Keep the raw output with its escape sequences instead of plain text.
    pub raw: bool,
}

impl Default for LogOptions {
    fn default() -> Self {
        Self { timestamp: true, line_pattern: default_line_pattern(), max_bytes: 0, raw: false }
    }
}

pub fn default_line_pattern() -> String {
    "[%Y-%m-%d %H:%M:%S] %v".to_string()
}

/// Session log, like WindTerm's session logging: escape sequences are stripped
/// (unless raw), lines can be prefixed with a time, and big logs are split.
pub struct SessionLog {
    /// First file of the log (what the UI shows).
    path: PathBuf,
    /// File written right now (differs from `path` after a split).
    current: PathBuf,
    writer: BufWriter<File>,
    written: u64,
    part: u32,
    opts: LogOptions,
    paused: bool,
    at_line_start: bool,
    /// Line pattern text after `%v`, written at the end of the current line.
    suffix: String,
    esc: EscState,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum EscState {
    Ground,
    Escape,
    Csi,
    /// OSC / DCS / APC / PM / SOS string, terminated by BEL or ESC \
    Str,
    StrEscape,
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

/// `name.log` -> `name_2.log` for the second part of a split log.
fn part_path(first: &Path, part: u32) -> PathBuf {
    let stem = first.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let name = match first.extension() {
        Some(ext) => format!("{}_{}.{}", stem, part, ext.to_string_lossy()),
        None => format!("{}_{}", stem, part),
    };
    first.with_file_name(name)
}

/// Expand the time tokens of a line pattern (`%v` is left for the caller).
fn expand_time(pattern: &str) -> String {
    let now = Local::now();
    let mut out = String::new();
    let mut chars = pattern.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some(spec @ ('Y' | 'm' | 'd' | 'H' | 'M' | 'S')) => out.push_str(&now.format(&format!("%{}", spec)).to_string()),
            Some('f') => out.push_str(&now.format("%3f").to_string()),
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
            opts,
            paused: false,
            at_line_start: true,
            suffix: String::new(),
            esc: EscState::Ground,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn current_path(&self) -> &Path {
        &self.current
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.paused = paused;
    }

    pub fn is_paused(&self) -> bool {
        self.paused
    }

    fn line_prefix_suffix(&self) -> (String, String) {
        if !self.opts.timestamp {
            return (String::new(), String::new());
        }
        let pattern = if self.opts.line_pattern.trim().is_empty() { default_line_pattern() } else { self.opts.line_pattern.clone() };
        match pattern.split_once("%v") {
            Some((pre, post)) => (expand_time(pre), expand_time(post)),
            None => (expand_time(&pattern), String::new()),
        }
    }

    /// Move on to the next part once the size limit is reached (only between lines).
    fn rotate_if_needed(&mut self) {
        if self.opts.max_bytes == 0 || self.written < self.opts.max_bytes {
            return;
        }
        let _ = self.writer.flush();
        let next = part_path(&self.path, self.part + 1);
        if let Ok(file) = open_append(&next) {
            self.part += 1;
            self.written = file.metadata().map(|m| m.len()).unwrap_or(0);
            self.writer = BufWriter::new(file);
            self.current = next;
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

    pub fn write(&mut self, data: &[u8]) {
        if self.paused {
            return;
        }
        if self.opts.raw {
            self.rotate_if_needed();
            self.emit(data);
            return;
        }
        let mut out: Vec<u8> = Vec::with_capacity(data.len() + 32);
        for &b in data {
            match self.esc {
                EscState::Ground => match b {
                    0x1b => self.esc = EscState::Escape,
                    b'\r' | 0x07 | 0x08 | 0x00 => {}
                    b'\n' => {
                        out.extend_from_slice(self.suffix.as_bytes());
                        self.suffix.clear();
                        out.push(b'\n');
                        self.at_line_start = true;
                        // Split only at line ends, so a line never spans two files.
                        if self.opts.max_bytes > 0 && self.written + out.len() as u64 >= self.opts.max_bytes {
                            let chunk = std::mem::take(&mut out);
                            self.emit(&chunk);
                            self.rotate_if_needed();
                        }
                    }
                    _ => {
                        if self.at_line_start {
                            let (pre, post) = self.line_prefix_suffix();
                            out.extend_from_slice(pre.as_bytes());
                            self.suffix = post;
                            self.at_line_start = false;
                        }
                        out.push(b);
                    }
                },
                EscState::Escape => {
                    self.esc = match b {
                        b'[' => EscState::Csi,
                        b']' | b'P' | b'_' | b'^' | b'X' => EscState::Str,
                        // ESC ( B and friends carry one more byte; ignore it with the next char.
                        _ => EscState::Ground,
                    }
                }
                EscState::Csi => {
                    if (0x40..=0x7e).contains(&b) {
                        self.esc = EscState::Ground;
                    }
                }
                EscState::Str => match b {
                    0x07 => self.esc = EscState::Ground,
                    0x1b => self.esc = EscState::StrEscape,
                    _ => {}
                },
                EscState::StrEscape => {
                    self.esc = if b == b'\\' { EscState::Ground } else { EscState::Str };
                }
            }
        }
        self.emit(&out);
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

    #[test]
    fn test_strips_escape_sequences_and_adds_timestamps() {
        let dir = temp_dir();
        let mut log = SessionLog::create(&dir, "t.log", plain()).unwrap();
        log.write(b"\x1b[31mred\x1b[0m text\r\n\x1b]0;title\x07next");
        log.write(b" line\r\n");
        let content = fs::read_to_string(log.path()).unwrap();
        assert_eq!(content, "red text\nnext line\n");

        let mut stamped = SessionLog::create(&dir, "s.log", LogOptions::default()).unwrap();
        stamped.write(b"a\r\nb\r\n");
        let content = fs::read_to_string(stamped.path()).unwrap();
        assert!(content.starts_with('['));
        assert_eq!(content.lines().count(), 2);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn test_line_pattern_with_suffix() {
        let dir = temp_dir();
        let opts = LogOptions { line_pattern: "<%v>".into(), ..Default::default() };
        let mut log = SessionLog::create(&dir, "p.log", opts).unwrap();
        log.write(b"one\r\ntwo\r\n");
        assert_eq!(fs::read_to_string(log.path()).unwrap(), "<one>\n<two>\n");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn test_pause_raw_and_split() {
        let dir = temp_dir();
        let mut log = SessionLog::create(&dir, "r.log", LogOptions { raw: true, ..plain() }).unwrap();
        log.write(b"\x1b[1mA\r\n");
        log.set_paused(true);
        log.write(b"hidden\r\n");
        log.set_paused(false);
        log.write(b"B");
        assert_eq!(fs::read(log.path()).unwrap(), b"\x1b[1mA\r\nB");

        let mut split = SessionLog::create(&dir, "big.log", LogOptions { max_bytes: 10, ..plain() }).unwrap();
        split.write(b"0123456789\r\nabc\r\n");
        assert_eq!(fs::read_to_string(dir.join("big.log")).unwrap(), "0123456789\n");
        assert_eq!(fs::read_to_string(dir.join("big_2.log")).unwrap(), "abc\n");
        assert_eq!(split.current_path(), dir.join("big_2.log"));
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
