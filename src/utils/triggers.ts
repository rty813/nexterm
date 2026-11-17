import type { AppSettings, BuiltinTrigger, TriggerRule } from "../types/domain";

/**
 * Triggers (WindTerm's trigger feature): patterns recognized in terminal output.
 * Hovering a match shows its tooltip, clicking it runs its action. The four built-ins
 * (hyperlink, hexadecimal / timestamp converter, unarchiver) are implemented here;
 * other triggers are a pattern plus a tooltip template / script and an action template.
 */

/** What activating a match does (carried out by the pane). */
export type TriggerEffect =
  /** Open in the system browser / mail client (http, https, ftp, ftps, mailto). */
  | { kind: "open"; url: string }
  /** Open a Nexterm session (ssh / sftp / scp / telnet links), as quick connect input. */
  | { kind: "connect"; target: string; label: string }
  /** Show a local file (file:// link) in Explorer. */
  | { kind: "reveal"; path: string }
  /** Type into the terminal (CR = Enter). */
  | { kind: "send"; text: string };

export interface TriggerContext {
  t: (key: string, options?: Record<string, unknown>) => string;
  /** Highlight scheme of the session: "linux", "powershell", "cmd" ... */
  scheme: string;
}

export interface TriggerHit {
  rule: TriggerRule;
  /** UTF-16 range of the match in the searched text. */
  start: number;
  end: number;
  text: string;
  /** "0" = whole match, "1".. = groups, plus the named groups. */
  captures: Record<string, string>;
  effect: TriggerEffect | null;
  /** Sanitized tooltip HTML, or a script whose result is the tooltip. */
  tip: { html: string } | { script: string } | null;
  /** What clicking does, as a plain line under the tooltip. */
  hint: string | null;
}

export interface CompiledTrigger {
  rule: TriggerRule;
  re: RegExp;
  builtin?: BuiltinDef;
}

interface BuiltinDef {
  pattern: string;
  caseSensitive: boolean;
  /** Off for this session (unarchiver commands make no sense in PowerShell / CMD). */
  off?: (ctx: TriggerContext) => boolean;
  /** Shorten a match (trailing punctuation after a link); "" drops it. */
  trim?: (text: string, captures: Record<string, string>) => string;
  handle: (text: string, captures: Record<string, string>, ctx: TriggerContext) => { effect?: TriggerEffect | null; tip?: string | null } | null;
}

// ---------------------------------------------------------------------------
// Hyperlink

const URL_SCHEMES = "https?|ftps?|sftp|scp|ssh|telnet|file";
const HYPERLINK_PATTERN =
  String.raw`(?<![\w.+-])(?:(?:(?:${URL_SCHEMES}):\/\/|mailto:|www\.)[^\s<>"'` +
  "`" +
  String.raw`]+|[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w@:\/-]|\.\w))`;
const EMAIL = /^[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

/** Drop trailing punctuation and closing brackets that are not part of the link. */
export function trimLink(text: string): string {
  let s = text;
  for (;;) {
    const last = s[s.length - 1];
    if (last && ".,;:!?'\"".includes(last)) {
      s = s.slice(0, -1);
      continue;
    }
    const open = { ")": "(", "]": "[", "}": "{", ">": "<" }[last ?? ""];
    if (open && count(s, last!) > count(s, open)) {
      s = s.slice(0, -1);
      continue;
    }
    return s;
  }
}

function count(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

/** What opening a link does: browser / mail client, a Nexterm session, or Explorer. */
export function linkEffect(raw: string): TriggerEffect | null {
  const s = raw.trim();
  if (!s || /[\x00-\x1f\x7f]/.test(s)) return null;
  const scheme = /^([a-z][\w+.-]*):/i.exec(s)?.[1].toLowerCase();
  if (!scheme || (scheme !== "mailto" && !s.slice(scheme.length + 1).startsWith("//"))) {
    if (/^www\./i.test(s)) return { kind: "open", url: `http://${s}` };
    if (EMAIL.test(s)) return { kind: "open", url: `mailto:${s}` };
    return null;
  }
  switch (scheme) {
    case "http":
    case "https":
    case "ftp":
    case "ftps":
    case "mailto":
      return { kind: "open", url: s };
    case "ssh":
    case "sftp":
    case "scp":
    case "telnet": {
      // scheme://[user[;params][:password]@]host[:port][/path]
      const m = /^[a-z]+:\/\/(?:([^@/]*)@)?(\[[0-9a-f:.]+\]|[^:/?#\s]+)(?::(\d{1,5}))?(?:[/?#]|$)/i.exec(s);
      if (!m) return null;
      const user = m[1] ? safeDecode(m[1].split(/[;:]/)[0]) : "";
      const host = m[2];
      const port = m[3] ? Number(m[3]) : null;
      if (port !== null && (port < 1 || port > 65535)) return null;
      if (scheme === "telnet") {
        const target = `telnet://${host}:${port ?? 23}`;
        return { kind: "connect", target, label: `${host}:${port ?? 23}` };
      }
      const who = `${user ? `${user}@` : ""}${host}`;
      return { kind: "connect", target: `ssh://${who}${port ? `:${port}` : ""}`, label: who };
    }
    case "file": {
      // file:///C:/dir/x, file://localhost/C:/dir/x, file:///home/x. Never another host:
      // a UNC path would make Windows contact that host (and send credentials).
      const m = /^file:\/\/(localhost)?(\/[^?#]*)/i.exec(s);
      if (!m) return null;
      let path = safeDecode(m[2]);
      if (/^\/[A-Za-z]:([/\\]|$)/.test(path)) path = path.slice(1).replace(/\//g, "\\");
      if (/^[/\\]{2}/.test(path)) return null;
      return { kind: "reveal", path };
    }
  }
  return null;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// ---------------------------------------------------------------------------
// Hexadecimal / timestamp converters

export function hexTooltip(digits: string, t: TriggerContext["t"]): string | null {
  if (!/^[0-9a-f]{1,64}$/i.test(digits)) return null;
  const n = BigInt(`0x${digits}`);
  return `${t("trigger.tip.decimal")}${n.toString(10)}\n${t("trigger.tip.octal")}${n.toString(8)}`;
}

/** ISO 8601 time at `offsetMin` minutes east of UTC ("Z" for UTC). */
export function isoTime(ms: number, offsetMin: number | "Z", withMs: boolean): string {
  const off = offsetMin === "Z" ? 0 : offsetMin;
  const base = new Date(ms + off * 60000).toISOString().slice(0, withMs ? 23 : 19);
  if (offsetMin === "Z") return `${base}Z`;
  const a = Math.abs(off);
  return `${base}${off < 0 ? "-" : "+"}${pad2(Math.floor(a / 60))}:${pad2(a % 60)}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 10 digits = seconds, 13 digits = milliseconds since 1970. */
export function timestampTooltip(digits: string, t: TriggerContext["t"]): string | null {
  if (!/^(?:\d{10}|\d{13})$/.test(digits)) return null;
  const withMs = digits.length === 13;
  const ms = withMs ? Number(digits) : Number(digits) * 1000;
  const local = -new Date(ms).getTimezoneOffset();
  return `${t("trigger.tip.local")}${isoTime(ms, local, withMs)}\n${t("trigger.tip.utc")}${isoTime(ms, "Z", withMs)}`;
}

// ---------------------------------------------------------------------------
// Unarchiver

/** Extract command per archive suffix (after WindTerm's unarchiver trigger). */
const UNARCHIVE: [RegExp, string][] = [
  [/\.(?:tar\.bz2|tbz2?)$/i, "tar -xvjf"],
  [/\.(?:tar\.gz|tgz)$/i, "tar -xvzf"],
  [/\.(?:tar\.xz|txz)$/i, "tar -xvJf"],
  [/\.tar\.zst$/i, "tar --zstd -xvf"],
  [/\.tar$/i, "tar -xvf"],
  [/\.bz2$/i, "bzip2 -d"],
  [/\.gz$/i, "gzip -d"],
  [/\.xz$/i, "xz -d"],
  [/\.lzma$/i, "lzma -d"],
  [/\.zst$/i, "zstd -d"],
  [/\.rar$/i, "unrar x"],
  [/\.zip$/i, "unzip"],
  [/\.7z$/i, "7z x"],
  [/\.Z$/, "uncompress"],
];
const ARCHIVE_PATTERN = String.raw`(?<![\w./~+@%-])[\w./~+@%-]*?[\w~+@%-]\.(?:tar\.(?:bz2|gz|xz|zst)|tbz2?|tgz|txz|tar|bz2|gz|xz|lzma|zst|rar|zip|7z|Z)(?![\w.-])`;

export function unarchiveCommand(file: string): string | null {
  const hit = UNARCHIVE.find(([re]) => re.test(file));
  return hit ? `${hit[1]} ${shellQuote(file)}` : null;
}

export function shellQuote(s: string): string {
  return /^[\w./~+@%:=,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

const BUILTINS: Record<BuiltinTrigger, BuiltinDef> = {
  hyperlink: {
    pattern: HYPERLINK_PATTERN,
    caseSensitive: false,
    trim: trimLink,
    handle: (text) => ({ effect: linkEffect(text) }),
  },
  hexConverter: {
    pattern: String.raw`(?<![\w.])0x([0-9a-f]+)(?!\w)`,
    caseSensitive: false,
    handle: (_text, c, ctx) => ({ tip: hexTooltip(c[1], ctx.t) }),
  },
  timestampConverter: {
    pattern: String.raw`(?<![\w.])(?:\d{13}|\d{10})(?!\w|\.\d)`,
    caseSensitive: true,
    handle: (text, _c, ctx) => ({ tip: timestampTooltip(text, ctx.t) }),
  },
  unarchiver: {
    pattern: ARCHIVE_PATTERN,
    caseSensitive: false,
    off: (ctx) => ctx.scheme === "powershell" || ctx.scheme === "cmd",
    handle: (text) => {
      const cmd = unarchiveCommand(text);
      return cmd ? { effect: { kind: "send", text: cmd } } : null;
    },
  },
};

export const BUILTIN_TRIGGERS = Object.keys(BUILTINS) as BuiltinTrigger[];

/** The pattern a built-in trigger matches (shown read-only in Settings). */
export function builtinPattern(b: BuiltinTrigger): string {
  return BUILTINS[b].pattern;
}

// ---------------------------------------------------------------------------
// Rules

export const CALCULATOR_SCRIPT = "(captures)=>{\n  return `${captures.expr}=<font color='red'>${eval(captures.expr)}</font>`;\n}";

/** Order is priority: where matches overlap, the earlier trigger wins. */
export const DEFAULT_TRIGGERS: TriggerRule[] = [
  { id: "builtin-hyperlink", name: "Hyperlink", builtin: "hyperlink", enabled: true, pattern: "", caseSensitive: false, activation: "ctrlClick" },
  {
    id: "python-error",
    name: "Python Error",
    enabled: true,
    pattern: String.raw`file "(?<file>[^"]+)", line (?<line>\d+).*`,
    caseSensitive: false,
    action: "sendText",
    actionText: "vim ${file} +${line}\\n",
    activation: "ctrlClick",
  },
  { id: "builtin-unarchiver", name: "Unarchiver", builtin: "unarchiver", enabled: true, pattern: "", caseSensitive: false, activation: "ctrlClick" },
  { id: "builtin-hex", name: "Hexadecimal Converter", builtin: "hexConverter", enabled: true, pattern: "", caseSensitive: false },
  { id: "builtin-timestamp", name: "Timestamp Converter", builtin: "timestampConverter", enabled: true, pattern: "", caseSensitive: true },
  {
    id: "calculator",
    name: "Calculator",
    enabled: true,
    pattern: String.raw`(?<expr>\S+)=`,
    caseSensitive: false,
    tooltip: CALCULATOR_SCRIPT,
    action: "none",
  },
];

/** The configured triggers; built-ins added since the list was saved come last. */
export function triggersOf(s: Pick<AppSettings, "triggers">): TriggerRule[] {
  const list = s.triggers ?? DEFAULT_TRIGGERS;
  const missing = DEFAULT_TRIGGERS.filter((d) => d.builtin && !list.some((r) => r.builtin === d.builtin));
  return missing.length ? [...list, ...missing] : list;
}

/** Error message for a bad pattern ("empty" when it can match nothing), or null. */
export function patternError(pattern: string, caseSensitive = false): string | null {
  if (!pattern) return "empty";
  try {
    const re = new RegExp(pattern, caseSensitive ? "" : "i");
    return re.test("") ? "empty" : null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export function compileTriggers(rules: TriggerRule[]): CompiledTrigger[] {
  const out: CompiledTrigger[] = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const builtin = rule.builtin ? BUILTINS[rule.builtin] : undefined;
    if (rule.builtin && !builtin) continue;
    const pattern = builtin?.pattern ?? rule.pattern;
    const cs = builtin?.caseSensitive ?? rule.caseSensitive;
    if (patternError(pattern, cs)) continue;
    out.push({ rule, re: new RegExp(pattern, cs ? "g" : "gi"), builtin });
  }
  return out;
}

/** A trigger's tooltip is a script when it is written as a function. */
export function isScript(source: string): boolean {
  return /^\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/.test(source);
}

/** Replace \n, \r, \t, \e and \\ with the characters. */
export function unescapeText(s: string): string {
  return s.replace(/\\([nrte\\])/g, (_m, c: string) => ({ n: "\n", r: "\r", t: "\t", e: "\x1b", "\\": "\\" })[c] ?? c);
}

/** ${name} / ${1} placeholders filled from a match. */
export function fillTemplate(template: string, captures: Record<string, string>): string {
  return template.replace(/\$\{(\w+)\}/g, (_m, k: string) => captures[k] ?? "");
}

/** Typed text: every line break is Enter. */
function asTyped(text: string): string {
  return text.replace(/\r\n|\n/g, "\r");
}

function capturesOf(m: RegExpExecArray, text: string): Record<string, string> {
  const c: Record<string, string> = { "0": text };
  for (let i = 1; i < m.length; i++) c[String(i)] = m[i] ?? "";
  for (const [k, v] of Object.entries(m.groups ?? {})) c[k] = v ?? "";
  return c;
}

/** Longest stretch of text searched, per trigger and line (very long lines are cut). */
const MAX_TEXT = 4096;
const MAX_HITS = 200;

/** Every trigger match in `text`, earlier triggers first (xterm takes the first link at a cell). */
export function findTriggerHits(text: string, triggers: CompiledTrigger[], ctx: TriggerContext): TriggerHit[] {
  const src = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
  const hits: TriggerHit[] = [];
  for (const tr of triggers) {
    if (tr.builtin?.off?.(ctx)) continue;
    const re = tr.re;
    re.lastIndex = 0;
    let n = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null && n < MAX_HITS) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const matched = tr.builtin?.trim ? tr.builtin.trim(m[0], {}) : m[0];
      if (!matched) continue;
      const captures = capturesOf(m, matched);
      const hit = buildHit(tr, matched, captures, ctx);
      if (!hit) continue;
      hits.push({ ...hit, start: m.index, end: m.index + matched.length });
      n++;
    }
  }
  return hits;
}

function buildHit(
  tr: CompiledTrigger,
  text: string,
  captures: Record<string, string>,
  ctx: TriggerContext
): Omit<TriggerHit, "start" | "end"> | null {
  const rule = tr.rule;
  let effect: TriggerEffect | null = null;
  let tip: TriggerHit["tip"] = null;
  if (tr.builtin) {
    const r = tr.builtin.handle(text, captures, ctx);
    if (!r) return null;
    effect = r.effect ?? null;
    if (r.tip) tip = { html: sanitizeTooltip(r.tip) };
  } else {
    if (rule.action === "sendText" && rule.actionText) {
      // Captured text comes from the remote host and is typed into a shell: quote what is not
      // plain (a "file" like `x; rm -rf ~` stays one argument, a path with spaces just works).
      const quoted = Object.fromEntries(Object.entries(captures).map(([k, v]) => [k, shellQuote(v)]));
      effect = { kind: "send", text: asTyped(fillTemplate(unescapeText(rule.actionText), quoted)) };
    } else if (rule.action === "openLink" && rule.actionText) {
      effect = linkEffect(fillTemplate(rule.actionText, captures));
    }
    const source = rule.tooltip?.trim();
    if (source) tip = isScript(source) ? { script: source } : { html: sanitizeTooltip(fillTemplate(source, captures)) };
  }
  if (!effect && !tip) return null;
  return { rule, text, captures, effect, tip, hint: effect ? effectHint(effect, rule.activation ?? "ctrlClick", ctx.t) : null };
}

/** "Ctrl + click to open the link", "Ctrl + click to type: vim x.py +3⏎" ... */
export function effectHint(effect: TriggerEffect, activation: "click" | "ctrlClick", t: TriggerContext["t"]): string {
  const how = t(`trigger.how.${activation}`);
  switch (effect.kind) {
    case "open":
      return t("trigger.hint.open", { how });
    case "connect":
      return t("trigger.hint.connect", { how, target: effect.label });
    case "reveal":
      return t("trigger.hint.reveal", { how });
    case "send": {
      const shown = effect.text.replace(/\r/g, "⏎").replace(/\x1b/g, "␛").replace(/[\x00-\x1f]/g, "·");
      return t("trigger.hint.send", { how, text: shown.length > 80 ? `${shown.slice(0, 80)}…` : shown });
    }
  }
}

export interface UnderlineMark {
  start: number;
  end: number;
  /** Solid when clicking does something, dotted when it only shows a tooltip. */
  solid: boolean;
}

/**
 * Underlines for the hits of one line. Where hits overlap the earlier (higher priority)
 * one wins, as it does for the mouse. A script tooltip only counts once `scriptShows`
 * says the script produced text (the Calculator trigger matches every `x=`).
 */
export function underlineMarks(
  hits: TriggerHit[],
  scriptShows: (source: string, captures: Record<string, string>) => boolean
): UnderlineMark[] {
  const taken: [number, number][] = [];
  const marks: UnderlineMark[] = [];
  for (const h of hits) {
    if (taken.some(([s, e]) => h.start < e && h.end > s)) continue;
    taken.push([h.start, h.end]);
    const shows = h.effect !== null || (h.tip !== null && ("html" in h.tip ? true : scriptShows(h.tip.script, h.captures)));
    if (shows) marks.push({ start: h.start, end: h.end, solid: h.effect !== null });
  }
  return marks.sort((a, b) => a.start - b.start);
}

/** The click (or Ctrl + click) the trigger asks for. */
export function activationMatches(activation: TriggerRule["activation"], ev: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return (activation ?? "ctrlClick") === "click" || ev.ctrlKey || ev.metaKey;
}

// ---------------------------------------------------------------------------
// Tooltip HTML

const TAGS = new Set(["b", "strong", "i", "em", "u", "s", "code", "br", "font"]);

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * Tooltip text as safe HTML: a few formatting tags are kept (b, i, u, s, code, br and
 * font color, as in WindTerm's tooltips), everything else is shown as text. Matched
 * text comes from the remote host, so nothing may become markup beyond these.
 */
export function sanitizeTooltip(src: string): string {
  let out = "";
  let last = 0;
  for (const m of src.matchAll(/<(\/?)([a-z]+)\b([^<>]*)>/gi)) {
    out += escapeHtml(src.slice(last, m.index));
    last = m.index! + m[0].length;
    const name = m[2].toLowerCase();
    if (!TAGS.has(name)) {
      out += escapeHtml(m[0]);
    } else if (name === "br") {
      out += "<br>";
    } else if (m[1]) {
      out += `</${name}>`;
    } else if (name === "font") {
      const c = /\bcolor\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(m[3]);
      const color = c ? (c[1] ?? c[2] ?? c[3]).trim() : "";
      out += /^(?:#[0-9a-f]{3,8}|[a-z]{3,20})$/i.test(color) ? `<font color="${color}">` : "<font>";
    } else {
      out += `<${name}>`;
    }
  }
  out += escapeHtml(src.slice(last));
  return out.replace(/\r?\n/g, "<br>");
}
