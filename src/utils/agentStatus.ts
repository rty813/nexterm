import { looksLikePrompt } from "./commandWatch";

/**
 * AI agent status shown on tabs (Claude Code, Codex ...), in Herdr's model:
 * working, blocked (needs approval / an answer), done (finished, not looked at yet),
 * idle (done and seen), error.
 */
export type AgentState = "idle" | "working" | "blocked" | "done" | "error";

export interface AgentStatus {
  state: AgentState;
  /** For blocked: "permission" | "question". */
  kind?: string;
  /** "claude" | "codex" | other program name. */
  app: string;
  /** "hook": reported by the agent's hooks; "screen": guessed from the screen. */
  source: "hook" | "screen";
  since: number;
}

const STATES = new Set<AgentState>(["idle", "working", "blocked", "done", "error"]);

/** Normalize an app name from a hook ("claude-code" -> "claude"). */
export function normalizeApp(app: string | undefined): string {
  const a = (app || "").toLowerCase();
  if (a.startsWith("claude")) return "claude";
  if (a.startsWith("codex")) return "codex";
  return a || "agent";
}

export function agentDisplayName(app: string): string {
  return app === "claude" ? "Claude Code" : app === "codex" ? "Codex" : app;
}

/**
 * Parse the payload of OSC 7501 (`:state=working:kind=permission:app=claude-code`).
 * Returns state "clear" for state=clear, null for anything unknown.
 */
export function parseOsc7501(data: string): { state: AgentState | "clear"; kind?: string; app: string } | null {
  const fields: Record<string, string> = {};
  for (const part of data.split(":")) {
    const i = part.indexOf("=");
    if (i > 0) fields[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  const state = fields.state;
  if (state === "clear") return { state: "clear", app: normalizeApp(fields.app) };
  if (!STATES.has(state as AgentState)) return null;
  return { state: state as AgentState, kind: fields.kind || undefined, app: normalizeApp(fields.app) };
}

const WORKING = /esc to interrupt|esc to cancel|ctrl\+c to interrupt/i;
const BLOCKED = [
  /Do you want to (proceed|make this edit|create|allow|run|overwrite)/i,
  /Would you like to (run|make|apply)/i,
  /Allow (command|this|edit)\?/i,
  /❯\s*1\.\s*Yes/,
  /Press enter to confirm or esc to cancel/i,
];
/** Footer / chrome lines that only an agent's prompt shows. */
const AGENT_UI = /\? for shortcuts|esc to interrupt|context left|accept edits on|bypass permissions on|plan mode on|⏎ send|shift\+tab to cycle/i;

/** Which agent the screen belongs to, if any. */
function screenApp(text: string): string {
  if (/claude/i.test(text) || /[✻✽✢✳✶]/.test(text)) return "claude";
  if (/codex|openai/i.test(text)) return "codex";
  return "agent";
}

/**
 * A screen guess of "done" counts only after output stayed quiet this long. Codex hides
 * its "Working (… • esc to interrupt)" line while it streams a reply, so a single scan
 * then sees an idle prompt mid-turn; a working agent keeps redrawing (shimmer, timer,
 * streamed text), a finished one goes quiet.
 */
export const SCREEN_DONE_QUIET_MS = 3000;

/** Whether this screen guess ends a turn and must wait for [SCREEN_DONE_QUIET_MS] of quiet. */
export function needsQuietConfirm(next: AgentStatus | undefined, prev: AgentStatus | undefined): boolean {
  return next !== prev && next?.state === "done" && (prev?.state === "working" || prev?.state === "blocked");
}

/** Codex detached from this terminal and returned control to its shell. This says
 * nothing about whether the detached task continues in the background. */
export function codexDetachedFromTerminal(lines: string[], beforeCursor: string, normalScreen: boolean): boolean {
  if (!normalScreen || !looksLikePrompt(beforeCursor)) return false;
  return lines.some((line) => /^\s*Disconnected from this task\. Any running work continues\.\s*$/i.test(line));
}

/**
 * Guess the agent state from the bottom of the screen, for agents without hooks.
 * Returns undefined when the screen shows no agent at all.
 */
export function detectFromScreen(lines: string[], prev: AgentStatus | undefined): AgentStatus | undefined {
  const text = lines.join("\n");
  const now = Date.now();
  const app = prev?.app && prev.app !== "agent" ? prev.app : screenApp(text);
  const make = (state: AgentState, kind?: string): AgentStatus =>
    prev && prev.state === state && prev.kind === kind ? prev : { state, kind, app, source: "screen", since: now };
  if (BLOCKED.some((re) => re.test(text))) return make("blocked", "permission");
  if (WORKING.test(text)) return make("working");
  if (!AGENT_UI.test(text)) return undefined; // no agent on screen (exited, or never ran)
  // Agent prompt, not working: it just finished, or it was already done / idle.
  if (prev && (prev.state === "working" || prev.state === "blocked")) return make("done");
  return prev ?? make("idle");
}
