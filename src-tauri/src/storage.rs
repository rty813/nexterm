use std::fs;
use std::path::{Path, PathBuf};
use anyhow::{Context, Result};
use uuid::Uuid;

use crate::importer::parse_windterm_quickbar;
use crate::models::{
    AppSettings, AppStateSnapshot, AuthType, ImportedTheme, ProtocolType, QuickCommand,
    SessionConfig,
};

pub struct Storage {
    base_dir: PathBuf,
}

impl Storage {
    pub fn new(base_dir: PathBuf) -> Result<Self> {
        fs::create_dir_all(&base_dir)
            .with_context(|| format!("Failed to create storage directory: {:?}", base_dir))?;
        Ok(Self { base_dir })
    }

    pub fn base_dir(&self) -> &Path {
        &self.base_dir
    }

    fn sessions_path(&self) -> PathBuf {
        self.base_dir.join("sessions.json")
    }

    fn quick_commands_path(&self) -> PathBuf {
        self.base_dir.join("quick_commands.json")
    }

    fn themes_path(&self) -> PathBuf {
        self.base_dir.join("custom_themes.json")
    }

    fn settings_path(&self) -> PathBuf {
        self.base_dir.join("settings.json")
    }

    pub fn load_snapshot(&self) -> AppStateSnapshot {
        let mut sessions = self.load_sessions().unwrap_or_else(|_| default_sessions());
        let mut quick_commands = match self.load_quick_commands() {
            Ok(saved) => {
                let kept: Vec<QuickCommand> = saved
                    .iter()
                    .filter(|qc| !LEGACY_SEED_COMMANDS.contains(&qc.command.as_str()))
                    .cloned()
                    .collect();
                if kept.len() != saved.len() {
                    let next = if kept.is_empty() { default_quick_commands() } else { kept };
                    let _ = self.save_quick_commands(&next);
                    next
                } else {
                    saved
                }
            }
            Err(_) => default_quick_commands(),
        };
        let custom_themes = self.load_themes().unwrap_or_default();
        let mut settings = self.load_settings().unwrap_or_default();
        // Earlier builds put the proportional 'Microsoft YaHei UI' first, which makes
        // xterm measure a too-wide cell; keep a monospace font first.
        if settings.font_family.trim_start().starts_with("'Microsoft YaHei") {
            settings.font_family = AppSettings::default().font_family;
            let _ = self.save_settings(&settings);
        }

        if settings.language.starts_with("zh") {
            localize_legacy_seed_data(&mut sessions, &mut quick_commands);
        }

        if !self.sessions_path().exists() {
            let _ = self.save_sessions(&sessions);
        }
        if !self.quick_commands_path().exists() {
            let _ = self.save_quick_commands(&quick_commands);
        }
        if !self.settings_path().exists() {
            let _ = self.save_settings(&settings);
        }

        AppStateSnapshot {
            sessions,
            quick_commands,
            custom_themes,
            settings,
        }
    }

    pub fn load_sessions(&self) -> Result<Vec<SessionConfig>> {
        let raw = fs::read_to_string(self.sessions_path())?;
        Ok(serde_json::from_str(&raw)?)
    }

    pub fn save_sessions(&self, sessions: &[SessionConfig]) -> Result<()> {
        let json = serde_json::to_string_pretty(sessions)?;
        fs::write(self.sessions_path(), json)?;
        Ok(())
    }

    pub fn load_quick_commands(&self) -> Result<Vec<QuickCommand>> {
        let raw = fs::read_to_string(self.quick_commands_path())?;
        Ok(serde_json::from_str(&raw)?)
    }

    pub fn save_quick_commands(&self, commands: &[QuickCommand]) -> Result<()> {
        let json = serde_json::to_string_pretty(commands)?;
        fs::write(self.quick_commands_path(), json)?;
        Ok(())
    }

    pub fn load_themes(&self) -> Result<Vec<ImportedTheme>> {
        let raw = fs::read_to_string(self.themes_path())?;
        Ok(serde_json::from_str(&raw)?)
    }

    pub fn save_themes(&self, themes: &[ImportedTheme]) -> Result<()> {
        let json = serde_json::to_string_pretty(themes)?;
        fs::write(self.themes_path(), json)?;
        Ok(())
    }

    pub fn load_settings(&self) -> Result<AppSettings> {
        let raw = fs::read_to_string(self.settings_path())?;
        Ok(serde_json::from_str(&raw)?)
    }

    pub fn save_settings(&self, settings: &AppSettings) -> Result<()> {
        let json = serde_json::to_string_pretty(settings)?;
        fs::write(self.settings_path(), json)?;
        Ok(())
    }
}

pub fn localize_legacy_seed_data(
    sessions: &mut [SessionConfig],
    _quick_commands: &mut [QuickCommand],
) {
    let session_map = [
        ("Windows PowerShell", "Windows PowerShell"),
        ("Command Prompt (CMD)", "命令提示符 (CMD)"),
        ("WSL Default Distro", "WSL Linux 子系统"),
    ];

    for s in sessions {
        if let Some((_, zh)) = session_map.iter().find(|(en, _)| *en == s.label) {
            s.label = zh.to_string();
        }
        if s.group == "Local Shells" {
            s.group = "本地终端".to_string();
        }
    }
}

pub fn default_sessions() -> Vec<SessionConfig> {
    vec![
        SessionConfig {
            id: Uuid::new_v4().to_string(),
            label: "Windows PowerShell".to_string(),
            group: "本地终端".to_string(),
            protocol: ProtocolType::Powershell,
            host: String::new(),
            port: 0,
            username: String::new(),
            auth_type: AuthType::None,
            password: None,
            private_key_path: None,
            passphrase: None,
            jump_host: None,
            term: "xterm-256color".to_string(),
            keep_alive_secs: 0,
            startup_command: None,
            working_dir: None,
            shell_command: None,
            serial: None,
            auto_log: false,
            ..Default::default()
        },
        SessionConfig {
            id: Uuid::new_v4().to_string(),
            label: "命令提示符 (CMD)".to_string(),
            group: "本地终端".to_string(),
            protocol: ProtocolType::Cmd,
            host: String::new(),
            port: 0,
            username: String::new(),
            auth_type: AuthType::None,
            password: None,
            private_key_path: None,
            passphrase: None,
            jump_host: None,
            term: "xterm-256color".to_string(),
            keep_alive_secs: 0,
            startup_command: None,
            working_dir: None,
            shell_command: None,
            serial: None,
            auto_log: false,
            ..Default::default()
        },
        SessionConfig {
            id: Uuid::new_v4().to_string(),
            label: "WSL Linux 子系统".to_string(),
            group: "本地终端".to_string(),
            protocol: ProtocolType::Wsl,
            host: String::new(),
            port: 0,
            username: String::new(),
            auth_type: AuthType::None,
            password: None,
            private_key_path: None,
            passphrase: None,
            jump_host: None,
            term: "xterm-256color".to_string(),
            keep_alive_secs: 0,
            startup_command: None,
            working_dir: None,
            shell_command: None,
            serial: None,
            auto_log: false,
            ..Default::default()
        },
    ]
}

/// Commands this app used to seed on first run; stripped from saved data so the
/// QuickBar only holds the user's own (or WindTerm-imported) commands.
const LEGACY_SEED_COMMANDS: [&str; 5] = [
    "uname -a && uptime && free -h",
    "df -hT",
    "ss -tulpn",
    "docker ps --format 'table {{.Names}}  {{.Status}}  {{.Ports}}'",
    "journalctl -xe -n 50 --no-pager",
];

/// First-run quick commands: whatever the local WindTerm profile has in quickbar.config.
pub fn default_quick_commands() -> Vec<QuickCommand> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(home.join(".wind").join("profiles")) else {
        return Vec::new();
    };
    for entry in entries.flatten() {
        let path = entry.path().join("terminal").join("quickbar.config");
        if let Ok(raw) = fs::read_to_string(&path) {
            if let Ok(cmds) = parse_windterm_quickbar(&raw) {
                if !cmds.is_empty() {
                    return cmds;
                }
            }
        }
    }
    Vec::new()
}
