use std::io::{Read, Write};
use std::sync::mpsc as std_mpsc;
use std::sync::Arc;
use anyhow::{Context, Result};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};

use crate::manager::{ControlMsg, RuntimeControl, TerminalSink};
use crate::models::{ProtocolType, SessionConfig};

pub fn spawn_local_pty(
    instance_id: String,
    session: SessionConfig,
    cols: u16,
    rows: u16,
    sink: Arc<dyn TerminalSink>,
) -> Result<RuntimeControl> {
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
    let mut writer = pair
        .master
        .take_writer()
        .context("获取 PTY 写入流失败")?;
    let master = pair.master;

    sink.emit_state(&instance_id, "connected", None);

    if let Some(startup) = session
        .startup_command
        .as_ref()
        .filter(|s| !s.trim().is_empty())
    {
        let mut line = startup.clone();
        line.push(char::from(13));
        line.push(char::from(10));
        let _ = writer.write_all(line.as_bytes());
        let _ = writer.flush();
    }

    let (ctrl_tx, ctrl_rx) = std_mpsc::channel::<ControlMsg>();

    // Dedicated OS thread for reading ConPTY output
    let reader_id = instance_id.clone();
    let reader_sink = Arc::clone(&sink);
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
                Ok(n) => {
                    reader_sink.emit_output(&reader_id, &buf[..n]);
                }
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
                    if writer.write_all(&data).is_err() {
                        break;
                    }
                    let _ = writer.flush();
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
