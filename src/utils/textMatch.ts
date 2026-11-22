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
 * so a match can span a wrap. `range`: only the logical lines that start in rows
 * [from, to) (from widened to the start of its logical line).
 */
export function findAll(
  term: Terminal,
  re: RegExp,
  limit = 2000,
  range?: { from: number; to: number }
): { matches: BufferMatch[]; truncated: boolean } {
  const buf = term.buffer.active;
  const matches: BufferMatch[] = [];
  let y = range ? lineStart(term, Math.max(0, Math.min(range.from, buf.length - 1))) : 0;
  const end = range ? Math.min(buf.length, Math.max(0, range.to)) : buf.length;
  while (y < end) {
    const startRow = y;
    // First the logical line's text alone (xterm.js builds it natively, fast): most lines
    // have no match and need not be read cell by cell. Same text as the cell-by-cell read:
    // wrapped rows keep their trailing cells, the last row loses trailing whitespace.
    let quick = "";
    do {
      const line = buf.getLine(y);
      if (!line) break;
      const raw = line.translateToString(false);
      quick += buf.getLine(y + 1)?.isWrapped ? raw : raw.replace(/\s+$/, "");
      y++;
    } while (y < buf.length && buf.getLine(y)?.isWrapped);
    if (y === startRow) {
      y++;
      continue;
    }
    re.lastIndex = 0;
    if (!re.test(quick)) continue;

    let text = "";
    const pos: { row: number; col: number }[] = [];
    for (let r = startRow; r < y; r++) {
      const line = buf.getLine(r);
      if (!line) break;
      // Keep trailing cells of wrapped rows: they are part of the logical line.
      const full = buf.getLine(r + 1)?.isWrapped ? readFullRow(line) : readRow(line);
      for (let i = 0; i < full.text.length; i++) pos.push({ row: r, col: full.cols[i] });
      text += full.text;
    }

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
  }
  return { matches, truncated: false };
}

/** The buffer row where the logical line holding row `row` starts. */
function lineStart(term: Terminal, row: number): number {
  const buf = term.buffer.active;
  let y = row;
  while (y > 0 && buf.getLine(y)?.isWrapped) y--;
  return y;
}

/**
 * A full-history match in the buffer, near buffer row `row`. The history (a headless
 * terminal in the backend) and xterm.js need not split the output into the same lines
 * (TUI redraws, reflow after a resize), so the row a history line maps to can be a few
 * lines off: check that the match's context is really there, else take the nearest
 * logical line within `radius` rows that holds it. Null when it is nowhere near.
 */
export function locateMatch(
  term: Terminal,
  row: number,
  m: { start: number; end: number; ctx: string; ctxOffset: number },
  radius = 400
): BufferMatch | null {
  const buf = term.buffer.active;
  const rel = m.start - m.ctxOffset;
  const len = m.end - m.start;
  if (buf.length === 0 || rel < 0 || len <= 0 || rel + len > m.ctx.length) return null;
  // The buffer's rows lose trailing blanks; so may the context.
  const ctx = m.ctx.replace(/\s+$/, "");
  const needle = m.ctx.slice(rel, rel + len);
  const tryLine = (start: number): BufferMatch | null => {
    const exact = matchAtRow(term, start, m.start, m.end);
    if (exact && exact.lineText.startsWith(ctx, m.ctxOffset)) return exact;
    const text = logicalLineAt(term, start)?.text;
    if (!text) return null;
    const idx = text.indexOf(ctx);
    if (idx < 0 || text.slice(idx + rel, idx + rel + len) !== needle) return null;
    return matchAtRow(term, start, idx + rel, idx + rel + len);
  };
  const first = lineStart(term, Math.max(0, Math.min(row, buf.length - 1)));
  const hit = tryLine(first);
  if (hit) return hit;
  // Walk outwards, one logical line at a time in each direction.
  let down = first;
  let up = first;
  let more = true;
  while (more) {
    more = false;
    if (down - first < radius) {
      let y = down + 1;
      while (y < buf.length && buf.getLine(y)?.isWrapped) y++;
      if (y < buf.length) {
        down = y;
        more = true;
        const h = tryLine(down);
        if (h) return h;
      }
    }
    if (first - up < radius && up > 0) {
      up = lineStart(term, up - 1);
      more = true;
      const h = tryLine(up);
      if (h) return h;
    }
  }
  return null;
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
