//! XMODEM / YMODEM file transfer, compatible with lrzsz `rx` / `rb` (we send) and
//! `sx` / `sb` (we receive) on the remote side, like WindTerm's X/YModem upload.
//!
//! Unlike ZModem these protocols have no start header the terminal could detect,
//! so transfers are started from the pane menu.

use std::collections::VecDeque;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, Instant, UNIX_EPOCH};

use crate::zmodem::{crc16, file_name_of, file_size_of, unique_path, Progress};

const SOH: u8 = 0x01;
const STX: u8 = 0x02;
const EOT: u8 = 0x04;
const ACK: u8 = 0x06;
const NAK: u8 = 0x15;
const CAN: u8 = 0x18;
const CRC: u8 = b'C';
const SUB: u8 = 0x1a;

const MAX_RETRIES: usize = 10;
/// The remote program may take a while to start (or the user to type `sx`).
const START_TIMEOUT: Duration = Duration::from_secs(60);
const BLOCK_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Protocol {
    Xmodem,
    Ymodem,
}

#[derive(Debug)]
pub enum MError {
    Timeout,
    Cancelled,
    /// The other side sent CAN CAN.
    RemoteCancelled,
    Closed,
    Protocol(String),
    Io(std::io::Error),
}

impl std::fmt::Display for MError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MError::Timeout => write!(f, "对方长时间无响应（远程的 rx / rb / sx / sb 是否已启动？）"),
            MError::Cancelled => write!(f, "传输已取消"),
            MError::RemoteCancelled => write!(f, "对方取消了传输"),
            MError::Closed => write!(f, "连接已断开"),
            MError::Protocol(m) => write!(f, "协议错误: {}", m),
            MError::Io(e) => write!(f, "文件读写失败: {}", e),
        }
    }
}

impl From<std::io::Error> for MError {
    fn from(e: std::io::Error) -> Self {
        MError::Io(e)
    }
}

type MResult<T> = Result<T, MError>;

fn checksum(data: &[u8]) -> u8 {
    data.iter().fold(0u8, |a, &b| a.wrapping_add(b))
}

/// One X/YModem transfer: raw bytes from the remote arrive on `rx`, replies go out via `write`.
pub struct ModemTransfer {
    rx: Receiver<Vec<u8>>,
    buf: VecDeque<u8>,
    write: Box<dyn Fn(&[u8]) + Send>,
    cancel: Arc<AtomicBool>,
    progress: Box<dyn FnMut(&Progress) + Send>,
    last_progress: Instant,
    /// Data block size when sending: 128 or 1024.
    packet_size: usize,
}

impl ModemTransfer {
    pub fn new(
        rx: Receiver<Vec<u8>>,
        initial: Vec<u8>,
        write: Box<dyn Fn(&[u8]) + Send>,
        cancel: Arc<AtomicBool>,
        progress: Box<dyn FnMut(&Progress) + Send>,
        packet_size: usize,
    ) -> Self {
        Self {
            rx,
            buf: initial.into(),
            write,
            cancel,
            progress,
            last_progress: Instant::now() - Duration::from_secs(1),
            packet_size: if packet_size >= 1024 { 1024 } else { 128 },
        }
    }

    /// Bytes received but not consumed (e.g. the shell prompt after the transfer).
    pub fn leftover(mut self) -> Vec<u8> {
        while let Ok(chunk) = self.rx.try_recv() {
            self.buf.extend(chunk);
        }
        self.buf.into_iter().collect()
    }

    /// Tell the other side to stop (CAN x 8, then backspaces to erase them from a shell).
    pub fn abort(&self) {
        let mut seq = vec![CAN; 8];
        seq.extend_from_slice(&[0x08; 8]);
        (self.write)(&seq);
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

    fn next(&mut self, timeout: Duration) -> MResult<u8> {
        let deadline = Instant::now() + timeout;
        loop {
            if self.cancel.load(Ordering::Acquire) {
                return Err(MError::Cancelled);
            }
            if let Some(b) = self.buf.pop_front() {
                return Ok(b);
            }
            let now = Instant::now();
            if now >= deadline {
                return Err(MError::Timeout);
            }
            let wait = (deadline - now).min(Duration::from_millis(200));
            match self.rx.recv_timeout(wait) {
                Ok(chunk) => self.buf.extend(chunk),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return Err(MError::Closed),
            }
        }
    }

    /// The next byte if one arrives within `timeout`, without consuming it.
    fn peek(&mut self, timeout: Duration) -> Option<u8> {
        if self.buf.is_empty() {
            if let Ok(chunk) = self.rx.recv_timeout(timeout) {
                self.buf.extend(chunk);
            }
        }
        self.buf.front().copied()
    }

    fn read_exact(&mut self, n: usize, timeout: Duration) -> MResult<Vec<u8>> {
        let mut out = Vec::with_capacity(n);
        for _ in 0..n {
            out.push(self.next(timeout)?);
        }
        Ok(out)
    }

    /// CAN must come twice in a row to count (a lone 0x18 can be line noise).
    fn is_cancel(&mut self) -> bool {
        self.peek(Duration::from_millis(500)) == Some(CAN)
    }

    // ------------------------------------------------------------ sending

    /// Wait for the receiver's start request: 'C' (CRC-16) or NAK (checksum).
    ///
    /// The terminal may still show text such as the echoed `rx Config.txt` or lrzsz's
    /// banner, so a 'C' only counts when it stands alone (nothing printable after it).
    fn wait_start(&mut self) -> MResult<bool> {
        let deadline = Instant::now() + START_TIMEOUT;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(MError::Timeout);
            }
            match self.next(left)? {
                b @ (CRC | NAK) => match self.peek(Duration::from_millis(300)) {
                    None => return Ok(b == CRC),
                    Some(n) if n == CRC || n == NAK => {
                        // Repeated start requests: take one, drop the rest.
                        while matches!(self.buf.front(), Some(&x) if x == CRC || x == NAK) {
                            self.buf.pop_front();
                        }
                        return Ok(b == CRC);
                    }
                    // Part of a word ("Config"): keep waiting.
                    Some(n) if (0x20..0x7f).contains(&n) => {}
                    Some(_) => return Ok(b == CRC),
                },
                CAN if self.is_cancel() => return Err(MError::RemoteCancelled),
                _ => {}
            }
        }
    }

    fn packet(num: u8, data: &[u8], size: usize, crc: bool, pad: u8) -> Vec<u8> {
        let mut body = data.to_vec();
        body.resize(size, pad);
        let mut p = Vec::with_capacity(size + 5);
        p.push(if size == 1024 { STX } else { SOH });
        p.push(num);
        p.push(255 - num);
        p.extend_from_slice(&body);
        if crc {
            p.extend_from_slice(&crc16(&body).to_be_bytes());
        } else {
            p.push(checksum(&body));
        }
        p
    }

    /// Send one block until it is acknowledged.
    fn send_block(&mut self, num: u8, data: &[u8], size: usize, crc: bool, pad: u8) -> MResult<()> {
        let packet = Self::packet(num, data, size, crc, pad);
        for _ in 0..MAX_RETRIES {
            self.send(&packet);
            let deadline = Instant::now() + BLOCK_TIMEOUT;
            loop {
                let left = deadline.saturating_duration_since(Instant::now());
                match self.next(left) {
                    Ok(ACK) => return Ok(()),
                    Ok(NAK) => break,
                    // Receiver still asking to start: it missed the block.
                    Ok(CRC) if num <= 1 => break,
                    Ok(CAN) if self.is_cancel() => return Err(MError::RemoteCancelled),
                    Ok(_) => {}
                    Err(MError::Timeout) => break,
                    Err(e) => return Err(e),
                }
            }
        }
        Err(MError::Protocol(format!("数据块 {} 重试 {} 次仍未被确认", num, MAX_RETRIES)))
    }

    fn send_eot(&mut self) -> MResult<()> {
        for _ in 0..MAX_RETRIES {
            self.send(&[EOT]);
            match self.next(BLOCK_TIMEOUT) {
                Ok(ACK) => return Ok(()),
                Ok(CAN) if self.is_cancel() => return Err(MError::RemoteCancelled),
                Ok(_) | Err(MError::Timeout) => {}
                Err(e) => return Err(e),
            }
        }
        Err(MError::Protocol("文件结束 (EOT) 未被确认".into()))
    }

    fn send_data(&mut self, path: &Path, crc: bool, index: usize, count: usize) -> MResult<u64> {
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let mut file = File::open(path)?;
        let total = file.metadata().map(|m| m.len()).unwrap_or(0);
        // 1K blocks need CRC; checksum receivers get 128-byte blocks.
        let size = if crc { self.packet_size } else { 128 };
        let mut buf = vec![0u8; size];
        let mut num: u8 = 1;
        let mut sent: u64 = 0;
        loop {
            let mut n = 0;
            while n < size {
                match file.read(&mut buf[n..])? {
                    0 => break,
                    k => n += k,
                }
            }
            if n == 0 {
                break;
            }
            // A short tail goes in a 128-byte block when it fits (less padding).
            let block = if n <= 128 { 128 } else { size };
            self.send_block(num, &buf[..n], block, crc, SUB)?;
            num = num.wrapping_add(1);
            sent += n as u64;
            self.report(Progress { file_name: name.clone(), file_index: index, file_count: count, transferred: sent, total }, false);
            if n < size {
                break;
            }
        }
        self.send_eot()?;
        self.report(Progress { file_name: name, file_index: index, file_count: count, transferred: sent, total }, true);
        Ok(sent)
    }

    /// XMODEM: send one file (`rx file` on the remote).
    pub fn send_xmodem(&mut self, path: &Path) -> MResult<()> {
        let crc = self.wait_start()?;
        self.send_data(path, crc, 1, 1)?;
        Ok(())
    }

    /// YMODEM batch: send files (`rb` on the remote).
    pub fn send_ymodem(&mut self, files: &[PathBuf]) -> MResult<()> {
        for (i, path) in files.iter().enumerate() {
            let crc = self.wait_start()?;
            let meta = std::fs::metadata(path)?;
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            let mut header = name.into_bytes();
            header.push(0);
            header.extend_from_slice(format!("{} {:o} 100644", meta.len(), mtime).as_bytes());
            let size = if header.len() > 128 { 1024 } else { 128 };
            self.send_block(0, &header, size, crc, 0)?;
            // The receiver asks again ('C') before the data.
            let crc = self.wait_start()?;
            self.send_data(path, crc, i + 1, files.len())?;
        }
        // Empty header ends the batch.
        let crc = self.wait_start()?;
        self.send_block(0, &[], 128, crc, 0)?;
        Ok(())
    }

    // ------------------------------------------------------------ receiving

    /// Read one block after its header byte. Ok(None) = damaged (NAK it).
    fn read_block(&mut self, header: u8, crc: bool) -> MResult<Option<(u8, Vec<u8>)>> {
        let size = if header == STX { 1024 } else { 128 };
        let head = self.read_exact(2, Duration::from_secs(3))?;
        let data = self.read_exact(size, Duration::from_secs(3))?;
        let ok = if crc {
            let c = self.read_exact(2, Duration::from_secs(3))?;
            u16::from_be_bytes([c[0], c[1]]) == crc16(&data)
        } else {
            self.next(Duration::from_secs(3))? == checksum(&data)
        };
        if head[0] != 255 - head[1] || !ok {
            return Ok(None);
        }
        Ok(Some((head[0], data)))
    }

    fn purge(&mut self) {
        // Drop the rest of a damaged block before NAKing it.
        while self.next(Duration::from_millis(300)).is_ok() {}
    }

    /// Request a transfer ('C', falling back to NAK) until the first block header arrives.
    /// Returns the header byte and whether CRC mode was accepted.
    fn request_start(&mut self) -> MResult<(u8, bool)> {
        let deadline = Instant::now() + START_TIMEOUT;
        let mut tries = 0;
        loop {
            if Instant::now() >= deadline {
                return Err(MError::Timeout);
            }
            let crc = tries < 6;
            self.send(&[if crc { CRC } else { NAK }]);
            tries += 1;
            let wait_until = Instant::now() + Duration::from_secs(3);
            loop {
                let left = wait_until.saturating_duration_since(Instant::now());
                match self.next(left) {
                    Ok(b @ (SOH | STX | EOT)) => return Ok((b, crc)),
                    Ok(CAN) if self.is_cancel() => return Err(MError::RemoteCancelled),
                    Ok(_) => {}
                    Err(MError::Timeout) => break,
                    Err(e) => return Err(e),
                }
            }
        }
    }

    /// Receive the data blocks of one file into `out`, starting with `first` (header byte).
    /// `size`: exact length from a YMODEM header (trailing padding is cut), None for XMODEM.
    fn receive_data(
        &mut self,
        mut header: u8,
        crc: bool,
        out: &mut File,
        size: Option<u64>,
        name: &str,
        index: usize,
        count: usize,
        ymodem: bool,
    ) -> MResult<u64> {
        let mut expected: u8 = 1;
        let mut written: u64 = 0;
        // XMODEM has no length: hold the last block back to strip its SUB padding.
        let mut pending: Option<Vec<u8>> = None;
        let mut errors = 0;
        let mut eot_seen = false;
        loop {
            match header {
                SOH | STX => match self.read_block(header, crc)? {
                    Some((num, data)) if num == expected => {
                        errors = 0;
                        if let Some(prev) = pending.take() {
                            out.write_all(&prev)?;
                            written += prev.len() as u64;
                        }
                        let mut data = data;
                        if let Some(limit) = size {
                            let left = limit.saturating_sub(written);
                            data.truncate(left.min(data.len() as u64) as usize);
                            out.write_all(&data)?;
                            written += data.len() as u64;
                        } else {
                            pending = Some(data);
                        }
                        expected = expected.wrapping_add(1);
                        self.send(&[ACK]);
                        let shown = written + pending.as_ref().map(|p| p.len() as u64).unwrap_or(0);
                        self.report(
                            Progress { file_name: name.to_string(), file_index: index, file_count: count, transferred: shown, total: size.unwrap_or(0) },
                            false,
                        );
                    }
                    // Our ACK got lost: the sender repeated the previous block.
                    Some((num, _)) if num == expected.wrapping_sub(1) => self.send(&[ACK]),
                    Some((num, _)) => {
                        self.abort();
                        return Err(MError::Protocol(format!("数据块序号错误：期望 {}，收到 {}", expected, num)));
                    }
                    None => {
                        errors += 1;
                        if errors > MAX_RETRIES {
                            self.abort();
                            return Err(MError::Protocol("数据块校验连续失败".into()));
                        }
                        self.purge();
                        self.send(&[NAK]);
                    }
                },
                EOT => {
                    // YMODEM: NAK the first EOT, ACK the second (guards against a stray EOT).
                    if ymodem && !eot_seen {
                        eot_seen = true;
                        self.send(&[NAK]);
                    } else {
                        self.send(&[ACK]);
                        break;
                    }
                }
                CAN if self.is_cancel() => return Err(MError::RemoteCancelled),
                _ => {}
            }
            header = self.next(BLOCK_TIMEOUT)?;
        }
        if let Some(mut last) = pending.take() {
            while last.last() == Some(&SUB) {
                last.pop();
            }
            out.write_all(&last)?;
            written += last.len() as u64;
        }
        out.flush()?;
        self.report(
            Progress { file_name: name.to_string(), file_index: index, file_count: count, transferred: written, total: size.unwrap_or(written) },
            true,
        );
        Ok(written)
    }

    /// XMODEM: receive one file to `path` (`sx file` on the remote).
    pub fn receive_xmodem(&mut self, path: &Path) -> MResult<Vec<PathBuf>> {
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let (header, crc) = self.request_start()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut out = File::create(path)?;
        let res = self.receive_data(header, crc, &mut out, None, &name, 1, 1, false);
        if res.is_err() {
            drop(out);
            let _ = std::fs::remove_file(path);
        }
        res.map(|_| vec![path.to_path_buf()])
    }

    /// YMODEM batch: receive files into `dir` (`sb files...` on the remote).
    pub fn receive_ymodem(&mut self, dir: &Path) -> MResult<Vec<PathBuf>> {
        std::fs::create_dir_all(dir)?;
        let mut saved = Vec::new();
        loop {
            let (header, crc) = self.request_start()?;
            if header == EOT {
                self.send(&[ACK]);
                continue;
            }
            let Some((num, info)) = self.read_block(header, crc)? else {
                self.purge();
                self.send(&[NAK]);
                continue;
            };
            if num != 0 {
                self.abort();
                return Err(MError::Protocol("缺少 YMODEM 文件头（对方可能在用 XMODEM 发送）".into()));
            }
            // Empty file name ends the batch.
            if info.first().copied().unwrap_or(0) == 0 {
                self.send(&[ACK]);
                return Ok(saved);
            }
            let name = file_name_of(&info);
            let size = file_size_of(&info);
            let path = unique_path(dir, &name);
            let mut out = File::create(&path)?;
            self.send(&[ACK]);
            self.send(&[CRC]);
            let first = loop {
                match self.next(BLOCK_TIMEOUT)? {
                    b @ (SOH | STX | EOT) => break b,
                    CAN if self.is_cancel() => return Err(MError::RemoteCancelled),
                    _ => {}
                }
            };
            // A size of 0 in the header can also mean "unknown": then keep what arrives.
            let limit = if size > 0 { Some(size) } else { None };
            let res = self.receive_data(first, true, &mut out, limit, &name, saved.len() + 1, 0, true);
            drop(out);
            match res {
                Ok(_) => saved.push(path),
                Err(e) => {
                    let _ = std::fs::remove_file(&path);
                    return Err(e);
                }
            }
        }
    }

    pub fn run(&mut self, protocol: Protocol, send: bool, files: &[PathBuf], target: &Path) -> MResult<Vec<PathBuf>> {
        match (protocol, send) {
            (Protocol::Xmodem, true) => {
                let file = files.first().ok_or_else(|| MError::Protocol("没有要发送的文件".into()))?;
                self.send_xmodem(file).map(|_| vec![file.clone()])
            }
            (Protocol::Ymodem, true) => self.send_ymodem(files).map(|_| files.to_vec()),
            (Protocol::Xmodem, false) => self.receive_xmodem(target),
            (Protocol::Ymodem, false) => self.receive_ymodem(target),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn pair(packet: usize) -> (ModemTransfer, ModemTransfer) {
        let (a_tx, a_rx) = mpsc::channel::<Vec<u8>>();
        let (b_tx, b_rx) = mpsc::channel::<Vec<u8>>();
        let sender = ModemTransfer::new(
            a_rx,
            Vec::new(),
            Box::new(move |b: &[u8]| {
                let _ = b_tx.send(b.to_vec());
            }),
            Arc::new(AtomicBool::new(false)),
            Box::new(|_| {}),
            packet,
        );
        let receiver = ModemTransfer::new(
            b_rx,
            // Shell noise before the transfer starts must be ignored.
            b"$ sx Config.txt\r\nSending Config.txt, 3 blocks: Give your local XMODEM receive command now.\r\n".to_vec(),
            Box::new(move |b: &[u8]| {
                let _ = a_tx.send(b.to_vec());
            }),
            Arc::new(AtomicBool::new(false)),
            Box::new(|_| {}),
            packet,
        );
        (sender, receiver)
    }

    fn payload(n: usize) -> Vec<u8> {
        (0..n).map(|i| (i * 31 % 251) as u8).collect()
    }

    #[test]
    fn test_crc16_xmodem() {
        assert_eq!(crc16(b"123456789"), 0x31C3);
        let p = ModemTransfer::packet(1, b"hi", 128, true, SUB);
        assert_eq!((p[0], p[1], p[2], p.len()), (SOH, 1, 254, 133));
    }

    #[test]
    fn test_xmodem_loopback() {
        let tmp = std::env::temp_dir().join(format!("wtn-xm-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let data = payload(1024 * 3 + 100);
        std::fs::write(tmp.join("a.bin"), &data).unwrap();
        for packet in [128, 1024] {
            let (mut s, mut r) = pair(packet);
            let dst = tmp.join(format!("out-{}.bin", packet));
            let dst2 = dst.clone();
            let recv = std::thread::spawn(move || r.receive_xmodem(&dst2).map_err(|e| e.to_string()));
            s.send_xmodem(&tmp.join("a.bin")).expect("send");
            recv.join().unwrap().expect("receive");
            assert_eq!(std::fs::read(&dst).unwrap(), data);
        }
        let _ = std::fs::remove_dir_all(tmp);
    }

    #[test]
    fn test_ymodem_loopback() {
        let tmp = std::env::temp_dir().join(format!("wtn-ym-{}", uuid::Uuid::new_v4()));
        let src = tmp.join("src");
        let dst = tmp.join("dst");
        std::fs::create_dir_all(&src).unwrap();
        // Ends in SUB bytes: YMODEM keeps them thanks to the size in the header.
        let mut a = payload(5000);
        a.extend_from_slice(&[SUB, SUB]);
        std::fs::write(src.join("a.bin"), &a).unwrap();
        std::fs::write(src.join("b.txt"), b"hello").unwrap();
        let (mut s, mut r) = pair(1024);
        let dst2 = dst.clone();
        let recv = std::thread::spawn(move || r.receive_ymodem(&dst2).map_err(|e| e.to_string()));
        s.send_ymodem(&[src.join("a.bin"), src.join("b.txt")]).expect("send");
        let saved = recv.join().unwrap().expect("receive");
        assert_eq!(saved.len(), 2);
        assert_eq!(std::fs::read(dst.join("a.bin")).unwrap(), a);
        assert_eq!(std::fs::read(dst.join("b.txt")).unwrap(), b"hello");
        let _ = std::fs::remove_dir_all(tmp);
    }
}
