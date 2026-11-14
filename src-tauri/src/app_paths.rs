//! The app's own folders, set once at startup. Bundled files (VcXsrv, the command
//! catalog) are looked up only here: the app never reads another program's install.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

struct Paths {
    resources: PathBuf,
    data: PathBuf,
}

static PATHS: OnceLock<Paths> = OnceLock::new();

pub fn init(resources: PathBuf, data: PathBuf) {
    let _ = PATHS.set(Paths { resources, data });
}

/// Folder holding `bundle.resources` (next to the exe for portable / dev builds).
pub fn resource_dir() -> PathBuf {
    PATHS
        .get()
        .map(|p| p.resources.clone())
        .or_else(|| std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// A bundled resource, e.g. `resource("vcxsrv")`.
pub fn resource(name: &str) -> PathBuf {
    resource_dir().join(name)
}

/// The app's writable data folder (settings.json lives here).
pub fn data_dir() -> PathBuf {
    PATHS
        .get()
        .map(|p| p.data.clone())
        .unwrap_or_else(std::env::temp_dir)
}
