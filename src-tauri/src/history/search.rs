//! Searching the full history: compiled queries, block scanning (one regex pass over a
//! block's lines joined with `\n`; only the lines it hits are looked at again), parallel
//! decompression, and the per-block summaries behind scrollbar marks and match counts.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

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
            prefilter: !(spec.regex && (pattern.contains("\\A") || pattern.contains("\\z") || turns_off_multi_line(&pattern))),
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

    /// Number of matches in one line (what `ranges` would return, without the UTF-16 offsets).
    fn count(&self, text: &[u8]) -> usize {
        self.re
            .find_iter(text)
            .filter(|m| m.start() < m.end() && (!self.whole_word || word_bounded(text, m.start(), m.end())))
            .count()
    }

    /// Matches in `joined` (lines separated by `\n`, line i starting at byte `starts[i]`) as
    /// (line index, byte start, byte end) in the joined text. None when a match crosses a
    /// line break (a regex such as `a\s+b`): the lines must then be searched one by one.
    ///
    /// Otherwise this finds exactly what a search of each line on its own would: with no
    /// match taking in a `\n`, the leftmost-first match at each position never looked past
    /// its line's end except through `$` / `\b`, which see the `\n` like the end of text.
    fn joined_hits(&self, joined: &[u8], starts: &[usize]) -> Option<Vec<(usize, usize, usize)>> {
        let mut out = Vec::new();
        self.joined_each(joined, starts, |li, s, e| out.push((li, s, e))).then_some(out)
    }

    /// `joined_hits` handed to `f` one by one (counting needs no list). False when a match
    /// crosses a line break; `f` may have seen some matches by then.
    fn joined_each(&self, joined: &[u8], starts: &[usize], mut f: impl FnMut(usize, usize, usize)) -> bool {
        let mut li = 0usize;
        for m in self.re.find_iter(joined) {
            let (s, e) = (m.start(), m.end());
            if s == e {
                continue;
            }
            if joined[s..e].contains(&b'\n') {
                return false;
            }
            if self.whole_word && !word_bounded(joined, s, e) {
                continue;
            }
            while li + 1 < starts.len() && starts[li + 1] <= s {
                li += 1;
            }
            f(li, s, e);
        }
        true
    }
}

/// A flag group such as `(?-m)` or `(?i-m:...)`: `^` / `$` then mean the edges of the whole
/// text, which a block's joined lines are not.
fn turns_off_multi_line(pattern: &str) -> bool {
    pattern.match_indices("(?").any(|(i, _)| {
        let flags: String = pattern[i + 2..].chars().take_while(|c| c.is_ascii_alphabetic() || *c == '-').collect();
        flags.split_once('-').is_some_and(|(_, off)| off.contains('m'))
    })
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// No word character right before `start` or right after `end` (like the front end's
/// `(?<![\p{L}\p{N}_])` ... `(?![\p{L}\p{N}_])`). Looks at the neighbouring characters only
/// (at most 4 bytes each side), so it costs the same in a long joined block as in a line.
fn word_bounded(text: &[u8], start: usize, end: usize) -> bool {
    !char_before(text, start).is_some_and(is_word) && !char_after(text, end).is_some_and(is_word)
}

fn char_before(text: &[u8], at: usize) -> Option<char> {
    let lo = at.saturating_sub(4);
    // The last character starts at the last byte that is not a UTF-8 continuation byte.
    let i = (lo..at).rev().find(|&i| text[i] & 0xC0 != 0x80)?;
    std::str::from_utf8(&text[i..at]).ok()?.chars().next()
}

fn char_after(text: &[u8], at: usize) -> Option<char> {
    let len = match *text.get(at)? {
        0x00..=0x7F => 1,
        0xC0..=0xDF => 2,
        0xE0..=0xEF => 3,
        _ => 4,
    };
    std::str::from_utf8(text.get(at..at + len)?).ok()?.chars().next()
}

/// A block's lines joined with `\n` (lines `keep` rejects are left empty), and the byte where
/// each line starts plus one entry for the end.
fn join(raw: &[u8], keep: impl Fn(usize, u8) -> bool) -> Result<(Vec<u8>, Vec<usize>), String> {
    let mut joined = Vec::with_capacity(raw.len());
    let mut starts = Vec::new();
    for_each_text(raw, |i, kind, t| {
        starts.push(joined.len());
        if keep(i, kind) {
            joined.extend_from_slice(t);
        }
        joined.push(b'\n');
    })
    .ok_or("history block corrupt")?;
    starts.push(joined.len());
    Ok((joined, starts))
}

/// A line with matches.
pub struct LineHit {
    pub line: u64,
    pub ranges: Vec<(u32, u32)>,
    pub text: String,
}

/// Lines of an encoded block in `[lo, hi)` (history numbers) that match.
pub fn scan_raw(raw: &[u8], first: u64, lo: u64, hi: u64, m: &Matcher) -> Result<Vec<LineHit>, String> {
    let wanted = |i: usize, kind: u8| {
        let n = first + i as u64;
        kind == KIND_TEXT && n >= lo && n < hi
    };
    if m.prefilter {
        let (joined, starts) = join(raw, wanted)?;
        if let Some(hits) = m.joined_hits(&joined, &starts) {
            return Ok(line_hits(&joined, &starts, first, &hits));
        }
    }
    let mut out = Vec::new();
    for_each_text(raw, |i, kind, t| {
        if !wanted(i, kind) {
            return;
        }
        let ranges = m.ranges(t);
        if !ranges.is_empty() {
            out.push(LineHit { line: first + i as u64, ranges, text: String::from_utf8_lossy(t).into_owned() });
        }
    })
    .ok_or("history block corrupt")?;
    Ok(out)
}

/// `joined_hits` grouped by line, with UTF-16 ranges.
fn line_hits(joined: &[u8], starts: &[usize], first: u64, hits: &[(usize, usize, usize)]) -> Vec<LineHit> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < hits.len() {
        let li = hits[i].0;
        let base = starts[li];
        let text = &joined[base..starts[li + 1] - 1];
        let mut bytes = Vec::new();
        while i < hits.len() && hits[i].0 == li {
            bytes.push(hits[i].1 - base);
            bytes.push(hits[i].2 - base);
            i += 1;
        }
        let s = String::from_utf8_lossy(text);
        let ranges = utf16_offsets(&s, &bytes).chunks(2).map(|p| (p[0], p[1])).collect();
        out.push(LineHit { line: first + li as u64, ranges, text: s.into_owned() });
    }
    out
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

/// Threads for a scan: all cores but two (the UI and the connection keep theirs), at most 16.
fn threads_for(items: usize) -> usize {
    std::thread::available_parallelism().map_or(4, |n| n.get().saturating_sub(2)).clamp(1, 16).min(items.max(1))
}

/// `f` over `items` on several threads; results in the items' order.
pub fn par_map<T: Sync, R: Send>(items: &[T], f: impl Fn(&T) -> R + Sync) -> Vec<R> {
    par_map_until(items, &|| false, f).into_iter().map(|r| r.expect("not stopped")).collect()
}

/// `par_map` with items handed out one at a time (blocks with many hits take longer than
/// the rest, so fixed shares would leave threads idle), stopping early once `stop` says so:
/// items not started by then are None.
pub fn par_map_until<T: Sync, R: Send>(items: &[T], stop: &(dyn Fn() -> bool + Sync), f: impl Fn(&T) -> R + Sync) -> Vec<Option<R>> {
    let threads = threads_for(items.len());
    if threads <= 1 || items.len() < 4 {
        return items.iter().map(|item| if stop() { None } else { Some(f(item)) }).collect();
    }
    let next = AtomicUsize::new(0);
    let (f, next) = (&f, &next);
    let parts: Vec<Vec<(usize, R)>> = std::thread::scope(|s| {
        let handles: Vec<_> = (0..threads)
            .map(|_| {
                s.spawn(move || {
                    let mut got = Vec::new();
                    loop {
                        let i = next.fetch_add(1, Ordering::Relaxed);
                        if i >= items.len() || stop() {
                            break;
                        }
                        got.push((i, f(&items[i])));
                    }
                    got
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap_or_default()).collect()
    });
    let mut out: Vec<Option<R>> = (0..items.len()).map(|_| None).collect();
    for (i, r) in parts.into_iter().flatten() {
        out[i] = Some(r);
    }
    out
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
    /// `n` matches on line `i` of the block.
    fn add(&mut self, i: usize, n: usize) {
        self.count += n as u32;
        let g = (i as u64 / GROUP_LINES).min(127);
        self.groups |= 1u128 << g;
    }

    fn of_raw(raw: &[u8], m: &Matcher) -> Result<Summary, String> {
        if m.prefilter {
            let (joined, starts) = join(raw, |_, kind| kind == KIND_TEXT)?;
            let mut s = Summary::default();
            if m.joined_each(&joined, &starts, |li, _, _| s.add(li, 1)) {
                return Ok(s);
            }
        }
        let mut s = Summary::default();
        for_each_text(raw, |i, kind, t| {
            if kind != KIND_TEXT {
                return;
            }
            let n = m.count(t);
            if n > 0 {
                s.add(i, n);
            }
        })
        .ok_or("history block corrupt")?;
        Ok(s)
    }
}

/// Error of a summary pass that a newer request took over from.
pub const CANCELLED: &str = "cancelled";

/// Summaries of sealed blocks per query, kept across calls: after the first full pass,
/// only blocks sealed since are scanned.
#[derive(Default)]
pub struct SummaryCache {
    /// Query key -> block first line -> summary; most recently used query last. Each query's
    /// map has its own lock, held for a whole pass: a second pass over the same query (the
    /// count and the "3/120" rank at once, or a count asked again) waits for the first and
    /// then finds its blocks done, instead of starting over without them.
    entries: Mutex<VecDeque<(String, Arc<Mutex<HashMap<u64, Summary>>>)>>,
}

const CACHED_QUERIES: usize = 16;

impl SummaryCache {
    /// Summaries of `blocks` for each matcher (same order), scanning only what is missing;
    /// each block is decompressed at most once for all matchers. Once `cancel` says so the
    /// pass stops with `CANCELLED`, keeping what it has done for the next call.
    pub fn summaries(&self, blocks: &[BlockRef], ms: &[&Matcher], cancel: &(dyn Fn() -> bool + Sync)) -> Result<Vec<Vec<Summary>>, String> {
        match self.summaries_within(blocks, ms, cancel)? {
            (sums, true) => Ok(sums),
            (_, false) => Err(CANCELLED.to_string()),
        }
    }

    /// `summaries`, but stopping (`stop`: a time limit, a newer request) gives what is known
    /// so far, with `false`: blocks not scanned yet count as no matches.
    pub fn summaries_within(&self, blocks: &[BlockRef], ms: &[&Matcher], stop: &(dyn Fn() -> bool + Sync)) -> Result<(Vec<Vec<Summary>>, bool), String> {
        let cancel = stop;
        let oldest = blocks.first().map_or(u64::MAX, |b| b.first);
        // One map per distinct query, locked in key order so that passes never deadlock.
        let mut keys: Vec<&str> = ms.iter().map(|m| m.key.as_str()).collect();
        keys.sort_unstable();
        keys.dedup();
        let slot: Vec<usize> = ms.iter().map(|m| keys.binary_search(&m.key.as_str()).unwrap_or(0)).collect();
        let reps: Vec<&Matcher> = (0..keys.len()).map(|k| ms[slot.iter().position(|&s| s == k).unwrap_or(0)]).collect();
        let maps: Vec<Arc<Mutex<HashMap<u64, Summary>>>> = {
            let mut e = self.entries.lock().unwrap_or_else(|p| p.into_inner());
            let maps = keys
                .iter()
                .map(|k| {
                    let entry = match e.iter().position(|(key, _)| key == k) {
                        Some(i) => e.remove(i).expect("cache entry"),
                        None => ((*k).to_string(), Arc::default()),
                    };
                    let map = Arc::clone(&entry.1);
                    e.push_back(entry);
                    map
                })
                .collect();
            while e.len() > CACHED_QUERIES {
                e.pop_front();
            }
            maps
        };
        let mut known: Vec<MutexGuard<'_, HashMap<u64, Summary>>> = maps.iter().map(|m| m.lock().unwrap_or_else(|p| p.into_inner())).collect();
        for map in known.iter_mut() {
            // Blocks dropped from the history (limits, clear) are gone for good.
            map.retain(|first, _| *first >= oldest);
        }
        let todo: Vec<(&BlockRef, Vec<usize>)> = blocks
            .iter()
            .filter_map(|b| {
                let missing: Vec<usize> = (0..keys.len()).filter(|&j| !known[j].contains_key(&b.first)).collect();
                (!missing.is_empty()).then_some((b, missing))
            })
            .collect();
        let found = par_map_until(&todo, cancel, |(b, missing)| -> Result<Vec<(usize, Summary)>, String> {
            let raw = b.raw()?;
            missing.iter().map(|&j| Summary::of_raw(&raw, reps[j]).map(|s| (j, s))).collect()
        });
        let mut err = None;
        let mut complete = true;
        for ((b, _), r) in todo.iter().zip(found) {
            match r {
                Some(Ok(list)) => {
                    for (j, s) in list {
                        known[j].insert(b.first, s);
                    }
                }
                Some(Err(e)) => err = Some(e),
                None => complete = false,
            }
        }
        if let Some(e) = err {
            return Err(e);
        }
        let sums = slot.iter().map(|&j| blocks.iter().map(|b| known[j].get(&b.first).copied().unwrap_or_default()).collect()).collect();
        Ok((sums, complete))
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
    use super::super::archive::Loc;
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

    /// Per-line matching, the reference the joined scan must agree with.
    fn per_line(texts: &[&str], m: &Matcher) -> Vec<(u64, Vec<(u32, u32)>)> {
        texts.iter().enumerate().filter_map(|(i, t)| {
            let r = m.ranges(t.as_bytes());
            (!r.is_empty()).then_some((i as u64, r))
        }).collect()
    }

    #[test]
    fn joined_scan_matches_per_line() {
        let texts = [
            "error: 中文 error", "", "no match here", "ERROR at end error", "errorerror", "x error_y error",
            "a b", "a", "b", "tail a", "b head", "foo.bar", "$ ls", "end$",
        ];
        let raw = encode(&lines(&texts));
        let cases: &[(&str, bool, bool, bool)] = &[
            ("error", false, false, false),
            ("error", false, true, false),
            ("error", false, false, true),
            ("^error", true, false, false),
            ("error$", true, false, false),
            (r"a\s+b", true, true, false),
            (r"a[^x]*b", true, true, false),
            (r"\berror\b", true, true, false),
            ("foo.bar", false, true, false),
            ("$", false, true, false),
            ("中文", false, true, true),
            ("(?-m)^error", true, false, false),
            ("(?i-m:error$)", true, true, false),
        ];
        for &(p, regex, case_sensitive, whole_word) in cases {
            let m = Matcher::new(&QuerySpec { pattern: p.into(), regex, case_sensitive, whole_word }).unwrap();
            let want = per_line(&texts, &m);
            let got: Vec<_> = scan_raw(&raw, 0, 0, 100, &m).unwrap().into_iter().map(|h| (h.line, h.ranges)).collect();
            assert_eq!(got, want, "{p}");
            let s = Summary::of_raw(&raw, &m).unwrap();
            assert_eq!(s.count as usize, want.iter().map(|(_, r)| r.len()).sum::<usize>(), "{p}");
        }
    }

    #[test]
    fn multi_line_off_is_seen() {
        assert!(turns_off_multi_line("(?-m)^a"));
        assert!(turns_off_multi_line("x(?is-mu:a$)"));
        assert!(!turns_off_multi_line("(?i)a"));
        assert!(!turns_off_multi_line("(?:a-m)"));
    }

    #[test]
    fn word_bounds_look_at_neighbours_only() {
        let t = "中foo é_foo foo".as_bytes();
        assert_eq!(char_before(t, 3), Some('中'));
        assert_eq!(char_after(t, 0), Some('中'));
        assert_eq!(char_before(t, 0), None);
        assert_eq!(char_after(t, t.len()), None);
        let m = Matcher::new(&QuerySpec { pattern: "foo".into(), regex: false, case_sensitive: true, whole_word: true }).unwrap();
        assert_eq!(m.ranges(t).len(), 1);
    }

    #[test]
    fn cancelled_summaries_keep_what_was_done() {
        let texts: Vec<String> = (0..200).map(|i| format!("line {i}")).collect();
        let raw = encode(&texts.iter().map(|t| Line { text: t.clone(), runs: vec![], ts: 0, kind: 0 }).collect::<Vec<_>>());
        let packed = Arc::new(zstd::bulk::compress(&raw, 1).unwrap());
        let blocks: Vec<BlockRef> = (0..20)
            .map(|i| BlockRef { first: i * 200, count: 200, raw_len: raw.len() as u32, loc: Loc::Mem(Arc::clone(&packed)) })
            .collect();
        let m = Matcher::new(&spec("line 1")).unwrap();
        let cache = SummaryCache::default();
        assert_eq!(cache.summaries(&blocks, &[&m], &|| true).unwrap_err(), CANCELLED);
        let calls = AtomicUsize::new(0);
        let stop_after_some = || calls.fetch_add(1, Ordering::Relaxed) >= 5;
        assert!(cache.summaries(&blocks, &[&m], &stop_after_some).is_err());
        let all = cache.summaries(&blocks, &[&m], &|| false).unwrap();
        // "line 1", "line 1x", "line 1xx": 111 per block.
        assert!(all[0].iter().all(|s| s.count == 111));
        // The same query twice in one call (a search that is also a highlight) is one pass.
        let other = Matcher::new(&spec("line 19")).unwrap();
        let both = cache.summaries(&blocks, &[&m, &other, &m], &|| false).unwrap();
        assert_eq!(both.len(), 3);
        assert!(both[0].iter().all(|s| s.count == 111) && both[2] == both[0]);
        assert!(both[1].iter().all(|s| s.count == 11));
    }

    #[test]
    fn partial_summaries_count_what_is_scanned() {
        let texts: Vec<String> = (0..200).map(|i| format!("line {i}")).collect();
        let raw = encode(&texts.iter().map(|t| Line { text: t.clone(), runs: vec![], ts: 0, kind: 0 }).collect::<Vec<_>>());
        let packed = Arc::new(zstd::bulk::compress(&raw, 1).unwrap());
        let blocks: Vec<BlockRef> = (0..50)
            .map(|i| BlockRef { first: i * 200, count: 200, raw_len: raw.len() as u32, loc: Loc::Mem(Arc::clone(&packed)) })
            .collect();
        let m = Matcher::new(&spec("line 1")).unwrap();
        let cache = SummaryCache::default();
        let calls = AtomicUsize::new(0);
        let (part, complete) = cache.summaries_within(&blocks, &[&m], &|| calls.fetch_add(1, Ordering::Relaxed) >= 10).unwrap();
        assert!(!complete);
        let done = part[0].iter().filter(|s| s.count == 111).count();
        assert!(done > 0 && done < 50 && part[0].iter().all(|s| s.count == 111 || s.count == 0), "{done}");
        // The next call goes on from there and finishes.
        let (all, complete) = cache.summaries_within(&blocks, &[&m], &|| false).unwrap();
        assert!(complete && all[0].iter().all(|s| s.count == 111));
    }

    #[test]
    fn concurrent_passes_share_the_work() {
        let texts: Vec<String> = (0..200).map(|i| format!("line {i}")).collect();
        let raw = encode(&texts.iter().map(|t| Line { text: t.clone(), runs: vec![], ts: 0, kind: 0 }).collect::<Vec<_>>());
        let packed = Arc::new(zstd::bulk::compress(&raw, 1).unwrap());
        let blocks: Vec<BlockRef> = (0..200)
            .map(|i| BlockRef { first: i * 200, count: 200, raw_len: raw.len() as u32, loc: Loc::Mem(Arc::clone(&packed)) })
            .collect();
        let m = Matcher::new(&spec("line 1")).unwrap();
        let cache = SummaryCache::default();
        // Two passes at once (the count and a rank): the second waits for the first, then
        // finds every block done; scanning stops as soon as anything is asked to stop again.
        let scanned = AtomicUsize::new(0);
        let counting = || {
            scanned.fetch_add(1, Ordering::Relaxed);
            false
        };
        std::thread::scope(|s| {
            let a = s.spawn(|| cache.summaries(&blocks, &[&m], &counting).unwrap());
            let b = s.spawn(|| cache.summaries(&blocks, &[&m], &counting).unwrap());
            assert_eq!(a.join().unwrap(), b.join().unwrap());
        });
        // One check per block of the one pass that scanned (plus one per thread at the end).
        assert!(scanned.load(Ordering::Relaxed) < 200 + 64, "{}", scanned.load(Ordering::Relaxed));
    }

    #[test]
    fn parallel_map_keeps_order() {
        let v: Vec<u32> = (0..1000).collect();
        assert_eq!(par_map(&v, |x| x * 2), v.iter().map(|x| x * 2).collect::<Vec<_>>());
        assert_eq!(par_map(&[1u32, 2], |x| x + 1), [2, 3]);
    }
}
