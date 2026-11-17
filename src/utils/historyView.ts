/**
 * Pure logic of the full scrollback history (services/historyScroll.ts): the backend
 * (src-tauri/src/history/) keeps every line; when the user scrolls to the top of xterm.js's
 * buffer, older lines are fetched and written back into xterm.js above what it holds.
 */

/** Line kinds (history/line.rs). */
export const KIND_TEXT = 0;
export const KIND_CLEARED = 1;

/** Colors (history/line.rs): 0..255 palette, COLOR_RGB | 0xRRGGBB, COLOR_DEFAULT the theme's. */
export const COLOR_DEFAULT = 0xff000000;
export const COLOR_RGB = 0x01000000;

export const F_BOLD = 1;
export const F_DIM = 2;
export const F_ITALIC = 4;
export const F_UNDERLINE = 8;
export const F_INVERSE = 16;
export const F_STRIKE = 32;
export const F_HIDDEN = 64;

export interface HistoryStyle {
  fg: number;
  bg: number;
  flags: number;
}

/** A line as `history_lines` returns it: runs are [start (UTF-16), style index] pairs. */
export interface HistoryLine {
  text: string;
  runs: [number, number][];
  ts: number;
  kind: number;
  /** Line number as the margin shows it (starts over after each clear); 0 for markers. */
  no: number;
}

export interface HistoryInfo {
  first: number;
  /** End of the archived lines; the lines still on screen (`tail`) follow. */
  end: number;
  tail: number;
  dropped: number;
  /** The line numbered 1 since the last clear (0: never cleared). */
  base: number;
  memoryBytes: number;
  diskBytes: number;
}

export interface HistoryPage {
  first: number;
  lines: HistoryLine[];
  styles: HistoryStyle[];
  info: HistoryInfo;
}

/** Text of a line in one style. */
export interface Segment {
  text: string;
  style: HistoryStyle | null;
  /** UTF-16 offset of `text` in the logical line. */
  start: number;
}

/** The style segments of `line` within [from, to) (UTF-16). */
export function segments(line: HistoryLine, styles: HistoryStyle[], from = 0, to = line.text.length): Segment[] {
  if (from >= to) return [];
  if (line.runs.length === 0) return [{ text: line.text.slice(from, to), style: null, start: from }];
  const out: Segment[] = [];
  for (let i = 0; i < line.runs.length; i++) {
    const a = Math.max(line.runs[i][0], from);
    const b = Math.min(i + 1 < line.runs.length ? line.runs[i + 1][0] : line.text.length, to);
    if (a < b) out.push({ text: line.text.slice(a, b), style: styles[line.runs[i][1]] ?? null, start: a });
  }
  return out;
}


function sgrColor(c: number, base: number): string {
  if (c === COLOR_DEFAULT) return "";
  if (c >= COLOR_RGB && c < COLOR_DEFAULT) return `;${base + 8};2;${(c >> 16) & 0xff};${(c >> 8) & 0xff};${c & 0xff}`;
  if (c < 8) return `;${base + c}`;
  if (c < 16) return `;${base + 60 + c - 8}`;
  return `;${base + 8};5;${c}`;
}

/** SGR sequence of a style (always starting from a reset). */
export function sgr(style: HistoryStyle | null): string {
  if (!style) return "\x1b[0m";
  let s = "\x1b[0";
  const f = style.flags;
  if (f & F_BOLD) s += ";1";
  if (f & F_DIM) s += ";2";
  if (f & F_ITALIC) s += ";3";
  if (f & F_UNDERLINE) s += ";4";
  if (f & F_INVERSE) s += ";7";
  if (f & F_HIDDEN) s += ";8";
  if (f & F_STRIKE) s += ";9";
  return s + sgrColor(style.fg, 30) + sgrColor(style.bg, 40) + "m";
}

/**
 * Terminal output that reproduces history lines in xterm.js: each logical line in its
 * colors, ending with a newline (xterm.js wraps long lines itself). Markers become a dim
 * line reading `markerLabel`.
 */
export function linesToAnsi(lines: HistoryLine[], styles: HistoryStyle[], markerLabel: string): string {
  let out = "";
  for (const l of lines) {
    if (l.kind !== KIND_TEXT) {
      out += `\x1b[0;2m${markerLabel}\x1b[0m\r\n`;
      continue;
    }
    if (l.runs.length === 0) {
      out += l.text + "\r\n";
      continue;
    }
    for (const seg of segments(l, styles)) out += sgr(seg.style) + seg.text;
    out += "\x1b[0m\r\n";
  }
  return out;
}

/**
 * Margin number of history line `line` (numbers start over at each clear, which drops the
 * lines before it); null for a line from before the last clear.
 */
export function liveNumber(line: number, info: Pick<HistoryInfo, "base">): number | null {
  return line >= info.base ? line - info.base + 1 : null;
}

/** Text of a logical line for comparing with xterm.js (trailing blanks dropped). */
export function lineKey(text: string): string {
  return text.replace(/\s+$/, "");
}
