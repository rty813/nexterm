//! Android devices over the adb server's wire protocol (TCP 127.0.0.1:5037).
//!
//! We speak to the server directly instead of running adb.exe for every command: the
//! shell gets a real PTY with resize and exit codes (shell v2), files go over the sync
//! protocol, and the screen mirror / logcat streams are plain sockets. adb.exe is only run
//! to start the server and for wireless pairing (`locate.rs`).

pub mod client;
pub mod commands;
pub mod locate;
pub mod logcat;
pub mod ops;
pub mod scrcpy;
pub mod shell;
pub mod sync;

use std::sync::{Arc, Mutex};

use anyhow::Result;
use serde::Serialize;

pub use client::DeviceInfo;

/// The server we talk to. adb listens on loopback only.
pub const SERVER: (&str, u16) = ("127.0.0.1", 5037);

/// One device on the adb server: its serial ("R5CT..." over USB, "192.168.1.5:5555" over
/// WLAN). Cheap to clone; every operation opens its own socket.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdbDevice {
    pub serial: String,
}

impl AdbDevice {
    pub fn new(serial: impl Into<String>) -> Self {
        AdbDevice { serial: serial.into() }
    }

    /// A stream to `service` on the device (`shell,v2,pty:`, `sync:`, `localabstract:x`).
    pub async fn open(&self, service: &str) -> Result<crate::net::BoxedStream> {
        client::open_device(&self.serial, service).await
    }

    /// Run a shell command and return its stdout; a non-zero exit is an error carrying
    /// stderr (same contract as `SshLink::exec_output`).
    pub async fn exec_output(&self, command: &str) -> Result<String> {
        shell::exec_output(self, command).await
    }
}

/// The device behind an ADB pane, filled in once its shell is connected.
pub type AdbSlot = Arc<Mutex<Option<AdbDevice>>>;
