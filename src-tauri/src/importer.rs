use std::collections::HashMap;
use std::fs;
use std::path::Path;
use anyhow::{Context, Result};
use serde_json::Value;
use uuid::Uuid;

mod windterm_login;
use windterm_login::{Login, ProfileKey};

use crate::models::{
    AuthType, DiscoveryCandidate, ImportResult, ImportedTheme, JumpHostConfig, ProtocolType,
    ProxyConfig, QuickCommand, SerialConfig, SessionConfig, TunnelConfig, X11Config,
};

/// Strip `//` line comments and `/* ... */` block comments while respecting JSON string literals.
pub fn strip_json_comments(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    let mut in_string = false;
    let mut escape = false;
    let backslash = char::from(92);
    let newline = char::from(10);

    while let Some(c) = chars.next() {
        if in_string {
            out.push(c);
            if escape {
                escape = false;
            } else if c == backslash {
                escape = true;
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }

        if c == '"' {
            in_string = true;
            out.push(c);
        } else if c == '/' {
            match chars.peek().copied() {
                Some('/') => {
                    chars.next();
                    for nc in chars.by_ref() {
                        if nc == newline {
                            out.push(newline);
                            break;
                        }
                    }
                }
                Some('*') => {
                    chars.next();
                    while let Some(nc) = chars.next() {
                        if nc == '*' && chars.peek() == Some(&'/') {
                            chars.next();
                            break;
                        }
                    }
                }
                _ => out.push(c),
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Parse WindTerm `user.sessions` JSON content into `SessionConfig` items.
pub fn parse_windterm_sessions(raw: &str) -> Result<Vec<SessionConfig>> {
    parse_windterm_sessions_with_login(raw, |_| Ok(None))
}

fn parse_windterm_sessions_with_login(
    raw: &str,
    mut read_login: impl FnMut(&str) -> Result<Option<Login>>,
) -> Result<Vec<SessionConfig>> {
    let cleaned = strip_json_comments(raw.trim_start_matches('\u{feff}'));
    let val: Value =
        serde_json::from_str(&cleaned).context("Invalid WindTerm user.sessions JSON")?;
    let arr = val
        .as_array()
        .context("Expected top-level array in WindTerm user.sessions")?;
    let app_dir = find_windterm_app_dir();

    let mut result = Vec::new();
    for item in arr {
        let Some(obj) = item.as_object() else {
            continue;
        };
        let get_str = |key: &str| {
            obj.get(key)
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        };

        let proto_raw = get_str("session.protocol")
            .unwrap_or_else(|| "SSH".to_string())
            .to_ascii_lowercase();
        let target = get_str("session.target").unwrap_or_default();

        let group = get_str("session.group").unwrap_or_else(|| "WindTerm 导入".to_string());
        let id = get_str("session.uuid").unwrap_or_else(|| Uuid::new_v4().to_string());
        let term = get_str("session.term").unwrap_or_else(|| "xterm-256color".to_string());
        let keep_alive_secs = obj
            .get("session.keepAlive")
            .and_then(|v| v.as_u64())
            .unwrap_or(60);

        let mut explicit_user = get_str("session.username")
            .or_else(|| get_str("ssh.username"))
            .or_else(|| get_str("session.user"))
            .or_else(|| get_str("ssh.user"))
            .unwrap_or_default();
        let mut password = None;
        let mut passphrase = None;

        let mut private_key = get_str("ssh.identityFilePath.windows")
            .or_else(|| get_str("ssh.identityFilePath"))
            .or_else(|| get_str("ssh.privateKey"))
            .map(|s| expand_tilde(&s));
        let use_public_key = obj
            .get("ssh.authPublicKey")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let mut port = obj
            .get("session.port")
            .and_then(|v| v.as_u64())
            .map(|p| p as u16)
            .unwrap_or(22);
        let mut serial = None;
        let mut working_dir = None;

        let (protocol, host, username, shell_command) = match proto_raw.as_str() {
            "ssh" | "ssh2" => {
                if let Some(blob) = obj.get("session.autoLogin").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                    if let Some(mut login) = read_login(blob)? {
                        password = login.take_password();
                        let (key_path, key_pass) = login.take_key();
                        if private_key.is_none() {
                            private_key = key_path.map(|s| expand_tilde(&s));
                        }
                        passphrase = key_pass;
                        if !login.username.is_empty() {
                            explicit_user = login.username;
                        }
                    }
                }
                let (u, h) = split_user_host(&target, &explicit_user);
                (ProtocolType::Ssh, h, u, None)
            }
            "telnet" => {
                if !obj.contains_key("session.port") {
                    port = 23;
                }
                (ProtocolType::Telnet, target.clone(), String::new(), None)
            }
            "tcp" | "raw" => (ProtocolType::Tcp, target.clone(), String::new(), None),
            "serial" => {
                let baud_rate = obj
                    .get("serial.baudRate")
                    .and_then(|v| {
                        v.as_u64()
                            .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
                    })
                    .map(|b| b as u32)
                    .unwrap_or(115200);
                serial = Some(SerialConfig {
                    baud_rate,
                    ..SerialConfig::default()
                });
                port = 0;
                (ProtocolType::Serial, target.clone(), String::new(), None)
            }
            "cmd" => (ProtocolType::Cmd, String::new(), String::new(), None),
            "powershell" | "pwsh" => (ProtocolType::Powershell, String::new(), String::new(), None),
            "wsl" => (ProtocolType::Wsl, String::new(), String::new(), None),
            _ => {
                // WindTerm "Shell" sessions: session.target is the executable,
                // process.arguments its arguments (e.g. gsudo.exe + powershell.exe).
                port = 0;
                let exe = expand_windterm_vars(&target, app_dir.as_deref());
                let args = get_str("process.arguments")
                    .map(|a| expand_windterm_vars(&a, app_dir.as_deref()))
                    .unwrap_or_default();
                working_dir = get_str("process.workingDirectory")
                    .map(|d| expand_windterm_vars(&d, app_dir.as_deref()));
                let exe_name = Path::new(&exe)
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                let system = get_str("session.system").unwrap_or_default().to_ascii_lowercase();
                let builtin = match exe_name.as_str() {
                    "powershell" | "pwsh" => Some(ProtocolType::Powershell),
                    "cmd" => Some(ProtocolType::Cmd),
                    "wsl" => Some(ProtocolType::Wsl),
                    "" => match system.as_str() {
                        "cmd" => Some(ProtocolType::Cmd),
                        "wsl" => Some(ProtocolType::Wsl),
                        _ => Some(ProtocolType::Powershell),
                    },
                    _ => None,
                };
                match builtin {
                    Some(p) if args.is_empty() => (p, String::new(), String::new(), None),
                    _ => {
                        let cmdline = if args.is_empty() {
                            quote_if_needed(&exe)
                        } else {
                            format!("{} {}", quote_if_needed(&exe), args)
                        };
                        (ProtocolType::Custom, String::new(), String::new(), Some(cmdline))
                    }
                }
            }
        };

        let label = get_str("session.label").unwrap_or_else(|| match protocol {
            ProtocolType::Serial => format!(
                "{} ({})",
                target,
                serial.as_ref().map(|s| s.baud_rate).unwrap_or(115200)
            ),
            _ if target.is_empty() => "Imported Session".to_string(),
            _ => target.clone(),
        });

        let auth_type = if protocol == ProtocolType::Ssh {
            if private_key.is_some() || (use_public_key && password.is_none()) {
                AuthType::PrivateKey
            } else {
                AuthType::Password
            }
        } else {
            AuthType::None
        };

        result.push(SessionConfig {
            id,
            label,
            group,
            protocol,
            host,
            port,
            username,
            auth_type,
            password,
            private_key_path: private_key,
            passphrase,
            credential_id: None,
            jump_host: None,
            term,
            keep_alive_secs,
            startup_command: None,
            working_dir,
            shell_command,
            serial,
            auto_log: obj.contains_key("session.userLogFilePath")
                || obj.get("session.userLogType").and_then(|v| v.as_u64()).unwrap_or(0) > 0,
            proxy: parse_windterm_proxy(obj),
            tunnels: get_str("ssh.tunnels").map(|t| parse_windterm_tunnels(&t)).unwrap_or_default(),
            x11: obj
                .get("ssh.x11")
                .and_then(|v| v.as_bool())
                .filter(|on| *on)
                .map(|_| X11Config { enabled: true, display: "localhost:0.0".into() }),
            charset: get_str("session.charset").unwrap_or_default(),
            system: get_str("session.system").map(|s| s.to_ascii_lowercase()).unwrap_or_default(),
            skip_host_key_check: obj.get("ssh.verifyServerFingerprint").and_then(|v| v.as_bool()) == Some(false),
            desktop: None,
            adb: None,
            extra: match get_str("session.dataType") {
                Some(t) if t.eq_ignore_ascii_case("binary") => {
                    [("dataType".to_string(), Value::from("binary"))].into_iter().collect()
                }
                _ => Default::default(),
            },
        });
    }

    Ok(result)
}

/// WindTerm proxy: "session.proxy" = None | Http | Socks4 | Socks5, plus host / port / user.
fn parse_windterm_proxy(obj: &serde_json::Map<String, Value>) -> Option<ProxyConfig> {
    let kind = obj.get("session.proxy")?.as_str()?.trim().to_ascii_lowercase();
    let kind = match kind.as_str() {
        "http" | "https" => "http",
        "socks4" | "socks4a" => "socks4",
        "socks5" | "socks" => "socks5",
        _ => return None,
    };
    let host = obj.get("session.proxyHost")?.as_str()?.trim().to_string();
    let port = obj
        .get("session.proxyPort")
        .and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))? as u16;
    Some(ProxyConfig {
        kind: kind.into(),
        host,
        port,
        username: obj.get("session.proxyUsername").and_then(|v| v.as_str()).map(str::to_string),
        password: None,
        command: None,
    })
}

/// WindTerm "ssh.tunnels": `name:Local(listenHost),listenPort,targetHost:targetPort;...`
/// with Local / Remote / Dynamic; an empty target host means localhost.
pub fn parse_windterm_tunnels(raw: &str) -> Vec<TunnelConfig> {
    raw.split(';')
        .filter(|t| !t.trim().is_empty())
        .filter_map(|entry| {
            let (name, rest) = entry.split_once(':')?;
            let open = rest.find('(')?;
            let close = rest.find(')')?;
            let kind = rest[..open].trim().to_ascii_lowercase();
            let listen_host = rest[open + 1..close].trim().to_string();
            let mut fields = rest[close + 1..].trim_start_matches(',').splitn(2, ',');
            let listen_port: u16 = fields.next()?.trim().parse().ok()?;
            let target = fields.next().unwrap_or("").trim();
            let (target_host, target_port) = match target.rsplit_once(':') {
                Some((h, p)) => (h.trim().to_string(), p.trim().parse().unwrap_or(0)),
                None => (String::new(), 0),
            };
            let kind = match kind.as_str() {
                "local" => "local",
                "remote" => "remote",
                "dynamic" => "dynamic",
                _ => return None,
            };
            Some(TunnelConfig {
                name: name.trim().to_string(),
                kind: kind.into(),
                listen_host: if listen_host.is_empty() || listen_host == "localhost" { "127.0.0.1".into() } else { listen_host },
                listen_port,
                target_host: if target_host.is_empty() { "localhost".into() } else { target_host },
                target_port,
                enabled: true,
            })
        })
        .collect()
}

/// WindTerm `quick.icon` ("session::tag-coral") as we store it ("tag-coral").
fn icon_of(raw: &str) -> Option<String> {
    let icon = raw.trim();
    let icon = icon.strip_prefix("session::").unwrap_or(icon);
    (!icon.is_empty()).then(|| icon.to_string())
}

/// Parse WindTerm `quickbar.config` (array of `quick.*` entries) into quick commands.
pub fn parse_windterm_quickbar(raw: &str) -> Result<Vec<QuickCommand>> {
    let cleaned = strip_json_comments(raw);
    let val: Value =
        serde_json::from_str(&cleaned).context("Invalid WindTerm quickbar.config JSON")?;
    let arr = val
        .as_array()
        .context("Expected top-level array in WindTerm quickbar.config")?;

    let mut result = Vec::new();
    for item in arr {
        let Some(obj) = item.as_object() else {
            continue;
        };
        let get_str = |key: &str| obj.get(key).and_then(|v| v.as_str()).unwrap_or("");
        let kind = get_str("quick.type");
        if !kind.is_empty() && kind != "Send Text" {
            continue;
        }
        let command = get_str("quick.text");
        if command.is_empty() {
            continue;
        }
        let label = match get_str("quick.label").trim() {
            "" => command.lines().next().unwrap_or(command).chars().take(24).collect(),
            l => l.to_string(),
        };
        let group = match get_str("quick.group").trim() {
            "" => "快捷命令".to_string(),
            g => g.to_string(),
        };
        let id = match get_str("quick.uuid").trim() {
            "" => Uuid::new_v4().to_string(),
            u => u.to_string(),
        };
        result.push(QuickCommand {
            id,
            label,
            group,
            // WindTerm sends quick.text verbatim; line breaks are already embedded as \r.
            command: command.to_string(),
            append_newline: false,
            icon: icon_of(get_str("quick.icon")),
            shortcut: None,
            kind: None,
            action: None,
            escapes: Some(true),
        });
    }
    Ok(result)
}

/// Locate the WindTerm installation directory (the folder holding WindTerm.exe),
/// used to expand `$(AppDir)` / `${AppDir}` in imported shell sessions.
fn find_windterm_app_dir() -> Option<String> {
    let mut roots: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd);
    }
    if let Ok(exe) = std::env::current_exe() {
        roots.push(exe);
    }
    for root in roots {
        for dir in root.ancestors().take(6) {
            if dir.join("WindTerm.exe").is_file() {
                return Some(dir.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    None
}

fn expand_windterm_vars(input: &str, app_dir: Option<&str>) -> String {
    let home = dirs::home_dir()
        .map(|h| h.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    let mut out = input
        .replace("$(HomeDir)", &home)
        .replace("${HomeDir}", &home);
    if let Some(dir) = app_dir {
        out = out.replace("$(AppDir)", dir).replace("${AppDir}", dir);
    }
    out.trim().to_string()
}

fn quote_if_needed(path: &str) -> String {
    if path.contains(' ') && !path.starts_with('"') {
        format!("\"{}\"", path)
    } else {
        path.to_string()
    }
}

/// Parse OpenSSH `~/.ssh/config` content into `SessionConfig` entries.
pub fn parse_openssh_config(raw: &str) -> Vec<SessionConfig> {
    #[derive(Default)]
    struct HostBlock {
        aliases: Vec<String>,
        hostname: Option<String>,
        user: Option<String>,
        port: Option<u16>,
        identity_file: Option<String>,
        proxy_jump: Option<String>,
    }

    let mut blocks: Vec<HostBlock> = Vec::new();
    let mut current: Option<HostBlock> = None;

    for line in raw.lines() {
        let line = line.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(2, |c: char| c.is_whitespace() || c == '=');
        let Some(key) = parts.next().map(|s| s.trim().to_ascii_lowercase()) else {
            continue;
        };
        let Some(val) = parts.next().map(|s| s.trim().trim_matches('"')) else {
            continue;
        };
        if val.is_empty() {
            continue;
        }

        if key == "host" {
            if let Some(b) = current.take() {
                blocks.push(b);
            }
            let aliases = val
                .split_whitespace()
                .filter(|a| !a.contains('*') && !a.contains('?') && !a.starts_with('!'))
                .map(|s| s.to_string())
                .collect::<Vec<_>>();
            current = Some(HostBlock {
                aliases,
                ..Default::default()
            });
        } else if let Some(ref mut b) = current {
            match key.as_str() {
                "hostname" => b.hostname = Some(val.to_string()),
                "user" => b.user = Some(val.to_string()),
                "port" => b.port = val.parse::<u16>().ok(),
                "identityfile" => {
                    if b.identity_file.is_none() {
                        b.identity_file = Some(expand_tilde(val));
                    }
                }
                "proxyjump" => b.proxy_jump = Some(val.to_string()),
                _ => {}
            }
        }
    }
    if let Some(b) = current {
        blocks.push(b);
    }

    let mut sessions = Vec::new();
    for b in blocks {
        for alias in b.aliases {
            let host = b.hostname.clone().unwrap_or_else(|| alias.clone());
            let username = b.user.clone().unwrap_or_else(|| "root".to_string());
            let port = b.port.unwrap_or(22);
            let auth_type = if b.identity_file.is_some() {
                AuthType::PrivateKey
            } else {
                AuthType::Password
            };

            let jump_host = b.proxy_jump.as_ref().and_then(|pj| {
                let first_hop = pj.split(',').next()?.trim();
                if first_hop.eq_ignore_ascii_case("none") || first_hop.is_empty() {
                    return None;
                }
                let (ju, host_port) = if first_hop.contains('@') {
                    split_user_host(first_hop, "")
                } else {
                    split_user_host(first_hop, &username)
                };
                let (jh, jp) = split_host_port(&host_port, 22);
                Some(JumpHostConfig {
                    enabled: true,
                    host: jh,
                    port: jp,
                    username: ju,
                    auth_type: AuthType::Password,
                    password: None,
                    private_key_path: b.identity_file.clone(),
                    passphrase: None,
                    credential_id: None,
                })
            });

            sessions.push(SessionConfig {
                id: Uuid::new_v4().to_string(),
                label: alias,
                group: "OpenSSH Config".to_string(),
                protocol: ProtocolType::Ssh,
                host,
                port,
                username,
                auth_type,
                password: None,
                private_key_path: b.identity_file.clone(),
                passphrase: None,
                jump_host,
                term: "xterm-256color".to_string(),
                keep_alive_secs: 60,
                startup_command: None,
                working_dir: None,
                shell_command: None,
                serial: None,
                auto_log: false,
                ..Default::default()
            });
        }
    }
    sessions
}

/// Parse a WindTerm theme folder containing `scheme.theme` (and optionally `gui.theme`).
pub fn parse_windterm_theme_dir(theme_dir: &Path) -> Result<ImportedTheme> {
    let scheme_path = theme_dir.join("scheme.theme");
    let raw = fs::read_to_string(&scheme_path)
        .with_context(|| format!("Missing scheme.theme in {:?}", theme_dir))?;
    let folder_name = theme_dir
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("custom-theme");
    let gui_raw = fs::read_to_string(theme_dir.join("gui.theme")).ok();
    parse_windterm_scheme_str(folder_name, &raw, gui_raw.as_deref())
}

pub fn parse_windterm_scheme_str(
    theme_name: &str,
    scheme_raw: &str,
    gui_raw: Option<&str>,
) -> Result<ImportedTheme> {
    let cleaned = strip_json_comments(scheme_raw);
    let val: Value = serde_json::from_str(&cleaned).context("Invalid scheme.theme JSON")?;
    let styles = val
        .get("styles")
        .and_then(|v| v.as_array())
        .context("Missing styles array in scheme.theme")?;

    let mut fg_map: HashMap<String, String> = HashMap::new();
    let mut bg_map: HashMap<String, String> = HashMap::new();

    for entry in styles {
        let Some(name) = entry.get("name").and_then(|v| v.as_str()) else {
            continue;
        };
        if let Some(style) = entry.get("style").and_then(|v| v.as_object()) {
            if let Some(fg) = style.get("foreground").and_then(|v| v.as_str()) {
                fg_map.insert(name.to_string(), first_color(fg));
            }
            if let Some(bg) = style.get("background").and_then(|v| v.as_str()) {
                bg_map.insert(name.to_string(), first_color(bg));
            }
        }
    }

    let term_bg = bg_map
        .get("text.default")
        .cloned()
        .unwrap_or_else(|| "#1c1c1c".to_string());
    let term_fg = fg_map
        .get("text.default")
        .cloned()
        .unwrap_or_else(|| "#f8f8f2".to_string());

    let is_light = theme_name.to_ascii_lowercase().contains("white")
        && !theme_name.to_ascii_lowercase().contains("black-and-white")
        || term_bg.eq_ignore_ascii_case("white")
        || term_bg.eq_ignore_ascii_case("#ffffff");

    let gui_is_light = gui_raw
        .map(|g| g.contains("#f5f5f5") || g.contains("background-color: white"))
        .unwrap_or(is_light);

    let (gui_bg, gui_panel, gui_fg) = if gui_is_light {
        (
            "#f5f5f5".to_string(),
            "#ffffff".to_string(),
            "#333333".to_string(),
        )
    } else {
        (
            "#1c1c1c".to_string(),
            "#252526".to_string(),
            "#bbbbbb".to_string(),
        )
    };

    let ansi_keys = [
        ("terminal.ansiBlack", "#333333"),
        ("terminal.ansiRed", "#C4265E"),
        ("terminal.ansiGreen", "#86B42B"),
        ("terminal.ansiYellow", "#D0A500"),
        ("terminal.ansiBlue", "#3465A4"),
        ("terminal.ansiMagenta", "#8C6BC8"),
        ("terminal.ansiCyan", "#56ADBC"),
        ("terminal.ansiWhite", "#e3e3dd"),
        ("terminal.ansiBrightBlack", "#666666"),
        ("terminal.ansiBrightRed", "#f92672"),
        ("terminal.ansiBrightGreen", "#A6E22E"),
        ("terminal.ansiBrightYellow", "#9e862f"),
        ("terminal.ansiBrightBlue", "#819aff"),
        ("terminal.ansiBrightMagenta", "#AE81FF"),
        ("terminal.ansiBrightCyan", "#66D9EF"),
        ("terminal.ansiBrightWhite", "#f8f8f2"),
    ];

    let ansi = std::array::from_fn(|idx| {
        let (key, fallback) = ansi_keys[idx];
        fg_map
            .get(key)
            .cloned()
            .unwrap_or_else(|| fallback.to_string())
    });

    Ok(ImportedTheme {
        id: format!("imported-{}", theme_name.to_ascii_lowercase()),
        name: format!("{} (Imported)", theme_name),
        is_light: gui_is_light,
        gui_bg,
        gui_panel,
        gui_fg,
        accent: "#007acc".to_string(),
        term_bg,
        term_fg,
        cursor_local: fg_map
            .get("line.caret.local")
            .cloned()
            .unwrap_or_else(|| "#ffffff".to_string()),
        cursor_remote: fg_map
            .get("line.caret.remote")
            .cloned()
            .unwrap_or_else(|| "#ffa500".to_string()),
        ansi,
    })
}

/// Discover existing WindTerm profiles, themes, and OpenSSH configs on this machine.
pub fn discover_import_sources() -> Vec<DiscoveryCandidate> {
    let mut candidates = Vec::new();

    // 1. User home ~/.wind/profiles/*/terminal/user.sessions
    if let Some(home) = dirs::home_dir() {
        let wind_profiles = home.join(".wind").join("profiles");
        scan_windterm_profiles_dir(&wind_profiles, "本机 WindTerm 配置 (~/.wind)", &mut candidates);

        // 2. OpenSSH ~/.ssh/config
        let ssh_cfg = home.join(".ssh").join("config");
        if let Ok(raw) = fs::read_to_string(&ssh_cfg) {
            let parsed = parse_openssh_config(&raw);
            if !parsed.is_empty() {
                candidates.push(DiscoveryCandidate {
                    source_type: "openssh_config".to_string(),
                    label: "OpenSSH 配置文件 (~/.ssh/config)".to_string(),
                    path: ssh_cfg.to_string_lossy().to_string(),
                    item_count: parsed.len(),
                });
            }
        }
    }

    // Xshell session folders (Documents/NetSarang Computer/<version>/Xshell/Sessions).
    for dir in crate::importer_xshell::xshell_data_dirs() {
        let sessions = dir.join("Sessions");
        let count = crate::importer_xshell::count_sessions(&sessions);
        if count > 0 {
            let version = dir.parent().and_then(|v| v.file_name()).map(|v| v.to_string_lossy().to_string()).unwrap_or_default();
            candidates.push(DiscoveryCandidate {
                source_type: "xshell_sessions".to_string(),
                label: format!("Xshell {} 会话", version).replace("  ", " "),
                path: sessions.to_string_lossy().to_string(),
                item_count: count,
            });
        }
    }

    // MobaXterm.ini of an installed MobaXterm (the portable one is picked by hand).
    for ini in crate::importer_mobaxterm::mobaxterm_ini_paths() {
        if let Ok(r) = crate::importer_mobaxterm::import_path(&ini) {
            if !r.sessions.is_empty() {
                candidates.push(DiscoveryCandidate {
                    source_type: "mobaxterm".to_string(),
                    label: "MobaXterm 会话 (MobaXterm.ini)".to_string(),
                    path: ini.to_string_lossy().to_string(),
                    item_count: r.sessions.len(),
                });
            }
        }
    }

    // SecureCRT session folders (%APPDATA%VanDykeConfigSessions).
    for dir in crate::importer_securecrt::sessions_dirs() {
        let count = crate::importer_securecrt::count_sessions(&dir);
        if count > 0 {
            candidates.push(DiscoveryCandidate {
                source_type: "securecrt".to_string(),
                label: "SecureCRT 会话".to_string(),
                path: dir.to_string_lossy().to_string(),
                item_count: count,
            });
        }
    }

    // FinalShell conn folders.
    for dir in crate::importer_finalshell::conn_dirs() {
        let count = crate::importer_finalshell::count_connections(&dir);
        if count > 0 {
            candidates.push(DiscoveryCandidate {
                source_type: "finalshell".to_string(),
                label: "FinalShell 连接".to_string(),
                path: dir.to_string_lossy().to_string(),
                item_count: count,
            });
        }
    }

    // 3. Check sibling/parent WindTerm 2.7.0 installation if running inside workspace
    if let Ok(cwd) = std::env::current_dir() {
        for ancestor in cwd.ancestors().take(4) {
            let themes_dir = ancestor.join("global").join("themes");
            if themes_dir.is_dir() {
                if let Ok(entries) = fs::read_dir(&themes_dir) {
                    for entry in entries.flatten() {
                        let p = entry.path();
                        if p.join("scheme.theme").is_file() {
                            let name = p
                                .file_name()
                                .and_then(|s| s.to_str())
                                .unwrap_or("theme");
                            candidates.push(DiscoveryCandidate {
                                source_type: "windterm_theme".to_string(),
                                label: format!("WindTerm 主题配色: {}", name),
                                path: p.to_string_lossy().to_string(),
                                item_count: 1,
                            });
                        }
                    }
                }
            }

            let fixture_profiles = ancestor
                .join("ansi_vt_fix")
                .join("profile_home")
                .join(".wind")
                .join("profiles");
            scan_windterm_profiles_dir(
                &fixture_profiles,
                "工作区 WindTerm 配置",
                &mut candidates,
            );
        }
    }

    candidates
}

fn scan_windterm_profiles_dir(
    profiles_dir: &Path,
    prefix: &str,
    out: &mut Vec<DiscoveryCandidate>,
) {
    let Ok(entries) = fs::read_dir(profiles_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let quickbar_file = entry.path().join("terminal").join("quickbar.config");
        if let Ok(raw) = fs::read_to_string(&quickbar_file) {
            if let Ok(parsed) = parse_windterm_quickbar(&raw) {
                if !parsed.is_empty() {
                    out.push(DiscoveryCandidate {
                        source_type: "windterm_quickbar".to_string(),
                        label: format!(
                            "{} 快捷命令 ({})",
                            prefix,
                            entry.file_name().to_string_lossy()
                        ),
                        path: quickbar_file.to_string_lossy().to_string(),
                        item_count: parsed.len(),
                    });
                }
            }
        }
        let sessions_file = entry.path().join("terminal").join("user.sessions");
        if sessions_file.is_file() {
            if let Ok(raw) = fs::read_to_string(&sessions_file) {
                if let Ok(parsed) = parse_windterm_sessions(&raw) {
                    if !parsed.is_empty() {
                        let prof_name = entry
                            .file_name()
                            .to_string_lossy()
                            .to_string();
                        out.push(DiscoveryCandidate {
                            source_type: "windterm_sessions".to_string(),
                            label: format!("{} ({})", prefix, prof_name),
                            path: sessions_file.to_string_lossy().to_string(),
                            item_count: parsed.len(),
                        });
                    }
                }
            }
        }
    }
}

/// Identity of an imported session for spotting a repeated import: importers make a new id
/// every time, so match on group, name, protocol, host and port instead. Username is left out
/// so that a re-import with a corrected username still updates the old entry.
fn import_identity(s: &SessionConfig) -> (String, String, String, String, u16) {
    (
        s.group.trim().to_lowercase(),
        s.label.trim().to_lowercase(),
        format!("{:?}", s.protocol),
        s.host.trim().to_lowercase(),
        s.port,
    )
}

/// Merge imported sessions into the saved list. One that matches an existing session (same
/// id, or the same identity: imported before) replaces it in place and takes over its id, so
/// importing twice does not duplicate. A credential reference the user attached afterwards is
/// kept when the import brings no password or key of its own. Returns how many were updated.
pub fn merge_imported_sessions(existing: &mut Vec<SessionConfig>, incoming: &mut [SessionConfig]) -> usize {
    let mut updated = 0;
    let mut claimed = vec![false; existing.len()];
    for s in incoming.iter_mut() {
        let id = import_identity(s);
        let pos = existing.iter().position(|e| e.id == s.id).or_else(|| {
            existing.iter().enumerate().position(|(i, e)| !claimed.get(i).copied().unwrap_or(true) && import_identity(e) == id)
        });
        match pos {
            Some(pos) => {
                let old = &existing[pos];
                s.id = old.id.clone();
                let brings_secret = s.password.is_some() || s.private_key_path.is_some();
                if !brings_secret && s.credential_id.is_none() {
                    s.credential_id = old.credential_id.clone();
                }
                existing[pos] = s.clone();
                if let Some(c) = claimed.get_mut(pos) {
                    *c = true;
                }
                updated += 1;
            }
            None => existing.push(s.clone()),
        }
    }
    updated
}

pub fn import_from_path(source_type: &str, path_str: &str, secret: Option<&str>) -> Result<ImportResult> {
    let path = Path::new(path_str);
    match source_type {
        "windterm_sessions" => {
            let raw = fs::read_to_string(path)
                .with_context(|| format!("读取文件失败: {}", path_str))?;
            let mut key = None;
            let (mut passwords_skipped, mut opened, mut failed) = (0, 0, 0);
            let sessions = parse_windterm_sessions_with_login(&raw, |blob| {
                let Some(master) = secret else {
                    passwords_skipped += 1;
                    return Ok(None);
                };
                if key.is_none() {
                    key = Some(ProfileKey::load(path, master)?);
                }
                // One stale or damaged login (copied from another profile) skips only that
                // session's login; if none can be opened the key is wrong (checked below).
                match key.as_ref().unwrap().decrypt(blob) {
                    Ok(login) => { opened += 1; Ok(Some(login)) }
                    Err(_) => { failed += 1; Ok(None) }
                }
            })?;
            anyhow::ensure!(opened > 0 || failed == 0, "windtermDecryptFailed");
            passwords_skipped += failed;
            let count = sessions.len();
            Ok(ImportResult {
                sessions,
                themes: Vec::new(),
                quick_commands: Vec::new(),
                summary: format!("已从 WindTerm user.sessions 成功导入 {} 个会话", count),
                skipped: 0,
                passwords_skipped,
                keys_missing: 0,
                updated: 0,
            })
        }
        "windterm_quickbar" => {
            let raw = fs::read_to_string(path)
                .with_context(|| format!("读取文件失败: {}", path_str))?;
            let quick_commands = parse_windterm_quickbar(&raw)?;
            let count = quick_commands.len();
            Ok(ImportResult {
                sessions: Vec::new(),
                themes: Vec::new(),
                quick_commands,
                summary: format!("已从 WindTerm quickbar.config 成功导入 {} 条快捷命令", count),
                skipped: 0,
                passwords_skipped: 0,
                keys_missing: 0,
                updated: 0,
            })
        }
        "openssh_config" => {
            let raw = fs::read_to_string(path)
                .with_context(|| format!("读取文件失败: {}", path_str))?;
            let sessions = parse_openssh_config(&raw);
            let count = sessions.len();
            Ok(ImportResult {
                sessions,
                themes: Vec::new(),
                quick_commands: Vec::new(),
                summary: format!("已从 OpenSSH 配置成功导入 {} 个主机", count),
                skipped: 0,
                passwords_skipped: 0,
                keys_missing: 0,
                updated: 0,
            })
        }
        "windterm_theme" => {
            let theme_dir = if path.is_file() {
                path.parent().unwrap_or(path)
            } else {
                path
            };
            let theme = parse_windterm_theme_dir(theme_dir)?;
            let name = theme.name.clone();
            Ok(ImportResult {
                sessions: Vec::new(),
                themes: vec![theme],
                quick_commands: Vec::new(),
                summary: format!("已成功导入 WindTerm 配色主题 '{}'", name),
                skipped: 0,
                passwords_skipped: 0,
                keys_missing: 0,
                updated: 0,
            })
        }
        "xshell_sessions" => {
            let r = crate::importer_xshell::import_path(path)?;
            Ok(ImportResult {
                summary: format!("已从 Xshell 导入 {} 个会话", r.sessions.len()),
                sessions: r.sessions,
                themes: Vec::new(),
                quick_commands: Vec::new(),
                skipped: r.skipped,
                passwords_skipped: r.passwords_skipped,
                keys_missing: r.keys_missing,
                updated: 0,
            })
        }
        "mobaxterm" => {
            let r = crate::importer_mobaxterm::import_path(path)?;
            Ok(ImportResult {
                summary: format!("已从 MobaXterm 导入 {} 个会话", r.sessions.len()),
                sessions: r.sessions,
                themes: Vec::new(),
                quick_commands: Vec::new(),
                skipped: r.skipped,
                passwords_skipped: 0,
                keys_missing: 0,
                updated: 0,
            })
        }
        "securecrt" => {
            let r = crate::importer_securecrt::import_path_with(path, secret.unwrap_or("").as_bytes())?;
            Ok(ImportResult {
                summary: format!("已从 SecureCRT 导入 {} 个会话", r.sessions.len()),
                sessions: r.sessions,
                themes: Vec::new(),
                quick_commands: Vec::new(),
                skipped: r.skipped,
                passwords_skipped: r.passwords_skipped,
                keys_missing: r.keys_missing,
                updated: 0,
            })
        }
        "finalshell" => {
            let r = crate::importer_finalshell::import_path(path)?;
            Ok(ImportResult {
                summary: format!("已从 FinalShell 导入 {} 个会话", r.sessions.len()),
                sessions: r.sessions,
                themes: Vec::new(),
                quick_commands: Vec::new(),
                skipped: r.skipped,
                passwords_skipped: r.passwords_skipped,
                keys_missing: r.keys_missing,
                updated: 0,
            })
        }
        _ => anyhow::bail!("不支持的导入源类型: {}", source_type),
    }
}

fn first_color(raw: &str) -> String {
    raw.split(',')
        .next()
        .unwrap_or(raw)
        .trim()
        .to_string()
}

fn split_user_host(target: &str, explicit_user: &str) -> (String, String) {
    if let Some((u, h)) = target.rsplit_once('@') {
        let user = if explicit_user.is_empty() {
            u.trim().to_string()
        } else {
            explicit_user.to_string()
        };
        (user, h.trim().to_string())
    } else {
        (explicit_user.to_string(), target.trim().to_string())
    }
}

fn split_host_port(input: &str, default_port: u16) -> (String, u16) {
    if let Some((h, p)) = input.rsplit_once(':') {
        if let Ok(port) = p.parse::<u16>() {
            return (h.to_string(), port);
        }
    }
    (input.to_string(), default_port)
}

/// Largest session / config file read for import.
pub(crate) const IMPORT_FILE_MAX: u64 = 16 * 1024 * 1024;

/// Read a file for import, refusing anything over `max` bytes.
pub(crate) fn read_limited(path: &Path, max: u64) -> Result<Vec<u8>> {
    use std::io::Read;
    let file = fs::File::open(path).with_context(|| format!("读取文件失败: {}", path.display()))?;
    let mut raw = Vec::new();
    file.take(max + 1).read_to_end(&mut raw).with_context(|| format!("读取文件失败: {}", path.display()))?;
    if raw.len() as u64 > max {
        anyhow::bail!("文件过大（超过 {} MB）: {}", max / (1024 * 1024), path.display());
    }
    Ok(raw)
}

/// Text of a Windows config file: UTF-8 / UTF-16 (LE or BE) by BOM, UTF-16LE without BOM
/// when it looks like it, else UTF-8, else the GBK code page.
pub(crate) fn decode_text(raw: &[u8]) -> String {
    fn utf16(raw: &[u8], le: bool) -> String {
        let units: Vec<u16> = raw
            .chunks_exact(2)
            .map(|c| if le { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) })
            .collect();
        String::from_utf16_lossy(&units)
    }
    if let Some(rest) = raw.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(rest).into_owned();
    }
    if let Some(rest) = raw.strip_prefix(&[0xFF, 0xFE]) {
        return utf16(rest, true);
    }
    if let Some(rest) = raw.strip_prefix(&[0xFE, 0xFF]) {
        return utf16(rest, false);
    }
    // ASCII-heavy UTF-16LE without a BOM: most odd bytes are zero.
    if raw.len() >= 4 && raw.len() % 2 == 0 {
        let odd_zero = raw.iter().skip(1).step_by(2).filter(|&&b| b == 0).count();
        if odd_zero * 10 >= (raw.len() / 2) * 6 {
            return utf16(raw, true);
        }
    }
    match std::str::from_utf8(raw) {
        Ok(s) => s.to_string(),
        Err(_) => crate::charset::decode_codepage(936, raw),
    }
}

/// One `[section]` of an INI file, keys in file order.
#[derive(Debug, Default, Clone)]
pub(crate) struct IniSection {
    pub name: String,
    pub entries: Vec<(String, String)>,
}

impl IniSection {
    /// Case-insensitive lookup; the trimmed value, None when missing or empty.
    pub fn get(&self, key: &str) -> Option<&str> {
        self.entries
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(key))
            .map(|(_, v)| v.as_str())
            .filter(|v| !v.is_empty())
    }
}

/// Sections in file order. Lines before the first section, comments and lines without
/// `=` are ignored; only the first `=` splits key and value.
pub(crate) fn parse_ini(text: &str) -> Vec<IniSection> {
    let mut out: Vec<IniSection> = Vec::new();
    for line in text.lines() {
        let line = line.trim().trim_start_matches('\u{feff}');
        if line.is_empty() || line.starts_with(';') || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            out.push(IniSection { name: line[1..line.len() - 1].trim().to_string(), entries: Vec::new() });
            continue;
        }
        let (Some(sec), Some((k, v))) = (out.last_mut(), line.split_once('=')) else {
            continue;
        };
        sec.entries.push((k.trim().to_string(), v.trim().to_string()));
    }
    out
}

pub fn expand_tilde(path_str: &str) -> String {
    let win_prefix = format!("~{}", char::from(92));
    let stripped_opt = path_str
        .strip_prefix("~/")
        .or_else(|| path_str.strip_prefix(win_prefix.as_str()));
    if let Some(stripped) = stripped_opt {
        if let Some(home) = dirs::home_dir() {
            return home.join(stripped).to_string_lossy().to_string();
        }
    }
    path_str.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_reimport_updates_instead_of_duplicating() {
        let sess = |id: &str, user: &str| SessionConfig {
            id: id.into(),
            label: "pc".into(),
            group: "SecureCRT".into(),
            protocol: ProtocolType::Rdp,
            host: "192.0.2.10".into(),
            port: 3389,
            username: user.into(),
            ..Default::default()
        };
        let other = SessionConfig { label: "db".into(), ..sess("other", "root") };
        let mut existing = vec![
            SessionConfig { credential_id: Some("cred".into()), ..sess("old", "192.0.2.10\\user@example.com") },
            other.clone(),
        ];
        let mut incoming = vec![sess("new", "user@example.com"), SessionConfig { id: "new2".into(), host: "10.0.0.9".into(), ..sess("", "") }];
        assert_eq!(merge_imported_sessions(&mut existing, &mut incoming), 1);
        assert_eq!(existing.len(), 3);
        assert_eq!((incoming[0].id.as_str(), existing[0].username.as_str()), ("old", "user@example.com"));
        // No password in the import: the credential the user attached is kept.
        assert_eq!(existing[0].credential_id.as_deref(), Some("cred"));
        assert_eq!(existing[1].id, other.id);
        assert_eq!(existing[2].id, "new2");

        // A second identical import changes nothing in size.
        let mut again = vec![sess("x", "user@example.com"), SessionConfig { id: "y".into(), host: "10.0.0.9".into(), ..sess("", "") }];
        assert_eq!(merge_imported_sessions(&mut existing, &mut again), 2);
        assert_eq!(existing.len(), 3);
    }

    #[test]
    fn windterm_import_saved_logins() {
        let cases = [
            ("测试 master ", true, "6bqD6OZezOBD02/SdMpOlwjAi22OmiHjaozFPl0FI7gW0x8L09hZz6eFBUPQ34RmcAesG9rFYuKyZP8U6acQU5CZ54CzmoigiYnb05gp/Ds="),
            ("", false, "aYRrVYjRVtHwNZfwT4vJjEXVuyw3wN4IcTVHMO2W8JiC8q+s/fDWSJi+NtTn7wByvouyZ+w1KVcGDy7wDHksbomlzWcqD5liMqUKQ1LmVLk="),
        ];
        for (master, protected, blob) in cases {
            let profile = tempfile::tempdir().unwrap();
            let dir = if protected { profile.path().join("terminal") } else { profile.path().to_owned() };
            fs::create_dir_all(&dir).unwrap();
            let file = dir.join("user.sessions");
            let input = serde_json::json!([{
                "session.autoLogin": blob, "session.target": "old-user@example.test", "ssh.authPublicKey": true
            }, {"session.protocol":"Serial", "session.autoLogin":"not-an-ssh-login"}]);
            fs::write(&file, input.to_string()).unwrap();
            let import = |master| import_from_path("windterm_sessions", file.to_str().unwrap(), master);
            let skipped = import(None).unwrap();
            assert_eq!(skipped.passwords_skipped, 1);
            assert_eq!(skipped.sessions[0].username, "old-user");
            assert!(skipped.sessions[0].password.is_none());
            assert_eq!(import(Some(master)).unwrap_err().to_string(), "windtermProfile");
            fs::write(profile.path().join("user.config"), serde_json::json!({
                "application.fingerprint": "test-profile", "application.masterPassword": protected
            }).to_string()).unwrap();
            if protected {
                assert_eq!(import(Some("")).unwrap_err().to_string(), "windtermMasterRequired");
                assert_eq!(import(Some("wrong")).unwrap_err().to_string(), "windtermDecryptFailed");
            } else {
                // No master password set: a typed one is ignored.
                assert_eq!(import(Some("typed anyway")).unwrap().sessions[0].username, "测试");
            }
            let result = import(Some(master)).unwrap();
            assert_eq!(result.passwords_skipped, 0);
            // A damaged login next to a good one skips only that session's login.
            let mut more = input.clone();
            more.as_array_mut().unwrap().push(serde_json::json!({"session.autoLogin": "AAAA", "session.target": "other.test"}));
            fs::write(&file, more.to_string()).unwrap();
            let partial = import(Some(master)).unwrap();
            assert_eq!(partial.passwords_skipped, 1);
            assert!(partial.sessions[0].password.is_some() && partial.sessions[2].password.is_none());
            fs::write(&file, input.to_string()).unwrap();
            let session = &result.sessions[0];
            assert_eq!(session.host, "example.test");
            assert_eq!(session.username, "测试");
            assert_eq!(session.password.as_deref(), Some(" p@ss 密码 "));
            assert_eq!(session.auth_type, AuthType::Password);
        }
    }

    #[test]
    fn windterm_disabled_password_is_not_imported() {
        let mut login: Login = serde_json::from_str(r#"{"session.user":"jsmith","PasswordEnabled":false,"Password":"unused"}"#).unwrap();
        assert_eq!(login.username, "jsmith");
        assert!(login.take_password().is_none());
    }

    #[test]
    fn windterm_login_key_and_passphrase() {
        // Shapes seen in real WindTerm 2.x logins: Windows entries win, empty ones fall back.
        let mut login: Login = serde_json::from_str(r#"{"session.user":"u","Public Key":
            {"pass":"unix-pass","path":"~/.ssh/a","windows.pass":"","windows.path":"C:/k/id"}}"#).unwrap();
        assert_eq!(login.take_key(), (Some("C:/k/id".into()), Some("unix-pass".into())));
        let mut login: Login = serde_json::from_str(r#"{"Public Key":{"pass":null,"path":""}}"#).unwrap();
        assert_eq!(login.take_key(), (None, None));
        let mut login: Login = serde_json::from_str(r#"{"session.user":"u"}"#).unwrap();
        assert_eq!(login.take_key(), (None, None));
    }

    #[test]
    fn test_parse_windterm_sessions_ssh_and_tcp() {
        let sample = r#"
        // WindTerm user.sessions comment
        [
            {
                "session.group" : "Prod>Core",
                "session.label" : "Gateway Node",
                "session.port" : 2222,
                "session.protocol" : "SSH",
                "session.target" : "ubuntu@10.0.1.15",
                "session.term" : "xterm-256color",
                "session.uuid" : "session-1"
            },
            {
                "session.group" : "Fixture sessions",
                "session.label" : "ANSI VT Fixture",
                "session.port" : 47331,
                "session.protocol" : "TCP",
                "session.target" : "127.0.0.1",
                "session.uuid" : "00000000-0000-0000-0000-000000000133"
            }
        ]
        "#;

        let sessions = parse_windterm_sessions(sample).expect("should parse sessions");
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].protocol, ProtocolType::Ssh);
        assert_eq!(sessions[0].username, "ubuntu");
        assert_eq!(sessions[0].host, "10.0.1.15");
        assert_eq!(sessions[0].port, 2222);
        assert_eq!(sessions[0].group, "Prod>Core");

        assert_eq!(sessions[1].protocol, ProtocolType::Tcp);
        assert_eq!(sessions[1].host, "127.0.0.1");
        assert_eq!(sessions[1].port, 47331);
    }

    #[test]
    fn test_parse_openssh_config_with_jump_host() {
        let sample = r#"
        Host bastion
            HostName 203.0.113.10
            User ops
            Port 22022

        Host app-prod
            HostName 10.10.1.50
            User deploy
            IdentityFile ~/.ssh/id_ed25519
            ProxyJump ops@203.0.113.10:22022
        "#;

        let sessions = parse_openssh_config(sample);
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[1].label, "app-prod");
        assert_eq!(sessions[1].host, "10.10.1.50");
        assert_eq!(sessions[1].username, "deploy");
        assert_eq!(sessions[1].auth_type, AuthType::PrivateKey);
        let jump = sessions[1].jump_host.as_ref().expect("should have jump host");
        assert!(jump.enabled);
        assert_eq!(jump.host, "203.0.113.10");
        assert_eq!(jump.port, 22022);
        assert_eq!(jump.username, "ops");
    }

    #[test]
    fn test_parse_windterm_sessions_serial_shell_and_ssh_user() {
        let sample = r#"
        [
            {
                "serial.baudRate" : "1500000",
                "session.label" : "RK3588",
                "session.protocol" : "Serial",
                "session.target" : "COM4",
                "session.uuid" : "serial-1"
            },
            {
                "serial.baudRate" : "115200",
                "session.dataType" : "binary",
                "session.protocol" : "Serial",
                "session.target" : "COM5",
                "session.uuid" : "serial-2"
            },
            {
                "session.autoLogin" : "opaque",
                "session.label" : "jump-admin",
                "session.port" : 22223,
                "session.protocol" : "SSH",
                "session.target" : "backend.example.com",
                "session.uuid" : "ssh-1",
                "ssh.authPublicKey" : true,
                "ssh.identityFilePath.windows" : "C:/keys/id_rsa"
            },
            {
                "process.arguments" : "C:/Windows/system32/WindowsPowerShell/v1.0/powershell.exe",
                "session.label" : "admin:powershell",
                "session.protocol" : "Shell",
                "session.system" : "powershell",
                "session.target" : "C:/tools/gsudo.exe",
                "session.uuid" : "shell-1"
            },
            {
                "session.label" : "plain cmd",
                "session.protocol" : "Shell",
                "session.target" : "C:/WINDOWS/system32/cmd.exe",
                "session.uuid" : "shell-2"
            }
        ]
        "#;

        let sessions = parse_windterm_sessions(sample).expect("should parse sessions");
        assert_eq!(sessions[0].protocol, ProtocolType::Serial);
        assert_eq!(sessions[0].host, "COM4");
        assert_eq!(sessions[0].serial.as_ref().unwrap().baud_rate, 1_500_000);
        assert_eq!(sessions[1].label, "COM5 (115200)");
        assert!(!sessions[0].binary_data());
        assert!(sessions[1].binary_data());

        assert_eq!(sessions[2].protocol, ProtocolType::Ssh);
        assert_eq!(sessions[2].username, "");
        assert_eq!(sessions[2].auth_type, AuthType::PrivateKey);
        assert_eq!(sessions[2].private_key_path.as_deref(), Some("C:/keys/id_rsa"));

        assert_eq!(sessions[3].protocol, ProtocolType::Custom);
        assert_eq!(
            sessions[3].shell_command.as_deref(),
            Some("C:/tools/gsudo.exe C:/Windows/system32/WindowsPowerShell/v1.0/powershell.exe")
        );
        assert_eq!(sessions[4].protocol, ProtocolType::Cmd);
    }

    #[test]
    fn test_parse_windterm_tunnels_and_proxy() {
        let t = parse_windterm_tunnels("test:Local(localhost),2222,:23421;web:Remote(),8080,10.0.0.5:80;s:Dynamic(0.0.0.0),1080,;");
        assert_eq!(t.len(), 3);
        assert_eq!((t[0].kind.as_str(), t[0].listen_host.as_str(), t[0].listen_port), ("local", "127.0.0.1", 2222));
        assert_eq!((t[0].target_host.as_str(), t[0].target_port), ("localhost", 23421));
        assert_eq!((t[1].kind.as_str(), t[1].target_host.as_str(), t[1].target_port), ("remote", "10.0.0.5", 80));
        assert_eq!((t[2].kind.as_str(), t[2].listen_host.as_str(), t[2].listen_port), ("dynamic", "0.0.0.0", 1080));

        let sample = r#"[{"session.protocol":"SSH","session.target":"h","session.uuid":"p1",
            "session.proxy":"Http","session.proxyHost":"192.168.3.100","session.proxyPort":1084,
            "ssh.x11":true,"session.charset":"GBK","session.system":"cmd","ssh.verifyServerFingerprint":false},
            {"session.protocol":"Telnet","session.target":"192.168.104.2","session.uuid":"t1"}]"#;
        let s = parse_windterm_sessions(sample).unwrap();
        let p = s[0].proxy.as_ref().unwrap();
        assert_eq!((p.kind.as_str(), p.host.as_str(), p.port), ("http", "192.168.3.100", 1084));
        assert!(s[0].x11.as_ref().unwrap().enabled);
        assert_eq!((s[0].charset.as_str(), s[0].system.as_str()), ("GBK", "cmd"));
        assert!(s[0].skip_host_key_check);
        assert_eq!((s[1].protocol.clone(), s[1].port), (ProtocolType::Telnet, 23));
    }

    #[test]
    fn test_parse_windterm_quickbar() {
        let sample = r#"
        [
            {
                "quick.group" : "快速",
                "quick.label" : "查看CAN总线配置",
                "quick.text" : "ip -d -s -h link show can0\r",
                "quick.type" : "Send Text",
                "quick.icon" : "session::tag-coral",
                "quick.uuid" : "q-1"
            }
        ]
        "#;
        let cmds = parse_windterm_quickbar(sample).expect("should parse quickbar");
        assert_eq!(cmds.len(), 1);
        assert_eq!(cmds[0].group, "快速");
        assert_eq!(cmds[0].command, "ip -d -s -h link show can0\r");
        assert!(!cmds[0].append_newline);
        assert_eq!(cmds[0].icon.as_deref(), Some("tag-coral"));
    }

    #[test]
    fn test_parse_windterm_scheme_str() {
        let sample = r##"
        // Most colors take from Monokai.
        {
            "styles": [
                { "name": "terminal.ansiRed", "style": { "foreground": "#C4265E" } },
                { "name": "line.caret.remote", "style": { "foreground": "orange" } },
                { "name": "text.default", "style": { "foreground": "#F8F8F2", "background": "#1c1c1c" } }
            ]
        }
        "##;
        let theme = parse_windterm_scheme_str("dige-black", sample, None).expect("theme parse");
        assert_eq!(theme.term_bg, "#1c1c1c");
        assert_eq!(theme.term_fg, "#F8F8F2");
        assert_eq!(theme.ansi[1], "#C4265E");
        assert_eq!(theme.cursor_remote, "orange");
    }
}
