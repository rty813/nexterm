//! Terminal output to the webview: one binary channel per pane, with flow control.
//!
//! Bytes go out as raw `ArrayBuffer`s (no base64 / JSON), only to the window that shows
//! the pane. The webview acknowledges what xterm.js has parsed; while it is behind,
//! new output is merged into one pending buffer (so a flood becomes a few large
//! messages instead of thousands of 8 KB ones), and once that buffer is full the
//! connection's reader waits, which pushes back on the remote program like a real tty.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use tauri::ipc::{Channel, InvokeResponseBody};

/// Bytes sent to the webview and not yet acknowledged; beyond this, output waits in `pending`.
const WINDOW: usize = 512 * 1024;
/// The connection's reader waits while this much output is waiting to be sent.
const PENDING_LIMIT: usize = 1024 * 1024;
/// Kept for a pane with no window attached (a tab moving between windows); older bytes drop.
const ORPHAN_LIMIT: usize = 8 * 1024 * 1024;
/// A webview that stops acknowledging (reloaded, throttled while minimized) must not stall
/// the connection: after this long without progress, forget what it owes and send on.
const STALL_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Default)]
struct State {
    channel: Option<(u64, Channel<InvokeResponseBody>)>,
    pending: Vec<u8>,
    in_flight: usize,
}

#[derive(Default)]
struct Stream {
    state: Mutex<State>,
    progress: Condvar,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn streams() -> &'static Mutex<HashMap<String, Arc<Stream>>> {
    static STREAMS: OnceLock<Mutex<HashMap<String, Arc<Stream>>>> = OnceLock::new();
    STREAMS.get_or_init(Default::default)
}

fn stream(instance_id: &str) -> Arc<Stream> {
    Arc::clone(lock(streams()).entry(instance_id.to_string()).or_default())
}

/// Send what is pending if the webview has room for it.
fn flush(st: &mut State) {
    if st.pending.is_empty() || st.in_flight >= WINDOW {
        return;
    }
    let Some((_, channel)) = &st.channel else { return };
    let bytes = std::mem::take(&mut st.pending);
    let len = bytes.len();
    if channel.send(InvokeResponseBody::Raw(bytes)).is_ok() {
        st.in_flight += len;
    } else {
        // The webview is gone; keep nothing for it.
        st.channel = None;
        st.in_flight = 0;
    }
}

/// Run a blocking wait without starving the async runtime (SSH / Telnet / TCP readers
/// call in from Tokio tasks; local shells and serial ports from plain threads).
fn blocking<R>(f: impl FnOnce() -> R) -> R {
    match tokio::runtime::Handle::try_current() {
        Ok(h) if h.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread => {
            tokio::task::block_in_place(f)
        }
        _ => f(),
    }
}

/// Queue output of a pane. Blocks while the webview is far behind.
pub fn push(instance_id: &str, data: &[u8]) {
    if data.is_empty() {
        return;
    }
    let s = stream(instance_id);
    let mut st = lock(&s.state);
    if st.pending.len() >= PENDING_LIMIT {
        drop(st);
        st = blocking(|| {
            let deadline = Instant::now() + STALL_TIMEOUT;
            let mut st = lock(&s.state);
            while st.pending.len() >= PENDING_LIMIT {
                let now = Instant::now();
                if now >= deadline {
                    st.in_flight = 0;
                    flush(&mut st);
                    break;
                }
                st = s.progress.wait_timeout(st, deadline - now).unwrap_or_else(|e| e.into_inner()).0;
            }
            st
        });
    }
    st.pending.extend_from_slice(data);
    if st.channel.is_none() && st.pending.len() > ORPHAN_LIMIT {
        let excess = st.pending.len() - ORPHAN_LIMIT;
        st.pending.drain(..excess);
    }
    flush(&mut st);
}

/// Attach the pane's output to a channel of the window showing it. Returns a token for
/// `unsubscribe`, so a late unsubscribe from the previous window does not detach the new one.
pub fn subscribe(instance_id: &str, channel: Channel<InvokeResponseBody>) -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let token = NEXT.fetch_add(1, Ordering::Relaxed);
    let s = stream(instance_id);
    let mut st = lock(&s.state);
    st.channel = Some((token, channel));
    st.in_flight = 0;
    flush(&mut st);
    s.progress.notify_all();
    token
}

/// `live`: the pane's connection is still open (its tab is moving to another window),
/// so output keeps collecting for the window that picks it up.
pub fn unsubscribe(instance_id: &str, token: u64, live: bool) {
    let mut map = lock(streams());
    let Some(s) = map.get(instance_id).cloned() else { return };
    let mut st = lock(&s.state);
    if st.channel.as_ref().map(|(t, _)| *t) != Some(token) {
        return;
    }
    st.channel = None;
    st.in_flight = 0;
    if !live || st.pending.is_empty() {
        map.remove(instance_id);
    }
    s.progress.notify_all();
}

/// The pane's connection is closed: drop its stream unless a window still shows it.
pub fn forget_detached(instance_id: &str) {
    let mut map = lock(streams());
    let detached = map.get(instance_id).is_some_and(|s| lock(&s.state).channel.is_none());
    if detached {
        map.remove(instance_id);
    }
}

/// The webview has parsed `bytes` more bytes of this pane's output.
pub fn ack(instance_id: &str, bytes: usize) {
    let Some(s) = lock(streams()).get(instance_id).cloned() else { return };
    let mut st = lock(&s.state);
    st.in_flight = st.in_flight.saturating_sub(bytes);
    flush(&mut st);
    s.progress.notify_all();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn channel() -> (Channel<InvokeResponseBody>, mpsc::Receiver<usize>) {
        let (tx, rx) = mpsc::channel();
        let ch = Channel::new(move |body| {
            if let InvokeResponseBody::Raw(b) = body {
                let _ = tx.send(b.len());
            }
            Ok(())
        });
        (ch, rx)
    }

    #[test]
    fn output_before_subscribe_is_kept() {
        push("t-early", b"hello");
        let (ch, rx) = channel();
        subscribe("t-early", ch);
        assert_eq!(rx.try_recv(), Ok(5));
    }

    #[test]
    fn merges_while_behind_and_streams_on_ack() {
        let (ch, rx) = channel();
        subscribe("t-flow", ch);
        // Fill the window, then everything else merges into one pending message.
        push("t-flow", &vec![b'a'; WINDOW]);
        for _ in 0..100 {
            push("t-flow", &[b'b'; 1000]);
        }
        assert_eq!(rx.try_recv(), Ok(WINDOW));
        assert!(rx.try_recv().is_err());
        ack("t-flow", WINDOW);
        assert_eq!(rx.try_recv(), Ok(100_000));
    }

    #[test]
    fn reader_waits_until_acked() {
        let (ch, rx) = channel();
        subscribe("t-block", ch);
        push("t-block", &vec![0; WINDOW]);
        push("t-block", &vec![0; PENDING_LIMIT]);
        let started = Instant::now();
        let writer = std::thread::spawn(|| push("t-block", b"x"));
        std::thread::sleep(Duration::from_millis(100));
        assert!(!writer.is_finished(), "push must wait while the webview is behind");
        ack("t-block", WINDOW);
        writer.join().unwrap();
        assert!(started.elapsed() < STALL_TIMEOUT);
        assert_eq!(rx.try_recv(), Ok(WINDOW));
        assert_eq!(rx.try_recv(), Ok(PENDING_LIMIT));
    }

    #[test]
    fn stalled_webview_does_not_block_forever() {
        let (ch, _rx) = channel();
        subscribe("t-stall", ch);
        push("t-stall", &vec![0; WINDOW]);
        push("t-stall", &vec![0; PENDING_LIMIT]);
        let started = Instant::now();
        push("t-stall", b"x");
        assert!(started.elapsed() >= STALL_TIMEOUT);
    }
}
