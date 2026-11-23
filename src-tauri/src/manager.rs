use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Instant;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot};

use crate::anti_idle::{AntiIdle, PaneState};
use crate::charset::Codec;
use crate::hexdump::HexDump;
use crate::local_pty::spawn_local_pty;
use crate::models::{ProtocolType, SessionConfig, TerminalStatePayload};
use crate::serial_conn::spawn_serial_session;
use crate::session_log::SessionLog;
use crate::shell_integration::{Injector, Step};
use crate::term_capture::{Capture, CaptureMode, SharedCapture, ShellTracker};
use crate::ssh_conn::{spawn_ssh_session, SshLink};
use crate::tcp_conn::spawn_tcp_session;
use crate::telnet_conn::spawn_telnet_session;
use crate::xymodem::{MError, ModemTransfer, Protocol};
use crate::zmodem::{self, Detector, Direction, Transfer};

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Shown to the user when an SSH server's key is not (or no longer) in known_hosts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyPrompt {
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
    /// true: a different key is recorded for this host (possible man-in-the-middle).
    pub changed: bool,
    pub known_hosts: String,
    /// "ssh" (host key) or "rdp" (server TLS certificate, `desktop::certs`).
    pub kind: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostKeyDecision {
    Reject,
    AcceptOnce,
    AcceptAndSave,
}

/// A command to run on the SSH connection's own exec channel.
pub struct ExecRequest {
    pub command: String,
    pub reply: oneshot::Sender<Result<String, String>>,
}

/// A port forward running on an SSH connection, as shown in the forwarding panel.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatus {
    pub id: String,
    pub config: crate::models::TunnelConfig,
    /// Port actually bound (differs from the config when it asked for port 0).
    pub bound_port: u16,
    /// Connections open right now / since the forward started.
    pub active: usize,
    pub total: usize,
}

pub enum TunnelRequest {
    List(oneshot::Sender<Vec<TunnelStatus>>),
    Start(crate::models::TunnelConfig, oneshot::Sender<Result<Vec<TunnelStatus>, String>>),
    Stop(String, oneshot::Sender<Vec<TunnelStatus>>),
}

pub trait TerminalSink: Send + Sync {
    fn emit_output(&self, instance_id: &str, data: &[u8]);
    fn emit_state(&self, instance_id: &str, status: &str, message: Option<String>);

    /// Ask the user whether to trust an SSH host key. The default trusts it once.
    fn confirm_host_key(&self, _instance_id: &str, _prompt: HostKeyPrompt) -> oneshot::Receiver<HostKeyDecision> {
        let (tx, rx) = oneshot::channel();
        let _ = tx.send(HostKeyDecision::AcceptOnce);
        rx
    }

    /// Side-channel UI events (ZModem requests and progress).
    fn emit_event(&self, _name: &str, _payload: serde_json::Value) {}
}

fn pending_host_keys() -> &'static Mutex<HashMap<String, oneshot::Sender<HostKeyDecision>>> {
    static PENDING: OnceLock<Mutex<HashMap<String, oneshot::Sender<HostKeyDecision>>>> = OnceLock::new();
    PENDING.get_or_init(Default::default)
}

/// Deliver the desktop's answer to a `host-key-prompt` event.
pub fn resolve_host_key(request_id: &str, decision: HostKeyDecision) {
    answer_host_key(request_id, decision);
    crate::remote::host_key_done(request_id);
}

/// Deliver an answer (desktop or phone) to the waiting connection.
pub fn answer_host_key(request_id: &str, decision: HostKeyDecision) {
    if let Some(tx) = lock(pending_host_keys()).remove(request_id) {
        let _ = tx.send(decision);
    }
}

pub struct TauriSink {
    pub app: AppHandle,
}

impl TerminalSink for TauriSink {
    fn emit_output(&self, instance_id: &str, data: &[u8]) {
        crate::output::push(instance_id, data);
    }

    fn emit_state(&self, instance_id: &str, status: &str, message: Option<String>) {
        let payload = TerminalStatePayload {
            instance_id: instance_id.to_string(),
            status: status.to_string(),
            message,
        };
        let _ = self.app.emit("terminal-state", payload);
    }

    fn confirm_host_key(&self, instance_id: &str, prompt: HostKeyPrompt) -> oneshot::Receiver<HostKeyDecision> {
        let (tx, rx) = oneshot::channel();
        let request_id = uuid::Uuid::new_v4().to_string();
        lock(pending_host_keys()).insert(request_id.clone(), tx);
        crate::remote::host_key_prompt(instance_id, &request_id, &prompt);
        let mut payload = serde_json::to_value(&prompt).unwrap_or_default();
        payload["requestId"] = request_id.into();
        payload["instanceId"] = instance_id.into();
        let _ = self.app.emit("host-key-prompt", payload);
        rx
    }

    fn emit_event(&self, name: &str, payload: serde_json::Value) {
        let _ = self.app.emit(name, payload);
    }
}

pub enum ControlMsg {
    Write(Vec<u8>),
    Resize(u16, u16),
    Close,
}

#[derive(Clone)]
pub struct AsyncChannels {
    pub write_tx: mpsc::UnboundedSender<Vec<u8>>,
    pub resize_tx: mpsc::UnboundedSender<(u16, u16)>,
    pub close_tx: mpsc::UnboundedSender<()>,
    /// Only SSH connections can run side commands (tmux integration).
    pub exec_tx: Option<mpsc::UnboundedSender<ExecRequest>>,
    /// Only SSH connections can forward ports.
    pub tunnel_tx: Option<mpsc::UnboundedSender<TunnelRequest>>,
}

#[derive(Clone)]
pub enum RuntimeControl {
    Sync(std_mpsc::Sender<ControlMsg>),
    Async(AsyncChannels),
}

impl RuntimeControl {
    pub fn send_write(&self, data: &[u8]) {
        match self {
            Self::Sync(tx) => {
                let _ = tx.send(ControlMsg::Write(data.to_vec()));
            }
            Self::Async(ch) => {
                let _ = ch.write_tx.send(data.to_vec());
            }
        }
    }

    pub fn send_resize(&self, cols: u16, rows: u16) {
        match self {
            Self::Sync(tx) => {
                let _ = tx.send(ControlMsg::Resize(cols, rows));
            }
            Self::Async(ch) => {
                let _ = ch.resize_tx.send((cols, rows));
            }
        }
    }

    pub fn send_close(&self) {
        match self {
            Self::Sync(tx) => {
                let _ = tx.send(ControlMsg::Close);
            }
            Self::Async(ch) => {
                let _ = ch.close_tx.send(());
            }
        }
    }
}

type SharedLog = Arc<Mutex<Option<SessionLog>>>;

enum ZState {
    /// Watching terminal output for a ZRQINIT / ZRINIT.
    Idle(Detector),
    /// Transfer detected, waiting for the user to pick files / a folder.
    Pending { direction: Direction, buffered: Vec<u8> },
    /// Raw remote bytes feed the running transfer.
    Active { tx: std_mpsc::Sender<Vec<u8>>, cancel: Arc<AtomicBool> },
}

impl ZState {
    fn start_pending(
        &mut self,
        files: &[PathBuf],
        tx: std_mpsc::Sender<Vec<u8>>,
        cancel: Arc<AtomicBool>,
    ) -> Result<(Direction, Vec<u8>)> {
        let Self::Pending { direction, buffered } = self else {
            anyhow::bail!("没有等待开始的 ZModem 传输");
        };
        if *direction == Direction::Send && files.is_empty() {
            anyhow::bail!("请选择要发送的文件");
        }
        let pending = (*direction, std::mem::take(buffered));
        *self = Self::Active { tx, cancel };
        Ok(pending)
    }
}

/// Per-connection output path: drops output after disconnect, diverts ZModem
/// transfers, converts the remote charset to UTF-8, and writes the session log.
struct ScopedSink {
    inner: Arc<dyn TerminalSink>,
    cancelled: Arc<AtomicBool>,
    log: SharedLog,
    codec: Mutex<Codec>,
    zmodem: Mutex<ZState>,
    zmodem_conflict: Mutex<Option<(String, std_mpsc::Sender<zmodem::ConflictAnswer>)>>,
    zmodem_enabled: bool,
    /// Manual shell integration in progress: output held back until the script is loaded.
    inject: Mutex<Option<ManualInject>>,
    /// OSC 133 state and the MCP agent's output capture (see term_capture.rs).
    tracker: Mutex<ShellTracker>,
    /// Last status reported for the pane ("connecting", "connected", "disconnected" ...).
    status: Mutex<String>,
    /// The pane's full scrollback history (outlives this connection: see history.rs).
    history: Option<Arc<crate::history::Recorder>>,
    /// Binary data type (serial / raw TCP): output shown as a hex dump, no charset.
    binary: Option<Mutex<HexDump>>,
    /// Pane width, for the hex dump's bytes per row.
    cols: AtomicU16,
    /// Last time anything was sent to the remote (keys, paste, agent, anti-idle).
    last_input: Mutex<Instant>,
}

struct ManualInject {
    injector: Injector,
    done: Option<oneshot::Sender<InjectOutcome>>,
}

/// State observed on this connection; a nested shell can differ from an earlier shell.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellIntegrationStatus {
    pub detected: bool,
    pub loading: bool,
}

/// How a manual shell integration load ended.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum InjectOutcome {
    Loaded,
    /// The installer could not write the current user's scripts / startup files.
    Failed,
    /// Not bash, zsh or fish.
    Unsupported,
    /// No answer (no base64 / gunzip, not at a prompt, a program running ...).
    NoAnswer,
}

impl ScopedSink {
    fn ask_zmodem_conflict(
        &self, id: &str, path: &std::path::Path, suggested: &str, can_overwrite: bool, cancel: &AtomicBool,
    ) -> Result<zmodem::ConflictAnswer, zmodem::ZError> {
        let request_id = uuid::Uuid::new_v4().to_string();
        let (answer, receiver) = std_mpsc::channel();
        *lock(&self.zmodem_conflict) = Some((request_id.clone(), answer));
        self.inner.emit_event("zmodem-progress", serde_json::json!({
            "instanceId": id, "state": "conflict", "requestId": request_id, "path": path,
            "suggestedName": suggested, "canOverwrite": can_overwrite,
        }));
        let result = loop {
            if cancel.load(Ordering::Acquire) || self.cancelled.load(Ordering::Acquire) {
                break Err(zmodem::ZError::Cancelled);
            }
            if matches!(lock(&self.status).as_str(), "disconnected" | "error") {
                break Err(zmodem::ZError::Closed);
            }
            match receiver.recv_timeout(std::time::Duration::from_millis(200)) {
                Ok(answer) => break Ok(answer),
                Err(std_mpsc::RecvTimeoutError::Timeout) => continue,
                Err(std_mpsc::RecvTimeoutError::Disconnected) => break Err(zmodem::ZError::Closed),
            }
        };
        lock(&self.zmodem_conflict).take();
        result
    }

    fn emit_terminal(&self, instance_id: &str, data: &[u8]) {
        if data.is_empty() {
            return;
        }
        let decoded;
        let data = {
            let mut codec = lock(&self.codec);
            if codec.is_passthrough() {
                data
            } else {
                decoded = codec.decode(data);
                &decoded[..]
            }
        };
        self.emit_text(instance_id, data, data);
    }

    /// UTF-8 output to the pane; `log` is what the session log gets (they differ for
    /// the hex dump, whose partly filled row is redrawn on screen but logged once full).
    fn emit_text(&self, instance_id: &str, screen: &[u8], log: &[u8]) {
        if !log.is_empty() {
            if let Some(file) = lock(&self.log).as_mut() {
                file.write(log);
            }
        }
        if screen.is_empty() {
            return;
        }
        // The history can make this wait (its parser behind a flood); a reconnect meanwhile
        // cancels the wait, and this connection's output then goes nowhere.
        if let Some(history) = &self.history {
            if !history.feed_unless(screen, Some(&*self.cancelled)) {
                return;
            }
        }
        if self.cancelled.load(Ordering::Acquire) {
            return;
        }
        lock(&self.tracker).feed(screen, Instant::now());
        self.inner.emit_output(instance_id, screen);
    }

    fn transfer_busy(&self) -> bool {
        !matches!(*lock(&self.zmodem), ZState::Idle(_))
    }
}

impl ScopedSink {
    /// Drives a manual load: emits what the injector releases, reports the outcome.
    fn run_inject(sink: Arc<ScopedSink>, instance_id: String) {
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(30));
            let now = Instant::now();
            let (step, finished) = {
                let mut guard = lock(&sink.inject);
                let Some(m) = guard.as_mut() else { return };
                if m.injector.deadline().is_some_and(|d| now < d) {
                    continue;
                }
                let step = m.injector.tick(now);
                let finished = m.injector.is_done().then(|| guard.take()).flatten();
                (step, finished)
            };
            if let Step::Emit(bytes) = step {
                sink.deliver(&instance_id, &bytes);
            }
            if let Some(mut m) = finished {
                let outcome = if m.injector.loaded {
                    InjectOutcome::Loaded
                } else if m.injector.failed {
                    InjectOutcome::Failed
                } else if m.injector.unsupported {
                    InjectOutcome::Unsupported
                } else {
                    InjectOutcome::NoAnswer
                };
                if let Some(tx) = m.done.take() {
                    let _ = tx.send(outcome);
                }
                return;
            }
        });
    }
}

impl TerminalSink for ScopedSink {
    fn emit_output(&self, instance_id: &str, data: &[u8]) {
        if self.cancelled.load(Ordering::Acquire) {
            return;
        }
        let shown;
        let data = {
            let mut guard = lock(&self.inject);
            match guard.as_mut() {
                Some(m) => {
                    shown = m.injector.output(data, Instant::now());
                    &shown[..]
                }
                None => data,
            }
        };
        if !data.is_empty() {
            self.deliver(instance_id, data);
        }
    }

    fn emit_state(&self, instance_id: &str, status: &str, message: Option<String>) {
        if !self.cancelled.load(Ordering::Acquire) {
            *lock(&self.status) = status.to_string();
            self.inner.emit_state(instance_id, status, message);
        }
    }

    fn confirm_host_key(&self, instance_id: &str, prompt: HostKeyPrompt) -> oneshot::Receiver<HostKeyDecision> {
        self.inner.confirm_host_key(instance_id, prompt)
    }

    fn emit_event(&self, name: &str, payload: serde_json::Value) {
        self.inner.emit_event(name, payload)
    }
}

impl ScopedSink {
    /// Output past the manual-injection filter: ZModem detection, charset, log, pane.
    fn deliver(&self, instance_id: &str, data: &[u8]) {
        if self.cancelled.load(Ordering::Acquire) {
            return;
        }
        if let Some(dump) = &self.binary {
            let out = lock(dump).feed(data, self.cols.load(Ordering::Relaxed));
            self.emit_text(instance_id, &out.screen, &out.log);
            return;
        }
        if !self.zmodem_enabled {
            self.emit_terminal(instance_id, data);
            return;
        }
        let mut z = lock(&self.zmodem);
        match &mut *z {
            ZState::Idle(detector) => {
                let Some((offset, direction)) = detector.feed(data) else {
                    drop(z);
                    self.emit_terminal(instance_id, data);
                    return;
                };
                *z = ZState::Pending { direction, buffered: data[offset..].to_vec() };
                drop(z);
                self.emit_terminal(instance_id, &data[..offset]);
                self.inner.emit_event(
                    "zmodem-request",
                    serde_json::json!({
                        "instanceId": instance_id,
                        "direction": if direction == Direction::Receive { "receive" } else { "send" },
                    }),
                );
            }
            ZState::Pending { buffered, .. } => {
                if buffered.len() < 4 * 1024 * 1024 {
                    buffered.extend_from_slice(data);
                }
            }
            ZState::Active { tx, .. } => {
                let _ = tx.send(data.to_vec());
            }
        }
    }
}

/// The SSH connection behind a pane, once established (shared by panes that reuse it).
pub type SshSlot = Arc<Mutex<Option<SshLink>>>;

struct ActiveEntry {
    control: RuntimeControl,
    cancelled: Arc<AtomicBool>,
    log: SharedLog,
    sink: Arc<ScopedSink>,
    ssh: SshSlot,
    /// The device of an ADB pane (file browser, monitor, mirror, logcat).
    adb: crate::adb::AdbSlot,
    /// Session name, protocol ("ssh", "powershell" ...) and target ("me@host:22"), for the
    /// MCP pane list.
    label: String,
    protocol: String,
    target: String,
}

/// A pane's connection as the MCP tools see it.
#[derive(Debug, Clone)]
pub struct PaneRuntime {
    /// Session name ("一楼服务器", "Windows PowerShell").
    pub label: String,
    pub protocol: String,
    pub target: String,
    pub status: String,
    /// The shell reports commands (OSC 133): `run_command` knows when they end.
    pub shell_integration: bool,
    /// A command is running (only known with shell integration).
    pub command_running: bool,
}

#[derive(Default)]
pub struct ConnectionManager {
    sessions: Mutex<HashMap<String, ActiveEntry>>,
}

impl ConnectionManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// Connect a pane. `reuse_from`: another pane whose live SSH connection gets a new
    /// shell channel instead of logging in again (WindTerm: duplicate session).
    pub fn connect(
        &self,
        instance_id: String,
        config: SessionConfig,
        cols: u16,
        rows: u16,
        sink: Arc<dyn TerminalSink>,
        reuse_from: Option<&str>,
    ) -> Result<()> {
        if config.protocol.is_desktop() {
            anyhow::bail!("RDP / VNC 会话是远程桌面窗格，不经过终端连接");
        }
        // A running log keeps recording across reconnects of the same pane.
        let (log, reuse): (SharedLog, Option<SshLink>) = {
            let map = lock(&self.sessions);
            let log = map.get(&instance_id).map(|e| Arc::clone(&e.log)).unwrap_or_default();
            let reuse = reuse_from
                .filter(|_| config.protocol == ProtocolType::Ssh)
                .and_then(|id| map.get(id))
                .and_then(|e| lock(&e.ssh).clone());
            (log, reuse)
        };
        self.disconnect(&instance_id);
        let ssh_slot: SshSlot = Arc::default();
        let adb_slot: crate::adb::AdbSlot = Arc::default();

        let cancelled = Arc::new(AtomicBool::new(false));
        let binary = config.binary_data();
        let scoped = Arc::new(ScopedSink {
            inner: sink,
            cancelled: Arc::clone(&cancelled),
            log: Arc::clone(&log),
            codec: Mutex::new(Codec::new(&config.charset)),
            zmodem: Mutex::new(ZState::Idle(Detector::default())),
            zmodem_conflict: Mutex::default(),
            // Local ConPTY shells are not 8-bit clean, so only network / serial links.
            zmodem_enabled: !binary
                && matches!(
                    config.protocol,
                    ProtocolType::Ssh | ProtocolType::Telnet | ProtocolType::Serial | ProtocolType::Tcp
                ),
            inject: Mutex::new(None),
            tracker: Mutex::new(ShellTracker::default()),
            status: Mutex::new("connecting".into()),
            history: crate::history::get(&instance_id),
            binary: binary.then(|| Mutex::new(HexDump::default())),
            cols: AtomicU16::new(cols),
            last_input: Mutex::new(Instant::now()),
        });
        let anti_idle = AntiIdle::from_config(&config);
        let protocol = serde_json::to_value(&config.protocol)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_default();
        let label = config.label.clone();
        let target = match config.protocol {
            ProtocolType::Ssh | ProtocolType::Telnet | ProtocolType::Tcp => {
                let user = if config.username.is_empty() { String::new() } else { format!("{}@", config.username) };
                format!("{user}{}:{}", config.host, config.port)
            }
            _ => config.host.clone(),
        };
        let scoped_sink: Arc<dyn TerminalSink> = scoped.clone();

        let control = match config.protocol {
            ProtocolType::Ssh => spawn_ssh_session(
                instance_id.clone(),
                config,
                cols,
                rows,
                scoped_sink,
                Arc::clone(&ssh_slot),
                reuse,
            ),
            ProtocolType::Tcp => spawn_tcp_session(instance_id.clone(), config, scoped_sink),
            ProtocolType::Adb => crate::adb_conn::spawn_adb_session(
                instance_id.clone(),
                config,
                cols,
                rows,
                scoped_sink,
                Arc::clone(&adb_slot),
            ),
            ProtocolType::Telnet => {
                spawn_telnet_session(instance_id.clone(), config, cols, rows, scoped_sink)
            }
            ProtocolType::Powershell
            | ProtocolType::Cmd
            | ProtocolType::Wsl
            | ProtocolType::Custom
            | ProtocolType::Serial
            | ProtocolType::Rdp
            | ProtocolType::Vnc => {
                let is_serial = config.protocol == ProtocolType::Serial;
                let spawned = if is_serial {
                    spawn_serial_session(instance_id.clone(), config, Arc::clone(&scoped_sink))
                } else {
                    spawn_local_pty(instance_id.clone(), config, cols, rows, Arc::clone(&scoped_sink))
                };
                match spawned {
                    Ok(ctrl) => ctrl,
                    Err(err) => {
                        let msg = format!("{:#}", err);
                        let banner = format!(
                            "\x1b[31m[{}]\x1b[0m {}\r\n",
                            if is_serial { "串口打开失败" } else { "本地终端启动失败" },
                            msg
                        );
                        // Straight to the pane: not hex-dumped, not charset-decoded.
                        scoped.emit_text(&instance_id, banner.as_bytes(), banner.as_bytes());
                        scoped_sink.emit_state(&instance_id, "error", Some(msg));
                        // Keep a placeholder entry so a started log survives the retry.
                        let (dead_tx, _) = std_mpsc::channel::<ControlMsg>();
                        lock(&self.sessions).insert(
                            instance_id,
                            ActiveEntry {
                                control: RuntimeControl::Sync(dead_tx),
                                cancelled,
                                log,
                                sink: scoped,
                                ssh: ssh_slot,
                                adb: adb_slot,
                                label,
                                protocol,
                                target,
                            },
                        );
                        return Ok(());
                    }
                }
            }
        };

        if let Some(anti_idle) = anti_idle {
            spawn_anti_idle(anti_idle, Arc::clone(&scoped), control.clone(), Arc::clone(&cancelled));
        }
        lock(&self.sessions)
            .insert(instance_id, ActiveEntry { control, cancelled, log, sink: scoped, ssh: ssh_slot, adb: adb_slot, label, protocol, target });
        Ok(())
    }

    fn write_entry(entry: &ActiveEntry, data: &[u8]) {
        send_input(&entry.sink, &entry.control, data);
    }

    pub fn write(&self, instance_id: &str, data: &[u8]) -> Result<()> {
        if let Some(entry) = lock(&self.sessions).get(instance_id) {
            Self::write_entry(entry, data);
        }
        Ok(())
    }

    pub fn broadcast_write(&self, instance_ids: &[String], data: &[u8]) -> Result<()> {
        let map = lock(&self.sessions);
        for id in instance_ids {
            if let Some(entry) = map.get(id) {
                Self::write_entry(entry, data);
            }
        }
        Ok(())
    }

    pub fn resize(&self, instance_id: &str, cols: u16, rows: u16) -> Result<()> {
        if let Some(entry) = lock(&self.sessions).get(instance_id) {
            entry.sink.cols.store(cols, Ordering::Relaxed);
            entry.control.send_resize(cols, rows);
        }
        if let Some(history) = crate::history::get(instance_id) {
            history.resize(cols, rows);
        }
        Ok(())
    }

    /// Panes with a connection entry (live or failed).
    pub fn instance_ids(&self) -> Vec<String> {
        lock(&self.sessions).keys().cloned().collect()
    }

    /// What the MCP tools report about a pane (None: no connection).
    pub fn pane_runtime(&self, instance_id: &str) -> Option<PaneRuntime> {
        let map = lock(&self.sessions);
        let entry = map.get(instance_id)?;
        let (shell_integration, command_running) = {
            let tracker = lock(&entry.sink.tracker);
            (tracker.integrated, tracker.running)
        };
        let status = lock(&entry.sink.status).clone();
        Some(PaneRuntime {
            label: entry.label.clone(),
            protocol: entry.protocol.clone(),
            target: entry.target.clone(),
            status,
            shell_integration,
            command_running,
        })
    }

    /// Observed integration markers and whether a manual load is in progress.
    pub fn shell_integration_status(&self, instance_id: &str) -> Option<ShellIntegrationStatus> {
        let map = lock(&self.sessions);
        let entry = map.get(instance_id)?;
        let detected = lock(&entry.sink.tracker).integrated;
        let loading = lock(&entry.sink.inject).is_some();
        Some(ShellIntegrationStatus { detected, loading })
    }

    /// Start collecting the pane's output for an agent request (replaces any earlier one).
    pub fn arm_capture(&self, instance_id: &str, mode: CaptureMode) -> Result<SharedCapture> {
        let map = lock(&self.sessions);
        let entry = map.get(instance_id).ok_or_else(|| anyhow::anyhow!("该窗格没有活动的连接"))?;
        let cap: SharedCapture = Arc::new(Mutex::new(Capture::new(mode, Instant::now())));
        lock(&entry.sink.tracker).capture = Some(Arc::clone(&cap));
        Ok(cap)
    }

    /// The capture an earlier agent request left running (it timed out), if any.
    pub fn current_capture(&self, instance_id: &str) -> Option<SharedCapture> {
        let map = lock(&self.sessions);
        let tracker = lock(&map.get(instance_id)?.sink.tracker);
        tracker.capture.clone()
    }

    /// Stop collecting for `cap` (left alone when a newer request replaced it).
    pub fn disarm_capture(&self, instance_id: &str, cap: &SharedCapture) {
        if let Some(entry) = lock(&self.sessions).get(instance_id) {
            let mut tracker = lock(&entry.sink.tracker);
            if tracker.capture.as_ref().is_some_and(|c| Arc::ptr_eq(c, cap)) {
                tracker.capture = None;
            }
        }
    }

    /// Install shell integration for the pane's current user (nested ssh, container,
    /// WSL ...) and load it now; hide its echo and wait for success or failure.
    pub fn inject_shell_integration(&self, instance_id: &str) -> Result<oneshot::Receiver<InjectOutcome>> {
        let map = lock(&self.sessions);
        let entry = map.get(instance_id).ok_or_else(|| anyhow::anyhow!("该窗格没有活动的连接"))?;
        if entry.sink.transfer_busy() {
            anyhow::bail!("正在传输文件");
        }
        let (tx, rx) = oneshot::channel();
        {
            let mut inject = lock(&entry.sink.inject);
            if inject.is_some() {
                anyhow::bail!("正在加载 Shell 集成");
            }
            *inject = Some(ManualInject { injector: Injector::loading(Instant::now()), done: Some(tx) });
        }
        let token = uuid::Uuid::new_v4().simple().to_string()[..16].to_string();
        Self::write_entry(entry, crate::shell_integration::manual_line(&token).as_bytes());
        ScopedSink::run_inject(Arc::clone(&entry.sink), instance_id.to_string());
        Ok(rx)
    }

    /// Run a command on the SSH connection behind `instance_id` (not in its shell).
    pub fn exec(&self, instance_id: &str, command: &str) -> Result<oneshot::Receiver<Result<String, String>>> {
        let map = lock(&self.sessions);
        let entry = map
            .get(instance_id)
            .ok_or_else(|| anyhow::anyhow!("该窗格没有活动的连接"))?;
        let RuntimeControl::Async(AsyncChannels { exec_tx: Some(tx), .. }) = &entry.control else {
            anyhow::bail!("只有 SSH 会话支持该操作");
        };
        let (reply, rx) = oneshot::channel();
        tx.send(ExecRequest { command: command.to_string(), reply })
            .map_err(|_| anyhow::anyhow!("SSH 连接已断开"))?;
        Ok(rx)
    }

    /// The live SSH connection behind a pane (file browser, transfers).
    pub fn ssh_link(&self, instance_id: &str) -> Result<SshLink> {
        let map = lock(&self.sessions);
        let entry = map
            .get(instance_id)
            .ok_or_else(|| anyhow::anyhow!("该窗格没有活动的连接"))?;
        let link = lock(&entry.ssh).clone();
        link.ok_or_else(|| anyhow::anyhow!("该窗格不是已连接的 SSH 会话"))
    }

    /// The device behind a connected ADB pane.
    pub fn adb_device(&self, instance_id: &str) -> Result<crate::adb::AdbDevice> {
        let map = lock(&self.sessions);
        let entry = map
            .get(instance_id)
            .ok_or_else(|| anyhow::anyhow!("该窗格没有活动的连接"))?;
        let device = lock(&entry.adb).clone();
        device.ok_or_else(|| anyhow::anyhow!("该窗格不是已连接的 ADB 会话"))
    }

    /// Session name of a pane ("一楼服务器"), for transfer records.
    pub fn pane_label(&self, instance_id: &str) -> Option<String> {
        lock(&self.sessions).get(instance_id).map(|e| e.label.clone())
    }

    /// Send a request to the port-forward manager of the SSH connection behind `instance_id`.
    pub fn tunnel(&self, instance_id: &str, req: TunnelRequest) -> Result<()> {
        let map = lock(&self.sessions);
        let entry = map
            .get(instance_id)
            .ok_or_else(|| anyhow::anyhow!("该窗格没有活动的连接"))?;
        let RuntimeControl::Async(AsyncChannels { tunnel_tx: Some(tx), .. }) = &entry.control else {
            anyhow::bail!("只有 SSH 会话支持端口转发");
        };
        tx.send(req).map_err(|_| anyhow::anyhow!("SSH 连接已断开"))?;
        Ok(())
    }

    /// Start the ZModem transfer the remote requested. `files` for `rz`, `dir` for `sz`.
    pub fn zmodem_start(&self, instance_id: &str, files: Vec<PathBuf>, dir: Option<PathBuf>) -> Result<()> {
        let (sink, control, label) = {
            let map = lock(&self.sessions);
            let entry = map
                .get(instance_id)
                .ok_or_else(|| anyhow::anyhow!("该窗格没有活动的连接"))?;
            (Arc::clone(&entry.sink), entry.control.clone(), entry.label.clone())
        };
        let (tx, rx) = std_mpsc::channel();
        let cancel = Arc::new(AtomicBool::new(false));
        let (direction, buffered) = lock(&sink.zmodem).start_pending(&files, tx, Arc::clone(&cancel))?;

        let id = instance_id.to_string();
        let dir = dir.unwrap_or_else(default_download_dir);
        std::thread::spawn(move || {
            let writer = control.clone();
            let progress_sink = Arc::clone(&sink);
            let progress_id = id.clone();
            let mut transfer = Transfer::new(
                rx,
                buffered,
                Box::new(move |bytes: &[u8]| writer.send_write(bytes)),
                Arc::clone(&cancel),
                Box::new(move |p: &zmodem::Progress| {
                    let mut payload = serde_json::to_value(p).unwrap_or_default();
                    payload["instanceId"] = progress_id.clone().into();
                    payload["state"] = "running".into();
                    progress_sink.inner.emit_event("zmodem-progress", payload);
                }),
            );
            let result = match direction {
                Direction::Receive => transfer.receive(&dir, |path, suggested, can_overwrite| {
                    sink.ask_zmodem_conflict(&id, path, suggested, can_overwrite, &cancel)
                }),
                Direction::Send => transfer.send_files(&files).map(|_| files.clone()),
            };
            if result.is_err() {
                transfer.abort();
            }
            let leftover = transfer.leftover();
            *lock(&sink.zmodem) = ZState::Idle(Detector::default());

            let (state, message) = match &result {
                Ok(paths) => (
                    "done",
                    match direction {
                        Direction::Receive => format!("[ZModem] 已接收 {} 个文件 → {}", paths.len(), dir.display()),
                        Direction::Send => format!("[ZModem] 已发送 {} 个文件", paths.len()),
                    },
                ),
                Err(zmodem::ZError::Cancelled) => ("cancelled", "[ZModem] 传输已取消".to_string()),
                Err(e) => ("error", format!("[ZModem] 传输失败：{}", e)),
            };
            crate::transfer::record_modem(
                &id,
                &label,
                "zmodem",
                direction == Direction::Receive,
                state,
                &message,
                result.as_deref().unwrap_or_default(),
            );
            let files: Vec<String> = result
                .as_ref()
                .map(|p| p.iter().map(|x| x.to_string_lossy().to_string()).collect())
                .unwrap_or_default();
            sink.inner.emit_event(
                "zmodem-progress",
                serde_json::json!({ "instanceId": id, "state": state, "message": message, "files": files, "dir": dir.to_string_lossy() }),
            );
            let color = if state == "done" { "32" } else { "33" };
            sink.emit_terminal(&id, format!("\r\n\x1b[{}m{}\x1b[0m\r\n", color, message).as_bytes());
            sink.emit_terminal(&id, &leftover);
        });
        Ok(())
    }

    /// Start an XMODEM / YMODEM transfer from the pane menu. Sending runs `command`
    /// (e.g. `rx file` / `rb`) on the remote first; receiving expects `sx` / `sb` to run.
    /// `target`: the file (XMODEM) or folder (YMODEM) to save into.
    #[allow(clippy::too_many_arguments)]
    pub fn modem_start(
        &self,
        instance_id: &str,
        protocol: Protocol,
        send: bool,
        files: Vec<PathBuf>,
        target: Option<PathBuf>,
        command: Option<String>,
        packet_size: usize,
    ) -> Result<()> {
        let (sink, control, label) = {
            let map = lock(&self.sessions);
            let entry = map
                .get(instance_id)
                .ok_or_else(|| anyhow::anyhow!("该窗格没有活动的连接"))?;
            (Arc::clone(&entry.sink), entry.control.clone(), entry.label.clone())
        };
        if !sink.zmodem_enabled {
            anyhow::bail!("本地终端不支持 X/YMODEM 传输，请在 SSH、Telnet、串口或 TCP 会话中使用");
        }
        if send && files.is_empty() {
            anyhow::bail!("请选择要发送的文件");
        }
        let (rx, cancel) = {
            let mut z = lock(&sink.zmodem);
            if !matches!(*z, ZState::Idle(_)) {
                anyhow::bail!("已有文件传输正在进行");
            }
            let (tx, rx) = std_mpsc::channel();
            let cancel = Arc::new(AtomicBool::new(false));
            *z = ZState::Active { tx, cancel: Arc::clone(&cancel) };
            (rx, cancel)
        };
        let name = if protocol == Protocol::Xmodem { "XMODEM" } else { "YMODEM" };
        let id = instance_id.to_string();
        sink.inner.emit_event(
            "modem-started",
            serde_json::json!({ "instanceId": id, "direction": if send { "send" } else { "receive" }, "protocol": name }),
        );
        if let Some(cmd) = command.filter(|c| !c.trim().is_empty()) {
            let encoded = lock(&sink.codec).encode(format!("{}\r", cmd.trim_end()).as_bytes());
            control.send_write(&encoded);
        }
        let target = target.unwrap_or_else(default_download_dir);
        std::thread::spawn(move || {
            let writer = control.clone();
            let progress_sink = Arc::clone(&sink);
            let progress_id = id.clone();
            let mut transfer = ModemTransfer::new(
                rx,
                Vec::new(),
                Box::new(move |bytes: &[u8]| writer.send_write(bytes)),
                Arc::clone(&cancel),
                Box::new(move |p: &zmodem::Progress| {
                    let mut payload = serde_json::to_value(p).unwrap_or_default();
                    payload["instanceId"] = progress_id.clone().into();
                    payload["state"] = "running".into();
                    progress_sink.inner.emit_event("zmodem-progress", payload);
                }),
                packet_size,
            );
            let result = transfer.run(protocol, send, &files, &target);
            if matches!(result, Err(MError::Cancelled) | Err(MError::Timeout)) {
                transfer.abort();
            }
            let leftover = transfer.leftover();
            *lock(&sink.zmodem) = ZState::Idle(Detector::default());

            let dir = if protocol == Protocol::Xmodem && !send {
                target.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| target.clone())
            } else {
                target.clone()
            };
            let (state, message) = match &result {
                Ok(paths) if send => ("done", format!("[{}] 已发送 {} 个文件", name, paths.len())),
                Ok(paths) => ("done", format!("[{}] 已接收 {} 个文件 → {}", name, paths.len(), dir.display())),
                Err(MError::Cancelled) => ("cancelled", format!("[{}] 传输已取消", name)),
                Err(e) => ("error", format!("[{}] 传输失败：{}", name, e)),
            };
            crate::transfer::record_modem(
                &id,
                &label,
                &name.to_lowercase(),
                !send,
                state,
                &message,
                result.as_deref().unwrap_or_default(),
            );
            let files: Vec<String> = result
                .as_ref()
                .map(|p| p.iter().map(|x| x.to_string_lossy().to_string()).collect())
                .unwrap_or_default();
            sink.inner.emit_event(
                "zmodem-progress",
                serde_json::json!({ "instanceId": id, "state": state, "message": message, "files": files, "dir": dir.to_string_lossy() }),
            );
            let color = if state == "done" { "32" } else { "33" };
            sink.emit_terminal(&id, format!("\r\n\x1b[{}m{}\x1b[0m\r\n", color, message).as_bytes());
            sink.emit_terminal(&id, &leftover);
        });
        Ok(())
    }

    pub fn zmodem_answer(&self, instance_id: &str, request_id: &str, answer: zmodem::ConflictAnswer) -> Result<()> {
        let sessions = lock(&self.sessions);
        let entry = sessions.get(instance_id).ok_or_else(|| anyhow::anyhow!("该窗格没有活动的连接"))?;
        let mut conflict = lock(&entry.sink.zmodem_conflict);
        if !conflict.as_ref().is_some_and(|(id, _)| id == request_id) {
            anyhow::bail!("此文件冲突已失效");
        }
        if let zmodem::ConflictAnswer::Rename { name } = &answer {
            if !zmodem::valid_receive_name(name) {
                anyhow::bail!("请输入有效的文件名，不含路径或保留字符");
            }
        }
        let (_, sender) = conflict.take().unwrap();
        sender.send(answer).map_err(|_| anyhow::anyhow!("传输已结束"))
    }

    /// Refuse a pending transfer or stop a running one.
    pub fn zmodem_cancel(&self, instance_id: &str) {
        let Some((sink, control)) = lock(&self.sessions)
            .get(instance_id)
            .map(|e| (Arc::clone(&e.sink), e.control.clone()))
        else {
            return;
        };
        let mut z = lock(&sink.zmodem);
        match &*z {
            ZState::Pending { .. } => {
                *z = ZState::Idle(Detector::default());
                drop(z);
                control.send_write(&zmodem::cancel_sequence());
                sink.inner.emit_event(
                    "zmodem-progress",
                    serde_json::json!({ "instanceId": instance_id, "state": "cancelled", "message": "[ZModem] 已拒绝传输" }),
                );
            }
            ZState::Active { cancel, .. } => cancel.store(true, Ordering::Release),
            ZState::Idle(_) => {}
        }
    }

    /// Start logging a pane's output; returns the log file path.
    pub fn start_log(&self, instance_id: &str, log: SessionLog) -> Result<String> {
        let map = self
            .sessions
            .lock()
            .map_err(|_| anyhow::anyhow!("连接表已损坏"))?;
        let entry = map
            .get(instance_id)
            .ok_or_else(|| anyhow::anyhow!("该窗格没有活动的连接"))?;
        let path = log.path().to_string_lossy().to_string();
        if let Ok(mut guard) = entry.log.lock() {
            *guard = Some(log);
        }
        Ok(path)
    }

    pub fn is_logging(&self, instance_id: &str) -> bool {
        self.log_path(instance_id).is_some()
    }

    pub fn log_path(&self, instance_id: &str) -> Option<String> {
        let map = self.sessions.lock().ok()?;
        let entry = map.get(instance_id)?;
        let guard = entry.log.lock().ok()?;
        guard.as_ref().map(|l| l.path().to_string_lossy().to_string())
    }

    /// Pause or resume a running log; returns the new state (None: not logging).
    pub fn pause_log(&self, instance_id: &str, paused: bool) -> Option<bool> {
        let map = self.sessions.lock().ok()?;
        let entry = map.get(instance_id)?;
        let mut guard = entry.log.lock().ok()?;
        let log = guard.as_mut()?;
        log.set_paused(paused);
        Some(log.is_paused())
    }

    pub fn stop_log(&self, instance_id: &str) {
        if let Ok(map) = self.sessions.lock() {
            if let Some(entry) = map.get(instance_id) {
                if let Ok(mut guard) = entry.log.lock() {
                    *guard = None;
                }
            }
        }
    }

    pub fn is_open(&self, instance_id: &str) -> bool {
        lock(&self.sessions).contains_key(instance_id)
    }

    /// Panes with a connection entry (live or failed, until closed).
    pub fn count(&self) -> usize {
        lock(&self.sessions).len()
    }

    pub fn disconnect(&self, instance_id: &str) {
        if let Ok(mut map) = self.sessions.lock() {
            if let Some(entry) = map.remove(instance_id) {
                entry
                    .cancelled
                    .store(true, std::sync::atomic::Ordering::Release);
                entry.control.send_close();
            }
        }
        crate::output::forget_detached(instance_id);
    }
}

/// Bytes typed into a pane, on their way to the remote.
fn send_input(sink: &ScopedSink, control: &RuntimeControl, data: &[u8]) {
    // Keystrokes must not corrupt a running ZModem transfer.
    if sink.transfer_busy() {
        return;
    }
    *lock(&sink.last_input) = Instant::now();
    // Binary data type: the bytes go out exactly as given (hex sender, keystrokes).
    if sink.binary.is_some() {
        control.send_write(data);
        return;
    }
    let encoded = lock(&sink.codec).encode(data);
    control.send_write(&encoded);
}

/// One timer thread per connection with anti-idle on; it ends with the connection.
fn spawn_anti_idle(anti_idle: AntiIdle, sink: Arc<ScopedSink>, control: RuntimeControl, cancelled: Arc<AtomicBool>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(1));
        if cancelled.load(Ordering::Acquire) {
            return;
        }
        // One lock at a time: the output path takes these in its own order.
        let shell_busy = {
            let tracker = lock(&sink.tracker);
            tracker.alt_screen || tracker.running
        };
        let injecting = lock(&sink.inject).is_some();
        let connected = *lock(&sink.status) == "connected";
        let pane = PaneState { connected, busy: shell_busy || injecting || sink.transfer_busy() };
        let last_input = *lock(&sink.last_input);
        if anti_idle.due(Instant::now(), last_input, pane) {
            send_input(&sink, &control, &anti_idle.bytes);
        }
    });
}

fn default_download_dir() -> PathBuf {
    dirs::download_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::AuthType;
    use std::io::{Read as _, Write as _};
    use std::net::TcpListener;
    use std::time::{Duration, Instant};

    #[test]
    fn duplicate_zmodem_start_preserves_active_receiver() {
        let mut state = ZState::Pending { direction: Direction::Receive, buffered: vec![1, 2] };
        let (original_tx, original_rx) = std_mpsc::channel();
        let original_cancel = Arc::new(AtomicBool::new(false));
        let pending = state.start_pending(&[], original_tx, Arc::clone(&original_cancel)).unwrap();
        assert_eq!(pending, (Direction::Receive, vec![1, 2]));

        let (duplicate_tx, _) = std_mpsc::channel();
        assert!(state.start_pending(&[], duplicate_tx, Arc::default()).is_err());
        let ZState::Active { tx, cancel } = state else { panic!("transfer no longer active") };
        assert!(Arc::ptr_eq(&cancel, &original_cancel));
        tx.send(vec![3]).unwrap();
        assert_eq!(original_rx.try_recv().unwrap(), vec![3]);
    }

    #[derive(Default)]
    struct MockSink {
        output: Mutex<Vec<u8>>,
        states: Mutex<Vec<String>>,
    }

    impl TerminalSink for MockSink {
        fn emit_output(&self, _instance_id: &str, data: &[u8]) {
            if let Ok(mut guard) = self.output.lock() {
                guard.extend_from_slice(data);
            }
        }

        fn emit_state(&self, _instance_id: &str, status: &str, _message: Option<String>) {
            if let Ok(mut guard) = self.states.lock() {
                guard.push(status.to_string());
            }
        }
    }

    /// Binary data type: received bytes become a hex dump, written bytes go out untouched
    /// (no GBK encoding of 0x80+ bytes), and ZMODEM's start sequence is just data.
    #[test]
    fn tcp_binary_data_type() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let port = listener.local_addr().unwrap().port();
        let (got_tx, got_rx) = std_mpsc::channel::<Vec<u8>>();
        std::thread::spawn(move || {
            if let Ok((mut sock, _)) = listener.accept() {
                let _ = sock.write_all(b"**\x18B00\x01\xFFok");
                let mut b = [0u8; 16];
                if let Ok(n) = sock.read(&mut b) {
                    let _ = got_tx.send(b[..n].to_vec());
                }
            }
        });
        let sink = Arc::new(MockSink::default());
        let mut cfg = SessionConfig {
            id: "bin".into(),
            protocol: ProtocolType::Tcp,
            host: "127.0.0.1".into(),
            port,
            charset: "GBK".into(),
            ..Default::default()
        };
        cfg.extra.insert("dataType".into(), "binary".into());
        let mgr = ConnectionManager::new();
        mgr.connect("pane-bin".into(), cfg, 100, 24, sink.clone(), None).unwrap();

        let deadline = Instant::now() + Duration::from_secs(4);
        let mut text = String::new();
        while Instant::now() < deadline && !text.contains("**.B00..ok") {
            std::thread::sleep(Duration::from_millis(50));
            text = String::from_utf8_lossy(&sink.output.lock().unwrap()).to_string();
        }
        assert!(text.contains("2A 2A 18 42 30 30 01 FF  6F 6B"), "{text:?}");
        assert!(text.contains("**.B00..ok"), "{text:?}");

        mgr.write("pane-bin", &[0x01, 0x03, 0xC4, 0xE3]).unwrap();
        let sent = got_rx.recv_timeout(Duration::from_secs(4)).expect("server got bytes");
        mgr.disconnect("pane-bin");
        assert_eq!(sent, vec![0x01, 0x03, 0xC4, 0xE3]);
    }

    #[test]
    fn test_cmd_and_tcp_and_ssh_without_caller_tokio_context() {
        // Deliberately execute from a plain OS thread with NO Tokio runtime entered,
        // reproducing the exact Win32 UI thread environment that previously caused crashes.
        let join = std::thread::spawn(|| {
            let mgr = ConnectionManager::new();

            // 1. Test CMD ConPTY spawn, write, and output read
            let cmd_sink = Arc::new(MockSink::default());
            let cmd_cfg = SessionConfig {
                id: "test-cmd".into(),
                label: "CMD".into(),
                group: String::new(),
                protocol: ProtocolType::Cmd,
                host: String::new(),
                port: 0,
                username: String::new(),
                auth_type: AuthType::None,
                password: None,
                private_key_path: None,
                passphrase: None,
                jump_host: None,
                term: "xterm-256color".into(),
                keep_alive_secs: 0,
                startup_command: None,
                working_dir: None,
                shell_command: None,
                serial: None,
                auto_log: false,
                ..Default::default()
            };

            mgr.connect("pane-cmd".into(), cmd_cfg, 80, 24, cmd_sink.clone(), None)
                .expect("CMD ConPTY should connect cleanly");
            // Reply to Windows ConPTY's initial DSR cursor query (\x1b[6n) just like xterm.js does
            let dsr_reply = format!("{}[1;1R", char::from(27));
            mgr.write("pane-cmd", dsr_reply.as_bytes())
                .expect("DSR reply");
            let mut echo_cmd = String::from("echo CONPTY_OK");
            echo_cmd.push(char::from(13));
            echo_cmd.push(char::from(10));
            mgr.write("pane-cmd", echo_cmd.as_bytes())
                .expect("CMD write");

            let deadline = Instant::now() + Duration::from_secs(6);
            let mut saw_cmd_output = false;
            while Instant::now() < deadline {
                let text = String::from_utf8_lossy(&cmd_sink.output.lock().unwrap()).to_string();
                if text.contains("CONPTY_OK") {
                    saw_cmd_output = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(80));
            }
            let final_out = String::from_utf8_lossy(&cmd_sink.output.lock().unwrap()).to_string();
            let final_states = cmd_sink.states.lock().unwrap().clone();
            mgr.disconnect("pane-cmd");
            assert!(
                saw_cmd_output,
                "Expected CONPTY_OK from cmd.exe session; states={:?}, out={:?}",
                final_states,
                final_out
            );

            // 2. Test TCP session over Tauri async runtime without caller Tokio context
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
            let port = listener.local_addr().unwrap().port();
            std::thread::spawn(move || {
                if let Ok((mut sock, _)) = listener.accept() {
                    let _ = sock.write_all(b"TCP_BANNER_OK");
                    let mut b = [0u8; 32];
                    let _ = sock.read(&mut b);
                }
            });

            let tcp_sink = Arc::new(MockSink::default());
            let tcp_cfg = SessionConfig {
                id: "test-tcp".into(),
                label: "TCP".into(),
                group: String::new(),
                protocol: ProtocolType::Tcp,
                host: "127.0.0.1".into(),
                port,
                username: String::new(),
                auth_type: AuthType::None,
                password: None,
                private_key_path: None,
                passphrase: None,
                jump_host: None,
                term: "xterm-256color".into(),
                keep_alive_secs: 0,
                startup_command: None,
                working_dir: None,
                shell_command: None,
                serial: None,
                auto_log: false,
                ..Default::default()
            };

            mgr.connect("pane-tcp".into(), tcp_cfg, 80, 24, tcp_sink.clone(), None)
                .expect("TCP session should spawn cleanly");

            let deadline_tcp = Instant::now() + Duration::from_secs(4);
            let mut saw_tcp = false;
            while Instant::now() < deadline_tcp {
                let text = String::from_utf8_lossy(&tcp_sink.output.lock().unwrap()).to_string();
                if text.contains("TCP_BANNER_OK") {
                    saw_tcp = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            mgr.disconnect("pane-tcp");
            assert!(saw_tcp, "Expected TCP_BANNER_OK from loopback TCP server");

            // 3. Test SSH spawn against closed port (must emit clean error state, NEVER panic!)
            let ssh_sink = Arc::new(MockSink::default());
            let ssh_cfg = SessionConfig {
                id: "test-ssh".into(),
                label: "SSH".into(),
                group: String::new(),
                protocol: ProtocolType::Ssh,
                host: "127.0.0.1".into(),
                port: 1,
                username: "root".into(),
                auth_type: AuthType::Password,
                password: Some("test".into()),
                private_key_path: None,
                passphrase: None,
                jump_host: None,
                term: "xterm-256color".into(),
                keep_alive_secs: 60,
                startup_command: None,
                working_dir: None,
                shell_command: None,
                serial: None,
                auto_log: false,
                ..Default::default()
            };
            mgr.connect("pane-ssh".into(), ssh_cfg, 80, 24, ssh_sink.clone(), None)
                .expect("SSH spawn must not panic");

            let deadline_ssh = Instant::now() + Duration::from_secs(5);
            let mut saw_ssh_err = false;
            while Instant::now() < deadline_ssh {
                let states = ssh_sink.states.lock().unwrap().clone();
                if states.iter().any(|s| s == "error") {
                    saw_ssh_err = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            assert!(saw_ssh_err, "Expected clean SSH error state without panic");
        });

        join.join().expect("Plain OS thread must not panic");
    }
}

/// Real WSL ConPTY, isolated home: `cargo test --lib manual_inject_e2e -- --ignored`.
#[cfg(test)]
mod manual_inject_e2e {
    use super::*;

    #[derive(Default)]
    struct Collect(Mutex<Vec<u8>>);

    impl TerminalSink for Collect {
        fn emit_output(&self, _id: &str, data: &[u8]) {
            lock(&self.0).extend_from_slice(data);
        }
        fn emit_state(&self, _id: &str, _status: &str, _message: Option<String>) {}
    }

    fn text(sink: &Collect) -> String {
        String::from_utf8_lossy(&lock(&sink.0)).to_string()
    }

    #[test]
    #[ignore]
    fn loads_into_wsl_and_hides_the_line() {
        check_shell("bash", "--noprofile --norc -i");
        let fish = std::process::Command::new("wsl.exe").args(["--exec", "sh", "-c", "command -v fish"]).output().unwrap();
        if fish.status.success() {
            check_shell("fish", "--no-config -i");
        }
    }

    fn check_shell(shell: &str, clean_flags: &str) {
        use std::process::Command;
        struct TestHome(String);
        impl Drop for TestHome {
            fn drop(&mut self) {
                if self.0.strip_prefix("/tmp/nexterm-si-e2e-").is_some_and(|suffix| !suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_alphanumeric())) {
                    let _ = Command::new("wsl.exe").args(["--exec", "python3", "-c",
                        "import shutil,sys; shutil.rmtree(sys.argv[1])", &self.0]).output();
                }
            }
        }
        let home = Command::new("wsl.exe").args(["--exec", "mktemp", "-d", "/tmp/nexterm-si-e2e-XXXXXXXX"]).output().unwrap();
        assert!(home.status.success());
        let home = TestHome(String::from_utf8(home.stdout).unwrap().trim().to_string());
        assert!(home.0.starts_with("/tmp/nexterm-si-e2e-") && home.0[5..].bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'));
        let launch = format!("wsl.exe --exec env HOME={} XDG_CONFIG_HOME={}/.config {shell}", home.0, home.0);
        let session: SessionConfig = serde_json::from_value(serde_json::json!({
            "id": "w", "label": "w", "protocol": "custom", "shellCommand": format!("{launch} {clean_flags}")
        })).unwrap();
        let sink = Arc::new(Collect::default());
        let mgr = ConnectionManager::new();
        mgr.connect("w".into(), session.clone(), 120, 30, sink.clone(), None).unwrap();
        // Answer ConPTY's cursor query, then wait for the prompt to settle.
        std::thread::sleep(std::time::Duration::from_millis(500));
        mgr.write("w", b"\x1b[1;1R").unwrap();
        std::thread::sleep(std::time::Duration::from_secs(4));
        let before = lock(&sink.0).len();
        let rx = mgr.inject_shell_integration("w").unwrap();
        assert!(mgr.shell_integration_status("w").unwrap().loading);
        let outcome = rx.blocking_recv().unwrap();
        let integration = mgr.shell_integration_status("w").unwrap();
        assert!(integration.detected && !integration.loading);
        let after = text(&sink)[before..].to_string();
        eprintln!("{shell}: OUTCOME {outcome:?} AFTER {after:?}");
        assert_eq!(outcome, InjectOutcome::Loaded);
        assert!(!after.contains("nexterm-si") && !after.contains("base64"), "loader line showed");
        assert!(after.contains("\x1b]133;A\x07"));
        mgr.write("w", b"sleep 1\r").unwrap();
        std::thread::sleep(std::time::Duration::from_secs(2));
        assert!(text(&sink).contains("\x1b]633;E;sleep 1\x07"), "no command reported");
        mgr.disconnect("w");
        let mut session = session;
        session.shell_command = Some(format!("{launch} -i"));
        mgr.connect("w".into(), session, 120, 30, sink.clone(), None).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(500));
        mgr.write("w", b"\x1b[1;1R").unwrap();
        let deadline = Instant::now() + std::time::Duration::from_secs(10);
        while !mgr.shell_integration_status("w").unwrap().detected && Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(30));
        }
        assert!(mgr.shell_integration_status("w").unwrap().detected, "reopened WSL shell did not load integration");
        mgr.disconnect("w");
    }
}
