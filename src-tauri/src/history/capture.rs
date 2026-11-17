//! Turns terminal output into logical lines: a headless `alacritty_terminal` follows the
//! same byte stream as xterm.js, and every row that scrolls off its screen goes to the archive.

use std::collections::VecDeque;
use std::time::Instant;

use alacritty_terminal::event::VoidListener;
use alacritty_terminal::grid::{Dimensions, Row};
use alacritty_terminal::index::{Column, Line as GridLine};
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::term::{Config, Term, TermMode};
use alacritty_terminal::vte::ansi::{Color, NamedColor, Processor, StdSyncHandler};

use super::archive::Archive;
use super::line::*;

/// Rows the headless terminal may hold in its own history between two harvests.
const TERM_HISTORY: usize = 10_000;
/// Bytes parsed between harvests: bounds the rows scrolled (and allocated) in one go.
const SLICE: usize = 2048;
const CLEAR_SCROLLBACK: &[u8] = b"\x1b[3J";
const RESET: &[u8] = b"\x1bc";

struct Size {
    cols: usize,
    rows: usize,
}

impl Dimensions for Size {
    fn total_lines(&self) -> usize {
        self.rows
    }
    fn screen_lines(&self) -> usize {
        self.rows
    }
    fn columns(&self) -> usize {
        self.cols
    }
}

pub struct Capture {
    term: Term<VoidListener>,
    parser: Processor<StdSyncHandler>,
    pub archive: Archive,
    /// A logical line whose rows wrapped past the part already harvested.
    pending: LineBuilder,
    /// When each screen row was last written (0: blank, time unknown), and its content hash.
    row_ts: VecDeque<i64>,
    row_hash: VecDeque<u64>,
    /// The start of a sequence we split on, cut off at the end of the last chunk.
    carry: Vec<u8>,
}

impl Capture {
    pub fn new(cols: u16, rows: u16, archive: Archive) -> Self {
        let size = Size { cols: usize::from(cols.max(2)), rows: usize::from(rows.max(1)) };
        let config = Config { scrolling_history: TERM_HISTORY, ..Config::default() };
        let rows = size.rows;
        Capture {
            term: Term::new(config, &size, VoidListener),
            parser: Processor::new(),
            archive,
            pending: LineBuilder::default(),
            row_ts: VecDeque::from(vec![0; rows]),
            row_hash: VecDeque::from(vec![0; rows]),
            carry: Vec::new(),
        }
    }

    pub fn feed(&mut self, data: &[u8], now: i64) {
        let mut buf = std::mem::take(&mut self.carry);
        buf.extend_from_slice(data);
        let mut start = 0;
        let mut i = 0;
        let mut end = buf.len();
        while let Some(off) = buf[i..].iter().position(|&b| b == 0x1b) {
            i += off;
            let rest = &buf[i..];
            if rest.starts_with(CLEAR_SCROLLBACK) {
                // `clear`: the remote wipes the scrollback. The full history keeps it; note where.
                self.advance(&buf[start..i], now);
                self.archive.mark_cleared(now);
                i += CLEAR_SCROLLBACK.len();
                start = i;
            } else if rest.starts_with(RESET) {
                // A full reset discards the screen: archive it first.
                self.advance(&buf[start..i], now);
                self.push_screen(now);
                self.parser.advance(&mut self.term, RESET);
                self.forget_rows();
                i += RESET.len();
                start = i;
            } else if rest.len() < CLEAR_SCROLLBACK.len() && (CLEAR_SCROLLBACK.starts_with(rest) || RESET.starts_with(rest)) {
                self.carry = rest.to_vec();
                end = i;
                break;
            } else {
                i += 1;
            }
        }
        self.advance(&buf[start..end], now);
        self.update_rows(now);
    }

    /// No output for a while: end a synchronized update the program never closed, and
    /// release a held-back escape that turned out not to start a split sequence.
    pub fn tick(&mut self, now: i64) {
        if self.parser.sync_timeout().sync_timeout().is_some_and(|t| Instant::now() >= t) {
            self.parser.stop_sync(&mut self.term);
            self.harvest(now);
        }
        if !self.carry.is_empty() {
            let carry = std::mem::take(&mut self.carry);
            self.advance(&carry, now);
        }
        self.update_rows(now);
    }

    pub fn resize(&mut self, cols: u16, rows: u16, now: i64) {
        let size = Size { cols: usize::from(cols.max(2)), rows: usize::from(rows.max(1)) };
        if size.cols == self.term.columns() && size.rows == self.term.screen_lines() {
            return;
        }
        self.term.resize(size);
        self.harvest(now);
        self.forget_rows();
        self.update_rows(now);
    }

    /// The user cleared the scrollback. Like xterm.js `clear()`: drop the history and the
    /// rows above the cursor, and move the cursor's row to the top.
    pub fn clear(&mut self, now: i64) {
        self.archive.clear();
        self.pending.active = false;
        if !self.term.mode().contains(TermMode::ALT_SCREEN) {
            let rows = self.term.screen_lines();
            let grid = self.term.grid_mut();
            let up = grid.cursor.point.line.0.max(0) as usize;
            if up > 0 {
                grid.scroll_up::<Color>(&(GridLine(0)..GridLine(rows as i32)), up);
                grid.cursor.point.line = GridLine(0);
            }
            grid.clear_history();
        }
        self.forget_rows();
        self.update_rows(now);
    }

    /// The lines still on screen (not yet in the archive), oldest first.
    pub fn tail(&self) -> Vec<Line> {
        let mut out = Vec::new();
        let mut pending = self.pending.clone();
        if !self.term.mode().contains(TermMode::ALT_SCREEN) {
            let grid = self.term.grid();
            let cols = grid.columns();
            let last = (0..grid.screen_lines()).rev().find(|&r| !row_blank(&grid[GridLine(r as i32)], cols));
            if let Some(last) = last {
                for r in 0..=last {
                    let ts = self.row_ts.get(r).copied().filter(|t| *t > 0).unwrap_or(0);
                    take_row(&grid[GridLine(r as i32)], cols, ts, &mut pending, &mut |l| out.push(l.to_line()));
                }
            }
        }
        if pending.active {
            out.push(pending.view().to_line());
        }
        out
    }

    fn advance(&mut self, bytes: &[u8], now: i64) {
        for chunk in bytes.chunks(SLICE) {
            self.parser.advance(&mut self.term, chunk);
            self.harvest(now);
        }
    }

    /// Move the rows that scrolled into the terminal's own history to the archive.
    fn harvest(&mut self, now: i64) {
        let grid = self.term.grid();
        let h = grid.history_size();
        if h == 0 {
            return;
        }
        let cols = grid.columns();
        let archive = &mut self.archive;
        for k in (1..=h).rev() {
            // The top screen row scrolled out: its time goes with it, a blank row comes in.
            let ts = self.row_ts.pop_front().filter(|t| *t > 0).unwrap_or(now);
            self.row_ts.push_back(0);
            self.row_hash.pop_front();
            self.row_hash.push_back(u64::MAX);
            take_row(&grid[GridLine(-(k as i32))], cols, ts, &mut self.pending, &mut |l| archive.push(l));
        }
        self.term.grid_mut().clear_history();
    }

    /// Scroll the whole screen into the archive (before a reset wipes it).
    fn push_screen(&mut self, now: i64) {
        if !self.term.mode().contains(TermMode::ALT_SCREEN) {
            self.term.grid_mut().clear_viewport::<Color>();
            self.harvest(now);
        }
    }

    fn forget_rows(&mut self) {
        let rows = self.term.screen_lines();
        self.row_ts = VecDeque::from(vec![0; rows]);
        self.row_hash = VecDeque::from(vec![u64::MAX; rows]);
    }

    /// Stamp the rows whose content changed. Skipped on the alternate screen, so the
    /// main screen's rows keep their times across `vim` / `less`.
    fn update_rows(&mut self, now: i64) {
        if self.term.mode().contains(TermMode::ALT_SCREEN) {
            return;
        }
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
}

#[inline]
fn blank(cell: &Cell) -> bool {
    cell.c == ' '
        && cell.bg == Color::Named(NamedColor::Background)
        && !cell.flags.intersects(Flags::INVERSE | Flags::ALL_UNDERLINES | Flags::STRIKEOUT)
}

fn row_blank(row: &Row<Cell>, cols: usize) -> bool {
    (0..cols).all(|c| blank(&row[Column(c)]))
}

/// FNV-1a over the row's characters and attributes; 0 for a blank row.
fn row_hash(row: &Row<Cell>, cols: usize) -> u64 {
    if row_blank(row, cols) {
        return 0;
    }
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for c in 0..cols {
        let cell = &row[Column(c)];
        for v in [cell.c as u64, u64::from(cell.flags.bits()), color_key(cell.fg)] {
            h = (h ^ v).wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    h.max(1)
}

fn color_key(c: Color) -> u64 {
    match c {
        Color::Named(n) => n as u64,
        Color::Indexed(i) => 0x1000 + u64::from(i),
        Color::Spec(rgb) => 0x10000 + (u64::from(rgb.r) << 16 | u64::from(rgb.g) << 8 | u64::from(rgb.b)),
    }
}

/// Append one grid row to the open logical line; a row not ending in an automatic wrap
/// finishes the line and hands it to `out`.
fn take_row(row: &Row<Cell>, cols: usize, ts: i64, b: &mut LineBuilder, out: &mut impl FnMut(LineRef)) {
    let wrapped = row[Column(cols - 1)].flags.contains(Flags::WRAPLINE);
    if !b.active {
        b.start(ts);
    }
    b.ts = b.ts.max(ts);
    let mut end = cols;
    if !wrapped {
        while end > 0 && blank(&row[Column(end - 1)]) {
            end -= 1;
        }
    }
    // Neighbouring cells mostly share attributes: convert them once.
    let mut last: Option<(Color, Color, Flags, Style)> = None;
    for c in 0..end {
        let cell = &row[Column(c)];
        if cell.flags.intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER) {
            continue;
        }
        let style = match last {
            Some((fg, bg, fl, st)) if fg == cell.fg && bg == cell.bg && fl == cell.flags => st,
            _ => {
                let st = style_of(cell);
                last = Some((cell.fg, cell.bg, cell.flags, st));
                st
            }
        };
        let ch = match cell.c {
            '\t' | '\0' => ' ',
            ch => ch,
        };
        b.push(ch, style);
        if let Some(zw) = cell.zerowidth() {
            for &z in zw {
                b.push(z, style);
            }
        }
    }
    if !wrapped {
        out(b.view());
        b.active = false;
    }
}

fn style_of(cell: &Cell) -> Style {
    let mut flags = 0u16;
    let f = cell.flags;
    if f.contains(Flags::BOLD) {
        flags |= F_BOLD;
    }
    if f.contains(Flags::DIM) {
        flags |= F_DIM;
    }
    if f.contains(Flags::ITALIC) {
        flags |= F_ITALIC;
    }
    if f.intersects(Flags::ALL_UNDERLINES) {
        flags |= F_UNDERLINE;
    }
    if f.contains(Flags::INVERSE) {
        flags |= F_INVERSE;
    }
    if f.contains(Flags::STRIKEOUT) {
        flags |= F_STRIKE;
    }
    if f.contains(Flags::HIDDEN) {
        flags |= F_HIDDEN;
    }
    let fg = color(cell.fg, &mut flags);
    let bg = color(cell.bg, &mut 0);
    Style { fg, bg, flags }
}

fn color(c: Color, flags: &mut u16) -> u32 {
    match c {
        Color::Spec(rgb) => COLOR_RGB | u32::from(rgb.r) << 16 | u32::from(rgb.g) << 8 | u32::from(rgb.b),
        Color::Indexed(i) => u32::from(i),
        Color::Named(n) => {
            let v = n as usize;
            let dim0 = NamedColor::DimBlack as usize;
            if v < 16 {
                v as u32
            } else if (dim0..dim0 + 8).contains(&v) {
                *flags |= F_DIM;
                (v - dim0) as u32
            } else {
                if n == NamedColor::DimForeground {
                    *flags |= F_DIM;
                }
                COLOR_DEFAULT
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::archive::{Archive, Limits};
    use super::*;

    fn cap(cols: u16, rows: u16) -> Capture {
        Capture::new(cols, rows, Archive::new(Limits::default(), None, "t"))
    }

    fn archived(c: &Capture) -> Vec<Line> {
        let plan = c.archive.plan(0, u64::MAX);
        let mut out = Vec::new();
        for b in &plan.blocks {
            out.extend(c.archive.cache.get(b).unwrap().iter().cloned());
        }
        out.extend(plan.hot);
        out
    }

    fn texts(lines: &[Line]) -> Vec<String> {
        lines.iter().map(|l| if l.kind == KIND_CLEARED { "<cleared>".into() } else { l.text.clone() }).collect()
    }

    #[test]
    fn plain_lines_scroll_into_archive() {
        let mut c = cap(20, 3);
        c.feed(b"a\r\nb\r\nc\r\nd\r\ne", 10);
        assert_eq!(texts(&archived(&c)), ["a", "b"]);
        assert_eq!(texts(&c.tail()), ["c", "d", "e"]);
    }

    #[test]
    fn wrapped_rows_join_into_one_line() {
        let mut c = cap(10, 2);
        c.feed(b"0123456789abcdefghijKLM\r\nnext\r\n\r\n", 1);
        let a = archived(&c);
        assert_eq!(texts(&a), ["0123456789abcdefghijKLM", "next"]);
    }

    #[test]
    fn line_split_between_archive_and_screen_shows_in_tail() {
        let mut c = cap(5, 2);
        c.feed(b"abcdefghijklm", 1);
        // Rows "abcde" scrolled out, "fghij" + "klm" still on screen: one open logical line.
        assert!(archived(&c).is_empty());
        assert_eq!(texts(&c.tail()), ["abcdefghijklm"]);
    }

    #[test]
    fn carriage_return_progress_keeps_final_state() {
        let mut c = cap(20, 2);
        c.feed(b"10%\r50%\r100%\r\nok\r\n\r\n", 1);
        assert_eq!(texts(&archived(&c)), ["100%", "ok"]);
    }

    #[test]
    fn clear_keeps_history_and_marks_it() {
        let mut c = cap(20, 3);
        c.feed(b"one\r\ntwo\r\n", 1);
        // What `clear` sends, split across two chunks inside the ESC[3J.
        c.feed(b"\x1b[H\x1b[2J\x1b[", 2);
        c.feed(b"3Jprompt", 3);
        assert_eq!(texts(&archived(&c)), ["one", "two", "<cleared>"]);
        assert_eq!(texts(&c.tail()), ["prompt"]);
    }

    #[test]
    fn reset_archives_screen() {
        let mut c = cap(20, 3);
        c.feed(b"keep me\r\n\x1bcfresh", 1);
        assert_eq!(texts(&archived(&c)), ["keep me"]);
        assert_eq!(texts(&c.tail()), ["fresh"]);
    }

    #[test]
    fn alt_screen_is_not_archived() {
        let mut c = cap(20, 2);
        c.feed(b"before\r\n\x1b[?1049h", 1);
        for i in 0..10 {
            c.feed(format!("vim {i}\r\n").as_bytes(), 2);
        }
        c.feed(b"\x1b[?1049lafter\r\n\r\n", 3);
        assert_eq!(texts(&archived(&c)), ["before", "after"]);
    }

    #[test]
    fn colors_and_wide_chars() {
        let mut c = cap(10, 1);
        c.feed("\x1b[1;31m中文\x1b[0mx\x1b[38;2;1;2;3my\r\n".as_bytes(), 1);
        c.feed(b"\r\n", 2);
        let a = archived(&c);
        assert_eq!(a[0].text, "中文xy");
        let red = Style { fg: 1, bg: COLOR_DEFAULT, flags: F_BOLD };
        assert_eq!(
            a[0].runs,
            vec![
                Run { start: 0, style: red },
                Run { start: 2, style: Style::default() },
                Run { start: 3, style: Style { fg: COLOR_RGB | 0x010203, ..Style::default() } },
            ]
        );
        // A wide char that does not fit at the end of a row wraps whole.
        let mut c = cap(5, 1);
        c.feed("abcd中\r\n".as_bytes(), 1);
        assert_eq!(texts(&archived(&c)), ["abcd中"]);
    }

    #[test]
    fn row_timestamps_follow_rows() {
        let mut c = cap(20, 3);
        c.feed(b"$ ", 100);
        c.feed(b"ls\r\n", 200);
        c.feed(b"out\r\n$ ", 300);
        c.feed(b"\r\n\r\n\r\n", 900);
        let a = archived(&c);
        assert_eq!(texts(&a), ["$ ls", "out", "$"]);
        assert_eq!(a.iter().map(|l| l.ts).collect::<Vec<_>>(), [200, 300, 300]);
    }

    #[test]
    fn resize_then_continue() {
        let mut c = cap(10, 3);
        c.feed(b"1\r\n2\r\n3", 1);
        c.resize(10, 2, 2);
        c.feed(b"\r\n4\r\n5\r\n", 3);
        assert_eq!(texts(&archived(&c)), ["1", "2", "3", "4"]);
    }

    #[test]
    fn user_clear_drops_everything() {
        let mut c = cap(10, 3);
        c.feed(b"1\r\n2\r\n3\r\n4\r\n$ 5", 1);
        c.clear(2);
        assert!(archived(&c).is_empty());
        assert_eq!(texts(&c.tail()), ["$ 5"]);
        c.feed(b"\r\nx\r\ny\r\nz\r\n", 3);
        assert_eq!(texts(&archived(&c)), ["$ 5", "x"]);
    }

    #[test]
    fn many_lines_in_one_chunk() {
        let mut c = cap(80, 24);
        let data: String = (0..100_000).map(|i| format!("{i}\r\n")).collect();
        c.feed(data.as_bytes(), 1);
        let a = archived(&c);
        assert_eq!(a.len(), 100_000 - 23);
        assert_eq!(a[99_976].text, "99976");
    }
}
