//! Where the adb server is: on this computer (127.0.0.1:5037), or on a Linux host behind a
//! connected SSH pane (its own 127.0.0.1:5037, reached over that SSH connection). Every
//! adb operation opens a fresh server socket through its device's route, so all features
//! (shell, files, logcat, mirror ...) work the same either way.
//!
//! Over SSH, a server socket is a `direct-tcpip` channel when the server allows forwarding,
//! else an exec channel running `nc 127.0.0.1 5037` (bastions such as JumpServer often
//! refuse forwarding). The first connection finds out which and remembers it; when nothing
//! listens on the host yet, `adb start-server` is run there once.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::net::BoxedStream;
use crate::ssh_conn::SshLink;

#[derive(Clone, Default)]
pub enum Route {
    #[default]
    Local,
    Ssh(Arc<SshRoute>),
}

impl std::fmt::Debug for Route {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.key())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// `direct-tcpip` to 127.0.0.1:5037.
    Forward,
    /// `nc 127.0.0.1 5037` on an exec channel.
    Exec,
}

pub struct SshRoute {
    pane: String,
    link: SshLink,
    mode: Mutex<Option<Mode>>,
    /// Finding the mode (and starting the server) happens once at a time.
    probing: tokio::sync::Mutex<()>,
}

/// The netcat relay, through sh (the login shell may be fish). OpenBSD nc (Ubuntu's) gets
/// `-N` (its help lists it tab-indented) so the server socket is shut once the channel
/// closes; busybox / traditional nc end on the broken pipe instead.
const RELAY: &str = "sh -c 'if command -v nc >/dev/null 2>&1; then \
                     if nc -h 2>&1 | grep -q -- -N; then exec nc -N 127.0.0.1 5037; fi; exec nc 127.0.0.1 5037; \
                     elif command -v busybox >/dev/null 2>&1; then exec busybox nc 127.0.0.1 5037; \
                     else echo NEXTERM_NO_NC >&2; exit 127; fi'";

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// One route per SSH pane (keeps what was learnt about the host); replaced when the pane
/// reconnected (a new link).
fn routes() -> &'static Mutex<HashMap<String, Arc<SshRoute>>> {
    static R: OnceLock<Mutex<HashMap<String, Arc<SshRoute>>>> = OnceLock::new();
    R.get_or_init(Default::default)
}

impl Route {
    /// The adb server of the host `pane` is connected to.
    pub fn ssh(pane: &str, link: SshLink) -> Route {
        let mut map = lock(routes());
        if let Some(r) = map.get(pane).filter(|r| Arc::ptr_eq(&r.link, &link)) {
            return Route::Ssh(Arc::clone(r));
        }
        let r = Arc::new(SshRoute { pane: pane.to_string(), link, mode: Mutex::new(None), probing: Default::default() });
        map.insert(pane.to_string(), Arc::clone(&r));
        Route::Ssh(r)
    }

    /// Identifies the server (cache keys): "local" or "ssh:<pane>".
    pub fn key(&self) -> String {
        match self {
            Route::Local => "local".into(),
            Route::Ssh(r) => format!("ssh:{}", r.pane),
        }
    }

    pub fn is_local(&self) -> bool {
        matches!(self, Route::Local)
    }
}

impl SshRoute {
    async fn open(&self, mode: Mode) -> Result<BoxedStream> {
        Ok(match mode {
            Mode::Forward => Box::new(self.link.open_direct("127.0.0.1", 5037).await?.into_stream()),
            Mode::Exec => Box::new(self.link.open_exec(RELAY).await?.into_stream()),
        })
    }

    /// A server socket over SSH.
    pub async fn connect(&self) -> Result<BoxedStream> {
        let known = *lock(&self.mode);
        if let Some(mode) = known {
            return self.open(mode).await;
        }
        let _guard = self.probing.lock().await;
        let known = *lock(&self.mode);
        if let Some(mode) = known {
            return self.open(mode).await;
        }
        let mode = match self.probe().await {
            Ok(m) => m,
            Err(first) => {
                // Nothing listening yet: start the host's server once and look again.
                self.start_server().await.with_context(|| format!("{:#}", first))?;
                self.probe().await?
            }
        };
        *lock(&self.mode) = Some(mode);
        self.open(mode).await
    }

    /// Which way reaches a server answering `host:version`.
    async fn probe(&self) -> Result<Mode> {
        let mut errors = Vec::new();
        for mode in [Mode::Forward, Mode::Exec] {
            match tokio::time::timeout(Duration::from_secs(8), self.check(mode)).await {
                Ok(Ok(())) => return Ok(mode),
                Ok(Err(e)) => errors.push(format!("{}：{:#}", mode_name(mode), e)),
                Err(_) => errors.push(format!("{}：超时", mode_name(mode))),
            }
        }
        bail!("无法经 SSH 连接远端的 adb server（{}）", errors.join("；"))
    }

    async fn check(&self, mode: Mode) -> Result<()> {
        let mut s = self.open(mode).await?;
        s.write_all(&super::client::encode_request("host:version")).await?;
        let mut head = [0u8; 4];
        s.read_exact(&mut head).await.context("没有回应")?;
        if &head != b"OKAY" {
            bail!("回复不是 adb 协议（{}）", String::from_utf8_lossy(&head).escape_debug());
        }
        Ok(())
    }

    async fn start_server(&self) -> Result<()> {
        let out = tokio::time::timeout(
            Duration::from_secs(20),
            self.link.exec_output("command -v adb >/dev/null 2>&1 || { echo NEXTERM_NO_ADB; exit 0; }; adb start-server 2>&1"),
        )
        .await
        .context("在远端启动 adb server 超时")?
        .context("无法在远端执行命令（请在那台主机上手动运行 adb start-server）")?;
        if out.contains("NEXTERM_NO_ADB") {
            bail!("远端主机没有安装 adb（例如 apt install adb）");
        }
        Ok(())
    }
}

fn mode_name(mode: Mode) -> &'static str {
    match mode {
        Mode::Forward => "端口转发",
        Mode::Exec => "nc 中转",
    }
}


type Lookup = Box<dyn Fn(&str) -> Result<SshLink> + Send + Sync>;

static LOOKUP: OnceLock<Lookup> = OnceLock::new();

/// How to find a pane's SSH connection (set once at start-up: the connection manager).
pub fn set_lookup(f: Lookup) {
    let _ = LOOKUP.set(f);
}

/// The server a session's device is on: the host of its `via` SSH pane, else this computer.
pub fn for_via(via: Option<&str>) -> Result<Route> {
    let Some(pane) = via.map(str::trim).filter(|p| !p.is_empty()) else { return Ok(Route::Local) };
    let lookup = LOOKUP.get().context("SSH 连接不可用")?;
    let link = lookup(pane).context("经由的 SSH 窗格已关闭或未连接，请重新连接它")?;
    Ok(Route::ssh(pane, link))
}
