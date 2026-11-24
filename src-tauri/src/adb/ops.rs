//! App manager and process list for ADB panes: shell commands on the device and parsers
//! for their output (kept pure for tests).

use std::path::Path;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use super::AdbDevice;
use crate::transfer::shell_quote;

// ---------------------------------------------------------------------------------------
// Apps

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub package: String,
    /// Base APK path.
    pub apk: String,
    pub uid: Option<u32>,
    pub system: bool,
    pub disabled: bool,
    pub version_name: Option<String>,
    pub version_code: Option<String>,
}

/// One line of `pm list packages -f -U`: `package:/data/app/~~x==/com.a-y==/base.apk=com.a uid:10123`.
/// The APK path itself may contain "=", so the package is after the last "=".
pub fn parse_package_line(line: &str) -> Option<(String, String, Option<u32>)> {
    let rest = line.trim().strip_prefix("package:")?;
    let (rest, uid) = match rest.rsplit_once(" uid:") {
        Some((r, u)) => (r, u.trim().split(',').next().and_then(|u| u.parse().ok())),
        None => (rest, None),
    };
    let (apk, package) = rest.rsplit_once('=')?;
    if package.is_empty() {
        return None;
    }
    Some((package.to_string(), apk.to_string(), uid))
}

pub fn parse_packages(text: &str) -> Vec<(String, String, Option<u32>)> {
    text.lines().filter_map(parse_package_line).collect()
}

/// `pm list packages` without the "package:" prefix: just names.
fn names(text: &str) -> std::collections::HashSet<String> {
    text.lines().filter_map(|l| l.trim().strip_prefix("package:")).map(str::to_string).collect()
}

/// `versionName=` / `versionCode=` of each package in one `dumpsys package` dump.
pub fn parse_versions(text: &str) -> std::collections::HashMap<String, (Option<String>, Option<String>)> {
    let mut out = std::collections::HashMap::new();
    let mut current: Option<String> = None;
    for line in text.lines() {
        let t = line.trim();
        // "  Package [com.example] (1a2b3c):"
        if let Some(rest) = t.strip_prefix("Package [") {
            current = rest.split(']').next().map(str::to_string);
            continue;
        }
        let Some(pkg) = &current else { continue };
        let entry = out.entry(pkg.clone()).or_insert((None, None));
        if let Some(v) = t.strip_prefix("versionName=") {
            entry.0.get_or_insert_with(|| v.to_string());
        } else if let Some(v) = t.strip_prefix("versionCode=") {
            entry.1.get_or_insert_with(|| v.split_whitespace().next().unwrap_or("").to_string());
        }
    }
    out
}

/// Installed apps. `versions` reads one `dumpsys package packages` (slow on some phones:
/// the panel asks for it separately).
pub async fn apps(device: &AdbDevice, versions: bool) -> Result<Vec<AppInfo>> {
    let all = device.exec_output("pm list packages -f -U 2>/dev/null || pm list packages -f").await?;
    let system = names(&device.exec_output("pm list packages -s").await.unwrap_or_default());
    let disabled = names(&device.exec_output("pm list packages -d").await.unwrap_or_default());
    let vers = if versions {
        let dump = super::shell::exec_output_timeout(device, "dumpsys package packages", Duration::from_secs(30))
            .await
            .unwrap_or_default();
        parse_versions(&dump)
    } else {
        Default::default()
    };
    let mut out: Vec<AppInfo> = parse_packages(&all)
        .into_iter()
        .map(|(package, apk, uid)| {
            let (version_name, version_code) = vers.get(&package).cloned().unwrap_or((None, None));
            AppInfo {
                system: system.contains(&package),
                disabled: disabled.contains(&package),
                package,
                apk,
                uid,
                version_name,
                version_code,
            }
        })
        .collect();
    out.sort_by(|a, b| a.package.cmp(&b.package));
    Ok(out)
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AppAction {
    Launch,
    ForceStop,
    Clear,
    Uninstall,
    /// Keep data (`pm uninstall -k`).
    UninstallKeepData,
    Disable,
    Enable,
}

pub fn valid_package(p: &str) -> bool {
    !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_')
}

pub fn action_command(action: AppAction, package: &str) -> String {
    let p = shell_quote(package);
    match action {
        AppAction::Launch => format!("monkey -p {p} -c android.intent.category.LAUNCHER 1"),
        AppAction::ForceStop => format!("am force-stop {p}"),
        AppAction::Clear => format!("pm clear {p}"),
        AppAction::Uninstall => format!("pm uninstall {p}"),
        AppAction::UninstallKeepData => format!("pm uninstall -k {p}"),
        AppAction::Disable => format!("pm disable-user --user 0 {p}"),
        AppAction::Enable => format!("pm enable {p}"),
    }
}

/// `pm` prints "Failure [...]" with exit code 0 on some versions.
fn check_pm(out: &str) -> Result<String> {
    let t = out.trim();
    if let Some(i) = t.find("Failure") {
        bail!("{}", t[i..].trim());
    }
    if t.contains("Error:") || t.contains("No activities found") {
        bail!("{}", t);
    }
    Ok(t.to_string())
}

pub async fn app_action(device: &AdbDevice, package: &str, action: AppAction) -> Result<String> {
    if !valid_package(package) {
        bail!("包名不合法：{}", package);
    }
    let out = device.exec_output(&format!("{} 2>&1", action_command(action, package))).await?;
    check_pm(&out)
}

/// Push an APK to /data/local/tmp and install it (`-r` replace, `-g` grant permissions).
pub async fn install(device: &AdbDevice, apk: &Path) -> Result<String> {
    let name = format!("/data/local/tmp/nexterm-{}.apk", uuid::Uuid::new_v4().simple());
    super::sync::push_file(device, apk, &name, 0o644).await?;
    let q = shell_quote(&name);
    let out = super::shell::exec_output_timeout(device, &format!("pm install -r -g {q} 2>&1; rm -f {q}"), Duration::from_secs(300))
        .await
        .with_context(|| format!("无法安装 {}", apk.display()))?;
    check_pm(&out)
}

/// Copy an app's APK (all splits for split APKs) to `dir`. Returns the written files.
pub async fn export_apk(device: &AdbDevice, package: &str, dir: &Path) -> Result<Vec<String>> {
    if !valid_package(package) {
        bail!("包名不合法：{}", package);
    }
    let out = device.exec_output(&format!("pm path {}", shell_quote(package))).await?;
    let paths: Vec<&str> = out.lines().filter_map(|l| l.trim().strip_prefix("package:")).collect();
    if paths.is_empty() {
        bail!("找不到 {} 的 APK", package);
    }
    let mut written = Vec::new();
    for p in &paths {
        let file = p.rsplit('/').next().unwrap_or("base.apk");
        let local_name = if paths.len() == 1 { format!("{package}.apk") } else { format!("{package}-{file}") };
        let local = crate::transfer::free_local_path(&dir.join(local_name));
        super::sync::pull_file(device, p, &local).await?;
        written.push(local.display().to_string());
    }
    Ok(written)
}

// ---------------------------------------------------------------------------------------
// Processes

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub pid: u32,
    pub ppid: u32,
    pub user: String,
    pub cpu: f32,
    /// Resident set, KB.
    pub rss: u64,
    pub state: String,
    pub name: String,
}

/// toybox `ps -A -o PID,PPID,USER,%CPU,RSS,S,NAME` (header line first). Older devices
/// (toolbox ps) print `USER PID PPID VSIZE RSS WCHAN PC S NAME`; both are handled.
pub fn parse_ps(text: &str) -> Vec<ProcessInfo> {
    let mut lines = text.lines();
    let Some(header) = lines.next() else { return Vec::new() };
    let cols: Vec<&str> = header.split_whitespace().collect();
    let idx = |name: &str| cols.iter().position(|c| c.eq_ignore_ascii_case(name));
    let (Some(pid_i), Some(name_i)) = (idx("PID"), idx("NAME").or_else(|| idx("CMD"))) else { return Vec::new() };
    let ppid_i = idx("PPID");
    let user_i = idx("USER");
    let cpu_i = idx("%CPU");
    let rss_i = idx("RSS");
    let s_i = idx("S");
    let mut out = Vec::new();
    for line in lines {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < cols.len() {
            continue;
        }
        let Ok(pid) = parts[pid_i].parse() else { continue };
        let get = |i: Option<usize>| i.and_then(|i| parts.get(i).copied()).unwrap_or("");
        // toolbox rows carry a state letter before NAME that the header does not name.
        let (state, name_at) = match s_i {
            Some(_) => (get(s_i).to_string(), name_i),
            None if parts.len() > cols.len() && parts[name_i].len() == 1 => (parts[name_i].to_string(), name_i + 1),
            None => (String::new(), name_i),
        };
        out.push(ProcessInfo {
            pid,
            ppid: get(ppid_i).parse().unwrap_or(0),
            user: get(user_i).to_string(),
            cpu: get(cpu_i).parse().unwrap_or(0.0),
            rss: get(rss_i).parse().unwrap_or(0),
            state,
            // The name is the last column and may hold spaces.
            name: parts[name_at..].join(" "),
        });
    }
    out
}

pub async fn processes(device: &AdbDevice) -> Result<Vec<ProcessInfo>> {
    let out = device
        .exec_output("ps -A -o PID,PPID,USER,%CPU,RSS,S,NAME 2>/dev/null || ps")
        .await?;
    Ok(parse_ps(&out))
}

/// The foreground app's package from `dumpsys activity activities`:
/// `  topResumedActivity=ActivityRecord{1a2b u0 com.android.chrome/.Main t42}` (Android 10+)
/// or `  mResumedActivity: ActivityRecord{... u0 com.foo/.Main t7}` (older).
pub fn parse_foreground(text: &str) -> Option<String> {
    for key in ["topResumedActivity", "mResumedActivity", "ResumedActivity"] {
        for line in text.lines().filter(|l| l.contains(key)) {
            let pkg = line
                .split_whitespace()
                .find_map(|w| w.split_once('/').map(|(p, _)| p))
                .filter(|p| valid_package(p) && p.contains('.'));
            if let Some(p) = pkg {
                return Some(p.to_string());
            }
        }
    }
    None
}

pub async fn foreground(device: &AdbDevice) -> Result<Option<String>> {
    let out = device
        .exec_output("dumpsys activity activities 2>/dev/null | grep -E 'topResumedActivity|mResumedActivity' | head -n 3")
        .await?;
    Ok(parse_foreground(&out))
}

pub async fn kill(device: &AdbDevice, pids: &[u32], signal: u8) -> Result<()> {
    if pids.is_empty() {
        return Ok(());
    }
    let list: Vec<String> = pids.iter().map(u32::to_string).collect();
    device.exec_output(&format!("kill -{} {}", signal, list.join(" "))).await.context("无法结束进程（未 root 的设备只能结束 shell 用户自己的进程）")?;
    Ok(())
}

// ---------------------------------------------------------------------------------------
// Device summary (session form, sidebar tooltip)

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceProps {
    pub manufacturer: String,
    pub model: String,
    pub android: String,
    pub sdk: String,
    pub abi: String,
}

pub fn parse_props(text: &str) -> DeviceProps {
    let mut p = DeviceProps::default();
    for line in text.lines() {
        // [ro.product.model]: [Pixel 7]
        let Some((k, v)) = line.split_once("]: [") else { continue };
        let k = k.trim_start_matches('[');
        let v = v.trim_end_matches(']').to_string();
        match k {
            "ro.product.manufacturer" => p.manufacturer = v,
            "ro.product.model" => p.model = v,
            "ro.build.version.release" => p.android = v,
            "ro.build.version.sdk" => p.sdk = v,
            "ro.product.cpu.abi" => p.abi = v,
            _ => {}
        }
    }
    p
}

pub async fn props(device: &AdbDevice) -> Result<DeviceProps> {
    Ok(parse_props(&device.exec_output("getprop").await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn package_lines() {
        let l = "package:/data/app/~~ab==/com.foo.bar-xy==/base.apk=com.foo.bar uid:10234";
        assert_eq!(
            parse_package_line(l),
            Some(("com.foo.bar".into(), "/data/app/~~ab==/com.foo.bar-xy==/base.apk".into(), Some(10234)))
        );
        assert_eq!(
            parse_package_line("package:/system/app/Calc/Calc.apk=com.android.calculator2"),
            Some(("com.android.calculator2".into(), "/system/app/Calc/Calc.apk".into(), None))
        );
        // Shared uids list several: "uid:1000,1001".
        assert_eq!(parse_package_line("package:/a.apk=android uid:1000,1001").unwrap().2, Some(1000));
        assert!(parse_package_line("garbage").is_none());
    }

    #[test]
    fn versions_from_dumpsys() {
        let dump = "Packages:\n  Package [com.a] (1f):\n    versionCode=42 minSdk=24 targetSdk=34\n    versionName=1.2.3\n  Package [com.b] (2e):\n    versionCode=7 minSdk=21\n";
        let v = parse_versions(dump);
        assert_eq!(v["com.a"], (Some("1.2.3".into()), Some("42".into())));
        assert_eq!(v["com.b"], (None, Some("7".into())));
    }

    #[test]
    fn commands_are_quoted() {
        assert_eq!(action_command(AppAction::ForceStop, "com.a"), "am force-stop 'com.a'");
        assert!(valid_package("com.example_1.app"));
        assert!(!valid_package("com.a; reboot"));
    }

    #[test]
    fn pm_failures() {
        assert!(check_pm("Success").is_ok());
        assert_eq!(check_pm("Failure [DELETE_FAILED_INTERNAL_ERROR]").unwrap_err().to_string(), "Failure [DELETE_FAILED_INTERNAL_ERROR]");
        assert!(check_pm("Performing Streamed Install\nFailure [INSTALL_FAILED_VERSION_DOWNGRADE]").is_err());
    }

    #[test]
    fn toybox_ps() {
        let out = "  PID  PPID USER           %CPU   RSS S NAME\n    1     0 root            0.0 10964 S init\n 1234   567 u0_a123         3.5 204800 S com.example.app:remote\n";
        let ps = parse_ps(out);
        assert_eq!(ps.len(), 2);
        assert_eq!(ps[1].pid, 1234);
        assert_eq!(ps[1].user, "u0_a123");
        assert_eq!(ps[1].cpu, 3.5);
        assert_eq!(ps[1].rss, 204800);
        assert_eq!(ps[1].name, "com.example.app:remote");
    }

    #[test]
    fn toolbox_ps() {
        let out = "USER     PID   PPID  VSIZE  RSS     WCHAN    PC         NAME\nroot      1     0     8904   788   ffffffff 00000000 S /init\n";
        let ps = parse_ps(out);
        assert_eq!(ps.len(), 1);
        assert_eq!(ps[0].pid, 1);
        assert_eq!(ps[0].rss, 788);
        assert_eq!(ps[0].state, "S");
        assert_eq!(ps[0].name, "/init");
    }

    #[test]
    fn foreground_app() {
        let new = "  topResumedActivity=ActivityRecord{1a2b3c u0 com.android.chrome/com.google.android.apps.chrome.Main t42}\n";
        assert_eq!(parse_foreground(new).as_deref(), Some("com.android.chrome"));
        let old = "    mResumedActivity: ActivityRecord{42 u0 com.example.app/.MainActivity t7}\n";
        assert_eq!(parse_foreground(old).as_deref(), Some("com.example.app"));
        assert_eq!(parse_foreground("mResumedActivity: null"), None);
    }

    #[test]
    fn getprop() {
        let p = parse_props("[ro.product.model]: [Pixel 7]\n[ro.build.version.release]: [14]\n[ro.build.version.sdk]: [34]\n");
        assert_eq!(p.model, "Pixel 7");
        assert_eq!(p.android, "14");
        assert_eq!(p.sdk, "34");
    }
}
