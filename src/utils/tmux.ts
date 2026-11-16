/**
 * tmux on an SSH host or in WSL: the listing command run on a side channel, its parser,
 * and the lines typed into the pane. Typed lines check `$TMUX` in the pane's own shell, so
 * a pane that is already inside tmux switches its client instead of nesting a new one.
 */

export interface TmuxWindow {
  index: number;
  name: string;
  active: boolean;
}

export interface TmuxSession {
  name: string;
  windows: number;
  /** Clients attached to it (any terminal, not only this pane). */
  attached: number;
  /** Last activity, Unix seconds. */
  activity: number;
  windowList: TmuxWindow[];
}

export interface TmuxListing {
  installed: boolean;
  sessions: TmuxSession[];
}

const NOT_INSTALLED = "@@NEXTERM_NO_TMUX";
const WINDOWS_MARK = "@@NEXTERM_TMUX_WINDOWS";

/**
 * POSIX sh, run on an SSH exec channel or `wsl.exe --exec sh -c`. tmux replaces ':' and '.'
 * in session names, so ':' separates fields; window names go last and may contain anything.
 */
export const TMUX_LIST_COMMAND = [
  `command -v tmux >/dev/null 2>&1 || { echo ${NOT_INSTALLED}; exit 0; }`,
  `tmux list-sessions -F '#{session_name}:#{session_windows}:#{session_attached}:#{session_activity}' 2>/dev/null`,
  `echo ${WINDOWS_MARK}`,
  `tmux list-windows -a -F '#{session_name}:#{window_index}:#{window_active}:#{window_name}' 2>/dev/null`,
  "exit 0",
].join("; ");

export function parseTmuxListing(out: string): TmuxListing {
  const lines = out.replace(/\r/g, "").split("\n");
  if (lines.some((l) => l.trim() === NOT_INSTALLED)) return { installed: false, sessions: [] };
  const mark = lines.findIndex((l) => l.trim() === WINDOWS_MARK);
  const sessionLines = mark < 0 ? lines : lines.slice(0, mark);
  const windowLines = mark < 0 ? [] : lines.slice(mark + 1);
  const sessions: TmuxSession[] = [];
  const byName = new Map<string, TmuxSession>();
  for (const line of sessionLines) {
    const p = line.split(":");
    if (p.length < 4 || !p[0] || !/^\d+$/.test(p[1])) continue;
    const s: TmuxSession = {
      name: p[0],
      windows: Number(p[1]),
      attached: Number(p[2]) || 0,
      activity: Number(p[3]) || 0,
      windowList: [],
    };
    sessions.push(s);
    byName.set(s.name, s);
  }
  for (const line of windowLines) {
    const p = line.split(":");
    if (p.length < 4 || !/^\d+$/.test(p[1])) continue;
    byName.get(p[0])?.windowList.push({ index: Number(p[1]), active: p[2] === "1", name: p.slice(3).join(":") });
  }
  for (const s of sessions) s.windowList.sort((a, b) => a.index - b.index);
  return { installed: true, sessions };
}

/** Single-quoted for sh, bash, zsh and fish. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Exact-match target (`=name`, so "web" never matches "web2"), optionally a window. */
export function tmuxTarget(session: string, window?: number): string {
  return shQuote(window === undefined ? `=${session}` : `=${session}:${window}`);
}

/** tmux turns these into '_' in session names; refuse them so the target stays exact. */
export function validSessionName(name: string): boolean {
  return name.length > 0 && !/[:.\s'"\\]/.test(name);
}

/** tmux's own default naming: the smallest unused non-negative number. */
export function nextSessionName(existing: string[]): string {
  const used = new Set(existing);
  let n = 0;
  while (used.has(String(n))) n++;
  return String(n);
}

// Typed lines start with a space (kept out of history with ignorespace / HIST_IGNORE_SPACE)
// and use only `[ ]`, `&&`, `||` and `\;`, which sh, bash, zsh and fish 3 all parse.

/** Go to a session (or one of its windows): switch the client inside tmux, attach outside. */
export function typedSwitch(session: string, window?: number): string {
  const t = tmuxTarget(session, window);
  return ` [ -n "$TMUX" ] && tmux switch-client -t ${t} || tmux attach -t ${t}`;
}

/** New session: inside tmux it is created detached and switched to, never nested. */
export function typedNew(name: string): string {
  const q = shQuote(name);
  return ` [ -n "$TMUX" ] && tmux new-session -d -s ${q} \\; switch-client -t ${tmuxTarget(name)} || tmux new-session -s ${q}`;
}

export const TYPED_DETACH = ` [ -n "$TMUX" ] && tmux detach-client`;
export const TYPED_SYNC = ` [ -n "$TMUX" ] && tmux set-window-option synchronize-panes`;

/** Startup command of a new tab: a fresh shell, so never nested. */
export const newTabAttach = (session: string) => `tmux attach -t ${tmuxTarget(session)}`;
export const newTabNew = (name: string) => `tmux new-session -A -s ${shQuote(name)}`;

/** Side-channel commands (no client involved). */
export const execRename = (from: string, to: string) => `tmux rename-session -t ${tmuxTarget(from)} ${shQuote(to)}`;
export const execKill = (session: string) => `tmux kill-session -t ${tmuxTarget(session)}`;
