//! Remote desktop picture: an RGBA framebuffer, its dirty region, and the frames sent to
//! the pane's canvas.
//!
//! Frames go out on a per-pane `tauri::ipc::Channel` as raw bytes (little endian):
//!
//! | type | layout                                                                     |
//! |------|----------------------------------------------------------------------------|
//! | 1    | resize: `u16 width, u16 height`                                            |
//! | 2    | batch: `u32 seq, u16 count`, then per rect `u16 x, y, w, h` + `w*h*4` RGBA |
//! | 3    | cursor: `u16 hot_x, hot_y, w, h` + `w*h*4` RGBA (straight alpha)           |
//! | 4    | cursor hidden                                                              |
//! | 5    | cursor default (system arrow)                                              |
//!
//! Flow control: the pane acknowledges each batch's `seq` once it has drawn it. While
//! [`WINDOW`] batches are unacknowledged nothing more is sent; updates only grow the dirty
//! region, and the next batch carries the latest pixels of that whole region. The picture
//! is never lost and nothing piles up, without any timer on the page side (a minimized
//! WebView2 throttles those).

use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const MSG_RESIZE: u8 = 1;
pub const MSG_BATCH: u8 = 2;
pub const MSG_CURSOR: u8 = 3;
pub const MSG_CURSOR_HIDDEN: u8 = 4;
pub const MSG_CURSOR_DEFAULT: u8 = 5;

/// Batches in flight before updates are held back.
pub const WINDOW: u32 = 2;
/// An unanswered batch older than this is taken as lost (the page reloaded).
const STALL: Duration = Duration::from_secs(2);
/// More separate rectangles than this collapse into their bounding box.
const MAX_RECTS: usize = 24;
/// Largest desktop accepted (RDP and VNC both stop at 8192).
pub const MAX_SIDE: u32 = 8192;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

impl Rect {
    pub fn new(x: u32, y: u32, w: u32, h: u32) -> Self {
        Self { x, y, w, h }
    }

    fn right(&self) -> u32 {
        self.x + self.w
    }

    fn bottom(&self) -> u32 {
        self.y + self.h
    }

    pub fn is_empty(&self) -> bool {
        self.w == 0 || self.h == 0
    }

    /// Overlapping or sharing an edge.
    fn touches(&self, o: &Rect) -> bool {
        self.x <= o.right() && o.x <= self.right() && self.y <= o.bottom() && o.y <= self.bottom()
    }

    fn union(&self, o: &Rect) -> Rect {
        let x = self.x.min(o.x);
        let y = self.y.min(o.y);
        Rect::new(x, y, self.right().max(o.right()) - x, self.bottom().max(o.bottom()) - y)
    }

    /// Clipped to a `width` x `height` surface.
    pub fn clip(&self, width: u32, height: u32) -> Rect {
        let x = self.x.min(width);
        let y = self.y.min(height);
        Rect::new(x, y, self.right().min(width) - x, self.bottom().min(height) - y)
    }

    pub fn area(&self) -> u64 {
        u64::from(self.w) * u64::from(self.h)
    }
}

/// Changed parts of the framebuffer not yet sent: touching rectangles are merged.
#[derive(Debug, Default, Clone)]
pub struct Region {
    rects: Vec<Rect>,
}

impl Region {
    pub fn add(&mut self, rect: Rect) {
        if rect.is_empty() {
            return;
        }
        let mut rect = rect;
        while let Some(i) = self.rects.iter().position(|r| r.touches(&rect)) {
            rect = rect.union(&self.rects.swap_remove(i));
        }
        self.rects.push(rect);
        if self.rects.len() > MAX_RECTS {
            let all = self.rects.iter().skip(1).fold(self.rects[0], |acc, r| acc.union(r));
            self.rects = vec![all];
        }
    }

    pub fn is_empty(&self) -> bool {
        self.rects.is_empty()
    }

    pub fn clear(&mut self) {
        self.rects.clear();
    }

    pub fn take(&mut self) -> Vec<Rect> {
        std::mem::take(&mut self.rects)
    }

    pub fn rects(&self) -> &[Rect] {
        &self.rects
    }
}

/// RGBA pixels, 4 bytes each, rows packed.
#[derive(Debug, Clone)]
pub struct Framebuffer {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

impl Framebuffer {
    pub fn new(width: u32, height: u32) -> Self {
        let (width, height) = (width.min(MAX_SIDE), height.min(MAX_SIDE));
        // Opaque black until the server paints.
        let mut data = vec![0u8; width as usize * height as usize * 4];
        for px in data.chunks_exact_mut(4) {
            px[3] = 0xFF;
        }
        Self { width, height, data }
    }

    /// Copy `rect` (framebuffer coordinates) from `src`, whose pixel (0, 0) lands on
    /// (`src_x`, `src_y`) of the framebuffer and whose rows are `src_stride` bytes. Alpha is
    /// forced opaque (servers leave it 0). Returns the clipped rectangle written.
    pub fn put(&mut self, rect: Rect, src: &[u8], src_stride: usize, src_x: u32, src_y: u32) -> Rect {
        let rect = rect.clip(self.width, self.height);
        if rect.is_empty() || rect.x < src_x || rect.y < src_y {
            return Rect::new(0, 0, 0, 0);
        }
        let row_bytes = rect.w as usize * 4;
        for row in 0..rect.h {
            let sy = (rect.y - src_y + row) as usize;
            let sx = (rect.x - src_x) as usize * 4;
            let start = sy * src_stride + sx;
            let Some(line) = src.get(start..start + row_bytes) else {
                break;
            };
            let dst = ((rect.y + row) as usize * self.width as usize + rect.x as usize) * 4;
            let out = &mut self.data[dst..dst + row_bytes];
            out.copy_from_slice(line);
            for px in out.chunks_exact_mut(4) {
                px[3] = 0xFF;
            }
        }
        rect
    }

    /// VNC CopyRect: move `src` to (`dst_x`, `dst_y`) inside the framebuffer.
    pub fn copy_within(&mut self, src: Rect, dst_x: u32, dst_y: u32) -> Rect {
        let src = src.clip(self.width, self.height);
        let dst = Rect::new(dst_x, dst_y, src.w, src.h).clip(self.width, self.height);
        let (w, h) = (dst.w.min(src.w), dst.h.min(src.h));
        if w == 0 || h == 0 {
            return Rect::new(0, 0, 0, 0);
        }
        let stride = self.width as usize * 4;
        let row_bytes = w as usize * 4;
        // Copy rows in the order that never overwrites unread source rows.
        let rows: Box<dyn Iterator<Item = u32>> = if dst.y > src.y { Box::new((0..h).rev()) } else { Box::new(0..h) };
        for row in rows {
            let s = (src.y + row) as usize * stride + src.x as usize * 4;
            let d = (dst.y + row) as usize * stride + dst.x as usize * 4;
            self.data.copy_within(s..s + row_bytes, d);
        }
        Rect::new(dst.x, dst.y, w, h)
    }

    /// Append `rect`'s pixels to `out`.
    fn extract(&self, rect: Rect, out: &mut Vec<u8>) {
        let row_bytes = rect.w as usize * 4;
        for row in rect.y..rect.y + rect.h {
            let start = (row as usize * self.width as usize + rect.x as usize) * 4;
            out.extend_from_slice(&self.data[start..start + row_bytes]);
        }
    }
}

pub fn encode_resize(width: u32, height: u32) -> Vec<u8> {
    let mut out = vec![MSG_RESIZE];
    out.extend_from_slice(&(width as u16).to_le_bytes());
    out.extend_from_slice(&(height as u16).to_le_bytes());
    out
}

pub fn encode_batch(fb: &Framebuffer, seq: u32, rects: &[Rect]) -> Vec<u8> {
    let pixels: u64 = rects.iter().map(Rect::area).sum();
    let mut out = Vec::with_capacity(7 + rects.len() * 8 + pixels as usize * 4);
    out.push(MSG_BATCH);
    out.extend_from_slice(&seq.to_le_bytes());
    out.extend_from_slice(&(rects.len() as u16).to_le_bytes());
    for r in rects {
        for v in [r.x, r.y, r.w, r.h] {
            out.extend_from_slice(&(v as u16).to_le_bytes());
        }
        fb.extract(*r, &mut out);
    }
    out
}

pub fn encode_cursor(hot_x: u32, hot_y: u32, width: u32, height: u32, rgba: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(9 + rgba.len());
    out.push(MSG_CURSOR);
    for v in [hot_x, hot_y, width, height] {
        out.extend_from_slice(&(v as u16).to_le_bytes());
    }
    out.extend_from_slice(rgba);
    out
}

/// Where frames go (the pane's channel; a vector in tests). `false` = the pane is gone.
pub trait FrameSink: Send + Sync {
    fn send(&self, frame: Vec<u8>) -> bool;
}

struct OutState {
    fb: Framebuffer,
    dirty: Region,
    sent: u32,
    acked: u32,
    last_send: Instant,
}

/// The framebuffer shared by a session's protocol task (writes) and the pane's
/// acknowledgements (which release the next batch).
pub struct FrameOut {
    state: Mutex<OutState>,
    sink: Box<dyn FrameSink>,
}

impl FrameOut {
    pub fn new(sink: Box<dyn FrameSink>) -> Self {
        Self {
            state: Mutex::new(OutState {
                fb: Framebuffer::new(0, 0),
                dirty: Region::default(),
                sent: 0,
                acked: 0,
                last_send: Instant::now(),
            }),
            sink,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, OutState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn size(&self) -> (u32, u32) {
        let st = self.lock();
        (st.fb.width, st.fb.height)
    }

    /// New desktop size: a black framebuffer; the server repaints it.
    pub fn resize(&self, width: u32, height: u32) {
        let mut st = self.lock();
        st.fb = Framebuffer::new(width, height);
        st.dirty.clear();
        let (w, h) = (st.fb.width, st.fb.height);
        self.sink.send(encode_resize(w, h));
        st.dirty.add(Rect::new(0, 0, w, h));
        self.flush_locked(&mut st);
    }

    /// Pixels changed (see [`Framebuffer::put`]); sent by the next [`FrameOut::flush`].
    pub fn put(&self, rect: Rect, src: &[u8], src_stride: usize, src_x: u32, src_y: u32) {
        let mut st = self.lock();
        let written = st.fb.put(rect, src, src_stride, src_x, src_y);
        st.dirty.add(written);
    }

    pub fn copy_within(&self, src: Rect, dst_x: u32, dst_y: u32) {
        let mut st = self.lock();
        let written = st.fb.copy_within(src, dst_x, dst_y);
        st.dirty.add(written);
    }

    /// Send the dirty region now unless the pane is behind.
    pub fn flush(&self) {
        let mut st = self.lock();
        self.flush_locked(&mut st);
    }

    /// The pane drew batch `seq`.
    pub fn ack(&self, seq: u32) {
        let mut st = self.lock();
        // Wrapping: seq only grows, compare by distance.
        if seq.wrapping_sub(st.acked) <= st.sent.wrapping_sub(st.acked) {
            st.acked = seq;
        }
        self.flush_locked(&mut st);
    }

    /// Batches sent and not yet drawn.
    pub fn in_flight(&self) -> u32 {
        let st = self.lock();
        st.sent.wrapping_sub(st.acked)
    }

    fn flush_locked(&self, st: &mut OutState) {
        if st.dirty.is_empty() || st.fb.width == 0 || st.fb.height == 0 {
            return;
        }
        if st.sent.wrapping_sub(st.acked) >= WINDOW {
            if st.last_send.elapsed() < STALL {
                return;
            }
            st.acked = st.sent;
        }
        let rects: Vec<Rect> = st
            .dirty
            .take()
            .into_iter()
            .map(|r| r.clip(st.fb.width, st.fb.height))
            .filter(|r| !r.is_empty())
            .collect();
        if rects.is_empty() {
            return;
        }
        st.sent = st.sent.wrapping_add(1);
        st.last_send = Instant::now();
        self.sink.send(encode_batch(&st.fb, st.sent, &rects));
    }

    pub fn cursor(&self, hot_x: u32, hot_y: u32, width: u32, height: u32, rgba: &[u8]) {
        if width == 0 || height == 0 || rgba.len() < width as usize * height as usize * 4 {
            self.sink.send(vec![MSG_CURSOR_HIDDEN]);
            return;
        }
        self.sink.send(encode_cursor(hot_x, hot_y, width, height, &rgba[..width as usize * height as usize * 4]));
    }

    pub fn cursor_hidden(&self) {
        self.sink.send(vec![MSG_CURSOR_HIDDEN]);
    }

    pub fn cursor_default(&self) {
        self.sink.send(vec![MSG_CURSOR_DEFAULT]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[derive(Default, Clone)]
    struct Collect(Arc<Mutex<Vec<Vec<u8>>>>);

    impl FrameSink for Collect {
        fn send(&self, frame: Vec<u8>) -> bool {
            self.0.lock().unwrap().push(frame);
            true
        }
    }

    impl Collect {
        fn kinds(&self) -> Vec<u8> {
            self.0.lock().unwrap().iter().map(|f| f[0]).collect()
        }
    }

    #[test]
    fn region_merges_touching_rects_and_keeps_apart_ones() {
        let mut r = Region::default();
        r.add(Rect::new(0, 0, 10, 10));
        r.add(Rect::new(10, 0, 10, 10)); // shares an edge
        r.add(Rect::new(100, 100, 5, 5));
        assert_eq!(r.rects().len(), 2);
        assert!(r.rects().contains(&Rect::new(0, 0, 20, 10)));
        // A rect bridging both merges everything.
        r.add(Rect::new(15, 5, 90, 96));
        assert_eq!(r.rects(), &[Rect::new(0, 0, 105, 105)]);
        r.add(Rect::new(1, 1, 0, 5));
        assert_eq!(r.rects().len(), 1, "empty rects are ignored");
    }

    #[test]
    fn region_collapses_many_rects_into_bounding_box() {
        let mut r = Region::default();
        for i in 0..=MAX_RECTS as u32 {
            r.add(Rect::new(i * 10, i * 10, 2, 2));
        }
        assert_eq!(r.rects(), &[Rect::new(0, 0, MAX_RECTS as u32 * 10 + 2, MAX_RECTS as u32 * 10 + 2)]);
    }

    #[test]
    fn put_copies_rows_clips_and_forces_alpha() {
        let mut fb = Framebuffer::new(4, 3);
        // A 2x2 source placed at (3, 2): only its top-left pixel fits.
        let src = [1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0, 10, 11, 12, 0];
        let written = fb.put(Rect::new(3, 2, 2, 2), &src, 8, 3, 2);
        assert_eq!(written, Rect::new(3, 2, 1, 1));
        let at = (2 * 4 + 3) * 4;
        assert_eq!(&fb.data[at..at + 4], &[1, 2, 3, 255]);
        // Source given as a whole frame (stride of the full width).
        let full: Vec<u8> = (0..4 * 3 * 4).map(|i| i as u8).collect();
        fb.put(Rect::new(1, 1, 2, 1), &full, 16, 0, 0);
        let at = (4 + 1) * 4;
        assert_eq!(&fb.data[at..at + 8], &[20, 21, 22, 255, 24, 25, 26, 255]);
    }

    #[test]
    fn copy_within_handles_overlap_downwards() {
        let mut fb = Framebuffer::new(1, 4);
        for y in 0..4u8 {
            fb.data[y as usize * 4] = y + 1;
        }
        fb.copy_within(Rect::new(0, 0, 1, 3), 0, 1);
        let col: Vec<u8> = (0..4).map(|y| fb.data[y * 4]).collect();
        assert_eq!(col, vec![1, 1, 2, 3]);
        fb.copy_within(Rect::new(0, 1, 1, 3), 0, 0);
        let col: Vec<u8> = (0..4).map(|y| fb.data[y * 4]).collect();
        assert_eq!(col, vec![1, 2, 3, 3]);
    }

    #[test]
    fn batch_encoding_layout() {
        let mut fb = Framebuffer::new(2, 2);
        fb.put(Rect::new(0, 0, 2, 2), &[9; 16], 8, 0, 0);
        let msg = encode_batch(&fb, 7, &[Rect::new(1, 0, 1, 2)]);
        assert_eq!(msg[0], MSG_BATCH);
        assert_eq!(u32::from_le_bytes(msg[1..5].try_into().unwrap()), 7);
        assert_eq!(u16::from_le_bytes([msg[5], msg[6]]), 1);
        assert_eq!(&msg[7..15], &[1, 0, 0, 0, 1, 0, 2, 0]);
        assert_eq!(&msg[15..], &[9, 9, 9, 255, 9, 9, 9, 255]);
    }

    #[test]
    fn flow_control_holds_updates_until_acked() {
        let sink = Collect::default();
        let out = FrameOut::new(Box::new(sink.clone()));
        out.resize(8, 8); // resize + full batch #1
        assert_eq!(sink.kinds(), vec![MSG_RESIZE, MSG_BATCH]);
        let px = [1u8; 4];
        out.put(Rect::new(0, 0, 1, 1), &px, 4, 0, 0);
        out.flush(); // batch #2: window now full
        out.put(Rect::new(5, 5, 1, 1), &px, 4, 5, 5);
        out.flush();
        out.put(Rect::new(6, 5, 1, 1), &px, 4, 6, 5);
        out.flush();
        assert_eq!(sink.kinds().len(), 3, "held back while two batches are in flight");
        assert_eq!(out.in_flight(), 2);
        out.ack(1); // releases one merged batch with both pending pixels
        let frames = sink.0.lock().unwrap().clone();
        assert_eq!(frames.len(), 4);
        let last = &frames[3];
        assert_eq!(u16::from_le_bytes([last[5], last[6]]), 1, "the two pixels were merged");
        assert_eq!(&last[7..15], &[5, 0, 5, 0, 2, 0, 1, 0]);
        // A stale or bogus ack changes nothing.
        out.ack(1);
        out.ack(99);
        assert_eq!(out.in_flight(), 2);
    }
}
