//! Storage of a pane's history: an uncompressed hot block, sealed zstd blocks in memory,
//! and the oldest blocks spilled to encrypted segment files once memory is over its limit.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use ring::rand::{SecureRandom, SystemRandom};

use super::line::{decode, BlockBuilder, Line, LineRef};

/// A block is sealed at this many lines or this many bytes of line data.
pub const BLOCK_LINES: usize = 2000;
pub const BLOCK_BYTES: usize = 256 * 1024;
/// Spilled blocks go to segment files of about this size.
const SEGMENT_BYTES: u64 = 64 * 1024 * 1024;
const ZSTD_LEVEL: i32 = 3;
const CACHE_BLOCKS: usize = 8;

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// Compressed bytes kept in memory per pane.
    pub memory: usize,
    /// Bytes on disk per pane; 0: never spill, drop the oldest blocks instead.
    pub disk: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Limits { memory: 32 << 20, disk: 2048 << 20 }
    }
}

/// Encryption key of this process's spill files; never written anywhere.
struct Cipher {
    key: LessSafeKey,
    counter: AtomicU64,
}

fn cipher() -> Option<&'static Cipher> {
    static CIPHER: std::sync::OnceLock<Option<Cipher>> = std::sync::OnceLock::new();
    CIPHER
        .get_or_init(|| {
            let mut bytes = [0u8; 32];
            SystemRandom::new().fill(&mut bytes).ok()?;
            let key = UnboundKey::new(&AES_256_GCM, &bytes).ok()?;
            Some(Cipher { key: LessSafeKey::new(key), counter: AtomicU64::new(1) })
        })
        .as_ref()
}

fn nonce(n: u64) -> Nonce {
    let mut b = [0u8; 12];
    b[4..].copy_from_slice(&n.to_le_bytes());
    Nonce::assume_unique_for_key(b)
}

/// One spill file. Deleted when the last block stored in it is dropped.
pub struct Segment {
    path: PathBuf,
    /// Opened on the first read and kept: a search reads thousands of blocks, and opening
    /// the file for each one (virus scanners look at every open on Windows) cost more than
    /// reading them.
    reader: OnceLock<File>,
}

impl Segment {
    fn new(path: PathBuf) -> Segment {
        Segment { path, reader: OnceLock::new() }
    }

    fn read_at(&self, offset: u64, buf: &mut [u8]) -> std::io::Result<()> {
        let f = match self.reader.get() {
            Some(f) => f,
            None => {
                let f = File::open(&self.path)?;
                // Another reader may have opened it meanwhile: either handle will do.
                let _ = self.reader.set(f);
                self.reader.get().expect("segment reader")
            }
        };
        read_exact_at(f, buf, offset)
    }
}

#[cfg(unix)]
fn read_exact_at(f: &File, buf: &mut [u8], offset: u64) -> std::io::Result<()> {
    std::os::unix::fs::FileExt::read_exact_at(f, buf, offset)
}

/// Positional reads on a shared handle: no seek, so readers on several threads do not race.
#[cfg(windows)]
fn read_exact_at(f: &File, mut buf: &mut [u8], mut offset: u64) -> std::io::Result<()> {
    use std::os::windows::fs::FileExt;
    while !buf.is_empty() {
        match f.seek_read(buf, offset) {
            Ok(0) => return Err(std::io::ErrorKind::UnexpectedEof.into()),
            Ok(n) => {
                buf = &mut buf[n..];
                offset += n as u64;
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

impl Drop for Segment {
    fn drop(&mut self) {
        // Close the handle first, or Windows cannot delete the file.
        drop(self.reader.take());
        let _ = std::fs::remove_file(&self.path);
    }
}

#[derive(Clone)]
pub enum Loc {
    Mem(Arc<Vec<u8>>),
    Disk { seg: Arc<Segment>, offset: u64, len: u32, nonce: u64 },
}

/// A sealed block, cheap to clone (the data is shared).
#[derive(Clone)]
pub struct BlockRef {
    pub first: u64,
    pub count: u32,
    pub raw_len: u32,
    pub loc: Loc,
}

impl BlockRef {
    fn stored_len(&self) -> u64 {
        match &self.loc {
            Loc::Mem(d) => d.len() as u64,
            Loc::Disk { len, .. } => u64::from(*len),
        }
    }

    pub fn end(&self) -> u64 {
        self.first + u64::from(self.count)
    }

    /// Decompress (and decrypt) the block's lines.
    pub fn load(&self) -> Result<Vec<Line>, String> {
        decode(&self.raw()?).ok_or_else(|| "history block corrupt".to_string())
    }

    /// The block's encoded lines (see line.rs), decompressed and decrypted, not decoded.
    pub fn raw(&self) -> Result<Vec<u8>, String> {
        match &self.loc {
            Loc::Mem(d) => unpack(d, self.raw_len),
            Loc::Disk { seg, offset, len, nonce: n } => {
                let mut buf = vec![0u8; *len as usize];
                seg.read_at(*offset, &mut buf).map_err(|e| e.to_string())?;
                let c = cipher().ok_or("no cipher")?;
                let plain = c.key.open_in_place(nonce(*n), Aad::empty(), &mut buf).map_err(|_| "history block corrupt")?;
                unpack(plain, self.raw_len)
            }
        }
    }
}

thread_local! {
    /// One zstd context per thread instead of a new one (and its buffers) per block.
    static DCTX: RefCell<Option<zstd::bulk::Decompressor<'static>>> = const { RefCell::new(None) };
}

fn unpack(compressed: &[u8], raw_len: u32) -> Result<Vec<u8>, String> {
    DCTX.with(|d| {
        let mut d = d.borrow_mut();
        if d.is_none() {
            *d = zstd::bulk::Decompressor::new().ok();
        }
        match d.as_mut() {
            Some(d) => d.decompress(compressed, raw_len as usize),
            None => zstd::bulk::decompress(compressed, raw_len as usize),
        }
        .map_err(|e| e.to_string())
    })
}

struct SpillWriter {
    dir: PathBuf,
    prefix: String,
    seq: u64,
    /// File first: it must close before the segment's Drop deletes it (Windows).
    current: Option<(File, Arc<Segment>, u64)>,
}

impl SpillWriter {
    fn write(&mut self, data: &[u8]) -> std::io::Result<Loc> {
        let c = cipher().ok_or_else(|| std::io::Error::other("no cipher"))?;
        if self.current.as_ref().is_none_or(|(_, _, len)| *len >= SEGMENT_BYTES) {
            std::fs::create_dir_all(&self.dir)?;
            self.seq += 1;
            let path = self.dir.join(format!("{}-{}.bin", self.prefix, self.seq));
            let file = OpenOptions::new().create(true).write(true).truncate(true).open(&path)?;
            self.current = Some((file, Arc::new(Segment::new(path)), 0));
        }
        let (file, seg, len) = self.current.as_mut().expect("segment");
        let n = c.counter.fetch_add(1, Ordering::Relaxed);
        let mut buf = data.to_vec();
        c.key
            .seal_in_place_append_tag(nonce(n), Aad::empty(), &mut buf)
            .map_err(|_| std::io::Error::other("encrypt"))?;
        file.write_all(&buf)?;
        let loc = Loc::Disk { seg: Arc::clone(seg), offset: *len, len: buf.len() as u32, nonce: n };
        *len += buf.len() as u64;
        Ok(loc)
    }
}

/// Recently decoded blocks, shared by readers outside the recorder lock.
#[derive(Default)]
pub struct BlockCache {
    entries: Mutex<VecDeque<(u64, Arc<Vec<Line>>)>>,
}

impl BlockCache {
    pub fn get(&self, block: &BlockRef) -> Result<Arc<Vec<Line>>, String> {
        {
            let mut e = self.entries.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(i) = e.iter().position(|(f, l)| *f == block.first && l.len() == block.count as usize) {
                let hit = e.remove(i).expect("cache entry");
                e.push_front(hit.clone());
                return Ok(hit.1);
            }
        }
        let lines = Arc::new(block.load()?);
        let mut e = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        e.push_front((block.first, Arc::clone(&lines)));
        e.truncate(CACHE_BLOCKS);
        Ok(lines)
    }

    pub fn clear(&self) {
        self.entries.lock().unwrap_or_else(|p| p.into_inner()).clear();
    }
}

pub struct Archive {
    /// Number of the oldest line still kept.
    first: u64,
    /// Lines dropped from the front (limits, or cleared).
    dropped: u64,
    /// The line numbered 1 in the margin: where the last clear left off (0: never cleared).
    base: u64,
    blocks: VecDeque<BlockRef>,
    hot: BlockBuilder,
    mem_bytes: usize,
    disk_bytes: u64,
    limits: Limits,
    spill: Option<SpillWriter>,
    pub cache: Arc<BlockCache>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Stats {
    pub first: u64,
    pub end: u64,
    pub dropped: u64,
    pub mem_bytes: u64,
    pub disk_bytes: u64,
}

impl Archive {
    /// `spill_dir` / `prefix`: where this pane's segment files go (None: memory only).
    pub fn new(limits: Limits, spill_dir: Option<&Path>, prefix: &str) -> Self {
        Archive {
            first: 0,
            dropped: 0,
            base: 0,
            blocks: VecDeque::new(),
            hot: BlockBuilder::default(),
            mem_bytes: 0,
            disk_bytes: 0,
            limits,
            spill: spill_dir.map(|d| SpillWriter { dir: d.to_path_buf(), prefix: prefix.to_string(), seq: 0, current: None }),
            cache: Arc::new(BlockCache::default()),
        }
    }

    pub fn end(&self) -> u64 {
        self.blocks.back().map_or(self.first, BlockRef::end) + self.hot.len() as u64
    }

    pub fn first(&self) -> u64 {
        self.first
    }

    pub fn stats(&self) -> Stats {
        Stats {
            first: self.first,
            end: self.end(),
            dropped: self.dropped,
            mem_bytes: (self.mem_bytes + self.hot.bytes()) as u64,
            disk_bytes: self.disk_bytes,
        }
    }

    pub fn last_kind(&self) -> Option<u8> {
        self.hot.last_kind()
    }

    pub fn push(&mut self, line: LineRef) {
        self.hot.push(line);
        if self.hot.len() >= BLOCK_LINES || self.hot.bytes() >= BLOCK_BYTES {
            self.seal();
        }
    }

    /// Margin number of line `n` (1-based, starting over at each clear; lines dropped for
    /// the size limits keep counting).
    pub fn number(&self, n: u64) -> u64 {
        n.saturating_sub(self.base) + 1
    }

    pub fn number_base(&self) -> u64 {
        self.base
    }

    fn seal(&mut self) {
        if self.hot.is_empty() {
            return;
        }
        let first = self.end() - self.hot.len() as u64;
        let count = self.hot.len() as u32;
        let raw = std::mem::take(&mut self.hot).finish();
        let mut compressed = zstd::bulk::compress(&raw, ZSTD_LEVEL).unwrap_or_default();
        // compress() allocates the worst-case size (about the raw size); keep only what is used,
        // or each block holds ~20x its compressed size and the memory limit does not see it.
        compressed.shrink_to_fit();
        self.mem_bytes += compressed.len();
        self.blocks.push_back(BlockRef {
            first,
            count,
            raw_len: raw.len() as u32,
            loc: Loc::Mem(Arc::new(compressed)),
        });
        self.enforce();
    }

    fn enforce(&mut self) {
        // Over the memory limit: spill the oldest in-memory blocks (or drop them).
        while self.mem_bytes > self.limits.memory {
            let Some(i) = self.blocks.iter().position(|b| matches!(b.loc, Loc::Mem(_))) else { break };
            let spilled = match (&mut self.spill, self.limits.disk > 0) {
                (Some(w), true) => match &self.blocks[i].loc {
                    Loc::Mem(data) => w.write(data).ok(),
                    Loc::Disk { .. } => None,
                },
                _ => None,
            };
            match spilled {
                Some(loc) => {
                    let b = &mut self.blocks[i];
                    self.mem_bytes -= b.stored_len() as usize;
                    b.loc = loc;
                    self.disk_bytes += b.stored_len();
                }
                None => {
                    // No disk (disabled or failing): only the oldest blocks can go.
                    if !self.drop_oldest() {
                        break;
                    }
                }
            }
        }
        while self.disk_bytes > self.limits.disk && self.drop_oldest() {}
    }

    fn drop_oldest(&mut self) -> bool {
        let Some(b) = self.blocks.pop_front() else { return false };
        match b.loc {
            Loc::Mem(_) => self.mem_bytes -= b.stored_len() as usize,
            Loc::Disk { .. } => self.disk_bytes -= b.stored_len(),
        }
        self.first = b.end();
        self.dropped += u64::from(b.count);
        true
    }

    pub fn clear(&mut self) {
        let end = self.end();
        self.dropped += end - self.first;
        self.first = end;
        // Line numbers start over with the next line.
        self.base = end;
        self.blocks.clear();
        self.hot = BlockBuilder::default();
        self.mem_bytes = 0;
        self.disk_bytes = 0;
        if let Some(w) = &mut self.spill {
            w.current = None;
        }
        self.cache.clear();
    }

    /// Blocks overlapping `[from, to)` and the hot lines in that range, for reading outside the lock.
    pub fn plan(&self, from: u64, to: u64) -> ReadPlan {
        let from = from.max(self.first);
        let hot_first = self.end() - self.hot.len() as u64;
        let blocks = self
            .blocks
            .iter()
            .filter(|b| b.end() > from && b.first < to)
            .cloned()
            .collect();
        let lo = from.max(hot_first);
        let hi = to.min(self.end());
        let hot = if lo < hi { self.hot.lines((lo - hot_first) as usize, (hi - hot_first) as usize) } else { Vec::new() };
        ReadPlan { blocks, hot, hot_first: lo }
    }
}

/// What to read for a range, gathered under the lock and loaded without it.
pub struct ReadPlan {
    pub blocks: Vec<BlockRef>,
    pub hot: Vec<Line>,
    pub hot_first: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(i: u64) -> Line {
        Line { text: format!("line {i} {}", "x".repeat((i % 50) as usize)), runs: vec![], ts: i as i64, kind: 0 }
    }

    fn read(a: &Archive, from: u64, to: u64) -> Vec<Line> {
        let plan = a.plan(from, to);
        let mut out = Vec::new();
        for b in &plan.blocks {
            let lines = a.cache.get(b).unwrap();
            for (i, l) in lines.iter().enumerate() {
                let n = b.first + i as u64;
                if n >= from && n < to {
                    out.push(l.clone());
                }
            }
        }
        out.extend(plan.hot);
        out
    }

    #[test]
    fn seal_and_read_back() {
        let mut a = Archive::new(Limits::default(), None, "t");
        for i in 0..5000 {
            a.push(line(i).as_ref());
        }
        assert_eq!(a.end(), 5000);
        assert_eq!(a.blocks.len(), 2);
        let got = read(&a, 1990, 4010);
        assert_eq!(got.len(), 2020);
        assert_eq!(got[0], line(1990));
        assert_eq!(got[2019], line(4009));
        assert!(a.stats().mem_bytes < 5000 * 20);
        // Sealed blocks keep only their compressed bytes, not zstd's worst-case buffer.
        for b in &a.blocks {
            if let Loc::Mem(d) = &b.loc {
                assert!(d.capacity() < d.len() + 64, "capacity {} for {} bytes", d.capacity(), d.len());
            }
        }
    }

    #[test]
    fn memory_limit_without_disk_drops_oldest() {
        let mut a = Archive::new(Limits { memory: 1, disk: 0 }, None, "t");
        for i in 0..4500 {
            a.push(line(i).as_ref());
        }
        // Every sealed block is over the limit and gets dropped; the hot block stays.
        assert_eq!(a.first(), 4000);
        assert_eq!(a.stats().dropped, 4000);
        assert_eq!(read(&a, 0, 10_000)[0], line(4000));
    }

    #[test]
    fn spill_to_disk_and_limit() {
        let dir = std::env::temp_dir().join(format!("nexterm-hist-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        {
            let mut a = Archive::new(Limits { memory: 1, disk: 1 << 30 }, Some(&dir), "p");
            for i in 0..6000 {
                a.push(line(i).as_ref());
            }
            assert_eq!(a.first(), 0);
            assert!(a.stats().disk_bytes > 0);
            assert_eq!(a.stats().mem_bytes as usize, a.hot.bytes());
            let got = read(&a, 0, 6000);
            assert_eq!(got.len(), 6000);
            assert_eq!(got[2500], line(2500));
            // Tampering is detected.
            let file = std::fs::read_dir(&dir).unwrap().next().unwrap().unwrap().path();
            let mut bytes = std::fs::read(&file).unwrap();
            bytes[10] ^= 1;
            std::fs::write(&file, bytes).unwrap();
            assert!(a.blocks[0].load().is_err());
            a.limits.disk = 1;
            a.enforce();
            assert_eq!(a.first(), 6000);
        }
        // Dropping the blocks deleted the segment file.
        assert_eq!(std::fs::read_dir(&dir).map(|d| d.count()).unwrap_or(0), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn clear_keeps_numbering() {
        let mut a = Archive::new(Limits::default(), None, "t");
        for i in 0..2500 {
            a.push(line(i).as_ref());
        }
        assert_eq!(a.number(2499), 2500);
        a.clear();
        assert_eq!((a.first(), a.end()), (2500, 2500));
        a.push(line(1).as_ref());
        assert_eq!(a.end(), 2501);
        // The margin numbers start over: the first line after the clear is number 1.
        assert_eq!(a.number(2500), 1);
    }

    #[test]
    fn numbers_keep_counting_past_dropped_blocks() {
        let mut a = Archive::new(Limits { memory: 1, disk: 0 }, None, "t");
        for i in 0..4500 {
            a.push(line(i).as_ref());
        }
        assert_eq!(a.first(), 4000);
        assert_eq!(a.number(4000), 4001);
    }
}
