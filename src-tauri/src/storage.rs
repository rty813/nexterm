use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use anyhow::{Context, Result};
use uuid::Uuid;

use crate::importer::parse_windterm_quickbar;
use crate::local_secrets::{self, Kind};
use crate::models::{
    AppSettings, AppStateSnapshot, AuthType, ImportedTheme, ProtocolType, QuickCommand,
    SessionConfig, StorageNotice,
};

pub struct Storage {
    base_dir: PathBuf,
    backups_checked: bool,
    /// Files set aside since the last snapshot, reported with the next one.
    notices: Mutex<Vec<StorageNotice>>,
}

impl Storage {
    pub fn new(base_dir: PathBuf) -> Result<Self> {
        fs::create_dir_all(&base_dir)
            .with_context(|| format!("Failed to create storage directory: {:?}", base_dir))?;
        Ok(Self { base_dir, backups_checked: false, notices: Mutex::new(Vec::new()) })
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

    pub fn load_snapshot(&mut self) -> Result<AppStateSnapshot> {
        let mut sessions = self.read_sessions()?.unwrap_or_else(default_sessions);
        if !self.backups_checked {
            local_secrets::migrate_backups(&self.base_dir);
            self.backups_checked = true;
        }
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
        let mut settings = self.load_settings()?;
        // Earlier builds put the proportional 'Microsoft YaHei UI' first, which makes
        // xterm measure a too-wide cell; keep a monospace font first.
        if settings.font_family.trim_start().starts_with("'Microsoft YaHei") {
            settings.font_family = AppSettings::default().font_family;
            let _ = self.save_settings(&settings);
        }
        if drop_retired_settings(&mut settings) {
            let _ = self.save_settings(&settings);
        }

        if settings.language.starts_with("zh") {
            localize_legacy_seed_data(&mut sessions, &mut quick_commands);
        }

        if !self.sessions_path().exists() {
            self.save_sessions(&sessions)?;
        }
        if !self.quick_commands_path().exists() {
            let _ = self.save_quick_commands(&quick_commands);
        }
        if !self.settings_path().exists() {
            let _ = self.save_settings(&settings);
        }

        let notices = std::mem::take(&mut *self.notices.lock().unwrap_or_else(|e| e.into_inner()));
        Ok(AppStateSnapshot {
            sessions,
            quick_commands,
            custom_themes,
            settings,
            notices,
        })
    }

    fn notice(&self, file: &str, kept: &Path) {
        eprintln!("{file}.json could not be used; kept as {}", kept.display());
        self.notices.lock().unwrap_or_else(|e| e.into_inner()).push(StorageNotice {
            file: file.into(),
            kept: kept.display().to_string(),
        });
    }

    /// The saved sessions; none without a file. A file this Windows account cannot open,
    /// or a damaged one, is set aside (renamed) so the app still starts, and reported.
    fn read_sessions(&self) -> Result<Option<Vec<SessionConfig>>> {
        let path = self.sessions_path();
        let read = Kind::Sessions.read(&path, true).and_then(|value| {
            value.map(serde_json::from_value).transpose().map_err(|_| anyhow::anyhow!(local_secrets::INVALID))
        });
        match read {
            Ok(sessions) => Ok(sessions),
            Err(e) if local_secrets::recoverable(&e) => {
                let kept = local_secrets::set_aside(&path, false)?;
                self.notice("sessions", &kept);
                Ok(None)
            }
            Err(e) => Err(e),
        }
    }

    pub fn load_sessions(&self) -> Result<Vec<SessionConfig>> {
        Ok(self.read_sessions()?.unwrap_or_default())
    }

    pub fn save_sessions(&self, sessions: &[SessionConfig]) -> Result<()> {
        let path = self.sessions_path();
        Kind::Sessions.read(&path, false)?;
        local_secrets::write_atomic(&path, &Kind::Sessions.protect(serde_json::to_value(sessions)?)?)
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

    /// The settings, defaults without a file. Protected parts this Windows account cannot
    /// open (sync configuration, remote access, proxy) are reset and the rest is kept; a
    /// damaged file is set aside. Either way the original is kept and reported.
    pub fn load_settings(&self) -> Result<AppSettings> {
        let path = self.settings_path();
        let value = match Kind::Settings.read(&path, true) {
            Ok(value) => value,
            Err(e) if local_secrets::recoverable(&e) => match Kind::Settings.read_salvaged(&path)? {
                Some(value) => {
                    let kept = local_secrets::set_aside(&path, true)?;
                    local_secrets::write_atomic(&path, &Kind::Settings.protect(value.clone())?)?;
                    self.notice("settings", &kept);
                    Some(value)
                }
                None => {
                    let kept = local_secrets::set_aside(&path, false)?;
                    self.notice("settings", &kept);
                    None
                }
            },
            Err(e) => return Err(e),
        };
        let Some(value) = value else { return Ok(AppSettings::default()) };
        match serde_json::from_value(value) {
            Ok(settings) => Ok(settings),
            Err(_) => {
                let kept = local_secrets::set_aside(&path, false)?;
                self.notice("settings", &kept);
                Ok(AppSettings::default())
            }
        }
    }

    pub fn save_settings(&self, settings: &AppSettings) -> Result<()> {
        let path = self.settings_path();
        Kind::Settings.read(&path, false)?;
        local_secrets::write_atomic(&path, &Kind::Settings.protect(serde_json::to_value(settings)?)?)
    }
}

/// Settings no longer used: text highlights became per pane (frontend only), so the
/// old global `highlightRules` is removed. Returns true when something was removed.
fn drop_retired_settings(settings: &mut AppSettings) -> bool {
    settings.extra.remove("highlightRules").is_some()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn upgrades_sessions_and_backups_without_writing_cleartext_again() {
        use serde_json::{json, Value};
        let dir = tempfile::tempdir().unwrap();
        let mut storage = Storage::new(dir.path().into()).unwrap();
        let sessions = json!([{"id":"one", "protocol":"ssh", "label":"first", "host":"test.invalid",
            "username":"fake-account", "password":"test-login", "passphrase":"test-key-pass",
            "proxy":{"password":"test-proxy"}, "jumpHost":{"host":"jump", "port":22, "username":"other",
            "enabled":true, "authType":"password", "password":"test-hop", "passphrase":"test-hop-key"},
            "futureSetting": {"keep":true}}]);
        let mut settings = serde_json::to_value(AppSettings::default()).unwrap();
        settings["sync"] = json!({"password":"test-sync-password","webdav":{"password":"test-webdav"}});
        fs::write(storage.quick_commands_path(), "[]").unwrap();
        let backup = dir.path().join("backups").join("20261121-010101.001");
        fs::create_dir_all(&backup).unwrap();
        for root in [dir.path(), backup.as_path()] {
            fs::write(root.join("sessions.json"), sessions.to_string()).unwrap();
            fs::write(root.join("settings.json"), settings.to_string()).unwrap();
        }
        let snap = storage.load_snapshot().unwrap();
        assert_eq!(snap.sessions[0].password.as_deref(), Some("test-login"));
        assert_eq!(snap.settings.extra["sync"], settings["sync"]);
        for root in [dir.path(), backup.as_path()] {
            let path = root.join("sessions.json");
            let disk = fs::read_to_string(&path).unwrap();
            for needle in ["fake-account", "test.invalid", "test-login", "test-key-pass", "test-proxy", "test-hop"] {
                assert!(!disk.contains(needle));
            }
            assert_eq!(Kind::Sessions.read(&path, false).unwrap(), Some(sessions.clone()));
            assert!(!fs::read_to_string(root.join("settings.json")).unwrap().contains("test-"));
        }
        storage.save_sessions(&snap.sessions).unwrap();
        let saved: Value = serde_json::from_slice(&fs::read(storage.sessions_path()).unwrap()).unwrap();
        assert!(saved.get("ciphertext").is_some());
        let mut broken = saved.clone();
        broken["ciphertext"] = json!("YWJj");
        let broken = broken.to_string();
        fs::write(storage.sessions_path(), &broken).unwrap();
        // Another account's (here: damaged) file is set aside unchanged; the app still starts.
        let snap = storage.load_snapshot().unwrap();
        assert_eq!(snap.notices.len(), 1);
        assert_eq!(snap.notices[0].file, "sessions");
        assert_eq!(fs::read_to_string(&snap.notices[0].kept).unwrap(), broken);
        assert!(storage.load_snapshot().unwrap().notices.is_empty());
        assert!(storage.sessions_path().exists());
        storage.save_sessions(&[]).unwrap();

        // Settings: only the part that cannot be opened is reset.
        let mut disk: Value = serde_json::from_slice(&fs::read(storage.settings_path()).unwrap()).unwrap();
        disk["sync"]["ciphertext"] = json!("YWJj");
        disk["fontSize"] = json!(19);
        fs::write(storage.settings_path(), disk.to_string()).unwrap();
        let snap = storage.load_snapshot().unwrap();
        assert_eq!(snap.settings.font_size, 19);
        assert!(snap.settings.extra.get("sync").is_none());
        assert_eq!(snap.notices[0].file, "settings");
        assert!(fs::read_to_string(&snap.notices[0].kept).unwrap().contains("YWJj"));
    }

    #[test]
    fn drops_global_highlight_rules() {
        let mut settings = AppSettings::default();
        settings.extra.insert("highlightRules".into(), serde_json::json!([{ "id": "a", "pattern": "err" }]));
        settings.extra.insert("toolbar".into(), serde_json::json!(["x"]));
        assert!(drop_retired_settings(&mut settings));
        assert!(!settings.extra.contains_key("highlightRules"));
        assert!(settings.extra.contains_key("toolbar"));
        assert!(!drop_retired_settings(&mut settings));
    }
}
