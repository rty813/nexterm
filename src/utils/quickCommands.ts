import type { QuickBarSettings, QuickCommand } from "../types/domain";

/**
 * Icon shapes and colors of quick commands. WindTerm writes `quick.icon` as
 * "session::<shape>-<color>" (shapes tag / square / heart / star / circle / pinwheel /
 * waterdrop / wifi, CSS color names); we keep "<shape>-<color>".
 */
export const QUICK_ICON_SHAPES = [
  "tag",
  "square",
  "circle",
  "heart",
  "star",
  "pinwheel",
  "waterdrop",
  "wifi",
  "bookmark",
  "flag",
  "zap",
  "terminal",
  "rocket",
  "bug",
  "cloud",
  "database",
  "server",
  "container",
  "box",
  "key",
  "wrench",
  "folder",
  "branch",
  "cpu",
] as const;
export type QuickIconShape = (typeof QUICK_ICON_SHAPES)[number];

export const QUICK_ICON_COLORS = [
  "coral",
  "gold",
  "yellowgreen",
  "mediumseagreen",
  "darkturquoise",
  "dodgerblue",
  "mediumpurple",
  "hotpink",
  "silver",
] as const;

export const DEFAULT_QUICK_ICON = "tag-coral";

export function parseQuickIcon(icon: string | undefined): { shape: QuickIconShape; color: string } {
  const raw = (icon || DEFAULT_QUICK_ICON).replace(/^session::/, "");
  const dash = raw.indexOf("-");
  const shape = (dash > 0 ? raw.slice(0, dash) : raw) as QuickIconShape;
  const color = dash > 0 ? raw.slice(dash + 1) : "coral";
  return {
    shape: QUICK_ICON_SHAPES.includes(shape) ? shape : "tag",
    // A CSS color name or hex; anything else falls back.
    color: /^(#[0-9a-f]{3,8}|[a-z]+)$/i.test(color) ? color : "coral",
  };
}

const SIMPLE_ESCAPES: Record<string, string> = {
  n: "\n",
  r: "\r",
  t: "\t",
  a: "\x07",
  b: "\b",
  e: "\x1b",
  f: "\f",
  v: "\v",
  "0": "\0",
  "\\": "\\",
};

/**
 * Backslash escapes as WindTerm sends them: \n \r \t \a \b \e \f \v \0 \\, \xHH and
 * \uHHHH. Anything else (`\.`, a truncated `\x4`) is sent as typed.
 */
export function unescapeQuickText(text: string): string {
  return text.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|[\s\S])/g, (all, esc: string) => {
    if (esc.length > 1) return String.fromCharCode(parseInt(esc.slice(1), 16));
    return SIMPLE_ESCAPES[esc] ?? all;
  });
}

/**
 * What a text command sends: backslash escapes decoded when the command asks for it
 * (WindTerm imports, or the editor's checkbox; the text itself keeps them), every line
 * break as Enter (CR), plus Enter at the end if asked.
 */
export function quickPayload(qc: QuickCommand): string {
  const text = (qc.escapes ? unescapeQuickText(qc.command) : qc.command).replace(/\r\n|\n/g, "\r");
  return qc.appendNewline && !text.endsWith("\r") ? `${text}\r` : text;
}

/**
 * The text as edited in the dialog (lines with \n) and whether Enter follows it. A
 * trailing line break of imported WindTerm commands is shown as "Enter at the end".
 */
export function toEditor(qc: QuickCommand): { text: string; enter: boolean } {
  const text = qc.command.replace(/\r\n|\r/g, "\n");
  if (text.endsWith("\n")) return { text: text.slice(0, -1), enter: true };
  return { text, enter: qc.appendNewline };
}

/** Back from the dialog: line breaks stored as CR, like WindTerm. */
export function fromEditor(text: string, enter: boolean): { command: string; appendNewline: boolean } {
  return { command: text.replace(/\r\n|\n/g, "\r"), appendNewline: enter };
}

/** Groups in display order: the saved order first, then groups only commands mention. */
export function quickGroups(commands: QuickCommand[], bar: QuickBarSettings | undefined, fallback: string): string[] {
  const out: string[] = [];
  const add = (g: string) => {
    if (!out.includes(g)) out.push(g);
  };
  (bar?.groups ?? []).forEach((g) => g && add(g));
  commands.forEach((c) => add(c.group || fallback));
  return out;
}

/** Commands of one group, in their own order or by label. */
export function commandsOf(commands: QuickCommand[], group: string, fallback: string, sortAlpha?: boolean): QuickCommand[] {
  const list = commands.filter((c) => (c.group || fallback) === group);
  return sortAlpha ? [...list].sort((a, b) => a.label.localeCompare(b.label, "zh")) : list;
}

/** Swap a command with its neighbour inside its group (the list keeps other groups' positions). */
export function moveInGroup(commands: QuickCommand[], id: string, dir: -1 | 1, fallback: string): QuickCommand[] {
  const me = commands.find((c) => c.id === id);
  if (!me) return commands;
  const group = me.group || fallback;
  const idx = commands.map((c, i) => ((c.group || fallback) === group ? i : -1)).filter((i) => i >= 0);
  const pos = idx.indexOf(commands.indexOf(me));
  const other = idx[pos + dir];
  if (other === undefined) return commands;
  const next = [...commands];
  [next[idx[pos]], next[other]] = [next[other], next[idx[pos]]];
  return next;
}

/** Quick bar height: rows of 26px chips 4px apart, plus 5px padding and a 1px border top and bottom. */
export const QUICKBAR_MAX_ROWS = 8;
const QUICKBAR_ROW = 30;

export function quickBarHeight(rows: number): number {
  return 8 + QUICKBAR_ROW * clampQuickBarRows(rows);
}

export function clampQuickBarRows(rows: number): number {
  if (!Number.isFinite(rows)) return 1;
  return Math.min(QUICKBAR_MAX_ROWS, Math.max(1, Math.round(rows)));
}

/** Rows after dragging the bar's top edge by `dy` pixels (up is negative, makes it taller). */
export function quickBarRowsAfterDrag(startRows: number, dy: number): number {
  return clampQuickBarRows((quickBarHeight(startRows) - dy - 8) / QUICKBAR_ROW);
}
