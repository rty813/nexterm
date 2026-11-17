import type { IBufferLine, Terminal } from "@xterm/xterm";

export interface MatchOptions {
  regex?: boolean;
  caseSensitive?: boolean;
  wholeWord?: boolean;
}

/** Global RegExp for a search / highlight pattern, or an error message for a bad regex. */
export function buildMatcher(pattern: string, o: MatchOptions): { re: RegExp | null; error: string | null } {
  if (!pattern) return { re: null, error: null };
  let source = o.regex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (o.wholeWord) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`;
  try {
    const re = new RegExp(source, `gu${o.caseSensitive ? "" : "i"}`);
    // A pattern that can match the empty string would loop forever / match everywhere.
    if (re.test("")) return { re: null, error: "empty" };
    re.lastIndex = 0;
    return { re, error: null };
  } catch (e) {
    return { re: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Read one buffer row as text plus the cell column of every UTF-16 code unit. */
export function readRow(line: IBufferLine): { text: string; cols: number[] } {
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

export interface BufferMatch {
  /** Absolute buffer row / cell column where the match starts. */
  row: number;
  col: number;
  /** Length in cells (for term.select). */
  cells: number;
  /** The logical line (wrapped rows joined) and the match inside it. */
  lineText: string;
  start: number;
  end: number;
}

/**
 * All matches in the normal buffer, scanning logical lines (wrapped rows joined)
 * so a match can span a wrap.
 */
export function findAll(term: Terminal, re: RegExp, limit = 2000): { matches: BufferMatch[]; truncated: boolean } {
  const buf = term.buffer.active;
  const matches: BufferMatch[] = [];
  let y = 0;
  while (y < buf.length) {
    const startRow = y;
    let text = "";
    const pos: { row: number; col: number }[] = [];
    do {
      const line = buf.getLine(y);
      if (!line) break;
      const r = readRow(line);
      // Keep trailing cells of wrapped rows: they are part of the logical line.
      const next = buf.getLine(y + 1);
      const full = next?.isWrapped ? readFullRow(line) : r;
      for (let i = 0; i < full.text.length; i++) pos.push({ row: y, col: full.cols[i] });
      text += full.text;
      y++;
    } while (y < buf.length && buf.getLine(y)?.isWrapped);

    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const s = m.index;
      const e = s + m[0].length;
      const first = pos[s];
      const last = pos[e - 1];
      if (!first || !last) continue;
      const width = buf.getLine(last.row)?.getCell(last.col)?.getWidth() || 1;
      const cells = (last.row - first.row) * term.cols + last.col + width - first.col;
      matches.push({ row: first.row, col: first.col, cells, lineText: text, start: s, end: e });
      if (matches.length >= limit) return { matches, truncated: true };
    }
    if (y === startRow) y++;
  }
  return { matches, truncated: false };
}

/**
 * The cells of UTF-16 range [start, end) of the logical line that starts at buffer row
 * `row` (a match the full-history search found there). Null when the range is not there.
 */
export function matchAtRow(term: Terminal, row: number, start: number, end: number): BufferMatch | null {
  const buf = term.buffer.active;
  let text = "";
  const pos: { row: number; col: number }[] = [];
  let y = row;
  do {
    const line = buf.getLine(y);
    if (!line) break;
    const next = buf.getLine(y + 1);
    const full = next?.isWrapped ? readFullRow(line) : readRow(line);
    for (let i = 0; i < full.text.length; i++) pos.push({ row: y, col: full.cols[i] });
    text += full.text;
    y++;
  } while (y < buf.length && buf.getLine(y)?.isWrapped);
  const first = pos[start];
  const last = pos[end - 1];
  if (!first || !last || end <= start) return null;
  const width = buf.getLine(last.row)?.getCell(last.col)?.getWidth() || 1;
  const cells = (last.row - first.row) * term.cols + last.col + width - first.col;
  return { row: first.row, col: first.col, cells, lineText: text, start, end };
}

/**
 * The logical line (wrapped rows joined) that buffer row `row` belongs to, with the
 * cell of every UTF-16 code unit. At most `maxRows` rows are joined.
 */
export function logicalLineAt(
  term: Terminal,
  row: number,
  maxRows = 64
): { text: string; pos: { row: number; col: number }[] } | null {
  const buf = term.buffer.active;
  if (!buf.getLine(row)) return null;
  let y = row;
  while (y > 0 && row - y < maxRows && buf.getLine(y)?.isWrapped) y--;
  let text = "";
  const pos: { row: number; col: number }[] = [];
  const end = y + maxRows;
  do {
    const line = buf.getLine(y);
    if (!line) break;
    const next = buf.getLine(y + 1);
    const full = next?.isWrapped ? readFullRow(line) : readRow(line);
    for (let i = 0; i < full.text.length; i++) pos.push({ row: y, col: full.cols[i] });
    text += full.text;
    y++;
  } while (y < end && y < buf.length && buf.getLine(y)?.isWrapped);
  return { text, pos };
}

function readFullRow(line: IBufferLine): { text: string; cols: number[] } {
  let text = "";
  const cols: number[] = [];
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    if (!cell || cell.getWidth() === 0) continue;
    const chars = cell.getChars() || " ";
    for (let i = 0; i < chars.length; i++) cols.push(x);
    text += chars;
  }
  return { text, cols };
}

/** Black or white text, whichever reads better on `bg`. */
export function contrastText(bg: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(bg.trim());
  if (!m) return "#000000";
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#111111" : "#ffffff";
}

export const HIGHLIGHT_PRESETS = [
  "#fde047", // yellow
  "#fb923c", // orange
  "#f87171", // red
  "#f472b6", // pink
  "#c084fc", // purple
  "#60a5fa", // blue
  "#22d3ee", // cyan
  "#4ade80", // green
  "#a3a3a3", // gray
];
