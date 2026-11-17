//! Logical lines of the full history and their compact block encoding.

use std::collections::HashMap;

use serde::Serialize;

/// Line kinds. Markers have no text of their own; the viewer labels them.
pub const KIND_TEXT: u8 = 0;
/// The remote cleared the scrollback (`ESC[3J`, sent by `clear`); the history keeps it.
pub const KIND_CLEARED: u8 = 1;

/// Colors: 0..=255 palette index, `COLOR_RGB | 0xRRGGBB` true color, `COLOR_DEFAULT` the theme's.
pub const COLOR_DEFAULT: u32 = 0xFF00_0000;
pub const COLOR_RGB: u32 = 0x0100_0000;

pub const F_BOLD: u16 = 1;
pub const F_DIM: u16 = 2;
pub const F_ITALIC: u16 = 4;
pub const F_UNDERLINE: u16 = 8;
pub const F_INVERSE: u16 = 16;
pub const F_STRIKE: u16 = 32;
pub const F_HIDDEN: u16 = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
pub struct Style {
    pub fg: u32,
    pub bg: u32,
    pub flags: u16,
}

impl Default for Style {
    fn default() -> Self {
        Style { fg: COLOR_DEFAULT, bg: COLOR_DEFAULT, flags: 0 }
    }
}

impl Style {
    pub fn is_default(&self) -> bool {
        *self == Style::default()
    }
}

/// A style change at `start` (UTF-16 code units, so the front end can slice JS strings).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Run {
    pub start: u32,
    pub style: Style,
}

/// One logical line: rows joined across automatic wraps, trailing blanks removed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Line {
    pub text: String,
    /// Empty when the whole line has the default style; otherwise the first run starts at 0.
    pub runs: Vec<Run>,
    /// Unix milliseconds when the line was last written (0: unknown).
    pub ts: i64,
    pub kind: u8,
}

impl Line {
    pub fn marker(kind: u8, ts: i64) -> Line {
        Line { text: String::new(), runs: Vec::new(), ts, kind }
    }

    pub fn as_ref(&self) -> LineRef<'_> {
        LineRef { text: &self.text, runs: &self.runs, ts: self.ts, kind: self.kind }
    }
}

/// A borrowed line, as the capture hands it to the archive (no allocation per line).
#[derive(Debug, Clone, Copy)]
pub struct LineRef<'a> {
    pub text: &'a str,
    pub runs: &'a [Run],
    pub ts: i64,
    pub kind: u8,
}

impl LineRef<'_> {
    pub fn to_line(&self) -> Line {
        Line { text: self.text.to_string(), runs: self.runs.to_vec(), ts: self.ts, kind: self.kind }
    }
}

/// Builds a line cell by cell, merging equal neighbouring styles. Reused across lines.
#[derive(Debug, Clone, Default)]
pub struct LineBuilder {
    text: String,
    runs: Vec<Run>,
    utf16: u32,
    current: Style,
    pub ts: i64,
    /// A line is being built (rows wrapped into it).
    pub active: bool,
}

impl LineBuilder {
    pub fn start(&mut self, ts: i64) {
        self.text.clear();
        self.runs.clear();
        self.utf16 = 0;
        self.current = Style::default();
        self.ts = ts;
        self.active = true;
    }

    #[inline]
    pub fn push(&mut self, c: char, style: Style) {
        if style != self.current {
            if self.runs.is_empty() && self.utf16 > 0 {
                self.runs.push(Run { start: 0, style: Style::default() });
            }
            self.runs.push(Run { start: self.utf16, style });
            self.current = style;
        }
        self.text.push(c);
        self.utf16 += c.len_utf16() as u32;
    }

    pub fn view(&self) -> LineRef<'_> {
        let runs: &[Run] = if self.runs.iter().all(|r| r.style.is_default()) { &[] } else { &self.runs };
        LineRef { text: &self.text, runs, ts: self.ts, kind: KIND_TEXT }
    }
}

fn put_varint(out: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        out.push((v as u8) | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}

fn get_varint(data: &[u8], pos: &mut usize) -> Option<u64> {
    let mut v = 0u64;
    let mut shift = 0;
    loop {
        let b = *data.get(*pos)?;
        *pos += 1;
        v |= u64::from(b & 0x7F) << shift;
        if b < 0x80 {
            return Some(v);
        }
        shift += 7;
        if shift > 63 {
            return None;
        }
    }
}

fn zigzag(v: i64) -> u64 {
    ((v << 1) ^ (v >> 63)) as u64
}

fn unzigzag(v: u64) -> i64 {
    ((v >> 1) as i64) ^ -((v & 1) as i64)
}

/// The block being filled: lines are encoded as they arrive, and stay readable.
///
/// Encoding: `styles` (count, then fg / bg / flags varints), line count, then per line:
/// kind byte, zigzag timestamp delta, text length + UTF-8, run count + (start delta, style id).
#[derive(Default)]
pub struct BlockBuilder {
    styles: Vec<Style>,
    ids: HashMap<Style, u32>,
    body: Vec<u8>,
    /// Where each line starts in `body`, and its timestamp (deltas need the previous one).
    offsets: Vec<u32>,
    ts: Vec<i64>,
    last_kind: Option<u8>,
}

impl BlockBuilder {
    pub fn len(&self) -> usize {
        self.offsets.len()
    }

    pub fn is_empty(&self) -> bool {
        self.offsets.is_empty()
    }

    /// Approximate memory use.
    pub fn bytes(&self) -> usize {
        self.body.len() + self.offsets.len() * 12 + self.styles.len() * 16
    }

    pub fn last_kind(&self) -> Option<u8> {
        self.last_kind
    }

    pub fn push(&mut self, line: LineRef) {
        let prev = self.ts.last().copied().unwrap_or(0);
        self.offsets.push(self.body.len() as u32);
        self.ts.push(line.ts);
        self.last_kind = Some(line.kind);
        let body = &mut self.body;
        body.push(line.kind);
        put_varint(body, zigzag(line.ts - prev));
        put_varint(body, line.text.len() as u64);
        body.extend_from_slice(line.text.as_bytes());
        put_varint(body, line.runs.len() as u64);
        let mut prev_start = 0u32;
        for run in line.runs {
            let id = match self.ids.get(&run.style) {
                Some(&id) => id,
                None => {
                    self.styles.push(run.style);
                    let id = self.styles.len() as u32 - 1;
                    self.ids.insert(run.style, id);
                    id
                }
            };
            put_varint(body, u64::from(run.start - prev_start));
            prev_start = run.start;
            put_varint(body, u64::from(id));
        }
    }

    /// Lines `from..to` of this block.
    pub fn lines(&self, from: usize, to: usize) -> Vec<Line> {
        let to = to.min(self.len());
        let mut out = Vec::with_capacity(to.saturating_sub(from));
        for i in from..to {
            let mut pos = self.offsets[i] as usize;
            let prev = if i == 0 { 0 } else { self.ts[i - 1] };
            match read_line(&self.body, &mut pos, &self.styles, prev) {
                Some(l) => out.push(l),
                None => break,
            }
        }
        out
    }

    /// The finished block, ready to compress.
    pub fn finish(self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.body.len() + self.styles.len() * 8 + 8);
        put_varint(&mut out, self.styles.len() as u64);
        for s in &self.styles {
            put_varint(&mut out, u64::from(s.fg));
            put_varint(&mut out, u64::from(s.bg));
            put_varint(&mut out, u64::from(s.flags));
        }
        put_varint(&mut out, self.offsets.len() as u64);
        out.extend_from_slice(&self.body);
        out
    }
}

fn read_line(data: &[u8], pos: &mut usize, styles: &[Style], prev_ts: i64) -> Option<Line> {
    let kind = *data.get(*pos)?;
    *pos += 1;
    let ts = prev_ts + unzigzag(get_varint(data, pos)?);
    let len = get_varint(data, pos)? as usize;
    let text = std::str::from_utf8(data.get(*pos..*pos + len)?).ok()?.to_string();
    *pos += len;
    let n_runs = get_varint(data, pos)? as usize;
    let mut runs = Vec::with_capacity(n_runs.min(4096));
    let mut start = 0u32;
    for _ in 0..n_runs {
        start += get_varint(data, pos)? as u32;
        let style = *styles.get(get_varint(data, pos)? as usize)?;
        runs.push(Run { start, style });
    }
    Some(Line { text, runs, ts, kind })
}

/// Every line of an encoded block as (index, kind, UTF-8 text), without decoding styles
/// or allocating: what search needs. None: the block is corrupt.
pub fn for_each_text(data: &[u8], mut f: impl FnMut(usize, u8, &[u8])) -> Option<()> {
    let mut pos = 0;
    let n_styles = get_varint(data, &mut pos)?;
    for _ in 0..n_styles.saturating_mul(3) {
        get_varint(data, &mut pos)?;
    }
    let n = get_varint(data, &mut pos)? as usize;
    for i in 0..n {
        let kind = *data.get(pos)?;
        pos += 1;
        get_varint(data, &mut pos)?;
        let len = get_varint(data, &mut pos)? as usize;
        f(i, kind, data.get(pos..pos + len)?);
        pos += len;
        let n_runs = get_varint(data, &mut pos)?;
        for _ in 0..n_runs.saturating_mul(2) {
            get_varint(data, &mut pos)?;
        }
    }
    Some(())
}

pub fn encode(lines: &[Line]) -> Vec<u8> {
    let mut b = BlockBuilder::default();
    for l in lines {
        b.push(l.as_ref());
    }
    b.finish()
}

pub fn decode(data: &[u8]) -> Option<Vec<Line>> {
    let mut pos = 0;
    let n_styles = get_varint(data, &mut pos)? as usize;
    let mut styles = Vec::with_capacity(n_styles.min(4096));
    for _ in 0..n_styles {
        styles.push(Style {
            fg: get_varint(data, &mut pos)? as u32,
            bg: get_varint(data, &mut pos)? as u32,
            flags: get_varint(data, &mut pos)? as u16,
        });
    }
    let n = get_varint(data, &mut pos)? as usize;
    let mut lines = Vec::with_capacity(n.min(1 << 16));
    let mut ts = 0i64;
    for _ in 0..n {
        let line = read_line(data, &mut pos, &styles, ts)?;
        ts = line.ts;
        lines.push(line);
    }
    Some(lines)
}

/// UTF-16 offsets of the given byte offsets in `text` (sorted ascending).
pub fn utf16_offsets(text: &str, bytes: &[usize]) -> Vec<u32> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut it = bytes.iter().peekable();
    let mut u = 0u32;
    for (i, c) in text.char_indices() {
        while let Some(&&b) = it.peek() {
            if b <= i {
                out.push(u);
                it.next();
            } else {
                break;
            }
        }
        u += c.len_utf16() as u32;
    }
    for _ in it {
        out.push(u);
    }
    out
}

/// Byte offset in `text` of a UTF-16 offset (clamped to the end).
pub fn byte_offset(text: &str, utf16: u32) -> usize {
    let mut u = 0u32;
    for (i, c) in text.char_indices() {
        if u >= utf16 {
            return i;
        }
        u += c.len_utf16() as u32;
    }
    text.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn styled(text: &str, style: Style) -> Line {
        let mut b = LineBuilder::default();
        b.start(5);
        for c in text.chars() {
            b.push(c, style);
        }
        b.view().to_line()
    }

    #[test]
    fn builder_merges_runs() {
        let red = Style { fg: 1, ..Style::default() };
        let mut b = LineBuilder::default();
        b.start(1);
        for c in "ab".chars() {
            b.push(c, Style::default());
        }
        for c in "中d".chars() {
            b.push(c, red);
        }
        b.push('e', Style::default());
        let line = b.view().to_line();
        assert_eq!(line.text, "ab中de");
        assert_eq!(
            line.runs,
            vec![
                Run { start: 0, style: Style::default() },
                Run { start: 2, style: red },
                Run { start: 4, style: Style::default() },
            ]
        );
        assert!(styled("plain", Style::default()).runs.is_empty());
        assert_eq!(styled("x", red).runs, vec![Run { start: 0, style: red }]);
        // Reuse starts clean.
        b.start(2);
        b.push('z', Style::default());
        assert_eq!(b.view().to_line(), Line { text: "z".into(), runs: vec![], ts: 2, kind: 0 });
    }

    #[test]
    fn encode_roundtrip() {
        let red = Style { fg: 1, bg: COLOR_RGB | 0x123456, flags: F_BOLD };
        let lines = vec![
            styled("hello", Style::default()),
            styled("世界 🌍", red),
            Line::marker(KIND_CLEARED, 3),
            Line { text: String::new(), runs: vec![], ts: 9_000_000_000_000, kind: 0 },
        ];
        assert_eq!(decode(&encode(&lines)).unwrap(), lines);
        assert!(decode(&[5, 1]).is_none());
        let mut b = BlockBuilder::default();
        for l in &lines {
            b.push(l.as_ref());
        }
        assert_eq!(b.lines(1, 3), lines[1..3].to_vec());
        assert_eq!(b.lines(3, 99), lines[3..].to_vec());
    }

    #[test]
    fn texts_without_decoding() {
        let lines = vec![
            styled("hello", Style::default()),
            Line::marker(KIND_CLEARED, 3),
            styled("世界", Style { fg: 2, ..Style::default() }),
        ];
        let raw = encode(&lines);
        let mut seen = Vec::new();
        for_each_text(&raw, |i, k, t| seen.push((i, k, String::from_utf8(t.to_vec()).unwrap()))).unwrap();
        assert_eq!(seen, [(0, 0, "hello".into()), (1, KIND_CLEARED, String::new()), (2, 0, "世界".into())]);
        assert!(for_each_text(&raw[..raw.len() - 2], |_, _, _| {}).is_none());
    }

    #[test]
    fn utf16() {
        let t = "a🌍b中";
        assert_eq!(utf16_offsets(t, &[0, 1, 5, 6, 9]), vec![0, 1, 3, 4, 5]);
        assert_eq!(byte_offset(t, 3), 5);
        assert_eq!(byte_offset(t, 99), t.len());
    }
}
