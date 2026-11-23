use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use anyhow::{Context, Result};
use russh::keys::{load_secret_key, HashAlg, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate};
use russh::{client, ChannelMsg, Disconnect};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

use crate::importer::expand_tilde;
use crate::manager::{
    AsyncChannels, ExecRequest, HostKeyDecision, HostKeyPrompt, RuntimeControl, SshSlot, TerminalSink, TunnelRequest,
    TunnelStatus,
};
use crate::models::{AuthType, JumpHostConfig, SessionConfig, TunnelConfig};
use crate::net::{connect_stream, BoxedStream};
use crate::pump::OutputPump;
use crate::shell_integration::{Injector, Step};

/// Where X11 channels opened by the server are delivered.
struct X11Target {
    host: String,
    port: u16,
    /// The session's display setting, resolved again when the X server went away.
    setting: String,
    /// Fake MIT-MAGIC-COOKIE-1 handed to the server; stripped before reaching the local X server.
    cookie: Vec<u8>,
}

#[derive(Clone)]
struct SshHandler {
    instance_id: String,
    /// Host / port as known_hosts records them (the target, even when tunnelled).
    host: String,
    port: u16,
    skip_host_key_check: bool,
    sink: Arc<dyn TerminalSink>,
    /// Remote forwards: bound remote port -> local target.
    remote_forwards: RemoteForwards,
    x11: Option<Arc<X11Target>>,
}

impl SshHandler {
    fn new(instance_id: &str, host: &str, port: u16, skip: bool, sink: Arc<dyn TerminalSink>) -> Self {
        Self {
            instance_id: instance_id.to_string(),
            host: host.trim().to_string(),
            port,
            skip_host_key_check: skip,
            sink,
            remote_forwards: Arc::default(),
            x11: None,
        }
    }
}

pub fn known_hosts_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ssh").join("known_hosts"))
}

/// Drop line `line` (1-based) of known_hosts, used when the user accepts a changed key.
fn remove_known_hosts_line(path: &std::path::Path, line: usize) -> std::io::Result<()> {
    let text = std::fs::read_to_string(path)?;
    let kept: Vec<&str> = text
        .lines()
        .enumerate()
        .filter(|(i, _)| i + 1 != line)
        .map(|(_, l)| l)
        .collect();
    std::fs::write(path, kept.join("\n") + "\n")
}

impl client::Handler for SshHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> std::result::Result<bool, Self::Error> {
        if self.skip_host_key_check {
            return Ok(true);
        }
        let key: PublicKey = match server_public_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            PublicKeyOrCertificate::Certificate(cert) => PublicKey::from(cert.public_key().clone()),
        };
        let Some(path) = known_hosts_path() else {
            return Ok(true);
        };
        let (changed_line, known) =
            match russh::keys::check_known_hosts_path(&self.host, self.port, &key, &path) {
                Ok(true) => return Ok(true),
                Ok(false) => (None, false),
                Err(russh::keys::Error::KeyChanged { line }) => (Some(line), true),
                Err(_) => (None, false),
            };

        let prompt = HostKeyPrompt {
            host: self.host.clone(),
            port: self.port,
            key_type: key.algorithm().as_str().to_string(),
            fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
            changed: known,
            known_hosts: path.to_string_lossy().to_string(),
            kind: "ssh",
        };
        let rx = self.sink.confirm_host_key(&self.instance_id, prompt);
        let decision = tokio::time::timeout(Duration::from_secs(300), rx)
            .await
            .ok()
            .and_then(|r| r.ok())
            .unwrap_or(HostKeyDecision::Reject);
        match decision {
            HostKeyDecision::Reject => Ok(false),
            HostKeyDecision::AcceptOnce => Ok(true),
            HostKeyDecision::AcceptAndSave => {
                if let Some(line) = changed_line {
                    let _ = remove_known_hosts_line(&path, line);
                }
                let _ = russh::keys::known_hosts::learn_known_hosts_path(&self.host, self.port, &key, &path);
                Ok(true)
            }
        }
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<client::Msg>,
        connected_address: &str,
        connected_port: u32,
        originator_address: &str,
        originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> std::result::Result<(), Self::Error> {
        let target = self
            .remote_forwards
            .lock()
            .ok()
            .and_then(|m| m.get(&connected_port).cloned());
        let Some(RemoteTarget { host, port, active, total }) = target else {
            drop(reply);
            return Ok(());
        };
        reply.accept().await;
        let guard = track(&active, &total);
        let sink = Arc::clone(&self.sink);
        let id = self.instance_id.clone();
        let origin = format!("{}:{}", originator_address, originator_port);
        let _ = connected_address;
        tokio::spawn(async move {
            let _guard = guard;
            match TcpStream::connect((host.as_str(), port)).await {
                Ok(mut local) => {
                    let mut remote = channel.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut remote, &mut local).await;
                }
                Err(e) => notice(
                    &sink,
                    &id,
                    &format!("[远程转发] {} 无法连接本地目标 {}:{}: {}", origin, host, port, e),
                    true,
                ),
            }
        });
        Ok(())
    }

    async fn server_channel_open_x11(
        &mut self,
        channel: russh::Channel<client::Msg>,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> std::result::Result<(), Self::Error> {
        let Some(x11) = self.x11.clone() else {
            drop(reply);
            return Ok(());
        };
        reply.accept().await;
        let sink = Arc::clone(&self.sink);
        let id = self.instance_id.clone();
        tokio::spawn(async move {
            if let Err(e) = proxy_x11(channel, &x11).await {
                notice(&sink, &id, &format!("[X11] {:#}", e), true);
            }
        });
        Ok(())
    }
}

/// A dim (or red) one-line notice for the terminal.
fn notice_line(text: &str, error: bool) -> String {
    let color = if error { "31" } else { "90" };
    format!("\r\n\x1b[{}m{}\x1b[0m\r\n", color, text)
}

/// Write a notice into the terminal. Not from the session loop once its `OutputPump` runs:
/// there notices go through the pump, after the output queued before them.
fn notice(sink: &Arc<dyn TerminalSink>, instance_id: &str, text: &str, error: bool) {
    sink.emit_output(instance_id, notice_line(text, error).as_bytes());
}

/// Parse an X display like "localhost:0.0", ":1" or "127.0.0.1:10" into host, TCP port, screen.
fn parse_x11_display(display: &str) -> (String, u16, u32) {
    let d = display.trim();
    let (host, rest) = match d.rsplit_once(':') {
        Some((h, r)) => (h, r),
        None => (d, "0"),
    };
    let host = if host.is_empty() || host == "unix" { "127.0.0.1" } else { host };
    let (num, screen) = rest.split_once('.').unwrap_or((rest, "0"));
    let num: u16 = num.parse().unwrap_or(0);
    (host.to_string(), 6000 + num, screen.parse().unwrap_or(0))
}

/// Pipe one X11 channel to the local X server, swapping the fake cookie for no auth.
async fn proxy_x11(channel: russh::Channel<client::Msg>, x11: &X11Target) -> Result<()> {
    let mut remote = channel.into_stream();
    // X11 connection setup: byte order, pad, major(2), minor(2), name_len(2), data_len(2), pad(2)
    let mut head = [0u8; 12];
    remote.read_exact(&mut head).await.context("读取 X11 握手失败")?;
    let le = head[0] == b'l';
    let read16 = |b: &[u8]| if le { u16::from_le_bytes([b[0], b[1]]) } else { u16::from_be_bytes([b[0], b[1]]) };
    let name_len = read16(&head[6..8]) as usize;
    let data_len = read16(&head[8..10]) as usize;
    let pad = |n: usize| (4 - n % 4) % 4;
    let mut auth = vec![0u8; name_len + pad(name_len) + data_len + pad(data_len)];
    remote.read_exact(&mut auth).await?;
    let name = &auth[..name_len];
    let data_start = name_len + pad(name_len);
    let data = &auth[data_start..data_start + data_len];
    if name != b"MIT-MAGIC-COOKIE-1" || data != x11.cookie.as_slice() {
        anyhow::bail!("服务器发来的 X11 连接认证不匹配，已拒绝");
    }
    let mut local = match TcpStream::connect((x11.host.as_str(), x11.port)).await {
        Ok(s) => s,
        Err(first) => {
            // The X server is gone (stopped, crashed, never started): resolve the display
            // setting again, which starts the built-in server when allowed, and retry.
            let setting = x11.setting.clone();
            let (display, warning) = tokio::task::spawn_blocking(move || crate::xserver::resolve_display(&setting))
                .await
                .unwrap_or_else(|_| (x11.setting.clone(), None));
            let (host, port, _) = parse_x11_display(&display);
            match TcpStream::connect((host.as_str(), port)).await {
                Ok(s) => s,
                Err(_) => {
                    let why = warning.unwrap_or_else(|| first.to_string());
                    anyhow::bail!("无法连接本地 X 服务器 {}:{}：{}", host, port, why);
                }
            }
        }
    };
    head[6..10].fill(0);
    local.write_all(&head).await?;
    tokio::io::copy_bidirectional(&mut remote, &mut local).await?;
    Ok(())
}

fn random_bytes(n: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(n);
    while out.len() < n {
        out.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
    }
    out.truncate(n);
    out
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

type SharedHandle = Arc<client::Handle<SshHandler>>;

/// A live SSH connection. Panes that reuse it (duplicate session) each open their own
/// shell channel on it; the connection closes when the last of them ends.
pub struct SshShared {
    handle: SharedHandle,
    forwards: RemoteForwards,
    /// X11 target and screen, when the connection was opened with X11 forwarding.
    x11: Option<(Arc<X11Target>, u32)>,
    /// Keeps the jump host connection (the tunnel this connection runs through) open.
    _jump: Option<client::Handle<SshHandler>>,
}

pub type SshLink = Arc<SshShared>;

impl SshShared {
    /// Start the SFTP subsystem on a channel of its own (file browser, transfers).
    pub async fn open_sftp(&self) -> Result<russh_sftp::client::SftpSession> {
        let ch = self.handle.channel_open_session().await.context("无法打开 SFTP 通道")?;
        ch.request_subsystem(true, "sftp").await.context("无法请求 SFTP 子系统")?;
        // A server without the subsystem closes the channel: init fails instead of hanging.
        let sftp = tokio::time::timeout(Duration::from_secs(15), russh_sftp::client::SftpSession::new(ch.into_stream()))
            .await
            .context("SFTP 初始化超时")?
            .context("服务器不支持 SFTP")?;
        sftp.set_timeout(30);
        Ok(sftp)
    }

    /// Run `command` as is (not through `posix_wrap`: scp needs the channel's stdin).
    pub async fn open_exec(&self, command: &str) -> Result<russh::Channel<client::Msg>> {
        let ch = self.handle.channel_open_session().await.context("无法打开 SSH 执行通道")?;
        ch.exec(true, command).await.context("远程命令启动失败")?;
        Ok(ch)
    }

    /// Run a POSIX sh script on an exec channel and return its stdout.
    pub async fn exec_output(&self, command: &str) -> Result<String> {
        run_exec(&self.handle, command).await
    }
}

/// Target of a remote (-R) forward plus its live connection counter.
#[derive(Clone)]
struct RemoteTarget {
    host: String,
    port: u16,
    active: Arc<AtomicUsize>,
    total: Arc<AtomicUsize>,
}

type RemoteForwards = Arc<Mutex<HashMap<u32, RemoteTarget>>>;

/// A forward running on this connection.
struct RunningTunnel {
    info: TunnelStatus,
    task: Option<tokio::task::JoinHandle<()>>,
    /// For remote forwards: (bind address, bound port) to cancel on stop.
    remote: Option<(String, u32)>,
    active: Arc<AtomicUsize>,
    total: Arc<AtomicUsize>,
}

/// Decrements the live connection count when a forwarded connection ends.
struct ConnGuard(Arc<AtomicUsize>);
impl Drop for ConnGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, AtomicOrdering::Relaxed);
    }
}

fn track(active: &Arc<AtomicUsize>, total: &Arc<AtomicUsize>) -> ConnGuard {
    active.fetch_add(1, AtomicOrdering::Relaxed);
    total.fetch_add(1, AtomicOrdering::Relaxed);
    ConnGuard(Arc::clone(active))
}

/// Start one -L / -R / -D forward. The notices for the terminal (text, error) are added to
/// `notes`: the caller writes them where they keep their place among the output.
async fn start_tunnel(
    handle: &SharedHandle,
    forwards: &RemoteForwards,
    id: String,
    t: &TunnelConfig,
    notes: &mut Vec<(String, bool)>,
) -> std::result::Result<RunningTunnel, String> {
    let listen_host = if t.listen_host.trim().is_empty() { "127.0.0.1" } else { t.listen_host.trim() };
    let target_host = if t.target_host.trim().is_empty() { "localhost" } else { t.target_host.trim() };
    let label = if t.name.is_empty() { String::new() } else { format!(" {}", t.name) };
    let active = Arc::new(AtomicUsize::new(0));
    let total = Arc::new(AtomicUsize::new(0));
    let mut info = TunnelStatus { id, config: t.clone(), bound_port: t.listen_port, active: 0, total: 0 };

    match t.kind.as_str() {
        "local" | "dynamic" => {
            let dynamic = t.kind == "dynamic";
            let listener = TcpListener::bind((listen_host, t.listen_port)).await.map_err(|e| {
                let msg = format!("无法监听 {}:{}: {}", listen_host, t.listen_port, e);
                notes.push((format!("[端口转发{}] {}", label, msg), true));
                msg
            })?;
            let bound = listener.local_addr().map(|a| a.port()).unwrap_or(t.listen_port);
            info.bound_port = bound;
            notes.push((
                if dynamic {
                    format!("[动态转发{}] SOCKS4/5 代理已在 {}:{} 启动", label, listen_host, bound)
                } else {
                    format!("[本地转发{}] {}:{} → {}:{}", label, listen_host, bound, target_host, t.target_port)
                },
                false,
            ));
            let handle = Arc::clone(handle);
            let target = (target_host.to_string(), t.target_port);
            let (a, tot) = (Arc::clone(&active), Arc::clone(&total));
            let task = tokio::spawn(async move {
                while let Ok((mut sock, peer)) = listener.accept().await {
                    let handle = Arc::clone(&handle);
                    let target = target.clone();
                    let guard = track(&a, &tot);
                    tokio::spawn(async move {
                        let _guard = guard;
                        // Dynamic: the SOCKS handshake names the destination; bytes the client
                        // sent past it are forwarded first.
                        let (dest, socks, early) = if dynamic {
                            match tokio::time::timeout(Duration::from_secs(10), crate::socks::accept(&mut sock)).await {
                                Ok(Ok((req, early))) => ((req.host, req.port), Some(req.version), early),
                                _ => return,
                            }
                        } else {
                            (target, None, Vec::new())
                        };
                        let opened = handle
                            .channel_open_direct_tcpip(dest.0.clone(), dest.1 as u32, peer.ip().to_string(), peer.port() as u32)
                            .await;
                        match opened {
                            Ok(ch) => {
                                if let Some(v) = socks {
                                    if sock.write_all(&crate::socks::final_reply(v, true)).await.is_err() {
                                        return;
                                    }
                                }
                                let mut stream = ch.into_stream();
                                if !early.is_empty() && stream.write_all(&early).await.is_err() {
                                    return;
                                }
                                let _ = tokio::io::copy_bidirectional(&mut sock, &mut stream).await;
                            }
                            Err(_) => {
                                if let Some(v) = socks {
                                    let _ = sock.write_all(&crate::socks::final_reply(v, false)).await;
                                }
                            }
                        }
                    });
                }
            });
            Ok(RunningTunnel { info, task: Some(task), remote: None, active, total })
        }
        "remote" => {
            let bind = if t.listen_host.trim().is_empty() || t.listen_host.trim() == "127.0.0.1" {
                "localhost".to_string()
            } else {
                t.listen_host.trim().to_string()
            };
            let port = handle.tcpip_forward(bind.clone(), t.listen_port as u32).await.map_err(|e| {
                let msg = format!("服务器拒绝监听 {}:{}: {}", bind, t.listen_port, e);
                notes.push((format!("[远程转发{}] {}", label, msg), true));
                msg
            })?;
            let port = if port == 0 { t.listen_port as u32 } else { port };
            if let Ok(mut m) = forwards.lock() {
                m.insert(
                    port,
                    RemoteTarget {
                        host: target_host.to_string(),
                        port: t.target_port,
                        active: Arc::clone(&active),
                        total: Arc::clone(&total),
                    },
                );
            }
            info.bound_port = port as u16;
            notes.push((format!("[远程转发{}] 服务器 {}:{} → 本机 {}:{}", label, bind, port, target_host, t.target_port), false));
            Ok(RunningTunnel { info, task: None, remote: Some((bind, port)), active, total })
        }
        other => Err(format!("未知的转发类型 {}", other)),
    }
}

async fn stop_tunnel(handle: &SharedHandle, forwards: &RemoteForwards, t: RunningTunnel) {
    if let Some(task) = t.task {
        task.abort();
    }
    if let Some((bind, port)) = t.remote {
        if let Ok(mut m) = forwards.lock() {
            m.remove(&port);
        }
        let _ = handle.cancel_tcpip_forward(bind, port).await;
    }
}

fn describe(t: &TunnelStatus) -> String {
    let c = &t.config;
    match c.kind.as_str() {
        "dynamic" => format!("SOCKS {}:{}", c.listen_host, t.bound_port),
        "remote" => format!("服务器 {}:{} → 本机 {}:{}", c.listen_host, t.bound_port, c.target_host, c.target_port),
        _ => format!("{}:{} → {}:{}", c.listen_host, t.bound_port, c.target_host, c.target_port),
    }
}

fn snapshot(tunnels: &[RunningTunnel]) -> Vec<TunnelStatus> {
    tunnels
        .iter()
        .map(|t| TunnelStatus {
            active: t.active.load(AtomicOrdering::Relaxed),
            total: t.total.load(AtomicOrdering::Relaxed),
            ..t.info.clone()
        })
        .collect()
}

/// Login shells differ (fish, csh ...), so the POSIX script is sent base64-encoded and
/// piped into `sh`: only a plain pipeline has to parse in the login shell.
pub fn posix_wrap(command: &str) -> String {
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(command.as_bytes());
    format!("echo {b64} | base64 -d | sh")
}

/// Run `command` (POSIX sh) on its own exec channel (tmux integration, agent hooks).
/// Returns stdout; stderr (shell start-up noise included) only goes into errors.
async fn run_exec(handle: &SharedHandle, command: &str) -> Result<String> {
    let mut ch = handle.channel_open_session().await.context("无法打开 SSH 执行通道")?;
    ch.exec(true, posix_wrap(command)).await?;
    let mut out = Vec::new();
    let mut err = Vec::new();
    let mut status = None;
    while let Some(msg) = tokio::time::timeout(Duration::from_secs(15), ch.wait())
        .await
        .context("远程命令执行超时")?
    {
        match msg {
            ChannelMsg::Data { ref data } => out.extend_from_slice(data),
            ChannelMsg::ExtendedData { ref data, .. } => err.extend_from_slice(data),
            ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
            ChannelMsg::Close => break,
            _ => {}
        }
    }
    let text = String::from_utf8_lossy(&out).to_string();
    match status {
        Some(0) | None => Ok(text),
        Some(code) => {
            let stderr = String::from_utf8_lossy(&err);
            anyhow::bail!("命令退出码 {}: {}", code, format!("{}
{}", stderr.trim(), text.trim()).trim())
        }
    }
}

pub fn spawn_ssh_session(
    instance_id: String,
    session: SessionConfig,
    cols: u16,
    rows: u16,
    sink: Arc<dyn TerminalSink>,
    slot: SshSlot,
    reuse: Option<SshLink>,
) -> RuntimeControl {
    let (write_tx, mut write_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let (resize_tx, mut resize_rx) = mpsc::unbounded_channel::<(u16, u16)>();
    let (close_tx, mut close_rx) = mpsc::unbounded_channel::<()>();
    let (exec_tx, mut exec_rx) = mpsc::unbounded_channel::<ExecRequest>();
    let (tunnel_tx, mut tunnel_rx) = mpsc::unbounded_channel::<TunnelRequest>();

    tauri::async_runtime::spawn(async move {
        sink.emit_state(&instance_id, "connecting", None);

        let opened: Result<(SshLink, russh::Channel<client::Msg>)> = match reuse {
            Some(link) => match link.handle.channel_open_session().await {
                Ok(ch) => {
                    notice(&sink, &instance_id, "[复用连接] 已在现有 SSH 连接上打开新会话（无需重新登录）", false);
                    Ok((link, ch))
                }
                Err(e) => Err(anyhow::Error::new(e).context("无法在现有 SSH 连接上打开新会话")),
            },
            None => {
                let mut x11 = None;
                if let Some(x) = session.x11.as_ref().filter(|x| x.enabled) {
                    // May start the built-in X server (blocking: waits until it listens).
                    let setting = x.display.clone();
                    let (display, warning) = tokio::task::spawn_blocking(move || crate::xserver::resolve_display(&setting))
                        .await
                        .unwrap_or_else(|_| (x.display.clone(), None));
                    if let Some(w) = warning {
                        notice(&sink, &instance_id, &format!("[X11] {}", w), true);
                    }
                    let (host, port, screen) = parse_x11_display(&display);
                    x11 = Some((
                        Arc::new(X11Target { host, port, setting: x.display.clone(), cookie: random_bytes(16) }),
                        screen,
                    ));
                }
                establish_ssh_session(&instance_id, &session, &sink, x11.as_ref().map(|x| Arc::clone(&x.0)))
                    .await
                    .map(|(handle, forwards, channel, jump)| {
                        (Arc::new(SshShared { handle: Arc::new(handle), forwards, x11, _jump: jump }), channel)
                    })
            }
        };
        let (link, mut channel) = match opened {
            Ok(v) => v,
            Err(err) => {
                let err_msg = format!("{:#}", err);
                let banner = format!("\x1b[31m[SSH 连接错误]\x1b[0m {}\r\n", err_msg);
                sink.emit_output(&instance_id, banner.as_bytes());
                sink.emit_state(&instance_id, "error", Some(err_msg));
                return;
            }
        };
        *slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(Arc::clone(&link));
        let handle: SharedHandle = Arc::clone(&link.handle);
        let forwards = Arc::clone(&link.forwards);
        let x11 = session.x11.as_ref().filter(|x| x.enabled).and(link.x11.as_ref());

        let term_name = if session.term.trim().is_empty() {
            "xterm-256color"
        } else {
            session.term.trim()
        };

        if let Some((target, screen)) = x11 {
            match channel.request_x11(true, false, "MIT-MAGIC-COOKIE-1", hex(&target.cookie), *screen).await {
                Ok(()) => notice(&sink, &instance_id, &format!("[X11] 已转发到本机 {}:{}", target.host, target.port), false),
                Err(e) => notice(&sink, &instance_id, &format!("[X11] 服务器拒绝了 X11 转发: {}", e), true),
            }
        }

        // Locale for the remote side (servers without AcceptEnv simply ignore it).
        let _ = channel.set_env(false, "LANG", crate::charset::remote_lang(&session.charset)).await;

        if let Err(err) = channel
            .request_pty(false, term_name, cols.max(10) as u32, rows.max(2) as u32, 0, 0, &[])
            .await
        {
            let msg = format!("请求远程伪终端 (PTY) 失败: {}", err);
            sink.emit_state(&instance_id, "error", Some(msg));
            return;
        }

        if let Err(err) = channel.request_shell(false).await {
            let msg = format!("启动远程交互式 Shell 失败: {}", err);
            sink.emit_state(&instance_id, "error", Some(msg));
            return;
        }

        sink.emit_state(&instance_id, "connected", None);

        // Shell integration (see shell_integration.rs): check the login shell and upload the
        // scripts on an exec channel while the shell starts.
        let mut injector = if crate::shell_integration::enabled() { Injector::new(Instant::now()) } else { Injector::disabled() };
        let si_token = hex(&random_bytes(8));
        let (si_tx, mut si_rx) = mpsc::unbounded_channel::<bool>();
        if !injector.is_done() {
            let handle = Arc::clone(&handle);
            let script = crate::shell_integration::upload_script(&si_token);
            tokio::spawn(async move {
                let res = tokio::time::timeout(Duration::from_secs(8), run_exec(&handle, &script)).await;
                let _ = si_tx.send(matches!(res, Ok(Ok(ref out)) if crate::shell_integration::upload_ok(out)));
            });
        } else {
            drop(si_tx);
        }
        let mut si_uploaded = false;
        let mut si_cleaned = false;

        let mut tunnels: Vec<RunningTunnel> = Vec::new();
        let mut next_tunnel = 0usize;
        for t in session.tunnels.iter().filter(|t| t.enabled) {
            next_tunnel += 1;
            let mut notes = Vec::new();
            let started = start_tunnel(&handle, &forwards, format!("t{}", next_tunnel), t, &mut notes).await;
            for (text, error) in notes {
                notice(&sink, &instance_id, &text, error);
            }
            if let Ok(rt) = started {
                tunnels.push(rt);
            }
        }

        // Sent once the integration loader is through, so it never types into the startup program.
        let mut startup = session.startup_command.clone().filter(|s| !s.trim().is_empty());
        // Output goes out on its own thread: keys still go through while the screen is behind.
        let mut pump = OutputPump::new(Arc::clone(&sink), instance_id.clone());

        loop {
            if injector.is_done() {
                if let Some(mut line) = startup.take() {
                    line.push('\n');
                    let _ = channel.data(line.as_bytes()).await;
                }
                if si_uploaded && !injector.loaded && !si_cleaned {
                    si_cleaned = true;
                    let handle = Arc::clone(&handle);
                    let script = crate::shell_integration::cleanup_script(&si_token);
                    tokio::spawn(async move {
                        let _ = run_exec(&handle, &script).await;
                    });
                }
            }
            let si_deadline = injector.deadline().map(tokio::time::Instant::from_std);
            tokio::select! {
                // Not read while output waits for room: the SSH window then holds the remote back.
                msg = channel.wait(), if !pump.is_behind() => {
                    match msg {
                        Some(ChannelMsg::Data { ref data }) | Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                            if injector.is_done() {
                                pump.output(data);
                            } else {
                                let shown = injector.output(data, Instant::now());
                                pump.output(&shown);
                            }
                        }
                        Some(ChannelMsg::ExitStatus { exit_status }) => {
                            pump.state("disconnected", Some(format!("远程进程已退出 (状态码 {})", exit_status)));
                            break;
                        }
                        Some(ChannelMsg::Eof) | None => {
                            pump.state("disconnected", Some("SSH 会话已关闭".into()));
                            break;
                        }
                        _ => {}
                    }
                }
                _ = pump.flush(), if pump.is_behind() => {}
                Some(bytes) = write_rx.recv() => {
                    injector.user_input(&bytes);
                    if let Err(e) = channel.data(&bytes[..]).await {
                        pump.state("disconnected", Some(format!("SSH 发送失败: {}", e)));
                        break;
                    }
                }
                Some((new_cols, new_rows)) = resize_rx.recv() => {
                    let _ = channel
                        .window_change(new_cols.max(10) as u32, new_rows.max(2) as u32, 0, 0)
                        .await;
                }
                Some(req) = tunnel_rx.recv() => match req {
                    TunnelRequest::List(reply) => {
                        let _ = reply.send(snapshot(&tunnels));
                    }
                    TunnelRequest::Start(cfg, reply) => {
                        next_tunnel += 1;
                        let mut notes = Vec::new();
                        let res = start_tunnel(&handle, &forwards, format!("t{}", next_tunnel), &cfg, &mut notes).await;
                        // Through the pump like the output: after what is queued, never inside it.
                        for (text, error) in notes {
                            pump.output(notice_line(&text, error).as_bytes());
                        }
                        let res = res.map(|rt| {
                            tunnels.push(rt);
                            snapshot(&tunnels)
                        });
                        let _ = reply.send(res);
                    }
                    TunnelRequest::Stop(id, reply) => {
                        if let Some(pos) = tunnels.iter().position(|t| t.info.id == id) {
                            let rt = tunnels.remove(pos);
                            let label = describe(&rt.info);
                            stop_tunnel(&handle, &forwards, rt).await;
                            pump.output(notice_line(&format!("[端口转发] 已停止 {}", label), false).as_bytes());
                        }
                        let _ = reply.send(snapshot(&tunnels));
                    }
                },
                Some(ok) = si_rx.recv() => {
                    si_uploaded = ok;
                    injector.set_shell_ok(ok);
                }
                _ = async { tokio::time::sleep_until(si_deadline.unwrap()).await }, if si_deadline.is_some() => {
                    match injector.tick(Instant::now()) {
                        Step::Inject => {
                            let line = crate::shell_integration::loader_line(&si_token);
                            let _ = channel.data(line.as_bytes()).await;
                        }
                        Step::Emit(bytes) => pump.output(&bytes),
                        Step::Nothing => {}
                    }
                }
                Some(req) = exec_rx.recv() => {
                    let handle = Arc::clone(&handle);
                    tokio::spawn(async move {
                        let res = run_exec(&handle, &req.command).await.map_err(|e| format!("{:#}", e));
                        let _ = req.reply.send(res);
                    });
                }
                Some(()) = close_rx.recv() => {
                    let _ = channel.eof().await;
                    let _ = channel.close().await;
                    pump.state("disconnected", Some("已断开连接".into()));
                    break;
                }
            }
        }
        pump.finish().await;
        for t in tunnels.drain(..) {
            stop_tunnel(&handle, &forwards, t).await;
        }
        // Other panes may still run on this connection; the last one closes it.
        slot.lock().unwrap_or_else(|e| e.into_inner()).take();
        if Arc::strong_count(&link) == 1 {
            let _ = handle.disconnect(Disconnect::ByApplication, "Closed by user", "en").await;
        }
    });

    RuntimeControl::Async(AsyncChannels {
        write_tx,
        resize_tx,
        close_tx,
        exec_tx: Some(exec_tx),
        tunnel_tx: Some(tunnel_tx),
    })
}

type Established = (
    client::Handle<SshHandler>,
    RemoteForwards,
    russh::Channel<client::Msg>,
    Option<client::Handle<SshHandler>>,
);

fn map_connect_error(err: russh::Error, host: &str, port: u16) -> anyhow::Error {
    match err {
        russh::Error::UnknownKey => anyhow::anyhow!("{}:{} 的主机密钥未被信任，已取消连接", host, port),
        other => anyhow::Error::new(other).context(format!("与 {}:{} 的 SSH 握手失败", host, port)),
    }
}

/// russh 的默认算法加上旧设备（防火墙、交换机等）常用的 SHA-1 / NIST ECDH 密钥交换、CBC 加密和 hmac-sha1。
/// 旧算法排在最后：协商取客户端列表里第一个双方都支持的，新服务器仍会选到安全算法。
fn compat_preferred() -> russh::Preferred {
    use russh::{cipher, kex, mac};
    let base = russh::Preferred::DEFAULT;
    let is_ext = |n: &kex::Name| {
        [
            kex::EXTENSION_SUPPORT_AS_CLIENT,
            kex::EXTENSION_SUPPORT_AS_SERVER,
            kex::EXTENSION_OPENSSH_STRICT_KEX_AS_CLIENT,
            kex::EXTENSION_OPENSSH_STRICT_KEX_AS_SERVER,
        ]
        .contains(n)
    };
    let mut kexes: Vec<kex::Name> = base.kex.iter().copied().filter(|n| !is_ext(n)).collect();
    kexes.extend([
        kex::ECDH_SHA2_NISTP256,
        kex::ECDH_SHA2_NISTP384,
        kex::ECDH_SHA2_NISTP521,
        kex::DH_G14_SHA1,
        kex::DH_GEX_SHA1,
        kex::DH_G1_SHA1,
    ]);
    kexes.extend(base.kex.iter().copied().filter(|n| is_ext(n)));

    let mut ciphers = base.cipher.to_vec();
    ciphers.extend([cipher::AES_128_GCM, cipher::AES_256_CBC, cipher::AES_192_CBC, cipher::AES_128_CBC]);
    let mut macs = base.mac.to_vec();
    macs.extend([mac::HMAC_SHA1_ETM, mac::HMAC_SHA1]);

    russh::Preferred {
        kex: kexes.into(),
        cipher: ciphers.into(),
        mac: macs.into(),
        ..base
    }
}

async fn establish_ssh_session(
    instance_id: &str,
    session: &SessionConfig,
    sink: &Arc<dyn TerminalSink>,
    x11: Option<Arc<X11Target>>,
) -> Result<Established> {
    let mut cfg = client::Config { preferred: compat_preferred(), ..Default::default() };
    if session.keep_alive_secs > 0 {
        cfg.keepalive_interval = Some(Duration::from_secs(session.keep_alive_secs));
        cfg.keepalive_max = 3;
    }
    cfg.inactivity_timeout = None;
    let cfg = Arc::new(cfg);

    let username = session.username.trim().to_string();
    if username.is_empty() {
        anyhow::bail!("未设置登录用户名");
    }

    let mut handler = SshHandler::new(instance_id, &session.host, session.port, session.skip_host_key_check, Arc::clone(sink));
    handler.x11 = x11;
    let forwards = Arc::clone(&handler.remote_forwards);
    let proxy = session.proxy.as_ref();

    let (mut target_handle, jump_guard) = match session
        .jump_host
        .as_ref()
        .filter(|j| j.enabled && !j.host.trim().is_empty())
    {
        Some(jump) => {
            let jump_handle = connect_and_authenticate_jump(&cfg, instance_id, session, jump, sink).await?;
            let direct_channel = jump_handle
                .channel_open_direct_tcpip(session.host.trim(), session.port as u32, "127.0.0.1", 0)
                .await
                .with_context(|| {
                    format!(
                        "无法通过跳板机 {}:{} 建立到 {}:{} 的隧道",
                        jump.host, jump.port, session.host, session.port
                    )
                })?;

            let stream = direct_channel.into_stream();
            let handle = client::connect_stream(Arc::clone(&cfg), stream, handler)
                .await
                .map_err(|e| map_connect_error(e, &session.host, session.port))?;
            (handle, Some(jump_handle))
        }
        None => {
            let stream =
                connect_stream(session.host.trim(), session.port, &username, proxy, Duration::from_secs(20)).await?;
            let handle = client::connect_stream(Arc::clone(&cfg), stream, handler)
                .await
                .map_err(|e| map_connect_error(e, &session.host, session.port))?;
            (handle, None)
        }
    };

    authenticate_handle(
        &mut target_handle,
        &username,
        &session.auth_type,
        session.password.as_deref(),
        session.private_key_path.as_deref(),
        session.passphrase.as_deref(),
    )
    .await?;

    let channel = target_handle
        .channel_open_session()
        .await
        .context("无法打开 SSH 会话通道")?;

    Ok((target_handle, forwards, channel, jump_guard))
}

/// Keeps the jump host's SSH connection alive for a tunnel opened by [`jump_tunnel`].
pub(crate) struct JumpTunnel {
    _handle: client::Handle<SshHandler>,
}

/// Log in to the session's jump host and open a direct-tcpip channel to `session.host:port`
/// (RDP / VNC panes through an SSH jump host). The stream lives while the guard does.
pub(crate) async fn jump_tunnel(
    instance_id: &str,
    session: &SessionConfig,
    jump: &JumpHostConfig,
    sink: &Arc<dyn TerminalSink>,
) -> Result<(BoxedStream, JumpTunnel)> {
    let mut cfg = client::Config { preferred: compat_preferred(), ..Default::default() };
    cfg.keepalive_interval = Some(Duration::from_secs(session.keep_alive_secs.max(15)));
    cfg.keepalive_max = 3;
    cfg.inactivity_timeout = None;
    let cfg = Arc::new(cfg);
    let handle = connect_and_authenticate_jump(&cfg, instance_id, session, jump, sink).await?;
    let channel = handle
        .channel_open_direct_tcpip(session.host.trim(), session.port as u32, "127.0.0.1", 0)
        .await
        .with_context(|| {
            format!(
                "无法通过跳板机 {}:{} 建立到 {}:{} 的隧道",
                jump.host, jump.port, session.host, session.port
            )
        })?;
    Ok((Box::new(channel.into_stream()), JumpTunnel { _handle: handle }))
}

async fn connect_and_authenticate_jump(
    cfg: &Arc<client::Config>,
    instance_id: &str,
    session: &SessionConfig,
    jump: &JumpHostConfig,
    sink: &Arc<dyn TerminalSink>,
) -> Result<client::Handle<SshHandler>> {
    let stream = connect_stream(jump.host.trim(), jump.port, jump.username.trim(), session.proxy.as_ref(), Duration::from_secs(20))
        .await
        .with_context(|| format!("无法连接到跳板机 {}:{}", jump.host, jump.port))?;
    let handler = SshHandler::new(instance_id, &jump.host, jump.port, session.skip_host_key_check, Arc::clone(sink));
    let mut handle = client::connect_stream(Arc::clone(cfg), stream, handler)
        .await
        .map_err(|e| map_connect_error(e, &jump.host, jump.port))?;

    let jump_user = jump.username.trim();
    if jump_user.is_empty() {
        anyhow::bail!("未设置跳板机登录用户名");
    }

    authenticate_handle(
        &mut handle,
        jump_user,
        &jump.auth_type,
        jump.password.as_deref(),
        jump.private_key_path.as_deref(),
        jump.passphrase.as_deref(),
    )
    .await
    .with_context(|| format!("跳板机认证失败 ({}@{})", jump_user, jump.host))?;

    Ok(handle)
}


async fn authenticate_handle(
    handle: &mut client::Handle<SshHandler>,
    username: &str,
    auth_type: &AuthType,
    password: Option<&str>,
    private_key_path: Option<&str>,
    passphrase: Option<&str>,
) -> Result<()> {
    match auth_type {
        AuthType::PrivateKey => {
            let key_path = private_key_path
                .filter(|p| !p.trim().is_empty())
                .map(expand_tilde)
                .or_else(default_user_ssh_key)
                .context("未指定 SSH 私钥文件路径")?;

            let pass_opt = passphrase.filter(|p| !p.is_empty());
            let key_pair = load_secret_key(&key_path, pass_opt)
                .with_context(|| format!("读取 SSH 私钥失败 '{}'", key_path))?;

            let best_hash = handle
                .best_supported_rsa_hash()
                .await
                .ok()
                .flatten()
                .flatten();

            let key_with_alg = PrivateKeyWithHashAlg::new(Arc::new(key_pair), best_hash);
            let auth_res = handle
                .authenticate_publickey(username, key_with_alg)
                .await
                .context("公钥认证请求失败")?;

            if !auth_res.success() {
                // Same as WindTerm with both public key and password enabled:
                // fall back to the password when the key is rejected.
                match password.filter(|p| !p.is_empty()) {
                    Some(pwd) => authenticate_password(handle, username, pwd).await?,
                    None => anyhow::bail!("服务器拒绝了用户 '{}' 的私钥认证", username),
                }
            }
        }
        AuthType::Password | AuthType::None => {
            authenticate_password(handle, username, password.unwrap_or("")).await?;
        }
    }
    Ok(())
}

async fn authenticate_password(
    handle: &mut client::Handle<SshHandler>,
    username: &str,
    pwd: &str,
) -> Result<()> {
    let auth_res = handle
        .authenticate_password(username, pwd)
        .await
        .context("密码认证请求失败")?;

    if !auth_res.success() {
        let kbd_res = handle
            .authenticate_keyboard_interactive_start(username, None)
            .await;
        if let Ok(client::KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. }) =
            kbd_res
        {
            let responses = vec![pwd.to_string(); prompts.len()];
            let step2 = handle
                .authenticate_keyboard_interactive_respond(responses)
                .await
                .context("交互式认证响应失败")?;
            if !matches!(step2, client::KeyboardInteractiveAuthResponse::Success) {
                anyhow::bail!("用户 '{}' 身份验证失败：密码错误", username);
            }
        } else {
            anyhow::bail!("用户 '{}' 身份验证失败：密码错误", username);
        }
    }
    Ok(())
}

fn default_user_ssh_key() -> Option<String> {
    let home = dirs::home_dir()?;
    let ssh_dir = home.join(".ssh");
    for candidate in ["id_ed25519", "id_rsa", "id_ecdsa"] {
        let p = ssh_dir.join(candidate);
        if p.is_file() {
            return Some(p.to_string_lossy().to_string());
        }
    }
    None
}

#[cfg(test)]
mod exec_wrap_tests {
    #[test]
    fn wraps_into_a_plain_pipeline() {
        let w = super::posix_wrap("if [ -f x ]; then echo 'a'; fi");
        assert!(w.starts_with("echo ") && w.ends_with(" | base64 -d | sh"));
        assert!(!w[5..w.len() - 18].contains(|c: char| " ;'\"$&|<>".contains(c)));
    }
}

#[cfg(test)]
mod algorithm_tests {
    use russh::{cipher, kex, mac};

    #[test]
    fn legacy_algorithms_follow_the_safe_defaults() {
        let p = super::compat_preferred();
        let pos = |n: kex::Name| p.kex.iter().position(|k| *k == n).unwrap();
        // 安全算法仍然优先，旧算法排在后面，扩展标记仍在末尾
        assert_eq!(p.kex[0], russh::Preferred::DEFAULT.kex[0]);
        assert!(pos(kex::DH_G14_SHA256) < pos(kex::ECDH_SHA2_NISTP256));
        assert!(pos(kex::DH_G1_SHA1) < pos(kex::EXTENSION_SUPPORT_AS_CLIENT));
        assert!(p.cipher.contains(&cipher::AES_128_CBC));
        assert!(p.mac.contains(&mac::HMAC_SHA1));
        assert_eq!(p.cipher[0], russh::Preferred::DEFAULT.cipher[0]);
        assert_eq!(p.mac[0], russh::Preferred::DEFAULT.mac[0]);
    }
}

/// Against a real sshd: `WT_SI_PORT=2222 WT_SI_USER=me WT_SI_KEY=path cargo test --lib ssh_e2e -- --ignored`.
#[cfg(test)]
mod ssh_e2e {
    use super::*;

    #[derive(Default)]
    struct Collect {
        out: Mutex<Vec<u8>>,
    }

    impl TerminalSink for Collect {
        fn emit_output(&self, _id: &str, data: &[u8]) {
            self.out.lock().unwrap().extend_from_slice(data);
        }
        fn emit_state(&self, _id: &str, status: &str, message: Option<String>) {
            eprintln!("state {status} {message:?}");
        }
    }

    fn wait_for(sink: &Collect, what: &str, count: usize, secs: u64) -> String {
        let end = std::time::Instant::now() + Duration::from_secs(secs);
        loop {
            let text = String::from_utf8_lossy(&sink.out.lock().unwrap()).to_string();
            if text.matches(what).count() >= count || std::time::Instant::now() > end {
                return text;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    #[test]
    #[ignore]
    fn shell_integration_is_injected_and_hidden() {
        let env = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.to_string());
        let key = env("WT_SI_KEY", &std::env::temp_dir().join("wtsi").join("client").to_string_lossy());
        let session: SessionConfig = serde_json::from_value(serde_json::json!({
            "id": "t", "label": "t", "protocol": "ssh", "host": "127.0.0.1",
            "port": env("WT_SI_PORT", "2222").parse::<u16>().unwrap(), "username": env("WT_SI_USER", "root"),
            "authType": "privatekey", "privateKeyPath": key, "skipHostKeyCheck": true,
        }))
        .unwrap();
        let sink = Arc::new(Collect::default());
        let ctl = spawn_ssh_session("t".into(), session, 120, 30, sink.clone(), Arc::default(), None);
        let before = wait_for(&sink, "\x1b]133;A", 1, 20);
        assert!(before.contains("\x1b]133;A"), "integration never loaded: {before:?}");
        ctl.send_write(b"sleep 0.3; echo \"a\\b\"\r");
        let text = wait_for(&sink, "\x1b]133;A", 2, 10);
        ctl.send_write(b"exit\r");
        std::thread::sleep(Duration::from_millis(500));
        eprintln!("OUTPUT {:?}", text);
        assert!(!text.contains(".nexterm-si-"), "loader line showed");
        assert!(!text.contains("NextermShellIntegration"), "ready mark showed");
        // Wire format: `;` -> `\x3b`, `\` -> `\\` (VS Code's OSC 633 escaping).
        assert!(text.contains(r#"]633;E;sleep 0.3\x3b echo "a\\b""#), "no command line");
        assert!(text.contains("\x1b]133;C\x07") && text.contains("\x1b]133;D;0\x07"));
    }
}
