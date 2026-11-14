use std::io::{ErrorKind, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc as std_mpsc;
use std::sync::Arc;
use std::time::Duration;
use anyhow::{Context, Result};
use serialport::{DataBits, FlowControl, Parity, StopBits};

use crate::manager::{ControlMsg, RuntimeControl, TerminalSink};
use crate::models::{SerialConfig, SessionConfig};

/// List serial ports present on this machine (e.g. COM3, COM4).
pub fn list_serial_ports() -> Vec<String> {
    serialport::available_ports()
        .map(|ports| ports.into_iter().map(|p| p.port_name).collect())
        .unwrap_or_default()
}

pub fn spawn_serial_session(
    instance_id: String,
    session: SessionConfig,
    sink: Arc<dyn TerminalSink>,
) -> Result<RuntimeControl> {
    let cfg = session.serial.clone().unwrap_or_default();
    let port_name = session.host.trim().to_string();
    if port_name.is_empty() {
        anyhow::bail!("未指定串口号（例如 COM3）");
    }

    let port = serialport::new(&port_name, cfg.baud_rate)
        .data_bits(data_bits(&cfg))
        .parity(parity(&cfg))
        .stop_bits(stop_bits(&cfg))
        .flow_control(flow_control(&cfg))
        .timeout(Duration::from_millis(50))
        .open()
        .with_context(|| format!("无法打开串口 {}（{} bps）", port_name, cfg.baud_rate))?;

    let mut reader = port.try_clone().context("克隆串口读取句柄失败")?;
    let mut writer = port;
    let closed = Arc::new(AtomicBool::new(false));

    sink.emit_state(&instance_id, "connected", None);

    if let Some(startup) = session
        .startup_command
        .as_ref()
        .filter(|s| !s.trim().is_empty())
    {
        let mut line = startup.clone();
        line.push(char::from(13));
        let _ = writer.write_all(line.as_bytes());
    }

    let reader_id = instance_id.clone();
    let reader_sink = Arc::clone(&sink);
    let reader_closed = Arc::clone(&closed);
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        while !reader_closed.load(Ordering::Acquire) {
            match reader.read(&mut buf) {
                Ok(0) => {}
                Ok(n) => reader_sink.emit_output(&reader_id, &buf[..n]),
                Err(e) if e.kind() == ErrorKind::TimedOut => {}
                Err(e) => {
                    if !reader_closed.load(Ordering::Acquire) {
                        reader_sink.emit_state(
                            &reader_id,
                            "disconnected",
                            Some(format!("串口读取错误: {}", e)),
                        );
                    }
                    break;
                }
            }
        }
    });

    let (ctrl_tx, ctrl_rx) = std_mpsc::channel::<ControlMsg>();
    std::thread::spawn(move || {
        while let Ok(msg) = ctrl_rx.recv() {
            match msg {
                ControlMsg::Write(data) => {
                    if let Err(e) = writer.write_all(&data) {
                        sink.emit_state(
                            &instance_id,
                            "disconnected",
                            Some(format!("串口写入错误: {}", e)),
                        );
                        break;
                    }
                    let _ = writer.flush();
                }
                ControlMsg::Resize(_, _) => {}
                ControlMsg::Close => {
                    sink.emit_state(&instance_id, "disconnected", Some("已关闭串口".into()));
                    break;
                }
            }
        }
        closed.store(true, Ordering::Release);
    });

    Ok(RuntimeControl::Sync(ctrl_tx))
}

fn data_bits(cfg: &SerialConfig) -> DataBits {
    match cfg.data_bits {
        5 => DataBits::Five,
        6 => DataBits::Six,
        7 => DataBits::Seven,
        _ => DataBits::Eight,
    }
}

fn parity(cfg: &SerialConfig) -> Parity {
    match cfg.parity.as_str() {
        "odd" => Parity::Odd,
        "even" => Parity::Even,
        _ => Parity::None,
    }
}

fn stop_bits(cfg: &SerialConfig) -> StopBits {
    if cfg.stop_bits == 2 {
        StopBits::Two
    } else {
        StopBits::One
    }
}

fn flow_control(cfg: &SerialConfig) -> FlowControl {
    match cfg.flow_control.as_str() {
        "software" => FlowControl::Software,
        "hardware" => FlowControl::Hardware,
        _ => FlowControl::None,
    }
}
