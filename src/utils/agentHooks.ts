/**
 * Installs Claude Code / Codex / Gemini CLI hooks that report the agent's state to Nexterm.
 *
 * One script (~/.nexterm/agent-state.sh) maps a hook event to a state and sends
 * it: to the local endpoint when NEXTERM_AGENT_URL is set (local shells), else as
 * OSC 7501 to the tty of the agent (SSH sessions; Herdr-compatible format).
 */

export const HOOK_MARK = ".nexterm/agent-state.sh";
export const WINDOWS_HOOK_MARK = ".nexterm/agent-state.ps1";

export const AGENT_STATE_SCRIPT = `#!/bin/sh
# Nexterm: report an AI agent's state to the terminal tab.
# Usage: agent-state.sh <app> <hook-event>   (hook JSON on stdin)
app="$1"; event="$2"; kind=""
input=$(cat 2>/dev/null)
case "$event" in
  SessionStart) state=idle ;;
  UserPromptSubmit|PostToolUse|SubagentStart|BeforeAgent|AfterTool) state=working ;;
  PreToolUse)
    case "$input" in
      *AskUserQuestion*|*ExitPlanMode*) state=blocked; kind=question ;;
      *) state=working ;;
    esac ;;
  BeforeTool)
    case "$input" in
      *'"tool_name":"ask_user"'*|*'"tool_name":"exit_plan_mode"'*) state=blocked; kind=question ;;
      *) state=working ;;
    esac ;;
  PermissionRequest) state=blocked; kind=permission ;;
  Notification)
    case "$input" in
      *permission_prompt*|*ToolPermission*) state=blocked; kind=permission ;;
      *elicitation_dialog*) state=blocked; kind=question ;;
      *idle_prompt*) state=idle ;;
      *) exit 0 ;;
    esac ;;
  Stop|AfterAgent) state=done ;;
  StopFailure) state=error ;;
  SessionEnd) state=clear ;;
  *) exit 0 ;;
esac
# Codex wants JSON from a Stop hook; harmless for Claude Code.
[ "$event" = Stop ] && printf '{"continue":true}\\n'

if [ -n "$NEXTERM_AGENT_URL" ] && [ -n "$NEXTERM_PANE_ID" ]; then
  url="$NEXTERM_AGENT_URL&pane=$NEXTERM_PANE_ID&app=$app&state=$state&kind=$kind"
  # WSL NAT cannot normally reach the Windows loopback listener from Linux.
  if [ -n "$WSL_INTEROP" ] && command -v curl.exe >/dev/null 2>&1; then
    curl.exe --noproxy '*' -fsS -m 2 -o /dev/null "$url" 2>/dev/null && exit 0
  fi
  if command -v curl >/dev/null 2>&1; then
    curl --noproxy '*' -fsS -m 2 -o /dev/null "$url" 2>/dev/null && exit 0
  fi
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

/** Windows hooks run under either cmd or a POSIX shell; use a native script. */
export const WINDOWS_AGENT_STATE_SCRIPT = `param([string]$app, [string]$eventName)
$inputJson = [Console]::In.ReadToEnd()
$kind = ''
switch ($eventName) {
  'SessionStart' { $state = 'idle' }
  { $_ -in 'UserPromptSubmit', 'PostToolUse', 'SubagentStart', 'BeforeAgent', 'AfterTool' } { $state = 'working' }
  'PreToolUse' { if ($inputJson -match 'AskUserQuestion|ExitPlanMode') { $state = 'blocked'; $kind = 'question' } else { $state = 'working' } }
  'BeforeTool' { if ($inputJson -match '"tool_name":"(ask_user|exit_plan_mode)"') { $state = 'blocked'; $kind = 'question' } else { $state = 'working' } }
  'PermissionRequest' { $state = 'blocked'; $kind = 'permission' }
  'Notification' {
    if ($inputJson -match 'permission_prompt|ToolPermission') { $state = 'blocked'; $kind = 'permission' }
    elseif ($inputJson -match 'elicitation_dialog') { $state = 'blocked'; $kind = 'question' }
    elseif ($inputJson -match 'idle_prompt') { $state = 'idle' }
    else { exit 0 }
  }
  { $_ -in 'Stop', 'AfterAgent' } { $state = 'done' }
  'StopFailure' { $state = 'error' }
  'SessionEnd' { $state = 'clear' }
  default { exit 0 }
}
if ($eventName -eq 'Stop') { [Console]::Out.WriteLine('{"continue":true}') }
if ($env:NEXTERM_AGENT_URL -and $env:NEXTERM_PANE_ID) {
  $url = $env:NEXTERM_AGENT_URL + '&pane=' + [uri]::EscapeDataString($env:NEXTERM_PANE_ID) + '&app=' + [uri]::EscapeDataString($app) + '&state=' + $state + '&kind=' + $kind
  try {
    $request = [System.Net.WebRequest]::Create($url)
    $request.Proxy = $null
    $request.Timeout = 2000
    $response = $request.GetResponse()
    $response.Close()
  } catch { }
}
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
/**
 * Gemini CLI has its own event names: a turn is BeforeAgent .. AfterAgent, and the only
 * Notification it sends is the tool permission prompt.
 */
const GEMINI_EVENTS = ["SessionStart", "BeforeAgent", "BeforeTool", "AfterTool", "Notification", "AfterAgent", "SessionEnd"];
const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse", "PermissionRequest", "BeforeTool", "AfterTool"]);
/** Hook timeout: seconds for Claude Code and Codex, milliseconds for Gemini CLI. */
const hookTimeout = (app: string) => (app === "gemini" ? 5000 : 5);

interface HookGroup {
  matcher?: string;
  hooks?: { name?: string; type?: string; command?: string; timeout?: number }[];
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

/** A matcher group. Gemini CLI also keeps settings such as "disabled": ["name"] under "hooks". */
const isGroup = (g: unknown): g is HookGroup =>
  Boolean(g) && typeof g === "object" && !Array.isArray(g) && Array.isArray((g as HookGroup).hooks ?? []);

const ours = (g: HookGroup) => (g.hooks ?? []).some((h) => ((h.command ?? "").includes(HOOK_MARK) || (h.command ?? "").includes(WINDOWS_HOOK_MARK)));

/** Remove our hook entries, then add them again when `install`. Other hooks are kept. */
function mergeHooks(text: string | null | undefined, file: string, app: string, events: string[], install: boolean, windows = false): string {
  const doc = parse(text, file);
  if (doc.hooks !== undefined && (!doc.hooks || typeof doc.hooks !== "object" || Array.isArray(doc.hooks))) {
    throw new Error(`${file} 的 hooks 不是对象，未修改`);
  }
  const hooks: Record<string, HookGroup[]> = { ...(doc.hooks ?? {}) };
  for (const [event, groups] of Object.entries(hooks)) {
    // Not a list of matcher groups (a setting, or something we do not understand): keep as is.
    if (!Array.isArray(groups) || !groups.every(isGroup) || !groups.some(ours)) continue;
    const kept = groups.map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !ours({ hooks: [h] })) })).filter((g) => g.hooks.length > 0);
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (install) {
    for (const event of events) {
      const group: HookGroup = {
        ...(TOOL_EVENTS.has(event) ? { matcher: "*" } : {}),
        hooks: [{ ...(app === "gemini" ? { name: "nexterm-agent-state" } : {}), type: "command", command: windows ? `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "& (Join-Path ([Environment]::GetFolderPath('UserProfile')) '${WINDOWS_HOOK_MARK}') ${app} ${event}"` : `sh "$HOME/${HOOK_MARK}" ${app} ${event}`, timeout: hookTimeout(app) }],
      };
      hooks[event] = [...(Array.isArray(hooks[event]) ? hooks[event] : []), group];
    }
  }
  const next: HooksFile = { ...doc, hooks };
  if (!Object.keys(hooks).length) delete next.hooks;
  return `${JSON.stringify(next, null, 2)}\n`;
}

export const mergeClaudeSettings = (text: string | null | undefined, install: boolean, windows = false) =>
  mergeHooks(text, "settings.json", "claude", CLAUDE_EVENTS, install, windows);
export const mergeCodexHooks = (text: string | null | undefined, install: boolean, windows = false) =>
  mergeHooks(text, "hooks.json", "codex", CODEX_EVENTS, install, windows);
export const mergeGeminiSettings = (text: string | null | undefined, install: boolean, windows = false) =>
  mergeHooks(text, "settings.json", "gemini", GEMINI_EVENTS, install, windows);

export function hasOurHooks(text: string | null | undefined): boolean {
  try {
    const doc = parse(text, "");
    return Object.values(doc.hooks ?? {}).some((groups) => Array.isArray(groups) && groups.some((g) => isGroup(g) && ours(g)));
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
const GEMINI_DIR = '"${GEMINI_CLI_HOME:-$HOME}/.gemini"';

/** Prints the config files (base64) and which agent directories exist. */
export const REMOTE_READ = [
  `for f in ${CLAUDE_DIR}/settings.json ${CODEX_DIR}/hooks.json "$HOME/${HOOK_MARK}" ${GEMINI_DIR}/settings.json; do`,
  `  printf '%s\\n' '${SEP}'; if [ -f "$f" ]; then base64 < "$f" | tr -d '\\n'; fi; echo`,
  `done`,
  `printf '%s\\n' '${SEP}'`,
  `[ -d ${CLAUDE_DIR} ] && echo claude-dir`,
  `[ -d ${CODEX_DIR} ] && echo codex-dir`,
  `[ -d ${GEMINI_DIR} ] && echo gemini-dir`,
  `command -v base64 >/dev/null && echo has-base64`,
  `true`,
].join("\n");

export interface RemoteHookFiles {
  claudeDir: boolean;
  codexDir: boolean;
  geminiDir: boolean;
  claudeSettings: string | null;
  codexHooks: string | null;
  geminiSettings: string | null;
  script: string | null;
  hasBase64: boolean;
}

export function parseRemoteRead(out: string): RemoteHookFiles {
  const parts = out.split(`${SEP}\n`);
  const file = (s: string | undefined) => (s && s.trim() ? fromBase64(s.trim()) : null);
  // The flags are the last part; the files come before it.
  const flags = parts.length > 4 ? parts[parts.length - 1] : "";
  return {
    claudeSettings: file(parts[1]),
    codexHooks: file(parts[2]),
    script: file(parts[3]),
    geminiSettings: parts.length > 5 ? file(parts[4]) : null,
    claudeDir: /claude-dir/.test(flags),
    codexDir: /codex-dir/.test(flags),
    geminiDir: /gemini-dir/.test(flags),
    hasBase64: /has-base64/.test(flags),
  };
}

const writeFile = (dir: string, name: string, content: string) =>
  `[ -f ${dir}/${name} ] && [ ! -f ${dir}/${name}.nexterm-bak ] && cp ${dir}/${name} ${dir}/${name}.nexterm-bak; ` +
  `printf '%s' '${toBase64(content)}' | base64 -d > ${dir}/${name}.wtn-tmp && mv ${dir}/${name}.wtn-tmp ${dir}/${name}`;

/**
 * Shell command that writes (or with null script, removes) the hook files. */
export function remoteWrite(script: string | null, claude: string | null, codex: string | null, gemini: string | null = null): string {
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
  if (gemini !== null) lines.push(writeFile(GEMINI_DIR, "settings.json", gemini));
  lines.push("echo WTN-OK");
  return lines.join("\n");
}

/** A single installer for any POSIX shell, including WSL and serial consoles. */
export function posixHookCommand(install: boolean): string {
  const config = JSON.stringify({ script: AGENT_STATE_SCRIPT, install, claude: CLAUDE_EVENTS, codex: CODEX_EVENTS, gemini: GEMINI_EVENTS, tools: [...TOOL_EVENTS] });
  const source = `import base64,json,os,pathlib,shutil,sys
c=json.loads(base64.b64decode('${toBase64(config)}'))
home=pathlib.Path.home()
script=home/'.nexterm'/'agent-state.sh'
targets=[(pathlib.Path(os.environ.get('CLAUDE_CONFIG_DIR') or home/'.claude')/'settings.json','claude'),(pathlib.Path(os.environ.get('CODEX_HOME') or home/'.codex')/'hooks.json','codex'),(pathlib.Path(os.environ.get('GEMINI_CLI_HOME') or home)/'.gemini'/'settings.json','gemini')]
mark=lambda h: isinstance(h,dict) and ('.nexterm/agent-state.sh' in h.get('command','') or '.nexterm/agent-state.ps1' in h.get('command',''))
isgroup=lambda g: isinstance(g,dict) and isinstance(g.get('hooks',[]),list)
changes=[]
for path,app in targets:
    if not path.parent.is_dir(): continue
    doc=json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
    if not isinstance(doc,dict) or not isinstance(doc.get('hooks',{}),dict): raise ValueError(str(path)+': invalid hooks object')
    hooks=doc.get('hooks',{})
    for event,groups in list(hooks.items()):
        if not isinstance(groups,list) or not all(isgroup(g) for g in groups): continue
        if not any(mark(h) for g in groups for h in g.get('hooks',[])): continue
        kept=[]
        for group in groups:
            group=dict(group)
            group['hooks']=[h for h in group.get('hooks',[]) if not mark(h)]
            if group['hooks']: kept.append(group)
        if kept: hooks[event]=kept
        else: del hooks[event]
    if c['install']:
        for event in c[app]:
            hook={'type':'command','command':'sh "$HOME/.nexterm/agent-state.sh" '+app+' '+event,'timeout':5000 if app=='gemini' else 5}
            if app=='gemini': hook={'name':'nexterm-agent-state',**hook}
            group={'hooks':[hook]}
            if event in c['tools']: group={'matcher':'*',**group}
            if not isinstance(hooks.get(event),list): hooks[event]=[]
            hooks[event].append(group)
    if hooks: doc['hooks']=hooks
    else: doc.pop('hooks',None)
    changes.append((path,json.dumps(doc,ensure_ascii=False,indent=2)+'\\n'))
if c['install'] and not changes: raise SystemExit('No Claude Code, Codex or Gemini CLI configuration directory found')
if c['install']:
    script.parent.mkdir(parents=True,exist_ok=True)
    script.write_text(c['script'],encoding='utf-8')
else: script.unlink(missing_ok=True)
for path,content in changes:
    backup=path.with_name(path.name+'.nexterm-bak')
    if path.exists() and not backup.exists(): shutil.copy2(path,backup)
    temp=path.with_name(path.name+'.wtn-tmp')
    temp.write_text(content,encoding='utf-8')
    temp.replace(path)
print('Nexterm agent hooks '+('installed' if c['install'] else 'removed')+'; restart the agent.')`;
  return `python3 -c "import base64;exec(base64.b64decode('${toBase64(source)}'))"`;
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
  gemini: AgentHookState;
  /** Installed, but the script is from an older Nexterm (reinstall to update). */
  outdated: boolean;
}

export function hookStatus(f: {
  claudeDir: boolean;
  codexDir: boolean;
  geminiDir?: boolean;
  claudeSettings: string | null;
  codexHooks: string | null;
  geminiSettings?: string | null;
  script: string | null;
  windows?: boolean;
}): HookStatus {
  const state = (dir: boolean, text: string | null): AgentHookState =>
    hasOurHooks(text) && f.script !== null ? "installed" : dir ? "missing" : "absent";
  const claude = state(f.claudeDir, f.claudeSettings);
  const codex = state(f.codexDir, f.codexHooks);
  const gemini = state(Boolean(f.geminiDir), f.geminiSettings ?? null);
  const any = claude === "installed" || codex === "installed" || gemini === "installed";
  const outdated = any && f.script !== (f.windows ? WINDOWS_AGENT_STATE_SCRIPT : AGENT_STATE_SCRIPT);
  return { claude, codex, gemini, outdated };
}

export const anyInstalled = (h: HookStatus | null | undefined) =>
  Boolean(h && (h.claude === "installed" || h.codex === "installed" || h.gemini === "installed"));
