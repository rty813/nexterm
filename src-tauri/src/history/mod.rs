//! Full scrollback history: every pane's output is followed by a headless terminal in a
//! worker thread, and lines that scroll off its screen are kept (compressed, spilled to
//! encrypted files past a memory limit). xterm.js keeps only the recent part; the history
//! viewer reads the rest from here.

pub mod archive;
pub mod capture;
pub mod line;
pub mod search;

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

use archive::{Archive, BlockCache, Limits, ReadPlan};
use capture::Capture;
use line::{byte_offset, Line, Style, COLOR_DEFAULT, COLOR_RGB, KIND_TEXT};
use search::SummaryCache;

pub use search::{Matcher, QuerySpec};

pub use archive::Limits as HistoryLimits;

/// Bytes gathered from the channel before one parse pass.
const BATCH: usize = 1 << 20;
const TICK: Duration = Duration::from_millis(150);
/// Most lines one `lines` call returns.
pub const MAX_LINES: u32 = 2000;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

enum Msg {
    Data(Vec<u8>),
    Resize(u16, u16),
    Clear,
}

/// One pane's history. Dropping it stops the worker and deletes its spill files.
pub struct Recorder {
    tx: Mutex<Sender<Msg>>,
    state: Arc<Mutex<Capture>>,
    cache: Arc<BlockCache>,
    /// Per-block match summaries of recent queries (search counts, scrollbar marks).
    summaries: SummaryCache,
    /// Bumped by each `marks` call; an older call still running sees it and stops.
    marks_gen: AtomicU64,
    /// The same for `rank`.
    rank_gen: AtomicU64,
    backlog: Arc<Backlog>,
}

/// Output queued for the worker and not parsed yet. The channel itself is unbounded, and
/// the batch size and the archive's memory limit only bound what is already parsed.
const QUEUE_LIMIT: usize = 8 << 20;

/// Queued bytes, and whether the worker is gone.
#[derive(Default)]
struct Backlog {
    state: Mutex<(usize, bool)>,
    room: Condvar,
}

/// How often a wait for room looks at its cancel flag (nothing signals the condvar then).
const CANCEL_POLL: Duration = Duration::from_millis(50);

impl Backlog {
    /// Makes room for `n` bytes, waiting while the queue is full. False (nothing reserved):
    /// `cancelled` was set before there was room.
    fn reserve(&self, n: usize, cancelled: Option<&AtomicBool>) -> bool {
        let is_cancelled = || cancelled.is_some_and(|c| c.load(Ordering::Acquire));
        let mut st = lock(&self.state);
        if st.0 >= QUEUE_LIMIT && !st.1 {
            drop(st);
            st = crate::output::blocking(|| {
                let mut st = lock(&self.state);
                while st.0 >= QUEUE_LIMIT && !st.1 && !is_cancelled() {
                    st = self.room.wait_timeout(st, CANCEL_POLL).unwrap_or_else(|e| e.into_inner()).0;
                }
                st
            });
        }
        if is_cancelled() {
            return false;
        }
        if !st.1 {
            st.0 += n;
        }
        true
    }

    fn release(&self, n: usize) {
        let mut st = lock(&self.state);
        st.0 = st.0.saturating_sub(n);
        self.room.notify_all();
    }
}

struct CloseOnDrop(Arc<Backlog>);

impl Drop for CloseOnDrop {
    fn drop(&mut self) {
        *lock(&self.0.state) = (0, true);
        self.0.room.notify_all();
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    /// Oldest line kept.
    pub first: u64,
    /// End of the archived lines; the lines still on screen follow, numbered from here.
    pub end: u64,
    pub tail: u64,
    /// Lines discarded (size limits or cleared).
    pub dropped: u64,
    /// The line numbered 1 in the margin: where the last clear left off (0: never cleared).
    pub base: u64,
    pub memory_bytes: u64,
    pub disk_bytes: u64,
}

/// A line as the front end gets it: style runs reference the response's style table.
#[derive(Debug, Clone, Serialize)]
pub struct WireLine {
    pub text: String,
    /// `[start (UTF-16), style index]` pairs; empty: default style throughout.
    pub runs: Vec<(u32, u32)>,
    pub ts: i64,
    pub kind: u8,
    /// Line number as shown in the margin (starts over at each clear); 0 for markers.
    pub no: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub first: u64,
    pub lines: Vec<WireLine>,
    pub styles: Vec<Style>,
    pub info: Info,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Match {
    pub line: u64,
    /// Line number as shown in the margin.
    pub no: u64,
    /// UTF-16 offsets in the line's text.
    pub start: u32,
    pub end: u32,
    /// The line around the match (all of it when short), starting at UTF-16 offset `ctx_offset`.
    pub ctx: String,
    pub ctx_offset: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Marks {
    pub first: u64,
    /// Lines in the history (first..total); buckets split `[first, total)`.
    pub total: u64,
    /// Matches of each query.
    pub counts: Vec<u64>,
    /// Buckets with matches, per query, ascending.
    pub buckets: Vec<Vec<u32>>,
    /// Queries that did not compile (their counts and buckets are empty).
    pub errors: Vec<Option<String>>,
    /// False: stopped at the time limit; counts and buckets cover what was scanned so far.
    pub complete: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub matches: Vec<Match>,
    /// Where to continue (the next line in the search direction); None: reached the end.
    pub next: Option<u64>,
}

impl Recorder {
    pub fn new(cols: u16, rows: u16, limits: Limits, spill_dir: Option<&Path>, name: &str) -> Arc<Recorder> {
        let archive = Archive::new(limits, spill_dir, name);
        let cache = Arc::clone(&archive.cache);
        let state = Arc::new(Mutex::new(Capture::new(cols, rows, archive)));
        let (tx, rx) = mpsc::channel::<Msg>();
        let worker = Arc::clone(&state);
        let backlog = Arc::new(Backlog::default());
        let parsed = Arc::clone(&backlog);
        let _ = std::thread::Builder::new().name(format!("history-{name}")).spawn(move || {
            // Also when the worker panics: `feed` must not wait for it then.
            let _closed = CloseOnDrop(Arc::clone(&parsed));
            let mut batch: Vec<u8> = Vec::new();
            loop {
                let first = match rx.recv_timeout(TICK) {
                    Ok(m) => m,
                    Err(RecvTimeoutError::Timeout) => {
                        lock(&worker).tick(now_ms());
                        continue;
                    }
                    Err(RecvTimeoutError::Disconnected) => break,
                };
                // Gather what is queued; other messages keep their place after the data.
                let mut next = Some(first);
                while let Some(msg) = next.take() {
                    match msg {
                        Msg::Data(d) => {
                            batch.extend_from_slice(&d);
                            if batch.len() < BATCH {
                                next = rx.try_recv().ok();
                            }
                            if next.as_ref().is_none_or(|m| !matches!(m, Msg::Data(_))) || batch.len() >= BATCH {
                                lock(&worker).feed(&batch, now_ms());
                                parsed.release(batch.len());
                                batch.clear();
                            }
                        }
                        Msg::Resize(c, r) => lock(&worker).resize(c, r, now_ms()),
                        Msg::Clear => lock(&worker).clear(now_ms()),
                    }
                }
            }
        });
        Arc::new(Recorder { tx: Mutex::new(tx), state, cache, summaries: SummaryCache::default(), marks_gen: AtomicU64::new(0), rank_gen: AtomicU64::new(0), backlog })
    }

    /// Waits while the worker is `QUEUE_LIMIT` behind, so a flood the history cannot keep
    /// up with slows the connection's reader instead of piling up here.
    pub fn feed(&self, data: &[u8]) {
        self.feed_unless(data, None);
    }

    /// `feed` for a connection's output: gives up when `cancelled` is set while it waits
    /// (the pane reconnected: the old connection's output must not follow the new one's).
    /// False: cancelled, nothing fed.
    pub fn feed_unless(&self, data: &[u8], cancelled: Option<&AtomicBool>) -> bool {
        if data.is_empty() {
            return true;
        }
        if !self.backlog.reserve(data.len(), cancelled) {
            return false;
        }
        if lock(&self.tx).send(Msg::Data(data.to_vec())).is_err() {
            self.backlog.release(data.len());
        }
        true
    }

    /// Bytes fed and not parsed yet.
    pub fn backlog(&self) -> usize {
        lock(&self.backlog.state).0
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        let _ = lock(&self.tx).send(Msg::Resize(cols, rows));
    }

    pub fn clear(&self) {
        let _ = lock(&self.tx).send(Msg::Clear);
    }

    pub fn info(&self) -> Info {
        let state = lock(&self.state);
        info_of(&state, state.tail().len() as u64)
    }

    /// Lines `from..from + count` (archive, then the lines still on screen).
    pub fn lines(&self, from: u64, count: u32) -> Result<Page, String> {
        let count = u64::from(count.min(MAX_LINES));
        let (plan, tail, info) = {
            let state = lock(&self.state);
            let tail = state.tail();
            let info = info_of(&state, tail.len() as u64);
            (state.archive.plan(from, from.saturating_add(count)), tail, info)
        };
        let from = from.max(info.first);
        let to = from.saturating_add(count).min(info.end + info.tail);
        let mut lines = Vec::with_capacity(to.saturating_sub(from) as usize);
        self.collect(&plan, from, to, &mut |_, l| lines.push(l.clone()))?;
        for (i, l) in tail.iter().enumerate() {
            let n = info.end + i as u64;
            if n >= from && n < to {
                lines.push(l.clone());
            }
        }
        let mut styles: Vec<Style> = Vec::new();
        let mut ids: HashMap<Style, u32> = HashMap::new();
        let lines = lines
            .into_iter()
            .enumerate()
            .map(|(i, l)| WireLine {
                no: if l.kind == KIND_TEXT { (from + i as u64).saturating_sub(info.base) + 1 } else { 0 },
                runs: l
                    .runs
                    .iter()
                    .map(|r| {
                        let id = *ids.entry(r.style).or_insert_with(|| {
                            styles.push(r.style);
                            styles.len() as u32 - 1
                        });
                        (r.start, id)
                    })
                    .collect(),
                text: l.text,
                ts: l.ts,
                kind: l.kind,
            })
            .collect();
        Ok(Page { first: from, lines, styles, info })
    }

    /// Visit the archived lines of `plan` in `[from, to)` in order.
    fn collect(&self, plan: &ReadPlan, from: u64, to: u64, f: &mut dyn FnMut(u64, &Line)) -> Result<(), String> {
        for b in &plan.blocks {
            let lines = self.cache.get(b)?;
            for (i, l) in lines.iter().enumerate() {
                let n = b.first + i as u64;
                if n >= from && n < to {
                    f(n, l);
                }
            }
        }
        for (i, l) in plan.hot.iter().enumerate() {
            let n = plan.hot_first + i as u64;
            if n >= from && n < to {
                f(n, l);
            }
        }
        Ok(())
    }

    /// Search up to `budget` lines from `from` (forward or backward), stopping after the
    /// line on which `limit` matches are reached. Sealed blocks are decompressed in parallel,
    /// a wave at a time, so a search with early hits stops early.
    pub fn search(&self, m: &Matcher, from: u64, backward: bool, limit: usize, budget: u64) -> Result<SearchResult, String> {
        let (info, plan, tail) = self.snapshot();
        let total = info.end + info.tail;
        if total <= info.first {
            return Ok(SearchResult { matches: vec![], next: None });
        }
        let from = from.clamp(info.first, total - 1);
        let (lo, hi) = if backward {
            (from.saturating_sub(budget.saturating_sub(1)).max(info.first), from + 1)
        } else {
            (from, from.saturating_add(budget).min(total))
        };
        // Units in search order: sealed blocks, then the hot block's lines, then the screen.
        enum Unit<'a> {
            Block(&'a archive::BlockRef),
            Lines(u64, &'a [Line]),
        }
        let mut units: Vec<Unit> = plan.blocks.iter().filter(|b| b.end() > lo && b.first < hi).map(Unit::Block).collect();
        units.push(Unit::Lines(plan.hot_first, &plan.hot));
        units.push(Unit::Lines(info.end, &tail));
        if backward {
            units.reverse();
        }
        // Small first waves (a hit nearby returns at once), doubling up to all threads busy
        // on many blocks (a search with few hits sweeps the history fast).
        let mut wave = std::thread::available_parallelism().map_or(4, |n| n.get()).clamp(1, 8) * 2;
        let mut found: Vec<Match> = Vec::new();
        let mut stop_at: Option<u64> = None;
        let mut i = 0;
        'outer: while i < units.len() {
            let end = (i + wave).min(units.len());
            let hits = search::par_map(&units[i..end], |u| match u {
                Unit::Block(b) => b.raw().and_then(|raw| search::scan_raw(&raw, b.first, lo, hi, m)),
                Unit::Lines(first, lines) => Ok(search::scan_lines(lines, *first, lo, hi, m)),
            });
            for unit_hits in hits {
                let mut unit_hits = unit_hits?;
                if backward {
                    unit_hits.reverse();
                }
                for h in unit_hits {
                    let mut ranges = h.ranges;
                    if backward {
                        ranges.reverse();
                    }
                    for (start, end) in ranges {
                        let (ctx, ctx_offset) = context(&h.text, start);
                        let no = h.line.saturating_sub(info.base) + 1;
                        found.push(Match { line: h.line, no, start, end, ctx, ctx_offset });
                    }
                    if found.len() >= limit {
                        stop_at = Some(h.line);
                        break 'outer;
                    }
                }
            }
            i = end;
            wave = (wave * 2).min(512);
        }
        let next = if backward {
            stop_at.unwrap_or(lo).checked_sub(1).filter(|&p| p >= info.first)
        } else {
            Some(stop_at.map_or(hi, |n| n + 1)).filter(|&p| p < total)
        };
        Ok(SearchResult { matches: found, next })
    }

    /// Where the matches of each query are in the whole history, as buckets of the range
    /// `[first, total)` split into `buckets` (scrollbar marks), and how many there are.
    /// Sealed blocks are summarized once per query and cached.
    pub fn marks(&self, ms: &[Matcher], buckets: u32) -> Result<Marks, String> {
        self.marks_within(ms, buckets, None)
    }

    /// `marks`, returning after about `budget` with what is known by then (`complete`
    /// false): the front end shows that and asks again, and the next call goes on from where
    /// this one stopped, so a long history fills in step by step instead of all at the end.
    pub fn marks_within(&self, ms: &[Matcher], buckets: u32, budget: Option<Duration>) -> Result<Marks, String> {
        let started = Instant::now();
        let buckets = buckets.clamp(1, 10_000);
        let (info, plan, tail) = self.snapshot();
        let total = info.end + info.tail;
        let span = total.saturating_sub(info.first);
        let refs: Vec<&Matcher> = ms.iter().collect();
        // A newer call (the query was edited) takes over: this one stops, and the blocks it
        // summarized stay cached for whoever asks next.
        let generation = self.marks_gen.fetch_add(1, Ordering::SeqCst) + 1;
        let superseded = || self.marks_gen.load(Ordering::Relaxed) != generation;
        let stop = || superseded() || budget.is_some_and(|b| started.elapsed() >= b);
        let (sums, complete) = self.summaries.summaries_within(&plan.blocks, &refs, &stop)?;
        if !complete && superseded() {
            return Err(search::CANCELLED.to_string());
        }
        let mut counts = Vec::with_capacity(ms.len());
        let mut out = Vec::with_capacity(ms.len());
        for (j, m) in ms.iter().enumerate() {
            let mut count = 0u64;
            let mut bs: Vec<u32> = Vec::new();
            for (b, s) in plan.blocks.iter().zip(&sums[j]) {
                count += u64::from(s.count);
                search::summary_buckets(s, b.first, b.end(), info.first, span, buckets, &mut bs);
            }
            for (first, lines) in [(plan.hot_first, &plan.hot[..]), (info.end, &tail[..])] {
                for h in search::scan_lines(lines, first, info.first, total, m) {
                    count += h.ranges.len() as u64;
                    bs.push(search::bucket_of(h.line, info.first, span, buckets));
                }
            }
            bs.sort_unstable();
            bs.dedup();
            counts.push(count);
            out.push(bs);
        }
        Ok(Marks { first: info.first, total, counts, buckets: out, errors: vec![None; ms.len()], complete })
    }

    /// `marks` for queries as the front end gives them: one that does not compile gets an
    /// error instead of failing the others.
    pub fn marks_of(&self, specs: &[QuerySpec], buckets: u32, budget: Option<Duration>) -> Result<Marks, String> {
        let compiled: Vec<Result<Matcher, String>> = specs.iter().map(Matcher::new).collect();
        let ok: Vec<Matcher> = compiled.iter().filter_map(|c| c.as_ref().ok()).cloned().collect();
        let got = self.marks_within(&ok, buckets, budget)?;
        let mut counts = got.counts.into_iter();
        let mut bs = got.buckets.into_iter();
        let mut out =
            Marks { first: got.first, total: got.total, counts: vec![], buckets: vec![], errors: vec![], complete: got.complete };
        for c in compiled {
            let err = c.err();
            let ok = err.is_none();
            out.counts.push(if ok { counts.next().unwrap_or(0) } else { 0 });
            out.buckets.push(if ok { bs.next().unwrap_or_default() } else { vec![] });
            out.errors.push(err);
        }
        Ok(out)
    }

    /// Number of matches before (line, UTF-16 offset `start`) in the whole history.
    pub fn rank(&self, m: &Matcher, line: u64, start: u32) -> Result<u64, String> {
        let (info, plan, tail) = self.snapshot();
        let before = |hits: Vec<search::LineHit>| -> u64 {
            hits.iter()
                .map(|h| if h.line < line { h.ranges.len() as u64 } else { h.ranges.iter().filter(|r| r.0 < start).count() as u64 })
                .sum()
        };
        let whole: Vec<archive::BlockRef> = plan.blocks.iter().filter(|b| b.end() <= line).cloned().collect();
        // Only the latest rank matters (the match jumped to last): an older one stops.
        let generation = self.rank_gen.fetch_add(1, Ordering::SeqCst) + 1;
        let superseded = || self.rank_gen.load(Ordering::Relaxed) != generation;
        let sums = self.summaries.summaries(&whole, &[m], &superseded)?;
        let mut n: u64 = sums[0].iter().map(|s| u64::from(s.count)).sum();
        if let Some(b) = plan.blocks.iter().find(|b| b.first <= line && b.end() > line) {
            n += before(search::scan_raw(&b.raw()?, b.first, b.first, line + 1, m)?);
        }
        n += before(search::scan_lines(&plan.hot, plan.hot_first, info.first, line + 1, m));
        n += before(search::scan_lines(&tail, info.end, info.first, line + 1, m));
        Ok(n)
    }

    /// The whole history as it stands: info, every sealed block and hot line, the screen.
    fn snapshot(&self) -> (Info, ReadPlan, Vec<Line>) {
        let state = lock(&self.state);
        let tail = state.tail();
        let info = info_of(&state, tail.len() as u64);
        (info, state.archive.plan(0, u64::MAX), tail)
    }

    /// Where the lines `sig` (consecutive texts, compared with runs of whitespace collapsed;
    /// markers skipped) are, nearest to `hint` within `window` lines either side. Lines the
    /// history up with the top of xterm.js's own buffer, whatever either side did since.
    pub fn locate(&self, sig: &[String], hint: u64, window: u64) -> Result<Option<u64>, String> {
        if sig.is_empty() {
            return Ok(None);
        }
        let (plan, tail, info, lo, hi) = {
            let state = lock(&self.state);
            let tail = state.tail();
            let info = info_of(&state, tail.len() as u64);
            let total = info.end + info.tail;
            let lo = hint.saturating_sub(window).max(info.first);
            let hi = hint.saturating_add(window).saturating_add(sig.len() as u64).min(total);
            (state.archive.plan(lo, hi.min(info.end)), tail, info, lo, hi)
        };
        let mut texts: Vec<(u64, String)> = Vec::new();
        let mut take = |n: u64, l: &Line| {
            if l.kind == KIND_TEXT && n >= lo && n < hi {
                texts.push((n, squash(&l.text)));
            }
        };
        self.collect(&plan, lo, hi, &mut |n, l| take(n, l))?;
        for (i, l) in tail.iter().enumerate() {
            take(info.end + i as u64, l);
        }
        let want: Vec<String> = sig.iter().map(|s| squash(s)).collect();
        let mut best: Option<u64> = None;
        if texts.len() >= want.len() {
            for i in 0..=texts.len() - want.len() {
                if texts[i..i + want.len()].iter().zip(&want).all(|((_, t), w)| t == w) {
                    let n = texts[i].0;
                    if best.is_none_or(|b| n.abs_diff(hint) < b.abs_diff(hint)) {
                        best = Some(n);
                    }
                }
            }
        }
        Ok(best)
    }

    /// Write the whole history (and the screen) to `path`; `ansi` keeps colors as SGR codes.
    pub fn export(&self, path: &Path, ansi: bool) -> Result<u64, String> {
        let (blocks, tail) = {
            let state = lock(&self.state);
            (state.archive.plan(0, u64::MAX), state.tail())
        };
        let file = std::fs::File::create(path).map_err(|e| e.to_string())?;
        let mut w = std::io::BufWriter::new(file);
        let mut count = 0u64;
        let mut err: Option<std::io::Error> = None;
        let mut write = |l: &Line| {
            if err.is_some() || l.kind != KIND_TEXT {
                return;
            }
            let r = if ansi { write_ansi(&mut w, l) } else { w.write_all(l.text.as_bytes()) }.and_then(|_| w.write_all(b"\r\n"));
            match r {
                Ok(()) => count += 1,
                Err(e) => err = Some(e),
            }
        };
        self.collect(&blocks, 0, u64::MAX, &mut |_, l| write(l))?;
        for l in &tail {
            write(l);
        }
        if let Some(e) = err {
            return Err(e.to_string());
        }
        w.flush().map_err(|e| e.to_string())?;
        Ok(count)
    }
}

/// Text with runs of whitespace collapsed to one space and the ends trimmed.
fn squash(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn info_of(state: &Capture, tail: u64) -> Info {
    let s = state.archive.stats();
    Info {
        first: s.first,
        end: s.end,
        tail,
        dropped: s.dropped,
        base: state.archive.number_base(),
        memory_bytes: s.mem_bytes,
        disk_bytes: s.disk_bytes,
    }
}

/// Context of a match starting at UTF-16 offset `start`: the whole line when short, else
/// a window around the match. Returns the text and the UTF-16 offset it starts at.
fn context(text: &str, start: u32) -> (String, u32) {
    const MAX: u32 = 320;
    const BEFORE: u32 = 80;
    if text.len() as u32 <= MAX {
        return (text.to_string(), 0);
    }
    let from = start.saturating_sub(BEFORE);
    let mut u = 0u32;
    let mut out = String::new();
    let mut offset = None;
    for c in text.chars() {
        if u >= from && offset.is_none() {
            offset = Some(u);
        }
        if let Some(o) = offset {
            if u >= o + MAX {
                break;
            }
            out.push(c);
        }
        u += c.len_utf16() as u32;
    }
    (out, offset.unwrap_or(u))
}

fn sgr_color(out: &mut String, c: u32, base: u32) {
    use std::fmt::Write as _;
    if c == COLOR_DEFAULT {
        return;
    }
    if c & COLOR_RGB != 0 && c != COLOR_DEFAULT {
        let _ = write!(out, ";{};2;{};{};{}", base + 8, (c >> 16) & 0xFF, (c >> 8) & 0xFF, c & 0xFF);
    } else if c < 8 {
        let _ = write!(out, ";{}", base + c);
    } else if c < 16 {
        let _ = write!(out, ";{}", base + 60 + c - 8);
    } else {
        let _ = write!(out, ";{};5;{}", base + 8, c);
    }
}

fn write_ansi(w: &mut impl Write, l: &Line) -> std::io::Result<()> {
    if l.runs.is_empty() {
        return w.write_all(l.text.as_bytes());
    }
    for (i, r) in l.runs.iter().enumerate() {
        let a = byte_offset(&l.text, r.start);
        let b = l.runs.get(i + 1).map_or(l.text.len(), |n| byte_offset(&l.text, n.start));
        let mut sgr = String::from("\x1b[0");
        let f = r.style.flags;
        for (bit, code) in [(1u16, 1u32), (2, 2), (4, 3), (8, 4), (16, 7), (64, 8), (32, 9)] {
            if f & bit != 0 {
                sgr.push_str(&format!(";{code}"));
            }
        }
        sgr_color(&mut sgr, r.style.fg, 30);
        sgr_color(&mut sgr, r.style.bg, 40);
        sgr.push('m');
        w.write_all(sgr.as_bytes())?;
        w.write_all(&l.text.as_bytes()[a..b])?;
    }
    w.write_all(b"\x1b[0m")
}

// ---- Per-pane registry ----

#[derive(Debug, Clone)]
pub struct Options {
    pub enabled: bool,
    pub limits: Limits,
    /// Spill folder of this run (None: memory only).
    pub dir: Option<PathBuf>,
}

impl Default for Options {
    fn default() -> Self {
        Options { enabled: true, limits: Limits::default(), dir: None }
    }
}

fn registry() -> &'static Mutex<HashMap<String, Arc<Recorder>>> {
    static R: OnceLock<Mutex<HashMap<String, Arc<Recorder>>>> = OnceLock::new();
    R.get_or_init(Default::default)
}

fn options() -> &'static Mutex<Options> {
    static O: OnceLock<Mutex<Options>> = OnceLock::new();
    O.get_or_init(Default::default)
}

/// Set where spill files go: `<base>/<run>`; folders of earlier runs are deleted.
pub fn init_dir(base: &Path) {
    if let Ok(entries) = std::fs::read_dir(base) {
        for e in entries.flatten() {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
    let run = format!("{}-{}", std::process::id(), now_ms());
    lock(options()).dir = Some(base.join(run));
}

/// Remove this run's spill folder (on exit).
pub fn shutdown() {
    lock(registry()).clear();
    if let Some(dir) = lock(options()).dir.clone() {
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// New settings apply to panes opened from now on (and `enabled: false` stops recording).
pub fn configure(enabled: bool, limits: Limits) {
    let mut o = lock(options());
    o.enabled = enabled;
    o.limits = limits;
}

pub fn enabled() -> bool {
    lock(options()).enabled
}

/// The pane's recorder, created on its first connection; reconnects keep the history.
pub fn ensure(pane: &str, cols: u16, rows: u16) -> Option<Arc<Recorder>> {
    let o = lock(options()).clone();
    let mut reg = lock(registry());
    if !o.enabled {
        reg.remove(pane);
        return None;
    }
    if let Some(r) = reg.get(pane) {
        r.resize(cols, rows);
        return Some(Arc::clone(r));
    }
    let name: String = pane.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(48).collect();
    let r = Recorder::new(cols, rows, o.limits, o.dir.as_deref(), &name);
    reg.insert(pane.to_string(), Arc::clone(&r));
    Some(r)
}

pub fn get(pane: &str) -> Option<Arc<Recorder>> {
    lock(registry()).get(pane).cloned()
}

/// The pane closed: drop its history.
pub fn remove(pane: &str) {
    lock(registry()).remove(pane);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wait_for(r: &Recorder, end: u64) {
        for _ in 0..200 {
            if r.info().end >= end {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("history did not reach {end}: {:?}", r.info());
    }

    fn filled(n: usize) -> Arc<Recorder> {
        let r = Recorder::new(40, 5, Limits::default(), None, "t");
        let data: String = (0..n).map(|i| format!("row {i}\r\n")).collect();
        r.feed(data.as_bytes());
        wait_for(&r, n as u64 - 4);
        r
    }

    /// Base64-like lines, as the throughput benchmark prints them (`chunk` bytes per call).
    fn flood(r: &Recorder, mb: usize, chunk: usize) -> usize {
        let line: Vec<u8> = (0..76u8).map(|i| b'A' + i % 26).chain(*b"\r\n").collect();
        let block: Vec<u8> = line.iter().copied().cycle().take(chunk).collect();
        let mut peak = 0;
        for _ in 0..(mb << 20) / chunk {
            r.feed(&block);
            peak = peak.max(r.backlog());
        }
        peak
    }

    #[test]
    fn backlog_stays_bounded_when_output_outruns_the_parser() {
        let r = Recorder::new(145, 50, Limits::default(), None, "t-flood");
        // Fed far faster than any parser: the queue must stop growing at its limit.
        let peak = flood(&r, 64, 32 << 10);
        assert!(peak <= QUEUE_LIMIT + (32 << 10), "backlog reached {peak}");
        for _ in 0..1000 {
            if r.backlog() == 0 {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("the worker did not catch up: {}", r.backlog());
    }

    #[test]
    fn feed_does_not_wait_for_a_dead_worker() {
        let r = Recorder::new(40, 5, Limits::default(), None, "t-dead");
        // Kill the worker by closing its channel (what dropping the recorder does).
        let (dead, _) = mpsc::channel();
        *lock(&r.tx) = dead;
        for _ in 0..100 {
            if lock(&r.backlog.state).1 {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let started = std::time::Instant::now();
        flood(&r, 32, 1 << 20);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn a_cancelled_feed_stops_waiting_for_room() {
        let r = Recorder::new(40, 5, Limits::default(), None, "t-cancel");
        // A full queue the worker is not draining (nothing it was sent is left to parse).
        lock(&r.backlog.state).0 = QUEUE_LIMIT;
        let cancelled = Arc::new(AtomicBool::new(false));
        let (done_tx, done_rx) = mpsc::channel();
        let (rec, flag) = (Arc::clone(&r), Arc::clone(&cancelled));
        std::thread::spawn(move || {
            let _ = done_tx.send(rec.feed_unless(b"stale output", Some(&*flag)));
        });
        assert!(done_rx.recv_timeout(Duration::from_millis(200)).is_err(), "fed into a full queue");
        cancelled.store(true, Ordering::Release);
        assert_eq!(done_rx.recv_timeout(Duration::from_secs(2)), Ok(false));
        assert_eq!(r.backlog(), QUEUE_LIMIT);
        // Already cancelled: no wait, nothing fed.
        assert!(!r.feed_unless(b"x", Some(&*cancelled)));
    }

    /// How fast the history parses plain text (cargo test --release -- --ignored --nocapture).
    #[test]
    #[ignore]
    fn parse_throughput() {
        let r = Recorder::new(145, 50, Limits::default(), None, "t-speed");
        let started = std::time::Instant::now();
        flood(&r, 256, 32 << 10);
        while r.backlog() > 0 {
            std::thread::sleep(Duration::from_millis(1));
        }
        let secs = started.elapsed().as_secs_f64();
        println!("history parses {:.1} MB/s", 256.0 / secs);
    }

    #[test]
    fn lines_cover_archive_and_screen() {
        let r = filled(5000);
        let info = r.info();
        assert_eq!((info.first, info.end, info.tail), (0, 4996, 4));
        let p = r.lines(4990, 100).unwrap();
        assert_eq!(p.first, 4990);
        let texts: Vec<_> = p.lines.iter().map(|l| l.text.as_str()).collect();
        assert_eq!(texts.len(), 10);
        assert_eq!(texts[0], "row 4990");
        assert_eq!(texts[9], "row 4999");
        assert_eq!(r.lines(0, 3).unwrap().lines[2].text, "row 2");
    }

    fn q(p: &str, regex: bool, case: bool) -> Matcher {
        Matcher::new(&QuerySpec { pattern: p.into(), regex, case_sensitive: case, whole_word: false }).unwrap()
    }

    #[test]
    fn search_both_ways() {
        let r = filled(5000);
        let res = r.search(&q("ROW 12", false, false), 0, false, 3, 1_000_000).unwrap();
        let lines: Vec<_> = res.matches.iter().map(|m| m.line).collect();
        assert_eq!(lines, [12, 120, 121]);
        assert_eq!(res.next, Some(122));
        let res = r.search(&q(r"row 4\d99$", true, true), 4999, true, 2, 1_000_000).unwrap();
        let lines: Vec<_> = res.matches.iter().map(|m| m.line).collect();
        assert_eq!(lines, [4999, 4899]);
        assert_eq!(res.next, Some(4898));
        let res = r.search(&q("row", false, true), 100, false, 1000, 50).unwrap();
        assert_eq!(res.matches.len(), 50);
        assert_eq!(res.next, Some(150));
        let m = &r.search(&q("w 7", false, true), 7, false, 1, 10).unwrap().matches[0];
        assert_eq!((m.line, m.start, m.end, m.ctx.as_str(), m.ctx_offset), (7, 2, 5, "row 7", 0));
        // Nothing at all: the whole range is scanned and the search ends.
        let res = r.search(&q("zzz", false, true), 4999, true, 10, 1_000_000).unwrap();
        assert!(res.matches.is_empty());
        assert_eq!(res.next, None);
    }

    #[test]
    fn marks_counts_and_rank() {
        let r = filled(5000);
        let ms = [q("row 1", false, true), q(r"^row \d*7$", true, true)];
        let mk = r.marks(&ms, 100).unwrap();
        assert_eq!((mk.first, mk.total), (0, 5000));
        // row 1, row 10-19, row 100-199, row 1000-1999.
        assert_eq!(mk.counts, [1111, 500]);
        // Lines 1000-1999 all match the first query: buckets 20..39.
        assert!((20..40).all(|b| mk.buckets[0].contains(&b)));
        assert!(!mk.buckets[0].contains(&50));
        assert_eq!(mk.buckets[1].len(), 100);
        // Cached: the same answer, and new lines are picked up.
        assert_eq!(r.marks(&ms, 100).unwrap().counts, [1111, 500]);
        r.feed(b"row 1 again\r\n\r\n\r\n\r\n\r\n");
        wait_for(&r, 5001);
        assert_eq!(r.marks(&ms, 100).unwrap().counts[0], 1112);
        // Rank: matches before a position.
        let m = q("row 1", false, true);
        assert_eq!(r.rank(&m, 0, 0).unwrap(), 0);
        assert_eq!(r.rank(&m, 10, 0).unwrap(), 1);
        assert_eq!(r.rank(&m, 1000, 0).unwrap(), 111);
        assert_eq!(r.rank(&m, 1000, 1).unwrap(), 112);
        assert_eq!(r.rank(&m, 4999, 0).unwrap(), 1111);
    }

    #[test]
    fn marks_in_steps() {
        let r = filled(5000);
        let ms = [q("row 1", false, true)];
        // No time at all: nothing sealed is scanned, only the lines not sealed yet count.
        let part = r.marks_within(&ms, 100, Some(Duration::ZERO)).unwrap();
        assert!(!part.complete);
        assert!(part.counts[0] < 1111);
        // Asked again with time to spare, it finishes from the cache.
        let done = r.marks_within(&ms, 100, Some(Duration::from_secs(30))).unwrap();
        assert!(done.complete);
        assert_eq!(done.counts, [1111]);
    }

    #[test]
    fn search_spilled_blocks() {
        let dir = std::env::temp_dir().join(format!("nexterm-search-test-{}", std::process::id()));
        let r = Recorder::new(40, 5, Limits { memory: 1, disk: 1 << 30 }, Some(&dir), "s");
        let data: String = (0..9000).map(|i| format!("row {i}\r\n")).collect();
        r.feed(data.as_bytes());
        wait_for(&r, 8996);
        assert!(r.info().disk_bytes > 0);
        let res = r.search(&q("row 123", false, true), 0, false, 100, 1_000_000).unwrap();
        assert_eq!(res.matches.iter().map(|m| m.line).collect::<Vec<_>>(), [123, 1230, 1231, 1232, 1233, 1234, 1235, 1236, 1237, 1238, 1239]);
        assert_eq!(r.marks(&[q("row 8", false, true)], 10).unwrap().counts, [1111]);
        drop(r);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn long_line_context() {
        let line = format!("{}needle{}", "a".repeat(500), "b".repeat(500));
        let (ctx, off) = context(&line, 500);
        assert_eq!(off, 420);
        assert!(ctx.starts_with(&"a".repeat(80)) && ctx[80..].starts_with("needle"));
        assert_eq!(ctx.len(), 320);
        assert_eq!(context("short", 2), ("short".to_string(), 0));
    }

    #[test]
    fn locate_lines() {
        let r = filled(5000);
        let sig: Vec<String> = (3000..3005).map(|i| format!("row {i}  ")).collect();
        assert_eq!(r.locate(&sig, 3100, 500).unwrap(), Some(3000));
        assert_eq!(r.locate(&sig, 4000, 500).unwrap(), None);
        // Lines on screen count too.
        let sig = vec!["row 4998".to_string(), "row 4999".to_string()];
        assert_eq!(r.locate(&sig, 4990, 50).unwrap(), Some(4998));
        // The nearest of repeated lines wins.
        let r = Recorder::new(20, 3, Limits::default(), None, "rep");
        r.feed(b"x\r\n".repeat(100).as_slice());
        wait_for(&r, 97);
        assert_eq!(r.locate(&["x".into(), "x".into()], 40, 1000).unwrap(), Some(40));
    }

    #[test]
    fn export_text_and_ansi() {
        let r = Recorder::new(40, 3, Limits::default(), None, "e");
        r.feed(b"plain\r\n\x1b[1;31mred\x1b[0m tail\r\nlast");
        for _ in 0..100 {
            if r.info().tail > 0 && r.info().end + r.info().tail >= 3 {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let dir = std::env::temp_dir();
        let p = dir.join(format!("nexterm-export-{}.txt", std::process::id()));
        assert_eq!(r.export(&p, false).unwrap(), 3);
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "plain\r\nred tail\r\nlast\r\n");
        r.export(&p, true).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "plain\r\n\x1b[0;1;31mred\x1b[0m tail\x1b[0m\r\nlast\r\n");
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn clear_through_channel() {
        let r = filled(3000);
        r.clear();
        for _ in 0..100 {
            if r.info().first > 0 {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let info = r.info();
        assert_eq!(info.first, info.end);
        assert_eq!(info.dropped, 2996);
    }
}
