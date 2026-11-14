//! ZModem file transfer, compatible with lrzsz `rz` / `sz` on the remote side.
//!
//! `sz file` on the remote sends ZRQINIT → we receive files into a folder.
//! `rz` on the remote sends ZRINIT → we send files picked by the user.

use std::collections::VecDeque;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const ZPAD: u8 = b'*';
const ZDLE: u8 = 0x18; // also CAN
const ZBIN: u8 = b'A';
const ZHEX: u8 = b'B';
const ZBIN32: u8 = b'C';

pub const ZRQINIT: u8 = 0;
pub const ZRINIT: u8 = 1;
const ZSINIT: u8 = 2;
const ZACK: u8 = 3;
const ZFILE: u8 = 4;
const ZSKIP: u8 = 5;
const ZNAK: u8 = 6;
const ZABORT: u8 = 7;
const ZFIN: u8 = 8;
const ZRPOS: u8 = 9;
const ZDATA: u8 = 10;
const ZEOF: u8 = 11;
const ZFERR: u8 = 12;
const ZCRC: u8 = 13;
const ZCAN: u8 = 16;

const ZCRCE: u8 = b'h';
const ZCRCG: u8 = b'i';
const ZCRCQ: u8 = b'j';
const ZCRCW: u8 = b'k';

const CANFDX: u8 = 0x01;
const CANOVIO: u8 = 0x02;
const CANFC32: u8 = 0x20;

const BLOCK: usize = 4096;
/// Subpackets per ZCRCW window when sending (window = 128 KiB).
const WINDOW_PACKETS: usize = 32;
const TIMEOUT: Duration = Duration::from_secs(15);
const MAX_RETRIES: usize = 10;

/// What the remote asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    /// Remote runs `sz`: it sends, we receive.
    Receive,
    /// Remote runs `rz`: it receives, we send.
    Send,
}

/// Finds the ZRQINIT / ZRINIT hex header that starts a transfer in terminal output.
#[derive(Default)]
pub struct Detector {
    tail: Vec<u8>,
}

impl Detector {
    /// Returns the offset in `data` where the transfer starts and its direction.
    pub fn feed(&mut self, data: &[u8]) -> Option<(usize, Direction)> {
        const PAT: &[u8] = b"**\x18B0";
        let mut joined = std::mem::take(&mut self.tail);
        let carried = joined.len();
        joined.extend_from_slice(data);
        let found = joined.windows(PAT.len() + 1).position(|w| {
            w.starts_with(PAT) && (w[PAT.len()] == b'0' || w[PAT.len()] == b'1')
        });
        if let Some(pos) = found {
            let dir = if joined[pos + PAT.len()] == b'0' { Direction::Receive } else { Direction::Send };
            return Some((pos.saturating_sub(carried), dir));
        }
        let keep = joined.len().min(PAT.len());
        self.tail = joined[joined.len() - keep..].to_vec();
        None
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub file_name: String,
    pub file_index: usize,
    pub file_count: usize,
    pub transferred: u64,
    pub total: u64,
}

#[derive(Debug)]
pub enum ZError {
    Timeout,
    Cancelled,
    Closed,
    Protocol(String),
    Io(std::io::Error),
}

impl std::fmt::Display for ZError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ZError::Timeout => write!(f, "对方长时间无响应"),
            ZError::Cancelled => write!(f, "传输已取消"),
            ZError::Closed => write!(f, "连接已断开"),
            ZError::Protocol(m) => write!(f, "ZModem 协议错误: {}", m),
            ZError::Io(e) => write!(f, "文件读写失败: {}", e),
        }
    }
}

impl From<std::io::Error> for ZError {
    fn from(e: std::io::Error) -> Self {
        ZError::Io(e)
    }
}

type ZResult<T> = Result<T, ZError>;

// ---------------------------------------------------------------- CRC

pub(crate) fn crc16(data: &[u8]) -> u16 {
    let mut crc: u16 = 0;
    for &b in data {
        crc ^= (b as u16) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 { (crc << 1) ^ 0x1021 } else { crc << 1 };
        }
    }
    crc
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc: u32 = 0xFFFF_FFFF;
    for &b in data {
        crc ^= b as u32;
        for _ in 0..8 {
            crc = if crc & 1 != 0 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 };
        }
    }
    !crc
}

// ---------------------------------------------------------------- encoding

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Header {
    kind: u8,
    data: [u8; 4],
}

impl Header {
    fn new(kind: u8, data: [u8; 4]) -> Self {
        Self { kind, data }
    }
    fn pos(kind: u8, pos: u32) -> Self {
        Self { kind, data: pos.to_le_bytes() }
    }
    fn position(&self) -> u32 {
        u32::from_le_bytes(self.data)
    }
    /// ZF0 flags byte.
    fn zf0(&self) -> u8 {
        self.data[3]
    }
}

fn push_escaped(out: &mut Vec<u8>, b: u8) {
    match b {
        ZDLE | 0x10 | 0x90 | 0x11 | 0x91 | 0x13 | 0x93 | 0x0d | 0x8d => {
            out.push(ZDLE);
            out.push(b ^ 0x40);
        }
        0x7f => {
            out.push(ZDLE);
            out.push(b'l');
        }
        0xff => {
            out.push(ZDLE);
            out.push(b'm');
        }
        _ => out.push(b),
    }
}

fn hex_header(h: Header) -> Vec<u8> {
    let mut raw = vec![h.kind];
    raw.extend_from_slice(&h.data);
    let crc = crc16(&raw);
    raw.extend_from_slice(&crc.to_be_bytes());
    let mut out = vec![ZPAD, ZPAD, ZDLE, ZHEX];
    for b in raw {
        out.extend_from_slice(format!("{:02x}", b).as_bytes());
    }
    out.extend_from_slice(b"\r\x8a");
    if h.kind != ZFIN && h.kind != ZACK {
        out.push(0x11);
    }
    out
}

fn bin_header(h: Header, use_crc32: bool) -> Vec<u8> {
    let mut raw = vec![h.kind];
    raw.extend_from_slice(&h.data);
    let mut out = vec![ZPAD, ZDLE, if use_crc32 { ZBIN32 } else { ZBIN }];
    for &b in &raw {
        push_escaped(&mut out, b);
    }
    if use_crc32 {
        for b in crc32(&raw).to_le_bytes() {
            push_escaped(&mut out, b);
        }
    } else {
        for b in crc16(&raw).to_be_bytes() {
            push_escaped(&mut out, b);
        }
    }
    out
}

fn subpacket(data: &[u8], end: u8, use_crc32: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() * 11 / 10 + 12);
    for &b in data {
        push_escaped(&mut out, b);
    }
    out.push(ZDLE);
    out.push(end);
    let mut covered = data.to_vec();
    covered.push(end);
    if use_crc32 {
        for b in crc32(&covered).to_le_bytes() {
            push_escaped(&mut out, b);
        }
    } else {
        for b in crc16(&covered).to_be_bytes() {
            push_escaped(&mut out, b);
        }
    }
    if end == ZCRCW {
        out.push(0x11);
    }
    out
}

/// Bytes that make the remote `rz` / `sz` abort.
pub fn cancel_sequence() -> Vec<u8> {
    let mut v = vec![ZDLE; 8];
    v.extend_from_slice(&[0x08; 8]);
    v
}

// ---------------------------------------------------------------- transport

/// One ZModem transfer: raw bytes from the remote arrive on `rx`, replies go out via `write`.
pub struct Transfer {
    rx: Receiver<Vec<u8>>,
    buf: VecDeque<u8>,
    write: Box<dyn Fn(&[u8]) + Send>,
    cancel: Arc<AtomicBool>,
    progress: Box<dyn FnMut(&Progress) + Send>,
    last_progress: Instant,
}

enum ZByte {
    Data(u8),
    End(u8),
}

impl Transfer {
    pub fn new(
        rx: Receiver<Vec<u8>>,
        initial: Vec<u8>,
        write: Box<dyn Fn(&[u8]) + Send>,
        cancel: Arc<AtomicBool>,
        progress: Box<dyn FnMut(&Progress) + Send>,
    ) -> Self {
        Self {
            rx,
            buf: initial.into(),
            write,
            cancel,
            progress,
            last_progress: Instant::now() - Duration::from_secs(1),
        }
    }

    /// Bytes received but not consumed (e.g. the shell prompt after "OO").
    pub fn leftover(mut self) -> Vec<u8> {
        while let Ok(chunk) = self.rx.try_recv() {
            self.buf.extend(chunk);
        }
        self.buf.into_iter().collect()
    }

    fn send(&self, bytes: &[u8]) {
        (self.write)(bytes);
    }

    fn report(&mut self, p: Progress, force: bool) {
        if force || self.last_progress.elapsed() >= Duration::from_millis(150) {
            self.last_progress = Instant::now();
            (self.progress)(&p);
        }
    }

    fn next(&mut self, timeout: Duration) -> ZResult<u8> {
        let deadline = Instant::now() + timeout;
        loop {
            if self.cancel.load(Ordering::Acquire) {
                return Err(ZError::Cancelled);
            }
            if let Some(b) = self.buf.pop_front() {
                return Ok(b);
            }
            let now = Instant::now();
            if now >= deadline {
                return Err(ZError::Timeout);
            }
            let wait = (deadline - now).min(Duration::from_millis(200));
            match self.rx.recv_timeout(wait) {
                Ok(chunk) => self.buf.extend(chunk),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return Err(ZError::Closed),
            }
        }
    }

    fn peek(&mut self, timeout: Duration) -> Option<u8> {
        if self.buf.is_empty() {
            if let Ok(chunk) = self.rx.recv_timeout(timeout) {
                self.buf.extend(chunk);
            }
        }
        self.buf.front().copied()
    }

    fn zdl_read(&mut self, t: Duration) -> ZResult<ZByte> {
        loop {
            let c = self.next(t)?;
            match c {
                ZDLE => {}
                0x11 | 0x13 | 0x91 | 0x93 => continue,
                _ => return Ok(ZByte::Data(c)),
            }
            let mut cans = 1;
            loop {
                let c2 = self.next(t)?;
                match c2 {
                    ZDLE => {
                        cans += 1;
                        if cans >= 5 {
                            return Err(ZError::Cancelled);
                        }
                    }
                    0x11 | 0x13 | 0x91 | 0x93 => {}
                    ZCRCE | ZCRCG | ZCRCQ | ZCRCW => return Ok(ZByte::End(c2)),
                    b'l' => return Ok(ZByte::Data(0x7f)),
                    b'm' => return Ok(ZByte::Data(0xff)),
                    _ if c2 & 0x60 == 0x40 => return Ok(ZByte::Data(c2 ^ 0x40)),
                    _ => return Err(ZError::Protocol(format!("错误的转义字节 0x{:02x}", c2))),
                }
            }
        }
    }

    fn zdl_data(&mut self, t: Duration) -> ZResult<u8> {
        match self.zdl_read(t)? {
            ZByte::Data(b) => Ok(b),
            ZByte::End(_) => Err(ZError::Protocol("帧头中出现了数据包结束符".into())),
        }
    }

    fn hex_byte(&mut self, t: Duration) -> ZResult<u8> {
        let mut v = 0u8;
        for _ in 0..2 {
            let c = self.next(t)? & 0x7f;
            let d = (c as char)
                .to_digit(16)
                .ok_or_else(|| ZError::Protocol("十六进制帧头格式错误".into()))?;
            v = (v << 4) | d as u8;
        }
        Ok(v)
    }

    /// Read the next header. Returns the header and whether it used CRC-32.
    /// Damaged headers (bad CRC) are reported as `Ok(None)`.
    fn read_header(&mut self, t: Duration) -> ZResult<Option<(Header, bool)>> {
        let mut cans = 0;
        let mut skipped = 0usize;
        loop {
            let c = self.next(t)?;
            if c == ZDLE {
                cans += 1;
                if cans >= 5 {
                    return Err(ZError::Cancelled);
                }
                continue;
            }
            cans = 0;
            if c != ZPAD && c != (ZPAD | 0x80) {
                skipped += 1;
                if skipped > 64 * 1024 {
                    return Err(ZError::Protocol("长时间收不到有效帧头".into()));
                }
                continue;
            }
            let mut c = self.next(t)?;
            while c == ZPAD || c == (ZPAD | 0x80) {
                c = self.next(t)?;
            }
            if c != ZDLE {
                continue;
            }
            let format = self.next(t)?;
            let mut raw = [0u8; 5];
            let ok = match format {
                ZHEX => {
                    for b in raw.iter_mut() {
                        *b = self.hex_byte(t)?;
                    }
                    let crc = u16::from_be_bytes([self.hex_byte(t)?, self.hex_byte(t)?]);
                    // Swallow the CR LF (XON) that follows a hex header.
                    for _ in 0..3 {
                        match self.peek(Duration::from_millis(20)) {
                            Some(b'\r') | Some(b'\n') | Some(0x8a) | Some(0x8d) | Some(0x11) => {
                                self.buf.pop_front();
                            }
                            _ => break,
                        }
                    }
                    crc16(&raw) == crc
                }
                ZBIN => {
                    for b in raw.iter_mut() {
                        *b = self.zdl_data(t)?;
                    }
                    let crc = u16::from_be_bytes([self.zdl_data(t)?, self.zdl_data(t)?]);
                    crc16(&raw) == crc
                }
                ZBIN32 => {
                    for b in raw.iter_mut() {
                        *b = self.zdl_data(t)?;
                    }
                    let mut c4 = [0u8; 4];
                    for b in c4.iter_mut() {
                        *b = self.zdl_data(t)?;
                    }
                    crc32(&raw) == u32::from_le_bytes(c4)
                }
                _ => continue,
            };
            if !ok {
                return Ok(None);
            }
            let header = Header::new(raw[0], [raw[1], raw[2], raw[3], raw[4]]);
            if header.kind == ZCAN || header.kind == ZABORT {
                return Err(ZError::Cancelled);
            }
            return Ok(Some((header, format == ZBIN32)));
        }
    }

    /// Read one data subpacket. `Ok(None)` means a CRC error.
    fn read_subpacket(&mut self, use_crc32: bool, t: Duration) -> ZResult<Option<(Vec<u8>, u8)>> {
        let mut data = Vec::with_capacity(BLOCK);
        loop {
            match self.zdl_read(t)? {
                ZByte::Data(b) => {
                    if data.len() > 64 * 1024 {
                        return Err(ZError::Protocol("数据包过长".into()));
                    }
                    data.push(b);
                }
                ZByte::End(end) => {
                    let mut covered = data.clone();
                    covered.push(end);
                    let ok = if use_crc32 {
                        let mut c4 = [0u8; 4];
                        for b in c4.iter_mut() {
                            *b = self.zdl_data(t)?;
                        }
                        crc32(&covered) == u32::from_le_bytes(c4)
                    } else {
                        let crc = u16::from_be_bytes([self.zdl_data(t)?, self.zdl_data(t)?]);
                        crc16(&covered) == crc
                    };
                    return Ok(if ok { Some((data, end)) } else { None });
                }
            }
        }
    }

    pub fn abort(&self) {
        self.send(&cancel_sequence());
    }

    // ------------------------------------------------------------ receive

    /// Receive every file the remote `sz` sends into `dir`. Returns the saved paths.
    pub fn receive(&mut self, dir: &Path) -> ZResult<Vec<PathBuf>> {
        std::fs::create_dir_all(dir)?;
        let zrinit = hex_header(Header::new(ZRINIT, [0, 0, 0, CANFDX | CANOVIO | CANFC32]));
        self.send(&zrinit);
        let mut last_zrinit = Instant::now();
        let mut saved = Vec::new();
        let mut current: Option<(File, PathBuf, String, u64)> = None; // file, path, name, size
        let mut offset: u64 = 0;
        let mut index = 0usize;
        let mut retries = 0;

        loop {
            let header = match self.read_header(TIMEOUT) {
                Ok(Some(h)) => h,
                Ok(None) => {
                    self.send(&hex_header(Header::pos(ZRPOS, offset as u32)));
                    continue;
                }
                Err(ZError::Timeout) if retries < MAX_RETRIES => {
                    retries += 1;
                    if current.is_some() {
                        self.send(&hex_header(Header::pos(ZRPOS, offset as u32)));
                    } else {
                        self.send(&zrinit);
                    }
                    continue;
                }
                Err(e) => return Err(e),
            };
            retries = 0;
            let (h, crc32_frame) = header;
            match h.kind {
                ZRQINIT => {
                    if current.is_none() && last_zrinit.elapsed() > Duration::from_millis(800) {
                        self.send(&zrinit);
                        last_zrinit = Instant::now();
                    }
                }
                ZSINIT => {
                    let _ = self.read_subpacket(crc32_frame, TIMEOUT)?;
                    self.send(&hex_header(Header::new(ZACK, [0; 4])));
                }
                ZFILE => {
                    let Some((info, _)) = self.read_subpacket(crc32_frame, TIMEOUT)? else {
                        self.send(&hex_header(Header::new(ZNAK, [0; 4])));
                        continue;
                    };
                    if let Some((_, path, name, _)) = &current {
                        // Duplicate ZFILE for the file we already opened: just resync.
                        if offset == 0 && file_name_of(&info) == *name {
                            let _ = path;
                            self.send(&hex_header(Header::pos(ZRPOS, 0)));
                            continue;
                        }
                    }
                    let name = file_name_of(&info);
                    let size = file_size_of(&info);
                    let path = unique_path(dir, &name);
                    let file = File::create(&path)?;
                    index += 1;
                    current = Some((file, path, name.clone(), size));
                    offset = 0;
                    self.report(
                        Progress { file_name: name, file_index: index, file_count: 0, transferred: 0, total: size },
                        true,
                    );
                    self.send(&hex_header(Header::pos(ZRPOS, 0)));
                }
                ZDATA => {
                    let Some((file, _, name, size)) = current.as_mut() else {
                        self.send(&hex_header(Header::new(ZRINIT, [0, 0, 0, CANFDX | CANOVIO | CANFC32])));
                        continue;
                    };
                    if h.position() as u64 != offset {
                        self.send(&hex_header(Header::pos(ZRPOS, offset as u32)));
                        continue;
                    }
                    let (name, size) = (name.clone(), *size);
                    // Subpackets until a frame end that expects a header next.
                    loop {
                        let Some((data, end)) = self.read_subpacket(crc32_frame, TIMEOUT)? else {
                            self.send(&hex_header(Header::pos(ZRPOS, offset as u32)));
                            break;
                        };
                        file.write_all(&data)?;
                        offset += data.len() as u64;
                        let p = Progress { file_name: name.clone(), file_index: index, file_count: 0, transferred: offset, total: size };
                        self.report(p, false);
                        match end {
                            ZCRCG => continue,
                            ZCRCQ => {
                                self.send(&hex_header(Header::pos(ZACK, offset as u32)));
                                continue;
                            }
                            ZCRCW => {
                                self.send(&hex_header(Header::pos(ZACK, offset as u32)));
                                break;
                            }
                            _ => break, // ZCRCE
                        }
                    }
                }
                ZEOF => {
                    if current.is_some() && h.position() as u64 == offset {
                        let (mut file, path, name, size) = current.take().unwrap();
                        file.flush()?;
                        drop(file);
                        self.report(
                            Progress { file_name: name, file_index: index, file_count: 0, transferred: offset, total: size.max(offset) },
                            true,
                        );
                        saved.push(path);
                        self.send(&zrinit);
                    }
                }
                ZFIN => {
                    self.send(&hex_header(Header::new(ZFIN, [0; 4])));
                    // The sender closes with "OO"; drop it if it arrives.
                    for _ in 0..2 {
                        if self.peek(Duration::from_millis(500)) == Some(b'O') {
                            self.buf.pop_front();
                        }
                    }
                    if let Some((_, path, _, _)) = current.take() {
                        let _ = std::fs::remove_file(path);
                    }
                    return Ok(saved);
                }
                ZFERR => return Err(ZError::Protocol("对方报告文件读写错误".into())),
                _ => {}
            }
        }
    }

    // ------------------------------------------------------------ send

    /// Send `files` to the remote `rz`.
    pub fn send_files(&mut self, files: &[PathBuf]) -> ZResult<()> {
        // The ZRINIT that triggered us is normally already in the buffer.
        let use_crc32;
        let mut tries = 0;
        loop {
            match self.read_header(Duration::from_secs(3)) {
                Ok(Some((h, _))) if h.kind == ZRINIT => {
                    use_crc32 = h.zf0() & CANFC32 != 0;
                    break;
                }
                Ok(_) => {}
                Err(ZError::Timeout) if tries < 3 => {
                    tries += 1;
                    self.send(&hex_header(Header::new(ZRQINIT, [0; 4])));
                }
                Err(e) => return Err(e),
            }
        }

        let total_bytes: u64 = files.iter().filter_map(|f| std::fs::metadata(f).ok()).map(|m| m.len()).sum();
        let mut bytes_left = total_bytes;
        for (i, path) in files.iter().enumerate() {
            let size = std::fs::metadata(path)?.len();
            self.send_one(path, i + 1, files.len(), size, files.len() - i, bytes_left, use_crc32)?;
            bytes_left = bytes_left.saturating_sub(size);
        }

        // Finish the session.
        for _ in 0..MAX_RETRIES {
            self.send(&hex_header(Header::new(ZFIN, [0; 4])));
            match self.read_header(Duration::from_secs(5)) {
                Ok(Some((h, _))) if h.kind == ZFIN => {
                    self.send(b"OO");
                    return Ok(());
                }
                Ok(_) | Err(ZError::Timeout) => continue,
                Err(e) => return Err(e),
            }
        }
        self.send(b"OO");
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn send_one(
        &mut self,
        path: &Path,
        index: usize,
        count: usize,
        size: u64,
        files_left: usize,
        bytes_left: u64,
        crc: bool,
    ) -> ZResult<()> {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "file".into());
        let mtime = std::fs::metadata(path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or_else(|| SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0));
        let mut info = name.as_bytes().to_vec();
        info.push(0);
        info.extend_from_slice(format!("{} {:o} {:o} 0 {} {}", size, mtime, 0o100644, files_left, bytes_left).as_bytes());
        info.push(0);

        let mut file = File::open(path)?;
        let progress = |t: u64| Progress { file_name: name.clone(), file_index: index, file_count: count, transferred: t, total: size };
        self.report(progress(0), true);

        // Offer the file until the receiver asks for a position.
        // Stale ZRINITs that `rz` repeated before we answered must not trigger a resend.
        while let Ok(chunk) = self.rx.try_recv() {
            self.buf.extend(chunk);
        }
        self.buf.clear();
        let mut start: Option<u64> = None;
        'offer: for _ in 0..MAX_RETRIES {
            self.send(&bin_header(Header::new(ZFILE, [0, 0, 0, 1]), crc));
            self.send(&subpacket(&info, ZCRCW, crc));
            loop {
                match self.read_header(TIMEOUT) {
                    Ok(Some((h, _))) => match h.kind {
                        ZRPOS => {
                            start = Some(h.position() as u64);
                            break 'offer;
                        }
                        ZSKIP => {
                            self.report(progress(size), true);
                            return Ok(());
                        }
                        ZCRC => {
                            let mut all = Vec::new();
                            File::open(path)?.read_to_end(&mut all)?;
                            self.send(&hex_header(Header::pos(ZCRC, crc32(&all))));
                        }
                        ZNAK => continue 'offer,
                        _ => {}
                    },
                    Ok(None) => continue 'offer,
                    Err(ZError::Timeout) => continue 'offer,
                    Err(e) => return Err(e),
                }
            }
        }
        let mut pos = start.ok_or(ZError::Timeout)?;

        let mut buf = vec![0u8; BLOCK];
        'frame: loop {
            file.seek(SeekFrom::Start(pos))?;
            self.send(&bin_header(Header::pos(ZDATA, pos as u32), crc));
            let mut packets = 0;
            loop {
                if self.cancel.load(Ordering::Acquire) {
                    return Err(ZError::Cancelled);
                }
                let n = read_full(&mut file, &mut buf)?;
                let eof = n < BLOCK;
                packets += 1;
                let end = if eof {
                    ZCRCE
                } else if packets % WINDOW_PACKETS == 0 {
                    ZCRCW
                } else {
                    ZCRCG
                };
                self.send(&subpacket(&buf[..n], end, crc));
                pos += n as u64;
                self.report(progress(pos), false);

                if end == ZCRCW {
                    // Wait for the window ack before sending more.
                    match self.wait_ack(pos)? {
                        Ack::Continue => continue 'frame,
                        Ack::Reposition(p) => {
                            pos = p;
                            continue 'frame;
                        }
                    }
                }
                if eof {
                    break;
                }
            }

            // End of file: wait until the receiver confirms with ZRINIT.
            for _ in 0..MAX_RETRIES {
                self.send(&bin_header(Header::pos(ZEOF, pos as u32), crc));
                match self.read_header(TIMEOUT) {
                    Ok(Some((h, _))) => match h.kind {
                        ZRINIT => {
                            self.report(progress(pos), true);
                            return Ok(());
                        }
                        ZRPOS => {
                            pos = h.position() as u64;
                            continue 'frame;
                        }
                        ZSKIP => return Ok(()),
                        _ => {}
                    },
                    Ok(None) | Err(ZError::Timeout) => {}
                    Err(e) => return Err(e),
                }
            }
            return Err(ZError::Timeout);
        }
    }

    fn wait_ack(&mut self, pos: u64) -> ZResult<Ack> {
        for _ in 0..MAX_RETRIES {
            match self.read_header(TIMEOUT) {
                Ok(Some((h, _))) => match h.kind {
                    ZACK if h.position() as u64 == pos => return Ok(Ack::Continue),
                    ZACK => {}
                    ZRPOS => return Ok(Ack::Reposition(h.position() as u64)),
                    _ => {}
                },
                Ok(None) => {}
                Err(ZError::Timeout) => return Ok(Ack::Reposition(pos)),
                Err(e) => return Err(e),
            }
        }
        Err(ZError::Timeout)
    }
}

enum Ack {
    Continue,
    Reposition(u64),
}

fn read_full(f: &mut File, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut n = 0;
    while n < buf.len() {
        match f.read(&mut buf[n..])? {
            0 => break,
            k => n += k,
        }
    }
    Ok(n)
}

pub(crate) fn file_name_of(info: &[u8]) -> String {
    let raw = info.split(|&b| b == 0).next().unwrap_or(b"file");
    let name = String::from_utf8_lossy(raw).to_string();
    // Keep only the last path component and strip characters Windows rejects.
    let base = name.rsplit(['/', '\\']).next().unwrap_or("file");
    let clean: String = base
        .chars()
        .map(|c| if r#"<>:"|?*"#.contains(c) || c.is_control() { '_' } else { c })
        .collect();
    if clean.trim().is_empty() || clean == "." || clean == ".." {
        "file".into()
    } else {
        clean
    }
}

pub(crate) fn file_size_of(info: &[u8]) -> u64 {
    info.split(|&b| b == 0)
        .nth(1)
        .and_then(|meta| String::from_utf8_lossy(meta).split_whitespace().next().map(str::to_string))
        .and_then(|s| s.parse().ok())
        .unwrap_or(0)
}

/// `dir/name`, or `dir/name (1).ext` ... when the file already exists.
pub(crate) fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let p = Path::new(name);
    let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| name.into());
    let ext = p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    for i in 1.. {
        let candidate = dir.join(format!("{} ({}){}", stem, i, ext));
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn test_known_lrzsz_headers() {
        // rz's ZRINIT and sz's ZRQINIT exactly as lrzsz prints them.
        assert_eq!(
            hex_header(Header::new(ZRINIT, [0, 0, 0, 0x23])),
            b"**\x18B0100000023be50\r\x8a\x11".to_vec()
        );
        assert_eq!(hex_header(Header::new(ZRQINIT, [0; 4])), b"**\x18B00000000000000\r\x8a\x11".to_vec());
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        assert_eq!(crc16(b"123456789"), 0x31C3);
    }

    #[test]
    fn test_detector_across_chunks() {
        let mut d = Detector::default();
        assert!(d.feed(b"$ sz a.txt\r\nrz\r**\x18").is_none());
        let (off, dir) = d.feed(b"B00000000000000\r\x8a\x11").unwrap();
        assert_eq!((off, dir), (0, Direction::Receive));
        let mut d = Detector::default();
        let (off, dir) = d.feed(b"hello**\x18B0100000023be50").unwrap();
        assert_eq!((off, dir), (5, Direction::Send));
    }

    /// Our sender against our receiver through lossless pipes, with bytes that need escaping.
    #[test]
    fn test_loopback_transfer() {
        let tmp = std::env::temp_dir().join(format!("wtn-zm-{}", uuid::Uuid::new_v4()));
        let src = tmp.join("src");
        let dst = tmp.join("dst");
        std::fs::create_dir_all(&src).unwrap();
        let mut payload = Vec::new();
        for i in 0..(BLOCK * WINDOW_PACKETS * 2 + 777) {
            payload.push((i * 7 % 256) as u8);
        }
        payload.extend_from_slice(&[ZDLE, 0x11, 0x13, 0x7f, 0xff, 0x0d, 0x8d, ZDLE, ZDLE]);
        std::fs::write(src.join("blob.bin"), &payload).unwrap();
        std::fs::write(src.join("empty.txt"), b"").unwrap();

        let (to_recv_tx, to_recv_rx) = mpsc::channel::<Vec<u8>>();
        let (to_send_tx, to_send_rx) = mpsc::channel::<Vec<u8>>();
        let dst2 = dst.clone();
        let receiver = std::thread::spawn(move || {
            let mut t = Transfer::new(
                to_recv_rx,
                Vec::new(),
                Box::new(move |b: &[u8]| {
                    let _ = to_send_tx.send(b.to_vec());
                }),
                Arc::new(AtomicBool::new(false)),
                Box::new(|_| {}),
            );
            t.receive(&dst2).map_err(|e| e.to_string())
        });
        let mut sender = Transfer::new(
            to_send_rx,
            Vec::new(),
            Box::new(move |b: &[u8]| {
                let _ = to_recv_tx.send(b.to_vec());
            }),
            Arc::new(AtomicBool::new(false)),
            Box::new(|_| {}),
        );
        sender
            .send_files(&[src.join("blob.bin"), src.join("empty.txt")])
            .expect("send");
        let saved = receiver.join().unwrap().expect("receive");
        assert_eq!(saved.len(), 2);
        assert_eq!(std::fs::read(dst.join("blob.bin")).unwrap(), payload);
        assert_eq!(std::fs::read(dst.join("empty.txt")).unwrap(), b"");
        let _ = std::fs::remove_dir_all(tmp);
    }
}
