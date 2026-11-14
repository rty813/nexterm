use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

use crate::manager::{AsyncChannels, RuntimeControl, TerminalSink};
use crate::models::SessionConfig;

pub fn spawn_tcp_session(
    instance_id: String,
    session: SessionConfig,
    sink: Arc<dyn TerminalSink>,
) -> RuntimeControl {
    let (write_tx, mut write_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let (resize_tx, _resize_rx) = mpsc::unbounded_channel::<(u16, u16)>();
    let (close_tx, mut close_rx) = mpsc::unbounded_channel::<()>();

    tauri::async_runtime::spawn(async move {
        sink.emit_state(&instance_id, "connecting", None);
        let addr = format!("{}:{}", session.host.trim(), session.port);

        let stream_res =
            crate::net::connect_tcp(session.host.trim(), session.port, session.proxy.as_ref(), Duration::from_secs(15)).await;
        let stream = match stream_res {
            Ok(s) => s,
            Err(e) => {
                sink.emit_state(&instance_id, "error", Some(format!("TCP 连接失败 ({}): {:#}", addr, e)));
                return;
            }
        };

        let _ = stream.set_nodelay(true);
        let (mut rd, mut wr) = stream.into_split();
        sink.emit_state(&instance_id, "connected", None);

        if let Some(startup) = session
            .startup_command
            .as_ref()
            .filter(|s| !s.trim().is_empty())
        {
            let mut line = startup.clone();
            line.push(char::from(13));
            line.push(char::from(10));
            let _ = wr.write_all(line.as_bytes()).await;
        }

        let mut buf = vec![0u8; 64 * 1024];
        loop {
            tokio::select! {
                read_res = rd.read(&mut buf) => {
                    match read_res {
                        Ok(0) => {
                            sink.emit_state(&instance_id, "disconnected", Some("远端已关闭连接".into()));
                            break;
                        }
                        Ok(n) => {
                            sink.emit_output(&instance_id, &buf[..n]);
                        }
                        Err(e) => {
                            sink.emit_state(&instance_id, "disconnected", Some(format!("TCP 读取错误: {}", e)));
                            break;
                        }
                    }
                }
                Some(data) = write_rx.recv() => {
                    if let Err(e) = wr.write_all(&data).await {
                        sink.emit_state(&instance_id, "disconnected", Some(format!("TCP 写入错误: {}", e)));
                        break;
                    }
                }
                Some(()) = close_rx.recv() => {
                    let _ = wr.shutdown().await;
                    sink.emit_state(&instance_id, "disconnected", Some("已断开连接".into()));
                    break;
                }
            }
        }
    });

    RuntimeControl::Async(AsyncChannels {
        write_tx,
        resize_tx,
        close_tx,
        exec_tx: None,
        tunnel_tx: None,
    })
}
