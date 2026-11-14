//! Shell integration for SSH shells (bash, zsh, fish), without touching remote dotfiles:
//! the shell then reports prompts and commands (OSC 133 A/C/D, OSC 633 E) and its host
//! (OSC 7), which the tab uses for the running command and the host name.
//!
//! 1. An exec channel checks the login shell and writes the three scripts plus a tiny sh
//!    picker to `/tmp/.nexterm-si-<random>*` (mode 600). See [`upload_script`].
//! 2. Once the first prompt is on screen, a one-line loader is typed into the shell. The
//!    same line parses in bash, zsh and fish: the picker chooses the script by
//!    `$FISH_VERSION` / `$ZSH_VERSION` / `$BASH_VERSION`, so `exec fish` in `.bashrc` still
//!    gets the fish script. The script deletes itself and prints [`READY`].
//! 3. [`Injector`] holds the output back from the loader up to [`READY`], then redraws the
//!    new prompt over the old one, so the loader line never shows.
//!
//! WSL panes (local_pty.rs) do the same, with a separate `wsl.exe` in the same distribution
//! and user in place of the exec channel.
//!
//! Permanent installation (pane menu, including nested ssh, containers, WSL and serial)
//! uses [`manual_line`] to carry an installer and the scripts in the line itself
//! (gzip + base64). It installs for the current user, backs up startup files before
//! adding a loader, and sources the script immediately. Automatic SSH injection above
//! remains independent of startup files.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

static ENABLED: AtomicBool = AtomicBool::new(true);

/// Settings › "shellIntegration" (default on); read when a session starts.
pub fn set_enabled(on: bool) {
    ENABLED.store(on, Ordering::Relaxed);
}

pub fn enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

const BASH: &str = include_str!("../shell-integration/bash.sh");
const ZSH: &str = include_str!("../shell-integration/zsh.zsh");
const FISH: &str = include_str!("../shell-integration/fish.fish");

/// Printed by every script once it is loaded (OSC 633 P, ignored by terminals).
pub const READY: &[u8] = b"\x1b]633;P;NextermShellIntegration=1\x07";
/// Printed by the manual loader when the shell is not bash, zsh or fish.
pub const UNSUPPORTED: &[u8] = b"\x1b]633;P;NextermShellIntegration=0\x07";
/// The permanent installer failed (for example, a read-only home directory).
pub const FAILED: &[u8] = b"\x1b]633;P;NextermShellIntegration=2\x07";
/// Held output beyond this (a program printing instead of a prompt): give up and show it.
const HOLD_LIMIT: usize = 1 << 20;

/// Output must be quiet this long after the first bytes before the loader goes out (prompt drawn).
const QUIET: Duration = Duration::from_millis(500);
/// No prompt by then (or the exec check never answered): leave the shell alone.
const WAIT_LIMIT: Duration = Duration::from_secs(10);
/// No [`READY`] by then: show what was held back and carry on.
const LOAD_LIMIT: Duration = Duration::from_secs(5);
/// The new prompt is collected this long after [`READY`], then redrawn in one go.
const SETTLE: Duration = Duration::from_millis(150);

fn base(token: &str) -> String {
    format!("/tmp/.nexterm-si-{token}")
}

/// POSIX sh run on an exec channel: prints `ok` when the login shell is bash, zsh or fish
/// and the scripts are in place.
pub fn upload_script(token: &str) -> String {
    let d = base(token);
    let mut s = String::from("case \"${SHELL##*/}\" in bash|zsh|fish) ;; *) exit 0 ;; esac\numask 077\n");
    s += &format!("d={d}\nrm -f \"$d\" \"$d\".*\n");
    for (ext, body) in [("bash", BASH), ("zsh", ZSH), ("fish", FISH)] {
        s += &format!("cat > \"$d.{ext}\" <<'NEXTERM_SI_EOF'\n{}\nNEXTERM_SI_EOF\n", body.trim_end());
    }
    s += &format!(
        "cat > \"$d\" <<'NEXTERM_SI_EOF'\n\
         d={d}\n\
         if [ -n \"$1\" ]; then s=fish; elif [ -n \"$2\" ]; then s=zsh; elif [ -n \"$3\" ]; then s=bash; else s=none; fi\n\
         umask 077\n\
         if [ -f \"$d.$s\" ]; then mv -f \"$d.$s\" \"$d.rc\"; else : > \"$d.rc\"; fi\n\
         rm -f \"$d\" \"$d.fish\" \"$d.zsh\" \"$d.bash\"\n\
         NEXTERM_SI_EOF\n\
         echo ok\n"
    );
    s
}

/// Typed into the shell (leading space: kept out of history by fish, ignorespace, OMZ).
pub fn loader_line(token: &str) -> String {
    let d = base(token);
    format!(" sh {d} \"$FISH_VERSION\" \"$ZSH_VERSION\" \"$BASH_VERSION\"; source {d}.rc\r")
}

/// Full-line comments and blank lines dropped (the scripts have no heredocs).
fn strip_comments(script: &str) -> String {
    script
        .lines()
        .filter(|l| !l.trim().is_empty() && !l.trim_start().starts_with('#'))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Install for the running shell, then write a disposable script for immediate sourcing.
fn permanent_installer() -> String {
    let mut scripts = String::from("case $s in\n");
    for (name, body) in [("fish", FISH), ("zsh", ZSH), ("bash", BASH)] {
        // The automatic /tmp loaders delete themselves. Installed copies stay in place.
        let body = body.lines().filter(|line| !line.starts_with("rm -f -- ")).collect::<Vec<_>>().join("\n");
        scripts += &format!("{name}) cat > \"$script.tmp\" <<'NEXTERM_SI_EOF'\n{}\nNEXTERM_SI_EOF\n;;\n", strip_comments(&body));
    }
    scripts += "esac";
    strip_comments(&include_str!("../shell-integration/install.sh").replace("# NEXTERM_SCRIPT", &scripts))
}

/// Permanently install for the current user and load into the running bash, zsh or fish.
/// Needs `base64`, `gunzip`, writable startup files, a home directory and /tmp.
pub fn manual_line(token: &str) -> String {
    use base64::Engine;
    use std::io::Write;
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
    let _ = gz.write_all(permanent_installer().as_bytes());
    let b64 = base64::engine::general_purpose::STANDARD.encode(gz.finish().unwrap_or_default());
    let rc = format!("{}.rc", base(token));
    format!(
        " echo '{b64}' | base64 -d | gunzip | sh -s -- \"$FISH_VERSION\" \"$ZSH_VERSION\" \"$BASH_VERSION\" {rc} \"$ZDOTDIR\" \"$XDG_CONFIG_HOME\" > {rc}; source {rc}\r"
    )
}

/// Removes the uploaded files when the loader was never typed.
pub fn cleanup_script(token: &str) -> String {
    let d = base(token);
    format!("rm -f {d} {d}.*")
}

const POWERSHELL: &str = include_str!("../shell-integration/powershell.ps1");

/// Arguments that load the integration into a local PowerShell (after its profile):
/// `-NoExit -EncodedCommand <utf-16le base64>`. Inline, so the execution policy does not apply.
pub fn powershell_args() -> Vec<String> {
    use base64::Engine;
    let utf16: Vec<u8> = POWERSHELL.encode_utf16().flat_map(u16::to_le_bytes).collect();
    vec!["-NoExit".into(), "-EncodedCommand".into(), base64::engine::general_purpose::STANDARD.encode(utf16)]
}

/// A custom shell command that is a plain interactive PowerShell (no script or command of
/// its own), so [`powershell_args`] can be appended.
pub fn is_plain_powershell(parts: &[String]) -> bool {
    let Some(prog) = parts.first() else { return false };
    let name = prog.rsplit(['\\', '/']).next().unwrap_or(prog).to_ascii_lowercase();
    if !matches!(name.as_str(), "powershell" | "powershell.exe" | "pwsh" | "pwsh.exe") {
        return false;
    }
    !parts.iter().skip(1).any(|a| {
        let lower = a.to_ascii_lowercase();
        let flag = lower.trim_start_matches(['-', '/']);
        (a.starts_with('-') || a.starts_with('/'))
            && matches!(
                flag,
                "c" | "command" | "f" | "file" | "e" | "ec" | "encodedcommand" | "noexit" | "cwa" | "commandwithargs"
                    | "noninteractive" | "v" | "version" | "?" | "h" | "help"
            )
    })
}

/// Whether the exec check's output says the loader may be typed.
pub fn upload_ok(output: &str) -> bool {
    output.lines().any(|l| l.trim() == "ok")
}

enum State {
    /// Waiting for the first prompt (output quiet) and the exec check.
    Waiting { quiet_at: Option<Instant>, give_up: Instant },
    /// Loader typed: output is held back until [`READY`].
    Loading { held: Vec<u8>, give_up: Instant },
    /// [`READY`] seen: collecting the new prompt.
    Settling { prompt: Vec<u8>, flush_at: Instant },
    Done,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Step {
    Nothing,
    /// Type the loader now.
    Inject,
    /// Show these bytes (held output, or the redrawn prompt).
    Emit(Vec<u8>),
}

/// The per-session injection state machine; pure, the SSH loop drives it.
pub struct Injector {
    state: State,
    /// Result of the exec check: None while it runs.
    shell_ok: Option<bool>,
    /// The loader was typed.
    pub injected: bool,
    /// The script reported [`READY`] (else the uploaded files may need removing).
    pub loaded: bool,
    /// The manual loader reported [`UNSUPPORTED`] (not bash / zsh / fish).
    pub unsupported: bool,
    /// Installation could not persist its scripts or startup configuration.
    pub failed: bool,
}

impl Injector {
    pub fn new(now: Instant) -> Self {
        Self { state: State::Waiting { quiet_at: None, give_up: now + WAIT_LIMIT }, shell_ok: None, injected: false, loaded: false, unsupported: false, failed: false }
    }

    /// Manual loading: the loader line goes out right now.
    pub fn loading(now: Instant) -> Self {
        Self {
            state: State::Loading { held: Vec::new(), give_up: now + Duration::from_secs(15) },
            shell_ok: Some(true),
            injected: true,
            loaded: false,
            unsupported: false,
            failed: false,
        }
    }

    /// Injection off: everything passes through.
    pub fn disabled() -> Self {
        Self { state: State::Done, shell_ok: Some(false), injected: false, loaded: false, unsupported: false, failed: false }
    }

    pub fn is_done(&self) -> bool {
        matches!(self.state, State::Done)
    }

    pub fn set_shell_ok(&mut self, ok: bool) {
        self.shell_ok = Some(ok);
        if !ok && matches!(self.state, State::Waiting { .. }) {
            self.state = State::Done;
        }
    }

    /// Remote output; returns what to show now.
    pub fn output(&mut self, data: &[u8], now: Instant) -> Vec<u8> {
        match &mut self.state {
            State::Waiting { quiet_at, .. } => {
                *quiet_at = Some(now + QUIET);
                data.to_vec()
            }
            State::Loading { held, .. } => {
                held.extend_from_slice(data);
                let mark = [(READY, 1), (UNSUPPORTED, 0), (FAILED, 2)].into_iter()
                    .filter_map(|(mark, kind)| find(held, mark).map(|pos| (pos, kind)))
                    .min_by_key(|(pos, _)| *pos);
                if let Some((pos, kind)) = mark {
                    let prompt = held[pos + READY.len()..].to_vec();
                    self.loaded = kind == 1;
                    self.unsupported = kind == 0;
                    self.failed = kind == 2;
                    self.state = State::Settling { prompt, flush_at: now + SETTLE };
                } else if held.len() > HOLD_LIMIT {
                    let held = std::mem::take(held);
                    self.state = State::Done;
                    return held;
                }
                Vec::new()
            }
            State::Settling { prompt, .. } => {
                prompt.extend_from_slice(data);
                Vec::new()
            }
            State::Done => data.to_vec(),
        }
    }

    /// Input from the pane. Typing before the loader went out leaves the shell alone (the
    /// loader would land in the middle of the line); terminal replies (ESC ...) do not count.
    pub fn user_input(&mut self, data: &[u8]) {
        if matches!(self.state, State::Waiting { .. }) && data.first().is_some_and(|b| *b != 0x1b) {
            self.state = State::Done;
        }
    }

    /// When [`Injector::tick`] wants to run next.
    pub fn deadline(&self) -> Option<Instant> {
        match &self.state {
            State::Waiting { quiet_at, give_up } => match (self.shell_ok, quiet_at) {
                (Some(true), Some(q)) => Some((*q).min(*give_up)),
                _ => Some(*give_up),
            },
            State::Loading { give_up, .. } => Some(*give_up),
            State::Settling { flush_at, .. } => Some(*flush_at),
            State::Done => None,
        }
    }

    pub fn tick(&mut self, now: Instant) -> Step {
        match &mut self.state {
            State::Waiting { quiet_at, give_up } => {
                if now >= *give_up {
                    self.state = State::Done;
                } else if self.shell_ok == Some(true) && quiet_at.is_some_and(|q| now >= q) {
                    self.state = State::Loading { held: Vec::new(), give_up: now + LOAD_LIMIT };
                    self.injected = true;
                    return Step::Inject;
                }
                Step::Nothing
            }
            State::Loading { held, give_up } => {
                if now < *give_up {
                    return Step::Nothing;
                }
                let held = std::mem::take(held);
                self.state = State::Done;
                if held.is_empty() { Step::Nothing } else { Step::Emit(held) }
            }
            State::Settling { prompt, flush_at } => {
                if now < *flush_at {
                    return Step::Nothing;
                }
                // Unsupported: the new prompt may follow an error line, so it goes below.
                let out = if self.unsupported || self.failed { [b"\r\n".as_slice(), prompt].concat() } else { redraw(prompt) };
                self.state = State::Done;
                Step::Emit(out)
            }
            State::Done => Step::Nothing,
        }
    }
}

/// The new prompt drawn over the old one: the cursor still sits at the end of the old
/// prompt (the loader's echo was held back), which has as many lines as the new one.
fn redraw(prompt: &[u8]) -> Vec<u8> {
    let lines = prompt.iter().filter(|b| **b == b'\n').count();
    let mut out = b"\r".to_vec();
    if lines > 0 {
        out.extend_from_slice(format!("\x1b[{lines}A").as_bytes());
    }
    out.extend_from_slice(b"\x1b[J");
    out.extend_from_slice(prompt);
    out
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    #[test]
    fn injects_after_prompt_and_hides_the_loader() {
        let t0 = Instant::now();
        let mut inj = Injector::new(t0);
        assert_eq!(inj.output(b"Welcome\r\nme@box:~$ ", t0), b"Welcome\r\nme@box:~$ ");
        inj.set_shell_ok(true);
        assert_eq!(inj.tick(t0 + ms(100)), Step::Nothing);
        assert_eq!(inj.tick(t0 + ms(600)), Step::Inject);
        // Echo of the loader and the ready mark split over chunks: nothing shows.
        assert!(inj.output(b" sh /tmp/.nexterm-si-x \"$FISH_VERSION\"\r\n\x1b]633;P;Nexterm", t0 + ms(650)).is_empty());
        assert!(inj.output(b"ShellIntegration=1\x07\x1b]133;D;0\x07", t0 + ms(660)).is_empty());
        assert!(inj.output(b"me@box:~$ ", t0 + ms(670)).is_empty());
        let Step::Emit(out) = inj.tick(t0 + ms(900)) else { panic!("no redraw") };
        assert_eq!(out, b"\r\x1b[J\x1b]133;D;0\x07me@box:~$ ");
        assert!(inj.is_done());
        assert_eq!(inj.output(b"x", t0 + ms(950)), b"x");
    }

    #[test]
    fn two_line_prompt_is_redrawn_in_place() {
        assert_eq!(redraw(b"~/ws\r\n> "), b"\r\x1b[1A\x1b[J~/ws\r\n> ");
    }

    #[test]
    fn waits_for_output_to_settle() {
        let t0 = Instant::now();
        let mut inj = Injector::new(t0);
        inj.set_shell_ok(true);
        assert_eq!(inj.tick(t0 + ms(800)), Step::Nothing); // no prompt yet
        inj.output(b"motd", t0 + ms(800));
        inj.output(b"me@box:~$ ", t0 + ms(1200));
        assert_eq!(inj.tick(t0 + ms(1500)), Step::Nothing);
        assert_eq!(inj.tick(t0 + ms(1700)), Step::Inject);
    }

    #[test]
    fn typing_first_or_unsupported_shell_leaves_it_alone() {
        let t0 = Instant::now();
        let mut inj = Injector::new(t0);
        inj.output(b"$ ", t0);
        inj.user_input(b"\x1b[?62c"); // terminal reply, not typing
        assert!(!inj.is_done());
        inj.user_input(b"l");
        assert!(inj.is_done());
        inj.set_shell_ok(true);
        assert_eq!(inj.tick(t0 + ms(800)), Step::Nothing);
        assert!(!inj.injected);

        let mut inj = Injector::new(t0);
        inj.set_shell_ok(false);
        assert!(inj.is_done());
    }

    #[test]
    fn no_ready_mark_shows_the_held_output() {
        let t0 = Instant::now();
        let mut inj = Injector::new(t0);
        inj.output(b"> ", t0);
        inj.set_shell_ok(true);
        assert_eq!(inj.tick(t0 + ms(600)), Step::Inject);
        inj.output(b"syntax error", t0 + ms(700));
        assert_eq!(inj.tick(t0 + ms(2000)), Step::Nothing);
        assert_eq!(inj.tick(t0 + ms(6000)), Step::Emit(b"syntax error".to_vec()));
    }

    #[test]
    fn manual_load_hides_the_line_and_reports_unsupported_shells() {
        let t0 = Instant::now();
        let mut inj = Injector::loading(t0);
        assert!(inj.output(b" echo 'H4sI...' | base64 -d\r\n", t0).is_empty());
        inj.output(b"\x1b]633;P;NextermShellIntegration=1\x07$ ", t0 + ms(50));
        assert_eq!(inj.tick(t0 + ms(300)), Step::Emit(b"\r\x1b[J$ ".to_vec()));
        assert!(inj.loaded && !inj.unsupported);

        // dash: the error and the next prompt go below the old prompt.
        let mut inj = Injector::loading(t0);
        inj.output(b"\x1b]633;P;NextermShellIntegration=0\x07sh: 1: source: not found\r\n$ ", t0);
        assert_eq!(inj.tick(t0 + ms(300)), Step::Emit(b"\r\nsh: 1: source: not found\r\n$ ".to_vec()));
        assert!(inj.unsupported && !inj.loaded);

        let mut inj = Injector::loading(t0);
        inj.output(b"Permission denied\r\n\x1b]633;P;NextermShellIntegration=2", t0);
        inj.output(b"\x07$ ", t0 + ms(50));
        assert_eq!(inj.tick(t0 + ms(300)), Step::Emit(b"\r\n$ ".to_vec()));
        assert!(inj.failed && !inj.loaded && !inj.unsupported);
    }

    #[test]
    fn manual_line_fits_a_canonical_tty_line() {
        let line = manual_line("0123456789abcdef");
        // Linux MAX_CANON is 4096; the line is typed in one go.
        assert!(line.len() < 4096, "{}", line.len());
        assert!(line.starts_with(" echo '") && line.ends_with("source /tmp/.nexterm-si-0123456789abcdef.rc\r"));
        assert!(!line.contains('!'), "zsh / bash history expansion");
    }

    #[test]
    fn scripts_are_embedded_with_the_ready_mark() {
        let up = upload_script("abc");
        assert!(up.contains("d=/tmp/.nexterm-si-abc"));
        for body in [BASH, ZSH, FISH] {
            assert!(body.contains("printf '\\e]633;P;NextermShellIntegration=1\\a'"));
            assert!(!body.contains("\nNEXTERM_SI_EOF\n"));
        }
        assert!(loader_line("abc").starts_with(" sh /tmp/.nexterm-si-abc "));
        assert!(upload_ok("noise\nok\n"));
        assert!(!upload_ok(""));
    }

    /// Isolated WSL homes: `cargo test --lib installs_shell_integration -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn installs_shell_integration_for_future_shells() {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let spec = serde_json::json!({ "line": manual_line(&uuid::Uuid::new_v4().simple().to_string()) });
        let driver = format!("import json\nSPEC = json.loads({})\n{}",
            serde_json::to_string(&spec.to_string()).unwrap(), include_str!("../tests/shell_integration_install.py"));
        let mut child = Command::new("wsl.exe").args(["--exec", "python3", "-"])
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        child.stdin.take().unwrap().write_all(driver.as_bytes()).unwrap();
        let output = child.wait_with_output().unwrap();
        let out = String::from_utf8_lossy(&output.stdout);
        let err = String::from_utf8_lossy(&output.stderr);
        eprintln!("{out}{err}");
        assert!(output.status.success(), "{out}{err}");
    }
}

