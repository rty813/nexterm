use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ProtocolType {
    #[default]
    Ssh,
    Powershell,
    Cmd,
    Wsl,
    /// Git for Windows' bash (`git_bash.rs`).
    #[serde(rename = "gitbash")]
    GitBash,
    Custom,
    Tcp,
    Serial,
    Telnet,
    /// Remote desktop panes (`desktop/`), not terminals.
    Rdp,
    Vnc,
    /// Android device through the adb server (`adb/`, `adb_conn.rs`).
    Adb,
}

impl ProtocolType {
    /// RDP / VNC: a graphical pane driven by `desktop::`, not the terminal pipeline.
    pub fn is_desktop(&self) -> bool {
        matches!(self, ProtocolType::Rdp | ProtocolType::Vnc)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AuthType {
    Password,
    PrivateKey,
    None,
}

impl Default for AuthType {
    fn default() -> Self {
        Self::Password
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JumpHostConfig {
    pub enabled: bool,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: AuthType,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub private_key_path: Option<String>,
    #[serde(default)]
    pub passphrase: Option<String>,
    /// Login from the credential manager (`credentials.rs`), instead of the fields above.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionConfig {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub group: String,
    pub protocol: ProtocolType,
    #[serde(default)]
    pub host: String,
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub auth_type: AuthType,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub private_key_path: Option<String>,
    #[serde(default)]
    pub passphrase: Option<String>,
    /// Login from the credential manager (`credentials.rs`), filled in when connecting.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential_id: Option<String>,
    #[serde(default)]
    pub jump_host: Option<JumpHostConfig>,
    #[serde(default = "default_term")]
    pub term: String,
    #[serde(default = "default_keep_alive")]
    pub keep_alive_secs: u64,
    #[serde(default)]
    pub startup_command: Option<String>,
    #[serde(default)]
    pub working_dir: Option<String>,
    #[serde(default)]
    pub shell_command: Option<String>,
    #[serde(default)]
    pub serial: Option<SerialConfig>,
    /// Start logging as soon as the session connects (WindTerm: session log options).
    #[serde(default)]
    pub auto_log: bool,
    #[serde(default)]
    pub proxy: Option<ProxyConfig>,
    /// SSH port forwarding rules.
    #[serde(default)]
    pub tunnels: Vec<TunnelConfig>,
    #[serde(default)]
    pub x11: Option<X11Config>,
    /// Remote character set, e.g. "UTF-8", "GBK", "Big5". Empty means UTF-8.
    #[serde(default)]
    pub charset: String,
    /// Highlight scheme: "" (auto), "linux", "powershell", "cmd", "macos", "routeros", "none".
    #[serde(default)]
    pub system: String,
    /// Accept any SSH host key without checking known_hosts (WindTerm: verifyServerFingerprint off).
    #[serde(default)]
    pub skip_host_key_check: bool,
    /// RDP / VNC display options.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desktop: Option<DesktopConfig>,
    /// ADB device and view.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adb: Option<AdbConfig>,
    /// Frontend-only options (terminal keys, bell, tab color, ...) kept verbatim.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// ADB session options (`SessionConfig::adb`). A WLAN device's address is `host` / `port`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct AdbConfig {
    /// Device serial on the adb server ("R5CT...", "192.168.1.5:5555"). Empty: the only
    /// device connected, or `host:port` for WLAN.
    #[serde(default)]
    pub serial: String,
    /// "usb" | "wlan" (run `adb connect host:port` first).
    #[serde(default)]
    pub connect: String,
    /// "shell" (terminal) | "logcat" (log tab, `LogcatPane`).
    #[serde(default)]
    pub view: String,
    /// The SSH pane (its id) whose host runs the adb server, for devices plugged into a
    /// remote Linux machine (bastion panes included). Empty: this computer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub via: Option<String>,
    /// Logcat tab state (filters, buffers): frontend only, kept verbatim.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logcat: Option<serde_json::Value>,
}

impl AdbConfig {
    pub fn is_wlan(&self) -> bool {
        self.connect == "wlan"
    }
}

/// RDP / VNC session options (`SessionConfig::desktop`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopConfig {
    /// RDP logon domain.
    #[serde(default)]
    pub domain: String,
    /// Fixed desktop size (used when `resize` is "fixed").
    #[serde(default = "default_desktop_width")]
    pub width: u16,
    #[serde(default = "default_desktop_height")]
    pub height: u16,
    /// "fit-window": the remote desktop follows the pane size (RDP display control);
    /// "fixed": `width` x `height`.
    #[serde(default = "default_desktop_resize")]
    pub resize: String,
    /// "fit" | "actual" | "stretch": how the picture is drawn in the pane (frontend only).
    #[serde(default = "default_desktop_scale")]
    pub scale: String,
    /// RDP color depth: 16 / 24 / 32.
    #[serde(default = "default_color_depth")]
    pub color_depth: u32,
    /// RDP Network Level Authentication (CredSSP).
    #[serde(default = "default_true")]
    pub nla: bool,
    /// Text clipboard sync with the remote side.
    #[serde(default = "default_true")]
    pub clipboard: bool,
    /// RDP: files and folders go through the clipboard too, both ways (needs `clipboard`).
    #[serde(default = "default_true")]
    pub clipboard_files: bool,
    /// VNC: show only, never send input.
    #[serde(default)]
    pub view_only: bool,
    /// RDP audio: "local" (play here) | "remote" (leave on the remote computer) | "off".
    #[serde(default = "default_audio")]
    pub audio: String,
}

impl Default for DesktopConfig {
    fn default() -> Self {
        Self {
            domain: String::new(),
            width: default_desktop_width(),
            height: default_desktop_height(),
            resize: default_desktop_resize(),
            scale: default_desktop_scale(),
            color_depth: default_color_depth(),
            nla: true,
            clipboard: true,
            clipboard_files: true,
            view_only: false,
            audio: default_audio(),
        }
    }
}

fn default_desktop_width() -> u16 {
    1920
}

fn default_desktop_height() -> u16 {
    1080
}

fn default_desktop_resize() -> String {
    "fit-window".to_string()
}

fn default_desktop_scale() -> String {
    "fit".to_string()
}

fn default_color_depth() -> u32 {
    32
}

fn default_audio() -> String {
    "local".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProxyConfig {
    /// "none" | "socks5" | "socks4" | "http" | "command" (OpenSSH ProxyCommand, SSH only)
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    /// For kind "command": a local program whose stdin / stdout carry the first SSH hop
    /// (`%h` / `%p` / `%r` become host, port and user, as in OpenSSH).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TunnelConfig {
    #[serde(default)]
    pub name: String,
    /// "local" (-L) | "remote" (-R) | "dynamic" (-D, SOCKS4/4a/5 server)
    pub kind: String,
    #[serde(default = "default_listen_host")]
    pub listen_host: String,
    pub listen_port: u16,
    #[serde(default)]
    pub target_host: String,
    #[serde(default)]
    pub target_port: u16,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct X11Config {
    pub enabled: bool,
    /// Local X server display, e.g. "localhost:0.0" (VcXsrv / Xming / MobaXterm).
    #[serde(default = "default_x11_display")]
    pub display: String,
}

fn default_listen_host() -> String {
    "127.0.0.1".to_string()
}

fn default_x11_display() -> String {
    "localhost:0.0".to_string()
}

impl SessionConfig {
    /// Binary data type (`extra.dataType == "binary"`, WindTerm `session.dataType`):
    /// serial / raw TCP bytes are shown as a hex dump and sent without charset conversion.
    pub fn binary_data(&self) -> bool {
        matches!(self.protocol, ProtocolType::Serial | ProtocolType::Tcp)
            && self.extra.get("dataType").and_then(|v| v.as_str()) == Some("binary")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SerialConfig {
    #[serde(default = "default_baud_rate")]
    pub baud_rate: u32,
    #[serde(default = "default_data_bits")]
    pub data_bits: u8,
    /// "none" | "odd" | "even"
    #[serde(default = "default_none")]
    pub parity: String,
    #[serde(default = "default_stop_bits")]
    pub stop_bits: u8,
    /// "none" | "software" | "hardware"
    #[serde(default = "default_none")]
    pub flow_control: String,
    /// Show typed characters locally, for devices that do not echo.
    #[serde(default)]
    pub local_echo: bool,
}

impl Default for SerialConfig {
    fn default() -> Self {
        Self {
            baud_rate: default_baud_rate(),
            data_bits: default_data_bits(),
            parity: default_none(),
            stop_bits: default_stop_bits(),
            flow_control: default_none(),
            local_echo: false,
        }
    }
}

fn default_baud_rate() -> u32 {
    115200
}

fn default_data_bits() -> u8 {
    8
}

fn default_stop_bits() -> u8 {
    1
}

fn default_none() -> String {
    "none".to_string()
}

fn default_ssh_port() -> u16 {
    22
}

fn default_term() -> String {
    "xterm-256color".to_string()
}

fn default_keep_alive() -> u64 {
    60
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickCommand {
    pub id: String,
    pub label: String,
    pub group: String,
    pub command: String,
    pub append_newline: bool,
    /// "shape-color", as WindTerm's quick.icon without its "session::" prefix.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// Key combo that runs the command ("Alt+1"), in the app's keymap notation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shortcut: Option<String>,
    /// "text" (default): send `command`; "action": run the app action `action`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    /// Decode backslash escapes (\r \n \t \xHH ...) when sending, as WindTerm does.
    /// Set on commands imported from WindTerm; off for commands written here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub escapes: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedTheme {
    pub id: String,
    pub name: String,
    pub is_light: bool,
    pub gui_bg: String,
    pub gui_panel: String,
    pub gui_fg: String,
    pub accent: String,
    pub term_bg: String,
    pub term_fg: String,
    pub cursor_local: String,
    pub cursor_remote: String,
    pub ansi: [String; 16],
}

fn default_language() -> String {
    "zh-CN".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default = "default_language")]
    pub language: String,
    pub theme_id: String,
    pub font_family: String,
    pub font_size: u16,
    pub scrollback: u32,
    pub cursor_blink: bool,
    pub cursor_style: String,
    pub double_click_close_tab: bool,
    pub confirm_before_close: bool,
    #[serde(default)]
    pub lock_passcode: Option<String>,
    #[serde(default = "default_true")]
    pub syntax_highlight: bool,
    /// Hide to the system tray instead of quitting when the window is closed.
    #[serde(default = "default_true")]
    pub close_to_tray: bool,
    /// Session log folder; empty means Documents/Nexterm/logs.
    #[serde(default)]
    pub log_dir: Option<String>,
    #[serde(default = "default_log_pattern")]
    pub log_file_pattern: String,
    #[serde(default = "default_true")]
    pub log_timestamp: bool,
    /// Frontend-only preferences (key bindings, toolbar layout, window options ...).
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

pub fn default_log_pattern() -> String {
    "%n/%n_%Y-%m-%d_%H-%M-%S.log".to_string()
}

/// The default before logs went into a folder per session.
pub const OLD_DEFAULT_LOG_PATTERN: &str = "%n_%Y-%m-%d_%H-%M-%S.log";

fn default_true() -> bool {
    true
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            language: default_language(),
            theme_id: "dige-black".to_string(),
            font_family: "'Cascadia Mono', Consolas, 'Roboto Mono', 'Microsoft YaHei UI', monospace".to_string(),
            font_size: 14,
            scrollback: 50000,
            cursor_blink: false,
            cursor_style: "block".to_string(),
            double_click_close_tab: true,
            confirm_before_close: false,
            lock_passcode: None,
            syntax_highlight: true,
            close_to_tray: true,
            log_dir: None,
            log_file_pattern: default_log_pattern(),
            log_timestamp: true,
            extra: Default::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStateSnapshot {
    pub sessions: Vec<SessionConfig>,
    pub quick_commands: Vec<QuickCommand>,
    pub custom_themes: Vec<ImportedTheme>,
    pub settings: AppSettings,
    /// Local files that could not be used and were set aside, to tell the user once.
    #[serde(default)]
    pub notices: Vec<StorageNotice>,
}

/// A local data file this Windows account could not open (or a damaged one), kept as `kept`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageNotice {
    /// "sessions" / "credentials" (the list started empty) or "settings" (the parts that could not be
    /// opened, such as the sync configuration, were reset).
    pub file: String,
    pub kept: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryCandidate {
    pub source_type: String,
    pub label: String,
    pub path: String,
    pub item_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub sessions: Vec<SessionConfig>,
    pub themes: Vec<ImportedTheme>,
    #[serde(default)]
    pub quick_commands: Vec<QuickCommand>,
    pub summary: String,
    /// Entries left out (unsupported protocol / session type, malformed).
    #[serde(default)]
    pub skipped: usize,
    /// Sessions whose saved (encrypted) password was not imported.
    #[serde(default)]
    pub passwords_skipped: usize,
    /// Sessions using a key that could not be found as a file (pick it again).
    #[serde(default)]
    pub keys_missing: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStatePayload {
    pub instance_id: String,
    pub status: String,
    pub message: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clipboard_files_default_on_for_older_sessions() {
        let old: DesktopConfig = serde_json::from_str(r#"{"clipboard":true}"#).unwrap();
        assert!(old.clipboard_files);
        let off: DesktopConfig = serde_json::from_str(r#"{"clipboardFiles":false}"#).unwrap();
        assert!(!off.clipboard_files);
        assert!(DesktopConfig::default().clipboard_files);
    }
}
