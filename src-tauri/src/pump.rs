//! A network connection's output, delivered on a thread of its own.
//!
//! The SSH / Telnet / TCP loops read output and send the user's keys from one task. When
//! output was handed to the sink right in that loop, a webview that fell behind blocked
//! the loop (`output::push` waits for acknowledgements), and a Ctrl+C typed during a flood
//! sat in the queue until the screen caught up. Now the loop only queues output here; when
//! the queue is full it stops reading the connection (the remote is held back as before)
//! but keeps sending keys.

use std::collections::VecDeque;
use std::sync::Arc;

use tokio::sync::mpsc::{self, error::TrySendError};

use crate::manager::TerminalSink;

/// Messages queued for the delivery thread; past this the loop holds output and stops reading.
const QUEUE: usize = 8;

enum Out {
    Data(Vec<u8>),
    State(String, Option<String>),
}

pub struct OutputPump {
    tx: Option<mpsc::Sender<Out>>,
    /// Waiting for room in the queue, in order.
    held: VecDeque<Out>,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl OutputPump {
    pub fn new(sink: Arc<dyn TerminalSink>, instance_id: String) -> Self {
        let (tx, mut rx) = mpsc::channel::<Out>(QUEUE);
        let worker = std::thread::Builder::new()
            .name(format!("output-{instance_id}"))
            .spawn(move || {
                while let Some(out) = rx.blocking_recv() {
                    match out {
                        Out::Data(d) => sink.emit_output(&instance_id, &d),
                        Out::State(status, message) => sink.emit_state(&instance_id, &status, message),
                    }
                }
            })
            .expect("spawn output thread");
        OutputPump { tx: Some(tx), held: VecDeque::new(), worker: Some(worker) }
    }

    pub fn output(&mut self, data: &[u8]) {
        if !data.is_empty() {
            self.queue(Out::Data(data.to_vec()));
        }
    }

    /// A status change, delivered after the output queued before it.
    pub fn state(&mut self, status: &str, message: Option<String>) {
        self.queue(Out::State(status.to_string(), message));
    }

    fn queue(&mut self, out: Out) {
        if self.held.is_empty() {
            let Some(tx) = &self.tx else { return };
            match tx.try_send(out) {
                Ok(()) | Err(TrySendError::Closed(_)) => return,
                Err(TrySendError::Full(out)) => {
                    self.held.push_back(out);
                    return;
                }
            }
        }
        if let (Out::Data(d), Some(Out::Data(last))) = (&out, self.held.back_mut()) {
            last.extend_from_slice(d);
            return;
        }
        self.held.push_back(out);
    }

    /// Output is waiting for room: do not read the connection until `flush` made some.
    pub fn is_behind(&self) -> bool {
        !self.held.is_empty()
    }

    /// Hands over what is held as room frees up. Cancel safe: in a `select!` branch, what
    /// was not sent yet stays held.
    pub async fn flush(&mut self) {
        let Some(tx) = self.tx.clone() else {
            self.held.clear();
            return;
        };
        while !self.held.is_empty() {
            match tx.reserve().await {
                Ok(permit) => permit.send(self.held.pop_front().expect("held")),
                Err(_) => self.held.clear(),
            }
        }
    }

    /// Delivers everything queued, then stops the thread.
    pub async fn finish(mut self) {
        self.flush().await;
        self.tx = None;
        if let Some(worker) = self.worker.take() {
            let _ = tokio::task::spawn_blocking(move || worker.join()).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    /// A sink that blocks on output while `gate` is closed (a webview that fell behind).
    struct Slow {
        gate: Arc<(Mutex<bool>, std::sync::Condvar)>,
        log: Mutex<Vec<String>>,
    }

    impl TerminalSink for Slow {
        fn emit_output(&self, _: &str, data: &[u8]) {
            let (open, cv) = &*self.gate;
            let mut g = open.lock().unwrap();
            while !*g {
                g = cv.wait(g).unwrap();
            }
            self.log.lock().unwrap().push(String::from_utf8_lossy(data).into_owned());
        }
        fn emit_state(&self, _: &str, status: &str, _: Option<String>) {
            self.log.lock().unwrap().push(format!("<{status}>"));
        }
    }

    fn slow() -> Arc<Slow> {
        Arc::new(Slow { gate: Arc::new((Mutex::new(false), std::sync::Condvar::new())), log: Mutex::default() })
    }

    fn open(s: &Slow) {
        *s.gate.0.lock().unwrap() = true;
        s.gate.1.notify_all();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn queueing_never_waits_for_the_sink() {
        let sink = slow();
        let mut pump = OutputPump::new(sink.clone(), "p".into());
        let started = Instant::now();
        for i in 0..100 {
            pump.output(format!("{i},").as_bytes());
        }
        // The sink is stuck: the loop must still be free (to send keys), with output held.
        assert!(started.elapsed() < Duration::from_millis(200));
        assert!(pump.is_behind());
        pump.state("disconnected", None);
        open(&sink);
        pump.finish().await;
        let log = sink.log.lock().unwrap().clone();
        let text: String = log[..log.len() - 1].concat();
        assert_eq!(text, (0..100).map(|i| format!("{i},")).collect::<String>());
        assert_eq!(log.last().unwrap(), "<disconnected>");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn flush_is_cancel_safe() {
        let sink = slow();
        let mut pump = OutputPump::new(sink.clone(), "p".into());
        // Output and states alternate, so what is held does not merge into one message.
        let mut expected = Vec::new();
        for i in 0..50 {
            let c = ((b'a' + (i % 26) as u8) as char).to_string();
            pump.output(c.as_bytes());
            pump.state("s", None);
            expected.extend([c, "<s>".to_string()]);
        }
        // A select! where another branch wins: nothing held is lost.
        let _ = tokio::time::timeout(Duration::from_millis(50), pump.flush()).await;
        assert!(pump.is_behind());
        open(&sink);
        pump.flush().await;
        assert!(!pump.is_behind());
        pump.finish().await;
        assert_eq!(*sink.log.lock().unwrap(), expected);
    }
}
