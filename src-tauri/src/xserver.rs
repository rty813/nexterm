//! Built-in X server: the VcXsrv bundled with the app (resources/vcxsrv), started on
//! demand for SSH X11 forwarding.
//!
//! Lookup order for vcxsrv.exe: the configured path, the bundled copy, then a standalone
//! VcXsrv installation.

use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// Called with the new status whenever it changes (the app emits `xserver-state`).
type Notify = Box<dyn Fn(XServerStatus) + Send>;

/// Settings > X Server (AppSettings.xserver).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct XServerConfig {
    /// Start the X server for SSH sessions with X11 forwarding when none is running.
    pub enabled: bool,
    /// Start it with the app (xserver.autoStart).
    pub auto_start: bool,
    /// vcxsrv.exe; empty = find it automatically.
    pub path: String,
    /// Display number; -1 = first free one (xserver.displayNumber).
    pub display: i32,
    /// "multiwindow" | "rootless" | "fullscreen" | "windowed" (xserver.windowMode).
    pub window_mode: String,
    pub clipboard: bool,
    pub primary_selection: bool,
    pub keyhook: bool,
    pub tray_icon: bool,
    /// Keyboard layout, e.g. "us", "de"; empty or "auto" = Windows layout.
    pub xkb_layout: String,
    pub xkb_model: String,
    /// Allow X clients from other hosts too (-ac). Off: only this computer.
    pub disable_access_control: bool,
    /// Extra command line arguments.
    pub extra_args: String,
}

impl Default for XServerConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            auto_start: false,
            path: String::new(),
            display: -1,
            window_mode: "multiwindow".into(),
            clipboard: true,
            primary_selection: true,
            keyhook: false,
            tray_icon: false,
            xkb_layout: "auto".into(),
            xkb_model: "pc105".into(),
            disable_access_control: false,
            extra_args: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct XServerStatus {
    pub running: bool,
    /// Display we started on (or found running), e.g. 0 for ":0".
    pub display: Option<u16>,
    pub pid: Option<u32>,
    /// vcxsrv.exe that would be (or was) started; None when not found.
    pub executable: Option<String>,
    pub enabled: bool,
    pub message: Option<String>,
}

struct State {
    config: XServerConfig,
    child: Option<Child>,
    display: Option<u16>,
    notify: Option<Notify>,
    message: Option<String>,
}

fn state() -> MutexGuard<'static, State> {
    static STATE: OnceLock<Mutex<State>> = OnceLock::new();
    STATE
        .get_or_init(|| {
            Mutex::new(State {
                config: XServerConfig::default(),
                child: None,
                display: None,
                notify: None,
                message: None,
            })
        })
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

pub fn init(notify: Notify, config: XServerConfig) {
    let auto = config.auto_start;
    {
        let mut s = state();
        s.notify = Some(notify);
        s.config = config;
    }
    if auto {
        std::thread::spawn(|| {
            let _ = start(None);
        });
    }
}

pub fn configure(config: XServerConfig) {
    state().config = config;
    emit_status();
}

fn port_open(port: u16) -> bool {
    let v4 = SocketAddr::from(([127, 0, 0, 1], port));
    let v6 = SocketAddr::from((std::net::Ipv6Addr::LOCALHOST, port));
    // VcXsrv may only get one of them (IPv4 still in TIME_WAIT after a restart ...).
    TcpStream::connect_timeout(&v4, Duration::from_millis(150)).is_ok()
        || TcpStream::connect_timeout(&v6, Duration::from_millis(150)).is_ok()
}

fn display_running(n: u16) -> bool {
    port_open(6000 + n)
}

pub fn find_executable(config: &XServerConfig) -> Option<PathBuf> {
    let configured = config.path.trim();
    if !configured.is_empty() {
        let p = PathBuf::from(configured);
        let p = if p.is_dir() { p.join("vcxsrv.exe") } else { p };
        return p.is_file().then_some(p);
    }
    // The VcXsrv bundled with this app; else a standalone VcXsrv installation.
    let mut candidates = vec![crate::app_paths::resource("vcxsrv").join("vcxsrv.exe")];
    for var in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
        if let Ok(pf) = std::env::var(var) {
            candidates.push(Path::new(&pf).join("VcXsrv").join("vcxsrv.exe"));
        }
    }
    candidates.into_iter().find(|p| p.is_file())
}

/// VcXsrv reads its host access list from `X<display>.hosts`; without one every client is
/// refused. The list allows this computer only.
/// VcXsrv reads it from its working directory, so it is written to the app's data folder
/// (`xserver/`) and the server runs from there; the program folder is never written to.
fn ensure_hosts_file(work_dir: &Path, display: u16) -> Result<(), String> {
    std::fs::create_dir_all(work_dir).map_err(|e| format!("无法创建 {}: {}", work_dir.display(), e))?;
    let path = work_dir.join(format!("X{}.hosts", display));
    if path.is_file() {
        return Ok(());
    }
    let content = b"localhost\r\ninet6:localhost\r\n".to_vec();
    std::fs::write(&path, content).map_err(|e| {
        format!(
            "无法创建 {}（{}）。显示号 :{} 需要这个访问列表文件，请让该目录可写，或在 设置 › X 服务器 中勾选“允许其它主机连接”",
            path.display(),
            e,
            display
        )
    })
}

fn build_args(config: &XServerConfig, display: u16) -> Vec<String> {
    let mut args = vec![format!(":{}", display)];
    match config.window_mode.as_str() {
        "rootless" => args.push("-rootless".into()),
        "fullscreen" => args.push("-fullscreen".into()),
        "windowed" => {}
        _ => args.push("-multiwindow".into()),
    }
    args.push(if config.clipboard { "-clipboard" } else { "-noclipboard" }.into());
    args.push(if config.primary_selection { "-primary" } else { "-noprimary" }.into());
    args.push(if config.keyhook { "-keyhook" } else { "-nokeyhook" }.into());
    args.push(if config.tray_icon { "-trayicon" } else { "-notrayicon" }.into());
    args.push("-wgl".into());
    // Without it the server resets whenever its last client leaves (e.g. after xclock or a
    // port probe), and the multi-window manager quits during the reset.
    args.push("-noreset".into());
    args.push("-silent-dup-error".into());
    let layout = config.xkb_layout.trim();
    if !layout.is_empty() && !layout.eq_ignore_ascii_case("auto") {
        args.push("-xkblayout".into());
        args.push(layout.into());
    }
    let model = config.xkb_model.trim();
    if !model.is_empty() {
        args.push("-xkbmodel".into());
        args.push(model.into());
    }
    if config.disable_access_control {
        args.push("-ac".into());
    }
    args.extend(config.extra_args.split_whitespace().map(str::to_string));
    args
}

/// Whether the X server we started is still alive (reaps it when it exited).
fn child_alive(s: &mut State) -> bool {
    match s.child.as_mut().map(|c| c.try_wait()) {
        Some(Ok(None)) => true,
        Some(_) => {
            s.child = None;
            s.display = None;
            false
        }
        None => false,
    }
}

pub fn status() -> XServerStatus {
    let mut s = state();
    let alive = child_alive(&mut s);
    XServerStatus {
        running: alive,
        display: if alive { s.display } else { None },
        pid: s.child.as_ref().map(|c| c.id()),
        executable: find_executable(&s.config).map(|p| p.to_string_lossy().to_string()),
        enabled: s.config.enabled,
        message: s.message.clone(),
    }
}

fn emit_status() {
    let current = status();
    if let Some(notify) = state().notify.as_ref() {
        notify(current);
    }
}

/// Start the built-in X server on `display` (None: the configured number, or the first
/// free one). Returns the display number in use.
/// Whether we may listen on the display's TCP port. Windows reserves port ranges for
/// Hyper-V / WSL / Docker (`netsh int ipv4 show excludedportrange protocol=tcp`), often
/// 5799-6498, which blocks displays :0 to :498 although nothing listens there.
fn display_bindable(n: u16) -> bool {
    let Some(port) = 6000u16.checked_add(n) else { return false };
    std::net::TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], port))).is_ok()
}

/// First display number nobody serves and whose port can be bound. The bind test goes first:
/// it fails at once for reserved ports, while a connect to a closed port takes the timeout.
fn free_display() -> Option<u16> {
    (0..2000u16).find(|n| display_bindable(*n) && !display_running(*n))
}

pub fn start(display: Option<u16>) -> Result<u16, String> {
    // Sessions restored at startup ask together; start one server, not one each.
    static STARTING: Mutex<()> = Mutex::new(());
    let _one_at_a_time = STARTING.lock().unwrap_or_else(|e| e.into_inner());
    let result = start_inner(display);
    {
        let mut s = state();
        s.message = result.as_ref().err().cloned();
    }
    emit_status();
    result
}

fn start_inner(display: Option<u16>) -> Result<u16, String> {
    let mut s = state();
    if child_alive(&mut s) {
        if let Some(d) = s.display {
            // Ours serves every request that no other X server answers.
            if display.is_none() || display == Some(d) || display.is_some_and(|n| !display_running(n)) {
                return Ok(d);
            }
        }
    }
    let config = s.config.clone();
    let exe = find_executable(&config).ok_or_else(|| {
        "未找到 vcxsrv.exe：程序自带的 vcxsrv 文件夹缺失，请重新安装，或安装 VcXsrv / 在 设置 › X 服务器 中指定路径".to_string()
    })?;
    let wanted = display.or(if config.display >= 0 { Some(config.display as u16) } else { None });
    let n = match wanted {
        Some(n) if display_running(n) => {
            // Someone else's X server (VcXsrv, Xming ...) already serves it.
            return Ok(n);
        }
        Some(n) if display_bindable(n) => n,
        // The port is reserved by Windows (or taken): use the first usable display.
        _ => free_display().ok_or("没有可用的 X 显示号（6000 起的端口都被占用或被系统保留）")?,
    };
    let work_dir = crate::app_paths::data_dir().join("xserver");
    if !config.disable_access_control {
        ensure_hosts_file(&work_dir, n)?;
    }
    let mut cmd = Command::new(&exe);
    cmd.args(build_args(&config, n));
    // Don't hand it our console / pipes (it would keep them open after we exit).
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let _ = std::fs::create_dir_all(&work_dir);
    cmd.current_dir(&work_dir);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| format!("无法启动 {}: {}", exe.display(), e))?;
    drop(s);
    // Wait until it listens (or dies).
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        // "Its port got bound" instead of connecting: no extra client comes and goes.
        if !display_bindable(n) {
            break;
        }
        if let Ok(Some(code)) = child.try_wait() {
            return Err(format!("X 服务器启动后立即退出（{}）", code));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            return Err("X 服务器启动超时".into());
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    let mut s = state();
    s.child = Some(child);
    s.display = Some(n);
    Ok(n)
}

pub fn stop() {
    {
        let mut s = state();
        if let Some(mut child) = s.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        s.display = None;
        s.message = None;
    }
    emit_status();
}

/// The X display an SSH session forwards to, plus a warning to show when the built-in
/// server could not be used. "" / "auto" = the built-in server; a local display nobody
/// serves starts the built-in server (on another number when that one is unusable).
pub fn resolve_display(setting: &str) -> (String, Option<String>) {
    let d = setting.trim();
    let enabled = state().config.enabled;
    let auto = d.is_empty() || d.eq_ignore_ascii_case("auto") || d.eq_ignore_ascii_case("builtin");
    // Auto: an X server the user already runs on :0 (VcXsrv, Xming ...) is used as is.
    if auto && display_running(0) {
        return ("localhost:0.0".into(), None);
    }
    let (host, rest) = d.rsplit_once(':').unwrap_or((d, "0"));
    let local = auto || matches!(host, "" | "localhost" | "127.0.0.1" | "unix");
    let n: Option<u16> = if auto { None } else { rest.split('.').next().and_then(|n| n.parse().ok()) };
    if !local || n.is_some_and(display_running) {
        return (d.to_string(), None);
    }
    if !enabled {
        let hint = "本机没有 X 服务器在运行，内置 X 服务器已在 设置 › X 服务器 中关闭".to_string();
        return (if auto { "localhost:0.0".into() } else { d.to_string() }, Some(hint));
    }
    match start(n) {
        Ok(actual) => (format!("localhost:{}.0", actual), None),
        Err(e) => (if auto { "localhost:0.0".into() } else { d.to_string() }, Some(format!("内置 X 服务器启动失败：{}", e))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_args() {
        let cfg = XServerConfig { xkb_layout: "de".into(), ..Default::default() };
        let args = build_args(&cfg, 3);
        assert_eq!(args[0], ":3");
        assert!(args.contains(&"-multiwindow".to_string()));
        assert!(args.windows(2).any(|w| w[0] == "-xkblayout" && w[1] == "de"));
        assert!(!args.contains(&"-ac".to_string()));
        let cfg = XServerConfig { window_mode: "rootless".into(), clipboard: false, ..Default::default() };
        let args = build_args(&cfg, 0);
        assert!(args.contains(&"-rootless".to_string()) && args.contains(&"-noclipboard".to_string()));
        assert!(!args.iter().any(|a| a == "-xkblayout"));
    }

    /// Starts the real bundled VcXsrv: `cargo test --lib xserver -- --ignored`.
    #[test]
    #[ignore]
    fn test_start_real_vcxsrv() {
        println!("free display: {:?}, :0 bindable: {}", free_display(), display_bindable(0));
        let n = start(None).expect("start");
        assert!(display_running(n), "display :{} not listening", n);
        let (display, warning) = resolve_display("localhost:0.0");
        assert!(warning.is_none(), "{:?}", warning);
        println!("started :{} ; localhost:0.0 resolves to {}", n, display);
        // The window manager gives up (and the server exits) after ~10 s when refused.
        std::thread::sleep(Duration::from_secs(15));
        assert!(display_running(n), "X server exited after start");
        assert_eq!(handshake(6000 + n), 1, "localhost must be accepted");
        stop();
        assert!(!display_running(n));
    }

    /// X11 connection setup; returns the server's first reply byte (0 failed, 1 success).
    fn handshake(port: u16) -> u8 {
        use std::io::{Read, Write};
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.write_all(&[b'l', 0, 11, 0, 0, 0, 0, 0, 0, 0, 0, 0]).unwrap();
        let mut b = [0u8; 1];
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        s.read_exact(&mut b).unwrap();
        b[0]
    }

    #[test]
    fn test_explicit_remote_display_is_kept() {
        assert_eq!(resolve_display("192.168.1.5:0.0"), ("192.168.1.5:0.0".to_string(), None));
    }
}
