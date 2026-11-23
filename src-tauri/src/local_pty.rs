use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use anyhow::{Context, Result};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};

use crate::manager::{ControlMsg, RuntimeControl, TerminalSink};
use crate::models::{ProtocolType, SessionConfig};
use crate::shell_integration::{Injector, Step};

/// Settings › "conpty": which ConPTY local terminals use. Read once, when the first
/// local terminal opens; a change applies after a restart.
static CONPTY_MODE: Mutex<String> = Mutex::new(String::new());

pub fn set_conpty_mode(mode: &str) {
    *CONPTY_MODE.lock().unwrap() = mode.to_string();
}

/// First Windows build whose inbox ConPTY is the rewritten one (Windows 11 24H2). On
/// build 28000 the system ConPTY measured faster than the bundled one (conpty_bench).
const NEW_INBOX_CONPTY_BUILD: u32 = 26100;

/// "bundled" / "system"; anything else is "auto": the bundled one on older Windows.
fn use_bundled_conpty(mode: &str, build: Option<u32>) -> bool {
    match mode {
        "bundled" => true,
        "system" => false,
        _ => build.map_or(true, |b| b < NEW_INBOX_CONPTY_BUILD),
    }
}

/// CurrentBuildNumber from the registry (GetVersionEx reports 6.2 without a manifest).
fn windows_build() -> Option<u32> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
        let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
        let key = wide(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion");
        let name = wide("CurrentBuildNumber");
        let mut buf = [0u16; 32];
        let mut len = (buf.len() * 2) as u32;
        let rc = unsafe {
            RegGetValueW(HKEY_LOCAL_MACHINE, key.as_ptr(), name.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), buf.as_mut_ptr().cast(), &mut len)
        };
        if rc != 0 {
            return None;
        }
        let n = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..n]).trim().parse().ok()
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// Loads the bundled ConPTY (resources/conpty: Microsoft.Windows.Console.ConPTY, the
/// conpty.dll + OpenConsole.exe that Windows Terminal ships) before the first pseudo
/// console is created, when Settings › "conpty" picks it. The inbox conhost of
/// Windows 10 / early 11 renders slowly and drops sequences it doesn't know.
/// portable-pty prefers a `conpty.dll` that loads by name, and a module already loaded
/// is found by its name, so loading it once by full path is enough. conpty.dll starts
/// `<arch>\OpenConsole.exe` from its own folder. Missing or failing to load (e.g. an
/// ARM64 build, the DLL is x64): the system ConPTY is used.
pub fn preload_bundled_conpty() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let mode = CONPTY_MODE.lock().unwrap().clone();
        if use_bundled_conpty(&mode, windows_build()) {
            load_conpty_dll(&crate::app_paths::resource("conpty").join("conpty.dll"));
        }
    });
}

fn load_conpty_dll(dll: &std::path::Path) {
    if !dll.is_file() {
        eprintln!("bundled ConPTY not found at {}, using the system one", dll.display());
        return;
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let wide: Vec<u16> = dll.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        // Stays loaded for the life of the process (portable-pty keeps function
        // pointers into it).
        let module = unsafe { windows_sys::Win32::System::LibraryLoader::LoadLibraryW(wide.as_ptr()) };
        if module == 0 {
            eprintln!("loading {} failed ({}), using the system ConPTY", dll.display(), std::io::Error::last_os_error());
        }
    }
}

pub fn spawn_local_pty(
    instance_id: String,
    session: SessionConfig,
    cols: u16,
    rows: u16,
    sink: Arc<dyn TerminalSink>,
) -> Result<RuntimeControl> {
    preload_bundled_conpty();
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(2),
            cols: cols.max(10),
            pixel_width: 0,
            pixel_height: 0,
        })
        .context("无法创建本地 ConPTY 伪终端")?;

    let mut cmd = match session.protocol {
        ProtocolType::Powershell => {
            let mut c = CommandBuilder::new("powershell.exe");
            c.arg("-NoLogo");
            if crate::shell_integration::enabled() {
                c.args(crate::shell_integration::powershell_args());
            }
            c
        }
        ProtocolType::Cmd => CommandBuilder::new("cmd.exe"),
        ProtocolType::Wsl => CommandBuilder::new("wsl.exe"),
        ProtocolType::Custom => {
            let raw_cmd = session
                .shell_command
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or("powershell.exe");
            let parts = split_command_line(raw_cmd);
            let prog = parts.first().map(String::as_str).unwrap_or("powershell.exe");
            let mut c = CommandBuilder::new(prog);
            for arg in parts.iter().skip(1) {
                c.arg(arg);
            }
            if crate::shell_integration::enabled() && crate::shell_integration::is_plain_powershell(&parts) {
                c.args(crate::shell_integration::powershell_args());
            }
            c
        }
        _ => CommandBuilder::new("powershell.exe"),
    };

    cmd.env(
        "TERM",
        if session.term.trim().is_empty() {
            "xterm-256color"
        } else {
            session.term.trim()
        },
    );
    cmd.env("COLORTERM", "truecolor");
    // AI agent hooks report their status for this pane (see agent.rs); WSLENV passes
    // the variables on into WSL.
    if let Some(url) = crate::agent::endpoint() {
        cmd.env("NEXTERM_AGENT_URL", url);
        cmd.env("NEXTERM_PANE_ID", &instance_id);
        let wslenv = std::env::var("WSLENV").unwrap_or_default();
        let extra = "NEXTERM_AGENT_URL/u:NEXTERM_PANE_ID/u";
        cmd.env("WSLENV", if wslenv.is_empty() { extra.to_string() } else { format!("{wslenv}:{extra}") });
    }

    if let Some(ref wd) = session.working_dir {
        if !wd.trim().is_empty() {
            cmd.cwd(wd);
        }
    } else if let Some(home) = dirs::home_dir() {
        cmd.cwd(home);
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .context("启动本地终端进程失败")?;
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .context("克隆 PTY 读取流失败")?;
    let writer: SharedWriter = Arc::new(Mutex::new(
        pair.master.take_writer().context("获取 PTY 写入流失败")?,
    ));
    let master = pair.master;

    sink.emit_state(&instance_id, "connected", None);

    let startup = session
        .startup_command
        .clone()
        .filter(|s| !s.trim().is_empty())
        .map(|mut line| {
            line.push_str("\r\n");
            line
        });
    // WSL: shell integration typed into the shell like SSH (see shell_integration.rs); a
    // separate wsl.exe in the same distro and user checks the shell and writes the scripts.
    let injector = (session.protocol == ProtocolType::Wsl && crate::shell_integration::enabled())
        .then(|| Arc::new(Mutex::new(Injector::new(Instant::now()))));
    match &injector {
        Some(injector) => drive_wsl_injection(Arc::clone(injector), Arc::clone(&writer), Arc::clone(&sink), instance_id.clone(), startup),
        None => {
            if let Some(line) = startup {
                write_pty(&writer, line.as_bytes());
            }
        }
    }

    let (ctrl_tx, ctrl_rx) = std_mpsc::channel::<ControlMsg>();

    // Dedicated OS thread for reading ConPTY output
    let reader_id = instance_id.clone();
    let reader_sink = Arc::clone(&sink);
    let reader_injector = injector.clone();
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    reader_sink.emit_state(
                        &reader_id,
                        "disconnected",
                        Some("终端进程已退出".into()),
                    );
                    break;
                }
                Ok(n) => match &reader_injector {
                    // Held under the lock, so output released by the driver keeps its order.
                    Some(injector) => {
                        let mut inj = lock(injector);
                        let shown = if inj.is_done() { buf[..n].to_vec() } else { inj.output(&buf[..n], Instant::now()) };
                        if !shown.is_empty() {
                            reader_sink.emit_output(&reader_id, &shown);
                        }
                    }
                    None => reader_sink.emit_output(&reader_id, &buf[..n]),
                },
                Err(err) => {
                    reader_sink.emit_state(
                        &reader_id,
                        "disconnected",
                        Some(format!("终端已关闭: {}", err)),
                    );
                    break;
                }
            }
        }
    });

    // Dedicated OS thread for ConPTY write, resize, and process lifecycle (no Tokio runtime required)
    std::thread::spawn(move || {
        while let Ok(msg) = ctrl_rx.recv() {
            match msg {
                ControlMsg::Write(data) => {
                    if let Some(injector) = &injector {
                        lock(injector).user_input(&data);
                    }
                    if !write_pty(&writer, &data) {
                        break;
                    }
                }
                ControlMsg::Resize(new_cols, new_rows) => {
                    let _ = master.resize(PtySize {
                        rows: new_rows.max(2),
                        cols: new_cols.max(10),
                        pixel_width: 0,
                        pixel_height: 0,
                    });
                }
                ControlMsg::Close => {
                    let _ = child.kill();
                    break;
                }
            }
        }
        drop(writer);
        drop(master);
        let _ = child.kill();
    });

    Ok(RuntimeControl::Sync(ctrl_tx))
}

type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn write_pty(writer: &SharedWriter, data: &[u8]) -> bool {
    let mut w = lock(writer);
    w.write_all(data).is_ok() && w.flush().is_ok()
}

/// Runs a POSIX sh script in the default WSL distribution as the default user (the same
/// as the pane's plain `wsl.exe`); stdout, or None on failure or after `timeout`.
fn wsl_sh(script: &str, timeout: Duration) -> Option<String> {
    let mut cmd = Command::new("wsl.exe");
    cmd.args(["--exec", "sh", "-s"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().ok()?;
    // Written on its own thread: a full pipe must not block past the timeout.
    let mut stdin = child.stdin.take()?;
    let script = script.to_string();
    std::thread::spawn(move || {
        let _ = stdin.write_all(script.as_bytes());
    });
    let give_up = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut out = String::new();
                child.stdout.take()?.read_to_string(&mut out).ok()?;
                return status.success().then_some(out);
            }
            Ok(None) if Instant::now() < give_up => std::thread::sleep(Duration::from_millis(30)),
            _ => {
                let _ = child.kill();
                return None;
            }
        }
    }
}

/// Uploads the scripts beside the pane, then types the loader once the prompt is drawn
/// (the SSH loop in ssh_conn.rs does the same), and the startup command after it.
fn drive_wsl_injection(
    injector: Arc<Mutex<Injector>>,
    writer: SharedWriter,
    sink: Arc<dyn TerminalSink>,
    instance_id: String,
    startup: Option<String>,
) {
    let token: String = uuid::Uuid::new_v4().simple().to_string()[..16].to_string();
    // 0: running, 1: scripts in place, 2: nothing uploaded.
    let upload = Arc::new(AtomicU8::new(0));
    {
        let (injector, upload) = (Arc::clone(&injector), Arc::clone(&upload));
        // `wsl.exe --exec` may not set $SHELL; fall back to the passwd entry.
        let script = format!(
            "[ -n \"${{SHELL-}}\" ] || SHELL=$(getent passwd \"$(id -u)\" | cut -d: -f7)\n{}",
            crate::shell_integration::upload_script(&token)
        );
        std::thread::spawn(move || {
            let ok = wsl_sh(&script, Duration::from_secs(8)).is_some_and(|out| crate::shell_integration::upload_ok(&out));
            upload.store(if ok { 1 } else { 2 }, Ordering::Release);
            lock(&injector).set_shell_ok(ok);
        });
    }
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(30));
            let now = Instant::now();
            let inject = {
                let mut inj = lock(&injector);
                if inj.is_done() {
                    break;
                }
                if inj.deadline().is_some_and(|d| now < d) {
                    continue;
                }
                match inj.tick(now) {
                    Step::Inject => true,
                    // Under the lock: the reader passes later output straight through.
                    Step::Emit(bytes) => {
                        sink.emit_output(&instance_id, &bytes);
                        false
                    }
                    Step::Nothing => false,
                }
            };
            // Not under the lock: the reader must keep draining while the line goes out.
            if inject {
                write_pty(&writer, crate::shell_integration::loader_line(&token).as_bytes());
            }
        }
        let loaded = lock(&injector).loaded;
        if let Some(line) = startup {
            write_pty(&writer, line.as_bytes());
        }
        // The upload may still be running when the injector gave up.
        let give_up = Instant::now() + Duration::from_secs(10);
        while !loaded && upload.load(Ordering::Acquire) == 0 && Instant::now() < give_up {
            std::thread::sleep(Duration::from_millis(100));
        }
        if !loaded && upload.load(Ordering::Acquire) == 1 {
            let _ = wsl_sh(&crate::shell_integration::cleanup_script(&token), Duration::from_secs(8));
        }
    });
}

/// Split a command line on whitespace, keeping "double quoted" segments together.
fn split_command_line(input: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut has_token = false;
    for ch in input.chars() {
        match ch {
            '"' => {
                in_quotes = !in_quotes;
                has_token = true;
            }
            c if c.is_whitespace() && !in_quotes => {
                if has_token {
                    parts.push(std::mem::take(&mut current));
                    has_token = false;
                }
            }
            c => {
                current.push(c);
                has_token = true;
            }
        }
    }
    if has_token {
        parts.push(current);
    }
    parts
}

#[cfg(test)]
mod tests {
    use super::split_command_line;

    #[test]
    fn test_split_command_line_with_quotes() {
        let parts = split_command_line(
            r#"C:/WINDOWS/system32/cmd.exe  /s /k "C:/Program Files/clink/clink_x64.exe" inject"#,
        );
        assert_eq!(
            parts,
            vec![
                "C:/WINDOWS/system32/cmd.exe",
                "/s",
                "/k",
                "C:/Program Files/clink/clink_x64.exe",
                "inject"
            ]
        );
    }
}

#[cfg(test)]
mod wsl_integration {
    use super::*;

    #[derive(Default)]
    struct Collect(Mutex<Vec<u8>>);

    impl TerminalSink for Collect {
        fn emit_output(&self, _id: &str, data: &[u8]) {
            lock(&self.0).extend_from_slice(data);
        }
        fn emit_state(&self, _id: &str, _status: &str, _message: Option<String>) {}
    }

    /// Default WSL distribution (bash / zsh / fish login shell; startup files are only read):
    /// `cargo test --lib wsl_integration -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn loads_automatically_and_hides_the_loader() {
        let session: SessionConfig = serde_json::from_value(serde_json::json!({ "id": "w", "label": "w", "protocol": "wsl" })).unwrap();
        let sink = Arc::new(Collect::default());
        let RuntimeControl::Sync(tx) = spawn_local_pty("w".into(), session, 120, 30, sink.clone()).unwrap() else { panic!() };
        let text = || String::from_utf8_lossy(&lock(&sink.0)).to_string();
        let start = Instant::now();
        let mut answered = false;
        while !text().contains("\x1b]133;A") && start.elapsed() < Duration::from_secs(20) {
            if !answered && text().contains("\x1b[6n") {
                let _ = tx.send(ControlMsg::Write(b"\x1b[1;1R".to_vec()));
                answered = true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        std::thread::sleep(Duration::from_millis(500));
        let shown = text();
        eprintln!("{shown:?}");
        assert!(shown.contains("\x1b]133;A"), "integration never loaded");
        assert!(!shown.contains("nexterm-si"), "loader line showed");
        let _ = tx.send(ControlMsg::Write(b"sleep 0.3\r".to_vec()));
        std::thread::sleep(Duration::from_secs(2));
        assert!(text().contains("\x1b]633;E;sleep 0.3\x07"), "no command reported");
        let _ = tx.send(ControlMsg::Close);
    }
}

#[cfg(test)]
mod powershell_integration {
    /// Real ConPTY + powershell.exe (Windows, slow): `cargo test --lib powershell_integration -- --ignored`.
    #[test]
    #[ignore]
    fn reports_command_line_start_and_exit_code() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::io::Read;
        let pair = native_pty_system().openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
        let mut c = CommandBuilder::new("powershell.exe");
        c.arg("-NoLogo");
        c.args(crate::shell_integration::powershell_args());
        let mut child = pair.slave.spawn_command(c).unwrap();
        drop(pair.slave);
        let mut r = pair.master.try_clone_reader().unwrap();
        let mut w = pair.master.take_writer().unwrap();
        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
        std::thread::spawn(move || { let mut b = [0u8; 4096]; while let Ok(n) = r.read(&mut b) { if n == 0 { break; } if tx.send(b[..n].to_vec()).is_err() { break; } } });
        let mut v = Vec::new();
        let start = std::time::Instant::now();
        let mut step = 0;
        while start.elapsed() < std::time::Duration::from_secs(25) {
            if let Ok(chunk) = rx.recv_timeout(std::time::Duration::from_millis(200)) {
                if chunk.windows(4).any(|x| x == b"\x1b[6n") { let _ = std::io::Write::write_all(&mut w, b"\x1b[1;1R"); }
                v.extend_from_slice(&chunk);
            }
            let text = String::from_utf8_lossy(&v).to_string();
            if step == 0 && text.matches("133;A").count() >= 1 {
                std::thread::sleep(std::time::Duration::from_millis(500));
                let _ = std::io::Write::write_all(&mut w, b"Write-Output hi; cmd /c exit 3\r");
                step = 1;
            } else if step == 1 && text.matches("133;A").count() >= 2 {
                let _ = std::io::Write::write_all(&mut w, b"exit\r");
                step = 2;
                std::thread::sleep(std::time::Duration::from_millis(800));
                while let Ok(c) = rx.try_recv() { v.extend_from_slice(&c); }
                break;
            }
        }
        let _ = child.kill();
        let text = String::from_utf8_lossy(&v).to_string();
        assert_eq!(step, 2, "no second prompt: {text:?}");
        let e = char::from(27);
        let b = char::from(7);
        for mark in [format!("{e}]633;E;Write-Output hi"), format!("{e}]133;C{b}"), format!("{e}]133;D;3{b}")] {
            assert!(text.contains(&mark), "missing {mark:?} in {text:?}");
        }
    }
}

#[cfg(test)]
mod conpty_bench {
    /// Output throughput of the bundled vs the system ConPTY (Windows, run each mode in
    /// its own process, the choice is made once):
    /// `cargo test --lib conpty_bench -- --ignored --nocapture` and the same with
    /// `NEXTERM_SYSTEM_CONPTY=1`.
    #[test]
    #[ignore]
    fn cat_large_file() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::io::Read;
        let system = std::env::var_os("NEXTERM_SYSTEM_CONPTY").is_some();
        if !system {
            super::load_conpty_dll(&std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/conpty/conpty.dll"));
        }
        let file = std::env::temp_dir().join("nexterm-conpty-bench.txt");
        let line = "The quick brown fox \x1b[31mjumps\x1b[0m over the lazy dog 0123456789 abcdefghijklmnopqrstuvwxyz\r\n";
        let line = if std::env::var_os("NEXTERM_BENCH_PLAIN").is_some() { line.replace("\x1b[31m", "").replace("\x1b[0m", "") } else { line.to_string() };
        std::fs::write(&file, line.repeat(200_000)).unwrap();
        let pair = native_pty_system().openpty(PtySize { rows: 40, cols: 160, pixel_width: 0, pixel_height: 0 }).unwrap();
        let mut c = CommandBuilder::new("cmd.exe");
        c.args(["/c", "type", file.to_str().unwrap()]);
        let start = std::time::Instant::now();
        let mut child = pair.slave.spawn_command(c).unwrap();
        drop(pair.slave);
        let mut r = pair.master.try_clone_reader().unwrap();
        let mut w = pair.master.take_writer().unwrap();
        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
        std::thread::spawn(move || { let mut b = vec![0u8; 64 * 1024]; while let Ok(n) = r.read(&mut b) { if n == 0 || tx.send(b[..n].to_vec()).is_err() { break; } } });
        let mut total = 0usize;
        let mut exited = None;
        while let Ok(chunk) = rx.recv_timeout(std::time::Duration::from_millis(if exited.is_some() { 300 } else { 5000 })) {
            // ConPTY asks for the cursor position before it starts (INHERIT_CURSOR).
            if chunk.windows(4).any(|x| x == b"\x1b[6n") { let _ = std::io::Write::write_all(&mut w, b"\x1b[1;1R"); }
            total += chunk.len();
            if exited.is_none() && child.try_wait().ok().flatten().is_some() { exited = Some(start.elapsed()); }
        }
        let elapsed = exited.unwrap_or_else(|| start.elapsed());
        let _ = child.kill();
        let _ = std::fs::remove_file(&file);
        eprintln!("{} ConPTY: {} bytes out in {:?} ({:.1} MB/s)", if system { "system" } else { "bundled" }, total, elapsed, total as f64 / 1e6 / elapsed.as_secs_f64());
        assert!(total > 0);
    }
}

#[cfg(test)]
mod conpty_choice {
    use super::*;

    #[test]
    fn explicit_modes_win() {
        assert!(use_bundled_conpty("bundled", Some(28000)));
        assert!(!use_bundled_conpty("system", Some(19045)));
    }

    #[test]
    fn auto_uses_bundled_only_before_the_new_inbox_conpty() {
        assert!(use_bundled_conpty("auto", Some(19045)));
        assert!(use_bundled_conpty("", Some(22631)));
        assert!(!use_bundled_conpty("auto", Some(26100)));
        assert!(!use_bundled_conpty("", Some(28000)));
        assert!(use_bundled_conpty("auto", None));
    }

    #[cfg(windows)]
    #[test]
    fn reads_the_windows_build() {
        assert!(windows_build().is_some_and(|b| b >= 10240));
    }
}
