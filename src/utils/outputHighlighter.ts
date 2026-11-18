import type { IBufferLine, IDecoration, IDisposable, IMarker, Terminal } from "@xterm/xterm";
import type { HighlightRule, ThemeDefinition } from "../types/domain";
import { buildMatcher, contrastText } from "./textMatch";

/** A user highlight rule compiled for painting. */
interface UserRule {
  re: RegExp;
  bg: string | null;
  fg: string;
}

export function compileUserRules(rules: HighlightRule[] | undefined): UserRule[] {
  const out: UserRule[] = [];
  for (const r of rules ?? []) {
    if (!r.enabled || !r.pattern) continue;
    const { re } = buildMatcher(r.pattern, r);
    if (!re) continue;
    out.push(r.mode === "text" ? { re, bg: null, fg: r.color } : { re, bg: r.color, fg: r.textColor || contrastText(r.color) });
  }
  return out;
}

/**
 * WindTerm-style output highlighting (modeled on terminal/schemes/linux/linux.lexer):
 * colors keywords, IPs, dates, numbers, paths, options and the command after a prompt.
 *
 * It never rewrites the byte stream. Matches are painted with xterm decorations, and
 * only on cells that still use the default foreground, so programs' own colors
 * (ls --color, git, PSReadLine) always win.
 */

type TokenKind =
  | "error"
  | "success"
  | "warn"
  | "info"
  | "command"
  | "permission"
  | "address"
  | "datetime"
  | "string"
  | "option"
  | "path"
  | "number"
  | "variable";

interface Rule {
  kind: TokenKind;
  re: RegExp;
  /** Capture group to paint (default: whole match). */
  group?: number;
}

// Shared rules, after WindTerm's lexers (they share these "repository" entries).
const ERROR = /\b(?:bad|cannot|denied|deprecated|disabled|errors?|fail(?:ed|ure|s)?|false|fatal|incorrect|invalid|refused|unknown|unsupported|unreachable|timed? ?out|exception|not found|no such file or directory|wrong)\b|错误|失败|拒绝|异常|无法/gi;
const WARN = /\b(?:warn(?:ing|s)?|closed|exited|debug|disconnected|skipped|stopped|sudo|terminated|killed)\b|警告/gi;
const SUCCESS = /\b(?:ok|okay|pass(?:ed)?|success(?:ful(?:ly)?)?|succeeded|supported|true|yes|valid|done|active|running|connected|enabled|up|correct(?:ly)?)\b|成功|完成/gi;
const INFO = /\b(?:access|authentication|connection|disconnection|info|login|operation|password|permission)\b/gi;
const ADDRESS = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?::\d{1,5})?(?:\/\d{1,2})?\b|\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b|\bhttps?:\/\/[^\s'"<>]+/gi;
const DATETIME = /\b\d{4}[/-]\d{1,2}[/-]\d{1,2}(?:[ T]\d{1,2}(?::\d{2}){1,2}(?:\.\d+)?Z?)?\b|\b\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?: ?[AP]M)?\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\b|\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/g;
const STRING = /"[^"\n]{0,200}"|'[^'\n]{0,200}'/g;
const NUMBER = /(?<![\w.])-?\d+(?:\.\d+)?(?:[KMGTP]i?B?|[kmgt]b?|%)?(?![\w.])/g;
const UNIX_PATH = /(?<=^|[\s=:'"(])(?:~|\.{1,2})?\/[\w.@%+~-]+(?:\/[\w.@%+~-]*)*/g;
const WIN_PATH = /(?<=^|[\s=:'"(])(?:[A-Za-z]:\\|\\\\)[^\s:*?"<>|]*/g;

const common = (extra: Rule[] = []): Rule[] => [
  ...extra,
  { kind: "error", re: ERROR },
  { kind: "warn", re: WARN },
  { kind: "success", re: SUCCESS },
  { kind: "info", re: INFO },
  { kind: "address", re: ADDRESS },
  { kind: "datetime", re: DATETIME },
  { kind: "string", re: STRING },
];

/** Per-system rule sets, like WindTerm's terminal/schemes/<system>/<system>.lexer. */
const SCHEMES: Record<string, Rule[]> = {
  linux: [
    // user@host:~$ cmd   root@box:/# cmd   [user@host dir]$ cmd   > cmd
    { kind: "command", re: /^(?:\([^)]*\)\s)?(?:\[[^\]\n]*\]|[^\s$#%>]*[@:][^\n$#%>]*)?\s?[$#%>]\s*([\w][\w.\-]*)/g, group: 1 },
    { kind: "permission", re: /^[dlcbps-][rwxsStT-]{9}[.+@]?(?=\s)/g },
    ...common([{ kind: "variable", re: /\$\{?[A-Za-z_][\w]*\}?/g }]),
    { kind: "option", re: /(?<=^|\s)--?[A-Za-z][\w-]*(?==|\s|$)/g },
    { kind: "path", re: UNIX_PATH },
    { kind: "number", re: NUMBER },
  ],
  macos: [
    { kind: "command", re: /^[^\s%$#]*[@:]?[^\n%$#]*[%$#]\s*([\w][\w.\-]*)/g, group: 1 },
    { kind: "permission", re: /^[dlcbps-][rwxsStT-]{9}[.+@]?(?=\s)/g },
    ...common([{ kind: "variable", re: /\$\{?[A-Za-z_][\w]*\}?/g }]),
    { kind: "option", re: /(?<=^|\s)--?[A-Za-z][\w-]*(?==|\s|$)/g },
    { kind: "path", re: UNIX_PATH },
    { kind: "number", re: NUMBER },
  ],
  powershell: [
    // PS C:\Users\x> Get-ChildItem
    { kind: "command", re: /^PS [^>\n]*>\s*([\w][\w.\-]*)/g, group: 1 },
    { kind: "variable", re: /\$(?:env:)?[A-Za-z_][\w]*/g },
    ...common(),
    // -Force -ErrorAction
    { kind: "option", re: /(?<=^|\s)-[A-Za-z][\w]*(?=[\s:]|$)/g },
    { kind: "path", re: WIN_PATH },
    { kind: "number", re: NUMBER },
  ],
  cmd: [
    // C:\Users\x>dir
    { kind: "command", re: /^[A-Za-z]:\\[^>\n]*>\s*([\w][\w.\-]*)/g, group: 1 },
    { kind: "variable", re: /%[A-Za-z_][\w]*%/g },
    ...common(),
    // /s /q /?
    { kind: "option", re: /(?<=^|\s)\/[A-Za-z?][\w]*(?=\s|$)/g },
    { kind: "path", re: WIN_PATH },
    { kind: "number", re: NUMBER },
  ],
  routeros: [
    // [admin@MikroTik] /ip address>
    { kind: "command", re: /^\[[^\]\n]+\]\s*[^>\n]*>\s*([\w/][\w./\-]*)/g, group: 1 },
    ...common(),
    { kind: "option", re: /(?<=^|\s)[a-z][\w-]*(?==)/g },
    { kind: "path", re: /(?<=^|\s)\/[a-z][\w-]*(?:\s+[a-z][\w-]*)*/g },
    { kind: "number", re: NUMBER },
  ],
  none: [],
};

/** Guess the scheme from the session when the user left it on "auto". */
export function resolveScheme(system: string | undefined, protocol: string): string {
  if (system && SCHEMES[system]) return system;
  if (protocol === "powershell") return "powershell";
  if (protocol === "cmd") return "cmd";
  return "linux";
}

type Palette = Record<TokenKind, string>;

function hex(color: string | undefined, fallback: string): string {
  return color && /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;
}

export function buildHighlightPalette(theme: ThemeDefinition): Palette {
  const a = theme.ansi;
  return {
    error: hex(a[9], "#ff5f5f"),
    success: hex(a[10], "#5fd75f"),
    warn: hex(a[11], "#ffd75f"),
    info: hex(a[12], "#5f87ff"),
    command: hex(a[14], "#5fd7ff"),
    permission: hex(a[6], "#00afaf"),
    address: hex(a[12], "#5f87ff"),
    datetime: hex(a[6], "#00afaf"),
    string: hex(a[3], "#d7af5f"),
    option: hex(a[14], "#5fd7ff"),
    path: hex(a[13], "#d75fd7"),
    number: hex(a[13], "#d75fd7"),
    variable: hex(a[11], "#ffd75f"),
  };
}

interface LineRecord {
  marker: IMarker;
  text: string;
  decorations: IDecoration[];
  /** Has keyword highlights from Settings (they also mark the overview ruler). */
  user: boolean;
}

/**
 * Lines with keyword highlights kept in scrollback before the oldest are released.
 * Syntax colors are only kept around the viewport and repainted when it scrolls back:
 * every line record holds an xterm marker, and xterm visits every marker for each
 * line it trims, so thousands of them made large output many times slower.
 */
const MAX_RECORDS = 1000;
/** Upper bound of lines inspected per pass. */
const MAX_SCAN_LINES = 1000;
/**
 * Scans run right in onWriteParsed, before xterm's next animation frame, so new text is
 * drawn already colored instead of flashing in the default color first. Under heavy
 * output that would cost throughput, so once synchronous scans took this much time in
 * the current window, the rest of the window falls back to the deferred scan.
 */
const SYNC_BUDGET_MS = 4;
const SYNC_WINDOW_MS = 100;
/** Delay of the deferred scan (after renders, and when over the budget). */
const DEFERRED_SCAN_MS = 40;

export class OutputHighlighter implements IDisposable {
  private records: LineRecord[] = [];
  private timer: number | undefined;
  private syncWindowStart = 0;
  private syncSpent = 0;
  /**
   * Where the next scan resumes, held by a marker: absolute rows shift when the scrollback
   * trims rows at the top or the full history inserts / drops rows there.
   */
  private scanMarker: IMarker | null = null;
  private scanRow = 0;
  private enabled: boolean;
  private palette: Palette;
  private rules: Rule[];
  private userRules: UserRule[] = [];
  private readonly subs: IDisposable[];

  constructor(
    private readonly term: Terminal,
    theme: ThemeDefinition,
    enabled: boolean,
    scheme = "linux"
  ) {
    this.palette = buildHighlightPalette(theme);
    this.rules = SCHEMES[scheme] ?? SCHEMES.linux;
    this.enabled = enabled;
    this.subs = [
      term.onWriteParsed(() => this.scanNow()),
      // Not term.onScroll, which fires (and allocates) once per scrolled line: a viewport
      // change renders, so onRender covers scrolling back through the scrollback too.
      term.onRender(() => this.schedule()),
      term.onResize(() => this.reset()),
      term.buffer.onBufferChange(() => this.reset()),
    ];
  }

  setTheme(theme: ThemeDefinition): void {
    this.palette = buildHighlightPalette(theme);
    this.reset();
  }

  setScheme(scheme: string): void {
    const next = SCHEMES[scheme] ?? SCHEMES.linux;
    if (next === this.rules) return;
    this.rules = next;
    this.reset();
  }

  /** Keyword highlights from Settings; painted even when syntax highlighting is off. */
  setUserRules(rules: UserRule[]): void {
    this.userRules = rules;
    this.reset();
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.reset();
  }

  dispose(): void {
    window.clearTimeout(this.timer);
    this.subs.forEach((s) => s.dispose());
    this.scanMarker?.dispose();
    this.clearAll();
  }

  private reset(): void {
    this.clearAll();
    const buf = this.term.buffer.active;
    this.setScanFrom(Math.max(0, buf.baseY + this.term.rows - MAX_SCAN_LINES));
    this.schedule();
  }

  private scanFrom(): number {
    if (this.scanMarker) {
      // Trimmed away: everything still in the buffer is newer.
      this.scanRow = this.scanMarker.isDisposed ? 0 : this.scanMarker.line;
    }
    return this.scanRow;
  }

  private setScanFrom(row: number): void {
    const buf = this.term.buffer.active;
    if (row === this.scanRow && this.scanMarker && !this.scanMarker.isDisposed && this.scanMarker.line === row) return;
    this.scanMarker?.dispose();
    this.scanMarker = buf.type === "normal" ? this.term.registerMarker(row - (buf.baseY + buf.cursorY)) ?? null : null;
    this.scanRow = row;
  }

  private clearAll(): void {
    for (const r of this.records) {
      r.decorations.forEach((d) => d.dispose());
      r.marker.dispose();
    }
    this.records = [];
  }

  private schedule(): void {
    if (this.timer !== undefined) return;
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      this.scan();
    }, DEFERRED_SCAN_MS);
  }

  /** Scan synchronously while within the time budget, else defer. */
  private scanNow(): void {
    const start = performance.now();
    if (start - this.syncWindowStart >= SYNC_WINDOW_MS) {
      this.syncWindowStart = start;
      this.syncSpent = 0;
    }
    if (this.syncSpent >= SYNC_BUDGET_MS) {
      this.schedule();
      return;
    }
    // This pass covers whatever a pending deferred one would have.
    window.clearTimeout(this.timer);
    this.timer = undefined;
    this.scan();
    this.syncSpent += performance.now() - start;
  }

  private scan(): void {
    const buf = this.term.buffer.active;
    if ((!this.enabled && this.userRules.length === 0) || buf.type !== "normal") return;

    const rows = this.term.rows;
    const end = buf.baseY + rows;
    const cursorAbs = buf.baseY + buf.cursorY;
    // New output since the last pass, and whatever the viewport shows now.
    const fresh = Math.max(0, end - MAX_SCAN_LINES, this.scanFrom());
    const view = buf.viewportY;
    const lines: number[] = [];
    for (let y = view; y < Math.min(view + rows, fresh); y++) lines.push(y);
    for (let y = fresh; y < end; y++) lines.push(y);

    // Drop released lines, and syntax-only lines far from the viewport.
    const keepFrom = view - rows;
    const keepTo = view + 2 * rows;
    this.records = this.records.filter((r) => {
      const l = r.marker.line;
      if (r.marker.isDisposed) return false;
      if (r.user || (l >= keepFrom && l < keepTo)) return true;
      r.decorations.forEach((d) => d.dispose());
      r.marker.dispose();
      return false;
    });
    const byLine = new Map<number, LineRecord>();
    for (const r of this.records) byLine.set(r.marker.line, r);

    for (const y of lines) {
      // Off-screen output only matters for keyword highlights (ruler marks).
      if ((y < keepFrom || y >= keepTo) && this.userRules.length === 0) continue;
      const line = buf.getLine(y);
      if (!line) continue;
      const { text, cols } = readLine(line);
      const existing = byLine.get(y);
      if (existing) {
        if (existing.text === text) continue;
        existing.decorations.forEach((d) => d.dispose());
        existing.decorations = [];
        existing.text = text;
        existing.user = false;
        this.paint(existing, line, text, cols);
        continue;
      }
      if (!text.trim()) continue;
      const marker = this.term.registerMarker(y - cursorAbs);
      if (!marker) continue;
      const rec: LineRecord = { marker, text, decorations: [], user: false };
      this.records.push(rec);
      this.paint(rec, line, text, cols);
    }
    // Resume from the line the cursor is on; everything above it is settled.
    this.setScanFrom(cursorAbs);

    if (this.records.length > MAX_RECORDS) {
      this.records.sort((a, b) => a.marker.line - b.marker.line);
      const drop = this.records.splice(0, this.records.length - MAX_RECORDS);
      for (const r of drop) {
        r.decorations.forEach((d) => d.dispose());
        r.marker.dispose();
      }
    }
  }

  private paint(rec: LineRecord, line: IBufferLine, text: string, cols: number[]): void {
    const claimed = new Uint8Array(text.length);
    // User highlights win over syntax colors and also apply to colored program output.
    for (const rule of this.userRules) {
      rule.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = rule.re.exec(text)) !== null) {
        if (m[0].length === 0) {
          rule.re.lastIndex++;
          continue;
        }
        const s = m.index;
        const e = s + m[0].length;
        if (claimed.subarray(s, e).some((v) => v)) continue;
        claimed.fill(1, s, e);
        const x = cols[s];
        const xEnd = cols[e - 1] + (line.getCell(cols[e - 1])?.getWidth() || 1);
        const deco = this.term.registerDecoration({
          marker: rec.marker,
          x,
          width: xEnd - x,
          foregroundColor: rule.fg,
          ...(rule.bg ? { backgroundColor: rule.bg } : {}),
          layer: "top",
          overviewRulerOptions: { color: rule.bg ?? rule.fg, position: "right" },
        });
        if (deco) {
          rec.decorations.push(deco);
          rec.user = true;
        }
      }
    }
    if (!this.enabled) return;
    for (const rule of this.rules) {
      rule.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = rule.re.exec(text)) !== null) {
        if (m[0].length === 0) {
          rule.re.lastIndex++;
          continue;
        }
        const target = rule.group ? m[rule.group] : m[0];
        if (!target) continue;
        const s = rule.group ? m.index + m[0].lastIndexOf(target) : m.index;
        const e = s + target.length;
        if (claimed.subarray(s, e).some((v) => v)) continue;
        claimed.fill(1, s, e);

        const x = cols[s];
        const xEnd = cols[e - 1] + (line.getCell(cols[e - 1])?.getWidth() || 1);
        const first = line.getCell(x);
        const last = line.getCell(cols[e - 1]);
        if (!first?.isFgDefault() || !last?.isFgDefault() || first.isInverse()) continue;

        const deco = this.term.registerDecoration({
          marker: rec.marker,
          x,
          width: xEnd - x,
          foregroundColor: this.palette[rule.kind],
          layer: "top",
        });
        if (deco) rec.decorations.push(deco);
      }
    }
  }
}

/** Read a buffer line as text plus the cell column of every UTF-16 code unit. */
function readLine(line: IBufferLine): { text: string; cols: number[] } {
  let text = "";
  const cols: number[] = [];
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    if (!cell || cell.getWidth() === 0) continue;
    const chars = cell.getChars() || " ";
    for (let i = 0; i < chars.length; i++) cols.push(x);
    text += chars;
  }
  const trimmed = text.replace(/\s+$/, "");
  return { text: trimmed, cols: cols.slice(0, trimmed.length) };
}
