//! Searching the full history: compiled queries, block scanning (allocation-free, one
//! regex pass per block before line-by-line matching), parallel decompression, and the
//! per-block summaries behind scrollbar marks and match counts.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

use regex::bytes::{Regex, RegexBuilder};
use serde::Deserialize;

use super::archive::BlockRef;
use super::line::{for_each_text, utf16_offsets, Line, KIND_TEXT};

/// A search or highlight rule as the front end describes it.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct QuerySpec {
    pub pattern: String,
    #[serde(default)]
    pub regex: bool,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub whole_word: bool,
}

impl QuerySpec {
    pub fn literal(pattern: &str, case_sensitive: bool) -> Self {
        QuerySpec { pattern: pattern.into(), regex: false, case_sensitive, whole_word: false }
    }

    fn key(&self) -> String {
        format!("{}{}{}\0{}", u8::from(self.regex), u8::from(self.case_sensitive), u8::from(self.whole_word), self.pattern)
    }
}

/// A compiled query. Lines never contain newlines, so a block's lines joined with `\n` can
/// be tested in one pass first (multi-line mode keeps `^` / `$` at line edges); only blocks
/// that match there are searched line by line.
#[derive(Clone)]
pub struct Matcher {
    re: Regex,
    whole_word: bool,
    /// `\A` / `\z` mean "start / end of the line" per line, but not in the joined text.
    prefilter: bool,
    key: String,
}

impl Matcher {
    pub fn new(spec: &QuerySpec) -> Result<Matcher, String> {
        if spec.pattern.is_empty() {
            return Err("empty query".into());
        }
        let pattern = if spec.regex { spec.pattern.clone() } else { regex::escape(&spec.pattern) };
        let re = RegexBuilder::new(&pattern)
            .case_insensitive(!spec.case_sensitive)
            .multi_line(true)
            .size_limit(1 << 22)
            .build()
            .map_err(|e| e.to_string())?;
        if re.is_match(b"") {
            return Err("the pattern matches empty text".into());
        }
        Ok(Matcher {
            re,
            whole_word: spec.whole_word,
            prefilter: !(spec.regex && (pattern.contains("\\A") || pattern.contains("\\z"))),
            key: spec.key(),
        })
    }

    /// UTF-16 ranges of the matches in one line.
    pub fn ranges(&self, text: &[u8]) -> Vec<(u32, u32)> {
        let mut bytes: Vec<usize> = Vec::new();
        for m in self.re.find_iter(text) {
            if m.start() == m.end() {
                continue;
            }
            if self.whole_word && !word_bounded(text, m.start(), m.end()) {
                continue;
            }
            bytes.push(m.start());
            bytes.push(m.end());
        }
        if bytes.is_empty() {
            return Vec::new();
        }
        let s = String::from_utf8_lossy(text);
        utf16_offsets(&s, &bytes).chunks(2).map(|p| (p[0], p[1])).collect()
    }

    fn hit(&self, text: &[u8]) -> bool {
        if !self.whole_word {
            return self.re.is_match(text);
        }
        self.re.find_iter(text).any(|m| m.start() < m.end() && word_bounded(text, m.start(), m.end()))
    }
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// No word character right before `start` or right after `end` (like the front end's
/// `(?<![\p{L}\p{N}_])` ... `(?![\p{L}\p{N}_])`).
fn word_bounded(text: &[u8], start: usize, end: usize) -> bool {
    let before = std::str::from_utf8(&text[..start]).ok().and_then(|s| s.chars().next_back());
    let after = std::str::from_utf8(&text[end..]).ok().and_then(|s| s.chars().next());
    !before.is_some_and(is_word) && !after.is_some_and(is_word)
}

/// A line with matches.
pub struct LineHit {
    pub line: u64,
    pub ranges: Vec<(u32, u32)>,
    pub text: String,
}

/// Lines of an encoded block in `[lo, hi)` (history numbers) that match.
pub fn scan_raw(raw: &[u8], first: u64, lo: u64, hi: u64, m: &Matcher) -> Result<Vec<LineHit>, String> {
    if m.prefilter {
        let mut joined = Vec::with_capacity(raw.len());
        for_each_text(raw, |i, kind, t| {
            let n = first + i as u64;
            if kind == KIND_TEXT && n >= lo && n < hi {
                joined.extend_from_slice(t);
            }
            joined.push(b'\n');
        })
        .ok_or("history block corrupt")?;
        if !m.re.is_match(&joined) {
            return Ok(Vec::new());
        }
    }
    let mut out = Vec::new();
    for_each_text(raw, |i, kind, t| {
        let n = first + i as u64;
        if kind != KIND_TEXT || n < lo || n >= hi {
            return;
        }
        let ranges = m.ranges(t);
        if !ranges.is_empty() {
            out.push(LineHit { line: n, ranges, text: String::from_utf8_lossy(t).into_owned() });
        }
    })
    .ok_or("history block corrupt")?;
    Ok(out)
}

/// Matching lines among decoded lines numbered from `first`.
pub fn scan_lines(lines: &[Line], first: u64, lo: u64, hi: u64, m: &Matcher) -> Vec<LineHit> {
    let mut out = Vec::new();
    for (i, l) in lines.iter().enumerate() {
        let n = first + i as u64;
        if l.kind != KIND_TEXT || n < lo || n >= hi {
            continue;
        }
        let ranges = m.ranges(l.text.as_bytes());
        if !ranges.is_empty() {
            out.push(LineHit { line: n, ranges, text: l.text.clone() });
        }
    }
    out
}

/// `f` over `items` on several threads; results in the items' order.
pub fn par_map<T: Sync, R: Send>(items: &[T], f: impl Fn(&T) -> R + Sync) -> Vec<R> {
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).clamp(1, 8).min(items.len().max(1));
    if threads <= 1 || items.len() < 4 {
        return items.iter().map(&f).collect();
    }
    let chunk = items.len().div_ceil(threads);
    let f = &f;
    std::thread::scope(|s| {
        let handles: Vec<_> = items.chunks(chunk).map(|c| s.spawn(move || c.iter().map(f).collect::<Vec<R>>())).collect();
        handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
    })
}

/// Lines per summary group: scrollbar marks are placed with this precision.
const GROUP_LINES: u64 = 16;

/// What one sealed block holds for one query: the match count, and which 16-line groups
/// have a match (bit g: lines first + 16g .. first + 16g + 15).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Summary {
    pub count: u32,
    pub groups: u128,
}

impl Summary {
    fn of_raw(raw: &[u8], m: &Matcher) -> Result<Summary, String> {
        let mut s = Summary::default();
        if m.prefilter {
            let mut joined = Vec::with_capacity(raw.len());
            for_each_text(raw, |_, kind, t| {
                if kind == KIND_TEXT {
                    joined.extend_from_slice(t);
                }
                joined.push(b'\n');
            })
            .ok_or("history block corrupt")?;
            if !m.re.is_match(&joined) {
                return Ok(s);
            }
        }
        for_each_text(raw, |i, kind, t| {
            if kind != KIND_TEXT || !m.hit(t) {
                return;
            }
            s.count += m.ranges(t).len() as u32;
            let g = (i as u64 / GROUP_LINES).min(127);
            s.groups |= 1u128 << g;
        })
        .ok_or("history block corrupt")?;
        Ok(s)
    }
}

/// Summaries of sealed blocks per query, kept across calls: after the first full pass,
/// only blocks sealed since are scanned.
#[derive(Default)]
pub struct SummaryCache {
    /// Query key -> block first line -> summary; most recently used query last.
    entries: Mutex<VecDeque<(String, HashMap<u64, Summary>)>>,
}

const CACHED_QUERIES: usize = 16;

impl SummaryCache {
    /// Summaries of `blocks` for each matcher (same order), scanning only what is missing;
    /// each block is decompressed at most once for all matchers.
    pub fn summaries(&self, blocks: &[BlockRef], ms: &[&Matcher]) -> Result<Vec<Vec<Summary>>, String> {
        let oldest = blocks.first().map_or(u64::MAX, |b| b.first);
        // What is known, and which (block, matcher) pairs are missing.
        let mut known: Vec<HashMap<u64, Summary>> = {
            let mut e = self.entries.lock().unwrap_or_else(|p| p.into_inner());
            ms.iter()
                .map(|m| {
                    let i = e.iter().position(|(k, _)| *k == m.key);
                    let mut map = i.and_then(|i| e.remove(i)).map(|(_, v)| v).unwrap_or_default();
                    // Blocks dropped from the history (limits, clear) are gone for good.
                    map.retain(|first, _| *first >= oldest);
                    map
                })
                .collect()
        };
        let todo: Vec<(&BlockRef, Vec<usize>)> = blocks
            .iter()
            .filter_map(|b| {
                let missing: Vec<usize> = (0..ms.len()).filter(|&j| !known[j].contains_key(&b.first)).collect();
                (!missing.is_empty()).then_some((b, missing))
            })
            .collect();
        let found = par_map(&todo, |(b, missing)| -> Result<Vec<(usize, Summary)>, String> {
            let raw = b.raw()?;
            missing.iter().map(|&j| Summary::of_raw(&raw, ms[j]).map(|s| (j, s))).collect()
        });
        let mut err = None;
        for ((b, _), r) in todo.iter().zip(found) {
            match r {
                Ok(list) => {
                    for (j, s) in list {
                        known[j].insert(b.first, s);
                    }
                }
                Err(e) => err = Some(e),
            }
        }
        let out = ms
            .iter()
            .enumerate()
            .map(|(j, _)| blocks.iter().map(|b| known[j].get(&b.first).copied().unwrap_or_default()).collect())
            .collect();
        let mut e = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        for (m, map) in ms.iter().zip(known) {
            e.retain(|(k, _)| *k != m.key);
            e.push_back((m.key.clone(), map));
        }
        while e.len() > CACHED_QUERIES {
            e.pop_front();
        }
        match err {
            Some(e) => Err(e),
            None => Ok(out),
        }
    }

    pub fn clear(&self) {
        self.entries.lock().unwrap_or_else(|p| p.into_inner()).clear();
    }
}

/// Bucket of history line `line` when `[first, first + span)` is split into `buckets`.
pub fn bucket_of(line: u64, first: u64, span: u64, buckets: u32) -> u32 {
    if span == 0 {
        return 0;
    }
    ((u128::from(line.saturating_sub(first)) * u128::from(buckets) / u128::from(span)) as u32).min(buckets.saturating_sub(1))
}

/// Buckets touched by the groups of a block summary.
pub fn summary_buckets(s: &Summary, block_first: u64, block_end: u64, first: u64, span: u64, buckets: u32, out: &mut Vec<u32>) {
    let mut g = s.groups;
    while g != 0 {
        let bit = u64::from(g.trailing_zeros());
        g &= g - 1;
        let lo = block_first + bit * GROUP_LINES;
        let hi = (lo + GROUP_LINES).min(block_end).max(lo + 1) - 1;
        let (a, b) = (bucket_of(lo, first, span, buckets), bucket_of(hi, first, span, buckets));
        out.extend(a..=b);
    }
}

#[cfg(test)]
mod tests {
    use super::super::line::encode;
    use super::*;

    fn spec(p: &str) -> QuerySpec {
        QuerySpec::literal(p, true)
    }

    fn lines(texts: &[&str]) -> Vec<Line> {
        texts.iter().map(|t| Line { text: (*t).into(), runs: vec![], ts: 0, kind: 0 }).collect()
    }

    #[test]
    fn matcher_options() {
        let m = Matcher::new(&QuerySpec { pattern: "foo".into(), regex: false, case_sensitive: false, whole_word: true }).unwrap();
        assert_eq!(m.ranges("foofoo Foo foo_x 中foo".as_bytes()), [(7, 10)]);
        let m = Matcher::new(&QuerySpec { pattern: "a.c".into(), regex: false, case_sensitive: true, whole_word: false }).unwrap();
        assert!(m.ranges(b"abc").is_empty());
        assert_eq!(m.ranges("中a.c".as_bytes()), [(1, 4)]);
        assert!(Matcher::new(&spec("")).is_err());
        assert!(Matcher::new(&QuerySpec { pattern: "x*".into(), regex: true, case_sensitive: true, whole_word: false }).is_err());
        assert!(Matcher::new(&QuerySpec { pattern: "(".into(), regex: true, case_sensitive: true, whole_word: false }).is_err());
    }

    #[test]
    fn prefilter_keeps_line_anchors() {
        let raw = encode(&lines(&["x 12", "12 y", "12"]));
        let re = |p: &str| Matcher::new(&QuerySpec { pattern: p.into(), regex: true, case_sensitive: true, whole_word: false }).unwrap();
        let hits = |m: &Matcher| scan_raw(&raw, 10, 0, 100, m).unwrap().iter().map(|h| h.line).collect::<Vec<_>>();
        assert_eq!(hits(&re("^12$")), [12]);
        assert_eq!(hits(&re(r"\A12")), [11, 12]);
        assert_eq!(hits(&re("12$")), [10, 12]);
        // Range limits apply.
        assert_eq!(scan_raw(&raw, 10, 11, 12, &re("12")).unwrap().len(), 1);
    }

    #[test]
    fn summaries_and_buckets() {
        let texts: Vec<String> = (0..100).map(|i| if i % 40 == 0 { format!("hit {i} hit") } else { format!("line {i}") }).collect();
        let raw = encode(&texts.iter().map(|t| Line { text: t.clone(), runs: vec![], ts: 0, kind: 0 }).collect::<Vec<_>>());
        let m = Matcher::new(&spec("hit")).unwrap();
        let s = Summary::of_raw(&raw, &m).unwrap();
        // Lines 0, 40, 80: two matches each, in groups 0, 2 and 5.
        assert_eq!(s.count, 6);
        assert_eq!(s.groups, 0b100101);
        let mut out = Vec::new();
        summary_buckets(&s, 1000, 1100, 1000, 100, 10, &mut out);
        // Groups 0, 2, 5 cover lines 1000-1015, 1032-1047, 1080-1095.
        assert_eq!(out, [0, 1, 3, 4, 8, 9]);
        assert_eq!(bucket_of(5, 0, 0, 10), 0);
        assert_eq!(bucket_of(99, 0, 100, 10), 9);
        assert_eq!(bucket_of(500, 0, 100, 10), 9);
    }

    #[test]
    fn parallel_map_keeps_order() {
        let v: Vec<u32> = (0..1000).collect();
        assert_eq!(par_map(&v, |x| x * 2), v.iter().map(|x| x * 2).collect::<Vec<_>>());
        assert_eq!(par_map(&[1u32, 2], |x| x + 1), [2, 3]);
    }
}
