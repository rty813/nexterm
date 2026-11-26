//! Git Bash (Git for Windows) as a local terminal: finds `bin\bash.exe`.
//!
//! `git-bash.exe` opens its own mintty window and `cmd\git.exe` is git itself, so neither
//! can run in a ConPTY pane; `bin\bash.exe` sets up the MSYS environment (PATH, MSYSTEM)
//! and starts bash in the console it is given.

use std::path::{Path, PathBuf};

/// `<root>\bin\bash.exe` for a Git for Windows install root.
fn bash_in(root: &Path) -> PathBuf {
    root.join("bin").join("bash.exe")
}

/// The install root for a `git.exe` found on PATH: `<root>\cmd\git.exe`,
/// `<root>\bin\git.exe` or `<root>\mingw64\bin\git.exe` (also mingw32 / clangarm64).
fn root_from_git_dir(dir: &Path) -> Option<PathBuf> {
    let name = dir.file_name()?.to_str()?.to_ascii_lowercase();
    let parent = dir.parent()?;
    match name.as_str() {
        "cmd" => Some(parent.to_path_buf()),
        "bin" => {
            let pname = parent.file_name().and_then(|n| n.to_str()).unwrap_or("").to_ascii_lowercase();
            if matches!(pname.as_str(), "mingw64" | "mingw32" | "clangarm64" | "usr") {
                parent.parent().map(Path::to_path_buf)
            } else {
                Some(parent.to_path_buf())
            }
        }
        _ => None,
    }
}

/// Where to look, in order: the registry's install paths, `git.exe` on PATH, then the
/// usual install folders (machine-wide, per-user, scoop).
fn candidates(registry: &[PathBuf], path_env: Option<&std::ffi::OsStr>, env: &dyn Fn(&str) -> Option<PathBuf>) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = registry.to_vec();
    if let Some(path) = path_env {
        for dir in std::env::split_paths(path) {
            if dir.join("git.exe").is_file() {
                if let Some(root) = root_from_git_dir(&dir) {
                    roots.push(root);
                }
            }
        }
    }
    for var in ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(p) = env(var) {
            roots.push(p.join("Git"));
        }
    }
    if let Some(p) = env("LOCALAPPDATA") {
        roots.push(p.join("Programs").join("Git"));
    }
    if let Some(p) = env("USERPROFILE") {
        roots.push(p.join("scoop").join("apps").join("git").join("current"));
    }
    let mut out: Vec<PathBuf> = Vec::new();
    for root in roots {
        let bash = bash_in(&root);
        if !out.contains(&bash) {
            out.push(bash);
        }
    }
    out
}

#[cfg(windows)]
fn registry_roots() -> Vec<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }
    fn read(hive: HKEY) -> Option<PathBuf> {
        let (key, name) = (wide("SOFTWARE\\GitForWindows"), wide("InstallPath"));
        let mut buf = vec![0u16; 1024];
        let mut len = (buf.len() * 2) as u32;
        let rc = unsafe {
            RegGetValueW(hive, key.as_ptr(), name.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), buf.as_mut_ptr().cast(), &mut len)
        };
        if rc != 0 {
            return None;
        }
        let chars = (len as usize / 2).saturating_sub(1);
        let s = std::ffi::OsString::from_wide(&buf[..chars.min(buf.len())]);
        (!s.is_empty()).then(|| PathBuf::from(s))
    }
    [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE].into_iter().filter_map(read).collect()
}

#[cfg(not(windows))]
fn registry_roots() -> Vec<PathBuf> {
    Vec::new()
}

/// `bin\bash.exe` of the installed Git for Windows, if any.
pub fn find() -> Option<PathBuf> {
    let env = |k: &str| std::env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from);
    candidates(&registry_roots(), std::env::var_os("PATH").as_deref(), &env)
        .into_iter()
        .find(|p| p.is_file())
}

/// Runs a POSIX script with Git's bash (`-s`, no profile), for the shell integration upload.
pub fn sh_command(bash: &Path) -> std::process::Command {
    let mut cmd = std::process::Command::new(bash);
    cmd.args(["--noprofile", "--norc", "-s"]);
    cmd
}

/// For the frontend: the bash.exe a Git Bash pane would start, or null when Git for
/// Windows is not installed (the menus then leave Git Bash out).
#[tauri::command]
pub fn find_git_bash() -> Option<String> {
    find().map(|p| p.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_from_git_on_path() {
        let r = |s: &str| root_from_git_dir(Path::new(s)).map(|p| p.to_string_lossy().replace('\\', "/"));
        assert_eq!(r("/opt/Git/cmd").as_deref(), Some("/opt/Git"));
        assert_eq!(r("/opt/Git/bin").as_deref(), Some("/opt/Git"));
        assert_eq!(r("/opt/Git/mingw64/bin").as_deref(), Some("/opt/Git"));
        assert_eq!(r("/opt/Git/usr/bin").as_deref(), Some("/opt/Git"));
        assert_eq!(r("/opt/Git/libexec"), None);
    }

    #[test]
    fn candidates_in_order_without_duplicates() {
        let tmp = std::env::temp_dir().join(format!("nexterm-gitbash-{}", uuid::Uuid::new_v4().simple()));
        let cmd_dir = tmp.join("PathGit").join("cmd");
        std::fs::create_dir_all(&cmd_dir).unwrap();
        std::fs::write(cmd_dir.join("git.exe"), b"").unwrap();
        let path = std::env::join_paths([tmp.join("nothing-here"), cmd_dir.clone()]).unwrap();
        let pf = tmp.join("PF");
        let env = |k: &str| match k {
            "ProgramW6432" | "ProgramFiles" => Some(pf.clone()),
            "LOCALAPPDATA" => Some(tmp.join("Local")),
            _ => None,
        };
        let got = candidates(&[tmp.join("Reg")], Some(path.as_os_str()), &env);
        assert_eq!(
            got,
            vec![
                bash_in(&tmp.join("Reg")),
                bash_in(&tmp.join("PathGit")),
                bash_in(&pf.join("Git")),
                bash_in(&tmp.join("Local").join("Programs").join("Git")),
            ]
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
