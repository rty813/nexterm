import { hostFromPrompt } from "./hostname";
import { looksLikePrompt } from "./commandWatch";

/**
 * The command running in a pane right now (`make -j8`, `colcon build`), for the tab.
 *
 * With shell integration (OSC 133 C / D, VS Code's OSC 633 E) the shell says when a
 * command starts and ends. Without it: Enter on a prompt line starts the command, and it
 * ends once output is quiet and a shell prompt is back at the cursor. Enter while a
 * command runs is input to that program (passwords, REPLs) and is never read.
 */

/** The manual loader is a POSIX pipeline: not for local PowerShell / cmd tabs. */
export function canInjectShellIntegration(protocol: string, status: string): boolean {
  return status === "connected" && protocol !== "powershell" && protocol !== "cmd";
}

export interface RunningCommand {
  command: string;
  startedAt: number;
}

/** "root@web1:~# make -j8" -> { prompt: "root@web1:~#", command: "make -j8" }. */
export function splitPromptLine(line: string): { prompt: string; command: string } | null {
  const s = line.replace(/\s+$/, "");
  // cmd.exe: "C:\Users\me>dir" (no space after >).
  const cmd = /^([A-Za-z]:\\[^<>|]*>)\s*(\S.*)$/.exec(s);
  if (cmd) return { prompt: cmd[1], command: tidy(cmd[2]) };
  // oh-my-zsh default theme: "➜  src git:(main) ✗ make".
  const omz = /^(➜\s+\S+(?:\s+git:\([^)]*\))?(?:\s+✗)?)\s+(\S.*)$/.exec(s);
  if (omz) return { prompt: omz[1], command: tidy(omz[2]) };
  const m = /^(.*?[$#%>❯➜»λ])\s+(\S.*)$/.exec(s);
  if (!m || m[1].length > 160 || !looksLikePrompt(m[1])) return null;
  const command = tidy(m[2]);
  return command ? { prompt: m[1], command } : null;
}

/** Whether the text before the cursor is a shell prompt again (the command ended). */
export function isShellPrompt(beforeCursor: string, startPrompt: string): boolean {
  const s = beforeCursor.replace(/\s+$/, "");
  if (!s || s.length > 200) return false;
  if (s === startPrompt.replace(/\s+$/, "")) return true;
  if (hostFromPrompt(s)) return true;
  if (/^PS .*>$/.test(s) || /^[A-Za-z]:\\[^<>|]*>$/.test(s)) return true;
  // Same prompt symbol as before (cwd may have changed): "~/src ❯" -> "~/build ❯".
  const sym = startPrompt.replace(/\s+$/, "").slice(-1);
  return Boolean(sym) && s.endsWith(sym) && looksLikePrompt(s) && !/^>{2,3}$|^\.\.\.$/.test(s);
}

/** VS Code OSC 633 escapes: `\\` and `\xNN`. */
function unescape633(s: string): string {
  return s.replace(/\\(\\|x([0-9a-fA-F]{2}))/g, (_, a: string, hex?: string) => (hex ? String.fromCharCode(parseInt(hex, 16)) : a));
}

function tidy(command: string): string {
  return command.replace(/\s+/g, " ").trim().slice(0, 200);
}

interface Active extends RunningCommand {
  prompt: string;
  shown: boolean;
}

export class CommandTracker {
  private active: Active | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** OSC 133 C / D seen: the shell reports start and end, no guessing. */
  private integrated = false;
  /** Command line read at Enter (or from OSC 633 E), started on OSC 133 C. */
  private next: { command: string; prompt: string } | null = null;

  /**
   * @param report called with the command once it ran for `delayMs` (quick ones like
   *   `ls` / `cd` never show), and with null when it ends.
   */
  constructor(
    private readonly report: (cmd: RunningCommand | null) => void,
    private readonly delayMs = 1000,
    private readonly now: () => number = Date.now
  ) {}

  /** Whether an Enter now may start a command (worth reading the line for). */
  acceptsEnter(altScreen: boolean): boolean {
    return !altScreen && (this.integrated || !this.active);
  }

  /** The line Enter was pressed on (prompt + command), read once the shell redrew it. */
  onEnter(line: string): void {
    const parsed = splitPromptLine(line);
    if (this.integrated) {
      if (parsed && !this.next) this.next = parsed;
      return;
    }
    if (!this.active && parsed) this.start(parsed.command, parsed.prompt);
  }

  /** OSC 133 (A/B/C/D) or OSC 633 payloads. */
  onShellMark(data: string, osc: 133 | 633 = 133): void {
    const kind = data[0];
    if (osc === 633 && kind === "E") {
      const command = tidy(unescape633(data.slice(2).split(";")[0] ?? ""));
      if (command) this.next = { command, prompt: this.next?.prompt ?? "" };
      return;
    }
    if (kind === "C") {
      this.integrated = true;
      const next = this.next;
      this.next = null;
      // No line queued: keep the one Enter already started (first command of the shell).
      if (!next) return;
      this.finish();
      this.start(next.command, next.prompt);
    } else if (kind === "D") {
      this.integrated = true;
      this.finish();
    } else if (kind === "A" && this.integrated) {
      this.next = null;
      this.finish();
    }
  }

  /** Output went quiet: a prompt back at the cursor ends the command (no integration). */
  onQuiet(beforeCursor: string, altScreen: boolean): void {
    if (this.integrated || !this.active || altScreen) return;
    if (isShellPrompt(beforeCursor, this.active.prompt)) this.finish();
  }

  /** Disconnected / reconnected: nothing runs. */
  reset(): void {
    this.next = null;
    this.integrated = false;
    this.finish();
  }

  get current(): RunningCommand | null {
    return this.active?.shown ? { command: this.active.command, startedAt: this.active.startedAt } : null;
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.active = null;
  }

  private start(command: string, prompt: string): void {
    const active: Active = { command, prompt, startedAt: this.now(), shown: false };
    this.active = active;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.active !== active) return;
      active.shown = true;
      this.report({ command, startedAt: active.startedAt });
    }, this.delayMs);
  }

  private finish(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const was = this.active;
    this.active = null;
    if (was?.shown) this.report(null);
  }
}
