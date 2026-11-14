/**
 * One-shot "tell me when this command finishes" for ordinary shell commands (builds ...).
 *
 * Shells with shell integration report it exactly (OSC 133 C = command started,
 * D;<exit> = finished). Everything else: the command is done once output has been quiet
 * for a moment and the cursor sits right after a shell prompt again.
 */

/** Text left of the cursor ends like a shell prompt: `$ `, `# `, `> `, `% `, `❯ ` ... */
export function looksLikePrompt(beforeCursor: string): boolean {
  const s = beforeCursor.replace(/\s+$/, "");
  if (!s) return false;
  if (/[❯➜»λ$]$/.test(s)) return true;
  // Not progress output: "50%", "#####", "==>" / "->".
  if (s.endsWith("%")) return /[^\d\s.]\s*%$/.test(s) || s === "%";
  if (s.endsWith("#")) return !/##$/.test(s);
  if (s.endsWith(">")) return !/[=-]>$/.test(s);
  return false;
}

/** Exit code from an OSC 133 payload (`D;1` -> 1), null when absent. */
export function osc133Exit(data: string): number | null {
  const m = /^D;(-?\d+)/.exec(data);
  return m ? Number(m[1]) : null;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${m}m ${s}s`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

export interface CommandDone {
  /** The command line, when it was typed after arming. */
  command: string | null;
  /** From shell integration (OSC 133;D), else null. */
  exitCode: number | null;
  durationMs: number;
}
