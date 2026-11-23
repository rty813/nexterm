//! Server resource monitor: one POSIX sh script, run on an exec channel of the pane's
//! existing SSH connection, prints the raw /proc files and `df -P`. The frontend parses
//! them and computes rates (`src/utils/serverStats.ts`).

/// Sections start with `@@name`. Hosts without a Linux /proc print `@@unsupported <uname>`.
/// df is bounded by `timeout` (a hung network mount would stall it) and may fail on some
/// mounts; the script still exits 0.
pub const SCRIPT: &str = r#"LC_ALL=C; export LC_ALL
if [ ! -r /proc/stat ] || [ ! -r /proc/meminfo ]; then
  echo "@@unsupported $(uname -s 2>/dev/null)"
  exit 0
fi
echo "@@cpu"; grep '^cpu' /proc/stat
echo "@@mem"; cat /proc/meminfo
echo "@@load"; cat /proc/loadavg 2>/dev/null
echo "@@net"; cat /proc/net/dev 2>/dev/null
echo "@@uptime"; cat /proc/uptime 2>/dev/null
echo "@@df"
if command -v timeout >/dev/null 2>&1; then timeout 3 df -P -k 2>/dev/null; else df -P -k 2>/dev/null; fi
echo "@@end"
exit 0
"#;

/// Raw sample of the SSH connection behind a pane.
pub async fn sample(link: &crate::ssh_conn::SshLink) -> anyhow::Result<String> {
    link.exec_output(&script()).await
}

/// Android: the same /proc sections (toybox sh runs the script; /proc/stat is hidden from
/// the shell user on Android 8+, then CPU shows as unavailable), plus `dumpsys battery`.
pub async fn sample_adb(device: &crate::adb::AdbDevice) -> anyhow::Result<String> {
    device.exec_output(&adb_script()).await
}

pub fn adb_script() -> String {
    script().replace("echo \"@@end\"", "echo \"@@battery\"; dumpsys battery 2>/dev/null\necho \"@@end\"")
}

/// The script with LF line endings (a CRLF checkout must not send CRs to the remote sh).
pub fn script() -> String {
    SCRIPT.replace('\r', "")
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_script_sections_and_line_endings() {
        // Sent through `posix_wrap` (base64 | sh): CR characters would break the remote sh.
        assert!(!super::script().contains('\r'));
        for s in ["@@cpu", "@@mem", "@@load", "@@net", "@@uptime", "@@df", "@@end", "@@unsupported"] {
            assert!(super::SCRIPT.contains(s), "{s}");
        }
    }

    #[test]
    fn adb_script_adds_battery_before_end() {
        let s = super::adb_script();
        let battery = s.find("@@battery").expect("battery section");
        assert!(battery < s.find("echo \"@@end\"").unwrap());
        assert!(!s.contains('\r'));
    }
}
