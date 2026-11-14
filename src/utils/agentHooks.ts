/**
 * Installs Claude Code / Codex hooks that report the agent's state to Nexterm.
 *
 * One script (~/.nexterm/agent-state.sh) maps a hook event to a state and sends
 * it: to the local endpoint when NEXTERM_AGENT_URL is set (local shells), else as
 * OSC 7501 to the tty of the agent (SSH sessions; Herdr-compatible format).
 */

export const HOOK_MARK = ".nexterm/agent-state.sh";

export const AGENT_STATE_SCRIPT = `#!/bin/sh
# Nexterm: report an AI agent's state to the terminal tab.
# Usage: agent-state.sh <app> <hook-event>   (hook JSON on stdin)
app="$1"; event="$2"; kind=""
input=$(cat 2>/dev/null)
case "$event" in
  SessionStart) state=idle ;;
  UserPromptSubmit|PostToolUse|SubagentStart) state=working ;;
  PreToolUse)
    case "$input" in
      *AskUserQuestion*|*ExitPlanMode*) state=blocked; kind=question ;;
      *) state=working ;;
    esac ;;
  PermissionRequest) state=blocked; kind=permission ;;
  Notification)
    case "$input" in
      *permission_prompt*) state=blocked; kind=permission ;;
      *elicitation_dialog*) state=blocked; kind=question ;;
      *idle_prompt*) state=idle ;;
      *) exit 0 ;;
    esac ;;
  Stop) state=done ;;
  StopFailure) state=error ;;
  SessionEnd) state=clear ;;
  *) exit 0 ;;
esac
# Codex wants JSON from a Stop hook; harmless for Claude Code.
[ "$event" = Stop ] && printf '{"continue":true}\\n'

if [ -n "$NEXTERM_AGENT_URL" ] && [ -n "$NEXTERM_PANE_ID" ] && command -v curl >/dev/null 2>&1; then
  curl -s -m 2 -o /dev/null "$NEXTERM_AGENT_URL&pane=$NEXTERM_PANE_ID&app=$app&state=$state&kind=$kind" && exit 0
fi

seq=$(printf '\\033]7501;:state=%s%s:app=%s\\033\\\\' "$state" "\${kind:+:kind=$kind}" "$app")
# Hooks may run without a controlling terminal: find the agent's tty up the process tree.
p=$PPID; i=0
while [ -n "$p" ] && [ "$p" -gt 1 ] 2>/dev/null && [ $i -lt 8 ]; do
  t=$(ps -o tty= -p "$p" 2>/dev/null | tr -d ' ')
  case "$t" in
    ""|"?"|"??") ;;
    *) t="/dev/\${t#/dev/}"; if [ -w "$t" ]; then printf '%s' "$seq" > "$t" 2>/dev/null && exit 0; fi ;;
  esac
  p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' '); i=$((i+1))
done
printf '%s' "$seq" > /dev/tty 2>/dev/null
exit 0
`;

const CLAUDE_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
  "Notification",
  "Stop",
  "StopFailure",
  "SessionEnd",
];
/** Codex uses Claude's hook format; only the events it documents. */
const CODEX_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"];
const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse", "PermissionRequest"]);

interface HookGroup {
  matcher?: string;
  hooks?: { type?: string; command?: string; timeout?: number }[];
}
type HooksFile = { hooks?: Record<string, HookGroup[]> } & Record<string, unknown>;

function parse(text: string | null | undefined, file: string): HooksFile {
  if (!text || !text.trim()) return {};
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as HooksFile;
  } catch {
    // fall through
  }
  throw new Error(`${file} 不是有效的 JSON，未修改`);
}

const ours = (g: HookGroup) => (g.hooks ?? []).some((h) => (h.command ?? "").includes(HOOK_MARK));

/** Remove our hook entries, then add them again when `install`. Other hooks are kept. */
function mergeHooks(text: string | null | undefined, file: string, app: string, events: string[], install: boolean): string {
  const doc = parse(text, file);
  const hooks: Record<string, HookGroup[]> = { ...(doc.hooks ?? {}) };
  for (const [event, groups] of Object.entries(hooks)) {
    const kept = (groups ?? []).filter((g) => !ours(g));
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (install) {
    for (const event of events) {
      const group: HookGroup = {
        ...(TOOL_EVENTS.has(event) ? { matcher: "*" } : {}),
        hooks: [{ type: "command", command: `sh "$HOME/${HOOK_MARK}" ${app} ${event}`, timeout: 5 }],
      };
      hooks[event] = [...(hooks[event] ?? []), group];
    }
  }
  const next: HooksFile = { ...doc, hooks };
  if (!Object.keys(hooks).length) delete next.hooks;
  return `${JSON.stringify(next, null, 2)}\n`;
}

export const mergeClaudeSettings = (text: string | null | undefined, install: boolean) =>
  mergeHooks(text, "settings.json", "claude", CLAUDE_EVENTS, install);
export const mergeCodexHooks = (text: string | null | undefined, install: boolean) =>
  mergeHooks(text, "hooks.json", "codex", CODEX_EVENTS, install);

export function hasOurHooks(text: string | null | undefined): boolean {
  try {
    const doc = parse(text, "");
    return Object.values(doc.hooks ?? {}).some((groups) => (groups ?? []).some(ours));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- remote (SSH exec)

export function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function fromBase64(b64: string): string {
  const bin = atob(b64.replace(/\s+/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

const SEP = "@@WTN@@";
const CLAUDE_DIR = '"${CLAUDE_CONFIG_DIR:-$HOME/.claude}"';
const CODEX_DIR = '"${CODEX_HOME:-$HOME/.codex}"';

/** Prints both config files (base64) and which agent directories exist. */
export const REMOTE_READ = [
  `for f in ${CLAUDE_DIR}/settings.json ${CODEX_DIR}/hooks.json "$HOME/${HOOK_MARK}"; do`,
  `  printf '%s\\n' '${SEP}'; if [ -f "$f" ]; then base64 < "$f" | tr -d '\\n'; fi; echo`,
  `done`,
  `printf '%s\\n' '${SEP}'`,
  `[ -d ${CLAUDE_DIR} ] && echo claude-dir`,
  `[ -d ${CODEX_DIR} ] && echo codex-dir`,
  `command -v base64 >/dev/null && echo has-base64`,
  `true`,
].join("\n");

export interface RemoteHookFiles {
  claudeDir: boolean;
  codexDir: boolean;
  claudeSettings: string | null;
  codexHooks: string | null;
  script: string | null;
  hasBase64: boolean;
}

export function parseRemoteRead(out: string): RemoteHookFiles {
  const parts = out.split(`${SEP}\n`);
  const file = (s: string | undefined) => (s && s.trim() ? fromBase64(s.trim()) : null);
  const flags = parts[4] ?? "";
  return {
    claudeSettings: file(parts[1]),
    codexHooks: file(parts[2]),
    script: file(parts[3]),
    claudeDir: /claude-dir/.test(flags),
    codexDir: /codex-dir/.test(flags),
    hasBase64: /has-base64/.test(flags),
  };
}

const writeFile = (dir: string, name: string, content: string) =>
  `[ -f ${dir}/${name} ] && [ ! -f ${dir}/${name}.nexterm-bak ] && cp ${dir}/${name} ${dir}/${name}.nexterm-bak; ` +
  `printf '%s' '${toBase64(content)}' | base64 -d > ${dir}/${name}.wtn-tmp && mv ${dir}/${name}.wtn-tmp ${dir}/${name}`;

/**
 * Shell command that writes (or with null script, removes) the hook files. */
export function remoteWrite(script: string | null, claude: string | null, codex: string | null): string {
  const lines = ["set -e"];
  if (script) {
    lines.push(
      `mkdir -p "$HOME/.nexterm"`,
      `printf '%s' '${toBase64(script)}' | base64 -d > "$HOME/${HOOK_MARK}"`,
      `chmod +x "$HOME/${HOOK_MARK}"`
    );
  } else {
    lines.push(`rm -f "$HOME/${HOOK_MARK}"`);
  }
  if (claude !== null) lines.push(writeFile(CLAUDE_DIR, "settings.json", claude));
  if (codex !== null) lines.push(writeFile(CODEX_DIR, "hooks.json", codex));
  lines.push("echo WTN-OK");
  return lines.join("\n");
}

// ---------------------------------------------------------------- install status

/**
 * installed: our hooks are in the agent's config; missing: not; absent: agent not used
 * there; custom: the user has their own hooks file, left alone.
 */
export type AgentHookState = "installed" | "missing" | "absent" | "custom";

export interface HookStatus {
  claude: AgentHookState;
  codex: AgentHookState;
  /** Installed, but the script is from an older Nexterm (reinstall to update). */
  outdated: boolean;
}

export function hookStatus(f: {
  claudeDir: boolean;
  codexDir: boolean;
  claudeSettings: string | null;
  codexHooks: string | null;
  script: string | null;
}): HookStatus {
  const state = (dir: boolean, text: string | null): AgentHookState =>
    hasOurHooks(text) && f.script !== null ? "installed" : dir ? "missing" : "absent";
  const claude = state(f.claudeDir, f.claudeSettings);
  const codex = state(f.codexDir, f.codexHooks);
  const any = claude === "installed" || codex === "installed";
  const outdated = any && f.script !== AGENT_STATE_SCRIPT;
  return { claude, codex, outdated };
}

export const anyInstalled = (h: HookStatus | null | undefined) =>
  Boolean(h && (h.claude === "installed" || h.codex === "installed"));
