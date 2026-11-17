//! Where the configuration lives (WindTerm's profiles directory): next to the exe
//! (portable), in the user's app data folder (the default), or a folder the user picks.
//!
//! The choice is a small `storage-location.json` read before anything else starts. A copy
//! next to the exe wins, so a portable folder carries its own choice; otherwise the one in
//! the user's app data folder applies. Without either, this is the first run (or an install
//! from before this setting): the data stays in the user folder and, on a first run, the
//! app asks once where to keep it.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

pub const LOCATION_FILE: &str = "storage-location.json";
/// Data folder of the portable mode, under the exe's folder.
const APP_DATA_SUBDIR: &str = "data";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StorageMode {
    /// `<exe folder>/data`: portable.
    App,
    /// The user's app data folder (`%APPDATA%\com.nexterm.app`).
    User,
    /// A folder the user picked.
    Custom,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocationFile {
    mode: StorageMode,
    #[serde(default)]
    path: String,
    #[serde(default)]
    ask_at_startup: bool,
}

/// The folders the choice is made between.
#[derive(Debug, Clone)]
pub struct Roots {
    pub exe_dir: PathBuf,
    pub user_dir: PathBuf,
}

impl Roots {
    pub fn app_data(&self) -> PathBuf {
        self.exe_dir.join(APP_DATA_SUBDIR)
    }
}

#[derive(Debug, Clone)]
pub struct Resolved {
    pub mode: StorageMode,
    pub data_dir: PathBuf,
    pub custom_path: String,
    pub ask_at_startup: bool,
    /// No choice saved and no earlier data: ask where to keep it.
    pub first_run: bool,
    /// The saved folder could not be used; the user folder is used this time.
    pub fallback_error: Option<String>,
}

fn read_location(dir: &Path) -> Option<LocationFile> {
    let text = fs::read_to_string(dir.join(LOCATION_FILE)).ok()?;
    serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()
}

fn has_config(dir: &Path) -> bool {
    ["settings.json", "sessions.json"].iter().any(|f| dir.join(f).is_file())
}

/// Folder a mode stores in; `None` for a custom mode without a usable path.
pub fn target_dir(roots: &Roots, mode: StorageMode, custom: &str) -> Option<PathBuf> {
    match mode {
        StorageMode::App => Some(roots.app_data()),
        StorageMode::User => Some(roots.user_dir.clone()),
        StorageMode::Custom => {
            let p = PathBuf::from(custom.trim());
            (p.is_absolute()).then_some(p)
        }
    }
}

/// Decide the data folder for this run; creates it.
pub fn resolve(roots: &Roots) -> Resolved {
    let saved = read_location(&roots.exe_dir).or_else(|| read_location(&roots.user_dir));
    let Some(saved) = saved else {
        return Resolved {
            mode: StorageMode::User,
            data_dir: roots.user_dir.clone(),
            custom_path: String::new(),
            ask_at_startup: false,
            first_run: !has_config(&roots.user_dir),
            fallback_error: None,
        };
    };
    let mut out = Resolved {
        mode: saved.mode,
        data_dir: roots.user_dir.clone(),
        custom_path: saved.path.clone(),
        ask_at_startup: saved.ask_at_startup,
        first_run: false,
        fallback_error: None,
    };
    match target_dir(roots, saved.mode, &saved.path) {
        Some(dir) => match fs::create_dir_all(&dir) {
            Ok(()) => out.data_dir = dir,
            Err(e) => out.fallback_error = Some(format!("{}: {e}", dir.display())),
        },
        None => out.fallback_error = Some(format!("invalid path: {}", saved.path)),
    }
    out
}

/// Save a choice. The exe-side file is written for the portable mode and removed
/// otherwise (it would win over the user-side one).
pub fn save(roots: &Roots, mode: StorageMode, custom: &str, ask_at_startup: bool) -> Result<(), String> {
    let file = LocationFile { mode, path: custom.trim().to_string(), ask_at_startup };
    let json = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    let exe_file = roots.exe_dir.join(LOCATION_FILE);
    if mode == StorageMode::App {
        fs::write(&exe_file, json).map_err(|e| format!("{}: {e}", exe_file.display()))?;
        return Ok(());
    }
    fs::create_dir_all(&roots.user_dir).map_err(|e| format!("{}: {e}", roots.user_dir.display()))?;
    let user_file = roots.user_dir.join(LOCATION_FILE);
    fs::write(&user_file, json).map_err(|e| format!("{}: {e}", user_file.display()))?;
    if exe_file.exists() {
        fs::remove_file(&exe_file).map_err(|e| format!("{}: {e}", exe_file.display()))?;
    }
    Ok(())
}

/// Can files be created in `dir` (created if missing)?
pub fn writable(dir: &Path) -> bool {
    if fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".nexterm-write-test");
    let ok = fs::write(&probe, b"").is_ok();
    let _ = fs::remove_file(&probe);
    ok
}

/// Files that belong to this run or this computer's folder, not to the configuration.
const SKIP: &[&str] = &[
    LOCATION_FILE,
    "mcp-endpoint.json",
    "notify-icon.png",
    ".window-state.json",
    "sftp-edit",
    "sftp-drop",
    "xserver",
    "EBWebView",
];

/// Copy the configuration from `from` into `to` (existing files in `to` are kept).
pub fn copy_config(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let name = entry.file_name();
        if SKIP.iter().any(|s| name.eq_ignore_ascii_case(s)) {
            continue;
        }
        copy_tree(&entry.path(), &to.join(&name))?;
    }
    Ok(())
}

fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    let meta = fs::symlink_metadata(from)?;
    if meta.is_dir() {
        fs::create_dir_all(to)?;
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            copy_tree(&entry.path(), &to.join(entry.file_name()))?;
        }
    } else if meta.is_file() && !to.exists() {
        fs::copy(from, to)?;
    }
    Ok(())
}

pub fn same_dir(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| {
        let p = fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
        p.to_string_lossy().trim_end_matches(['\\', '/']).to_lowercase()
    };
    norm(a) == norm(b)
}

// ---- State of this run -------------------------------------------------------------

struct Current {
    roots: Roots,
    resolved: Resolved,
}

static CURRENT: OnceLock<Current> = OnceLock::new();
static PROMPTED: AtomicBool = AtomicBool::new(false);

/// The exe's folder, and the user folder Tauri would use (`app_data_dir`).
pub fn roots(user_dir: PathBuf) -> Roots {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."));
    Roots { exe_dir, user_dir }
}

/// Resolve once at startup; returns the data folder.
pub fn init(user_dir: PathBuf) -> PathBuf {
    let roots = roots(user_dir);
    let resolved = resolve(&roots);
    let dir = resolved.data_dir.clone();
    let _ = CURRENT.set(Current { roots, resolved });
    dir
}

/// The data folder for a process that is not the app (the MCP bridge).
pub fn data_dir_for(user_dir: PathBuf) -> PathBuf {
    let roots = roots(user_dir);
    read_location(&roots.exe_dir)
        .or_else(|| read_location(&roots.user_dir))
        .and_then(|s| target_dir(&roots, s.mode, &s.path))
        .unwrap_or(roots.user_dir)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageLocationInfo {
    pub mode: StorageMode,
    pub current_dir: String,
    pub app_dir: String,
    pub user_dir: String,
    pub custom_path: String,
    pub ask_at_startup: bool,
    pub app_dir_writable: bool,
    pub first_run: bool,
    pub fallback_error: Option<String>,
}

/// The saved choice (which may differ from this run's folder until a restart) and the
/// folder this run uses.
pub fn info() -> Option<StorageLocationInfo> {
    let c = CURRENT.get()?;
    let r = &c.resolved;
    let saved = read_location(&c.roots.exe_dir).or_else(|| read_location(&c.roots.user_dir));
    let (mode, custom_path, ask_at_startup) = match saved {
        Some(s) => (s.mode, s.path, s.ask_at_startup),
        None => (r.mode, r.custom_path.clone(), r.ask_at_startup),
    };
    Some(StorageLocationInfo {
        mode,
        current_dir: r.data_dir.display().to_string(),
        app_dir: c.roots.app_data().display().to_string(),
        user_dir: c.roots.user_dir.display().to_string(),
        custom_path,
        ask_at_startup,
        app_dir_writable: writable(&c.roots.exe_dir),
        first_run: r.first_run,
        fallback_error: r.fallback_error.clone(),
    })
}

/// The chooser to show at startup, once per run: on a first run, when the user asked to
/// be asked each time, or when the saved folder could not be used.
pub fn startup_prompt() -> Option<StorageLocationInfo> {
    let i = info()?;
    let wanted = i.first_run || i.ask_at_startup || i.fallback_error.is_some();
    (wanted && !PROMPTED.swap(true, Ordering::SeqCst)).then_some(i)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyOutcome {
    /// The data folder changes: the app must restart to use it.
    pub restart_required: bool,
    /// The new folder already held a configuration, which is used as it is.
    pub kept_existing: bool,
}

pub fn apply(mode: StorageMode, custom: &str, ask_at_startup: bool, migrate: bool) -> Result<ApplyOutcome, String> {
    let c = CURRENT.get().ok_or("not initialized")?;
    let target = target_dir(&c.roots, mode, custom).ok_or("invalid path")?;
    if !writable(&target) {
        return Err(format!("{}: not writable", target.display()));
    }
    if mode == StorageMode::App && !writable(&c.roots.exe_dir) {
        return Err(format!("{}: not writable", c.roots.exe_dir.display()));
    }
    let current = &c.resolved.data_dir;
    let changes = !same_dir(current, &target);
    let kept_existing = changes && has_config(&target);
    if changes && migrate && !kept_existing {
        copy_config(current, &target).map_err(|e| e.to_string())?;
    }
    save(&c.roots, mode, custom, ask_at_startup)?;
    Ok(ApplyOutcome { restart_required: changes, kept_existing })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_roots(name: &str) -> Roots {
        let base = std::env::temp_dir().join(format!("nexterm-loc-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let roots = Roots { exe_dir: base.join("exe"), user_dir: base.join("user") };
        fs::create_dir_all(&roots.exe_dir).unwrap();
        roots
    }

    #[test]
    fn first_run_without_any_data() {
        let roots = temp_roots("first");
        let r = resolve(&roots);
        assert_eq!(r.mode, StorageMode::User);
        assert!(r.first_run);
        assert_eq!(r.data_dir, roots.user_dir);
    }

    #[test]
    fn existing_install_is_not_asked() {
        let roots = temp_roots("existing");
        fs::create_dir_all(&roots.user_dir).unwrap();
        fs::write(roots.user_dir.join("settings.json"), "{}").unwrap();
        let r = resolve(&roots);
        assert!(!r.first_run);
        assert_eq!(r.data_dir, roots.user_dir);
    }

    #[test]
    fn portable_choice_wins_and_switching_back_removes_it() {
        let roots = temp_roots("portable");
        save(&roots, StorageMode::App, "", false).unwrap();
        let r = resolve(&roots);
        assert_eq!(r.mode, StorageMode::App);
        assert_eq!(r.data_dir, roots.exe_dir.join("data"));
        assert!(r.data_dir.is_dir());

        save(&roots, StorageMode::User, "", true).unwrap();
        assert!(!roots.exe_dir.join(LOCATION_FILE).exists());
        let r = resolve(&roots);
        assert_eq!(r.mode, StorageMode::User);
        assert!(r.ask_at_startup);
    }

    #[test]
    fn custom_folder_and_bad_path_fallback() {
        let roots = temp_roots("custom");
        let custom = roots.exe_dir.parent().unwrap().join("custom");
        save(&roots, StorageMode::Custom, custom.to_str().unwrap(), false).unwrap();
        let r = resolve(&roots);
        assert_eq!(r.data_dir, custom);
        assert!(r.fallback_error.is_none());

        save(&roots, StorageMode::Custom, "relative/dir", false).unwrap();
        let r = resolve(&roots);
        assert_eq!(r.data_dir, roots.user_dir);
        assert!(r.fallback_error.is_some());
    }

    #[test]
    fn copy_keeps_config_and_skips_runtime_files() {
        let roots = temp_roots("copy");
        let from = roots.user_dir.clone();
        let to = roots.exe_dir.join("data");
        fs::create_dir_all(from.join("history")).unwrap();
        fs::write(from.join("settings.json"), "a").unwrap();
        fs::write(from.join("history").join("h.json"), "h").unwrap();
        fs::write(from.join("mcp-endpoint.json"), "x").unwrap();
        fs::write(from.join(LOCATION_FILE), "x").unwrap();
        fs::create_dir_all(&to).unwrap();
        fs::write(to.join("sessions.json"), "keep").unwrap();
        fs::write(from.join("sessions.json"), "old").unwrap();

        copy_config(&from, &to).unwrap();
        assert_eq!(fs::read_to_string(to.join("settings.json")).unwrap(), "a");
        assert_eq!(fs::read_to_string(to.join("history").join("h.json")).unwrap(), "h");
        assert_eq!(fs::read_to_string(to.join("sessions.json")).unwrap(), "keep");
        assert!(!to.join("mcp-endpoint.json").exists());
        assert!(!to.join(LOCATION_FILE).exists());
    }
}
