"""Exercise the real installer in isolated homes; invoked by the Rust WSL test."""
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile


READY = "\x1b]633;P;NextermShellIntegration=1\x07"
FAILED = "\x1b]633;P;NextermShellIntegration=2\x07"
MARKER = "# >>> Nexterm shell integration >>>"


def verify(spec):
    # The PTY consumes CR as Enter; subprocess -c needs the same command without CR.
    spec["line"] = spec["line"].rstrip("\r")
    def run(args, env, text=None):
        result = subprocess.run(args, input=text, env=env, capture_output=True, text=True, timeout=20)
        output = result.stdout + result.stderr
        assert result.returncode == 0, (args[:3], result.returncode, output)
        return output

    with tempfile.TemporaryDirectory(prefix="nexterm-si-test-") as root:
        base = Path(root)
        for shell in ("bash", "fish", "zsh"):
            if not shutil.which(shell):
                print("SKIP unavailable shell:", shell)
                continue
            task_home = base / (shell + " home")
            task_home.mkdir()
            config = task_home / "custom config"
            zdir = task_home / "custom zsh"
            zdir.mkdir()
            env = dict(os.environ, HOME=str(task_home), XDG_CONFIG_HOME=str(config), ZDOTDIR=str(zdir))
            env.pop("BASH_ENV", None)
            original = "# existing user configuration\nexport NEXTERM_TEST_KEEP=preserved\n"
            if shell == "bash":
                startup = task_home / ".bashrc"
                login = task_home / ".bash_profile"
                login.write_text(original)
            elif shell == "zsh":
                startup = zdir / ".zshrc"
            else:
                startup = config / "fish/conf.d/nexterm-shell-integration.fish"
                original = "# existing user configuration\nset -gx NEXTERM_TEST_KEEP preserved\n"
            startup.parent.mkdir(parents=True, exist_ok=True)
            startup.write_text(original)
            args = {"bash": ["bash", "--noprofile", "--norc", "-ic"], "fish": ["fish", "--no-config", "-ic"], "zsh": ["zsh", "-fic"]}[shell]
            for _ in range(2):
                output = run(args + [spec["line"]], env)
                assert READY in output and FAILED not in output, output
            assert startup.read_text().count(MARKER) == 1
            assert startup.read_text().startswith(original)
            assert Path(str(startup) + ".nexterm-si.bak").read_text() == original
            if shell == "bash":
                assert login.read_text().count(MARKER) == 1
                assert Path(str(login) + ".nexterm-si.bak").read_text() == original
            installed = task_home / ".local/share/nexterm/shell-integration" / shell
            assert installed.exists()
            # Start entirely new processes that load only the saved startup configuration.
            query = 'printf "STATE=%s KEEP=%s" "$__wt_si" "$NEXTERM_TEST_KEEP"'
            for flags in (["-ic"], ["-lic"]) if shell == "bash" else (["-ic"],):
                output = run([shell] + flags + [query], env)
                assert READY in output and "STATE=1 KEEP=preserved" in output, output
                assert installed.exists(), "startup deleted the persistent script"
            output = run([shell, "-c", "printf clean"], env)
            assert output == "clean", repr(output)
            print("PASS", shell, "install, repeat, backup, reopen, noninteractive")

        # Use files where directories are required to force reliable I/O failures,
        # even when the test happens to run as root.
        broken = base / "broken"
        broken.mkdir()
        (broken / ".local").write_text("blocked")
        env = dict(os.environ, HOME=str(broken))
        output = run(["bash", "--noprofile", "--norc", "-ic", spec["line"]], env)
        assert FAILED in output and READY not in output, output
        assert not (broken / ".bashrc").exists()
        # The script can be installed but saving the startup file must still fail.
        (broken / ".local").unlink()
        (broken / ".bashrc").mkdir()
        output = run(["bash", "--noprofile", "--norc", "-ic", spec["line"]], env)
        assert FAILED in output and READY not in output, output
        output = run(["sh", "-c", spec["line"].replace("; source ", "; . ")], env)
        assert "\x1b]633;P;NextermShellIntegration=0\x07" in output
        for name in set(re.findall(r"/tmp/\.nexterm-si-[a-f0-9]+\.rc", spec["line"])):
            Path(name).unlink(missing_ok=True)
        print("PASS failed writes and unsupported shell do not report success")


verify(SPEC)
