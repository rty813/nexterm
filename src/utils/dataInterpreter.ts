/**
 * Data interpreter for binary-mode panes (WinHex style): the bytes under the selection
 * in the hex dump (hexdump.rs), read as integers and floats in either byte order.
 *
 * Dump row: `00000010  48 65 6C 6C 6F 20 57 6F  72 6C 64 0D 0A 00 01 02  |Hello World.....|`
 */

/** One byte of a dump row and the columns it is drawn at. */
export interface DumpCell {
  value: number;
  /** First column of its two hex digits. */
  hexCol: number;
  /** Its column in the ASCII part. */
  asciiCol: number;
}

export interface DumpRow {
  offset: number;
  cells: DumpCell[];
}

const OFFSET_RE = /^([0-9A-F]{8}) {2}/;
const HEX2_RE = /^[0-9A-F]{2}$/;

/** A hex dump row, or null for any other text. */
export function parseDumpRow(text: string): DumpRow | null {
  const m = OFFSET_RE.exec(text);
  if (!m) return null;
  const cells: DumpCell[] = [];
  let pos = 10;
  for (;;) {
    if (cells.length === 8 && text[pos] === " " && HEX2_RE.test(text.slice(pos + 1, pos + 3))) pos++;
    const hex = text.slice(pos, pos + 2);
    if (!HEX2_RE.test(hex) || text[pos + 2] !== " ") break;
    cells.push({ value: parseInt(hex, 16), hexCol: pos, asciiCol: -1 });
    pos += 3;
  }
  if (!cells.length) return null;
  const open = text.indexOf("|", pos);
  if (open < 0 || text.slice(pos, open).trim() !== "" || text[open + 1 + cells.length] !== "|") return null;
  cells.forEach((c, i) => (c.asciiCol = open + 1 + i));
  return { offset: parseInt(m[1], 16), cells };
}

/** A logical terminal line (wrapped rows joined) and the buffer row it starts at. */
export interface ScreenLine {
  text: string;
  startRow: number;
}

export interface BufferPos {
  x: number;
  y: number;
}

export interface ByteSelection {
  /** Offset of the first selected byte. */
  offset: number;
  /** Bytes selected. */
  selected: number;
  /** Up to 8 bytes from the first selected one (following rows included). */
  bytes: Uint8Array;
  /** Where the first selected byte is drawn: its hex digits and its ASCII character. */
  cells: { hex: CellSpan[]; ascii: CellSpan[] };
}

/** Cells on one buffer row: `x` .. `x + width - 1`. */
export interface CellSpan {
  x: number;
  y: number;
  width: number;
}

/** Cells `from` .. `from + width - 1` of a logical line, split at row wraps. */
function spans(line: ScreenLine, cols: number, from: number, width: number): CellSpan[] {
  const out: CellSpan[] = [];
  for (let at = from; at < from + width; ) {
    const x = at % cols;
    const w = Math.min(from + width - at, cols - x);
    out.push({ x, y: line.startRow + Math.floor(at / cols), width: w });
    at += w;
  }
  return out;
}

/**
 * The selected bytes of a hex dump. A byte counts when the selection touches its hex digits
 * or its ASCII character. `end` is exclusive, as in xterm.js.
 */
export function selectedBytes(lines: ScreenLine[], cols: number, start: BufferPos, end: BufferPos): ByteSelection | null {
  const linear = (p: BufferPos, line: ScreenLine) => (p.y - line.startRow) * cols + p.x;
  const rows: { row: DumpRow; line: number }[] = [];
  let first: { row: number; cell: number } | null = null;
  let selected = 0;
  lines.forEach((line, li) => {
    const row = parseDumpRow(line.text);
    if (!row) return;
    const ri = rows.push({ row, line: li }) - 1;
    const rowsInLine = Math.max(1, Math.ceil(line.text.length / cols));
    const lineEndRow = line.startRow + rowsInLine - 1;
    if (end.y < line.startRow || start.y > lineEndRow) return;
    const from = start.y < line.startRow ? 0 : linear(start, line);
    const to = end.y > lineEndRow ? Infinity : linear(end, line);
    row.cells.forEach((c, ci) => {
      const hit = (c.hexCol < to && c.hexCol + 2 > from) || (c.asciiCol < to && c.asciiCol + 1 > from);
      if (!hit) return;
      selected++;
      if (!first) first = { row: ri, cell: ci };
    });
  });
  if (!first) return null;
  const at: { row: number; cell: number } = first;
  const firstRow = rows[at.row];
  const firstCell = firstRow.row.cells[at.cell];
  const offset = firstRow.row.offset + at.cell;
  const bytes: number[] = [];
  let expect = offset;
  for (let r = at.row; r < rows.length && bytes.length < 8; r++) {
    const { row } = rows[r];
    const startCell = r === at.row ? at.cell : 0;
    // Only bytes that continue the dump (another dump further down is not "next").
    if (row.offset + startCell !== expect) break;
    for (let c = startCell; c < row.cells.length && bytes.length < 8; c++) bytes.push(row.cells[c].value);
    expect = row.offset + row.cells.length;
  }
  const line = lines[firstRow.line];
  return {
    offset,
    selected,
    bytes: Uint8Array.from(bytes),
    cells: { hex: spans(line, cols, firstCell.hexCol, 2), ascii: spans(line, cols, firstCell.asciiCol, 1) },
  };
}

export interface ByteHit {
  /** First cell of the byte (its hex digits, or its ASCII character). */
  start: BufferPos;
  /** Cells to select: 2 for hex digits, 1 for the ASCII character. */
  length: number;
}

/**
 * The byte drawn under a cursor position (a single click, WinHex style): its hex digits or
 * its ASCII character. Null on a dump row's padding or on any other text.
 */
export function byteUnderCursor(lines: ScreenLine[], cols: number, pos: BufferPos): ByteHit | null {
  for (const line of lines) {
    const rows = Math.max(1, Math.ceil(line.text.length / cols));
    if (pos.y < line.startRow || pos.y >= line.startRow + rows) continue;
    const row = parseDumpRow(line.text);
    if (!row) return null;
    const at = (pos.y - line.startRow) * cols + pos.x;
    for (const c of row.cells) {
      const from = at >= c.hexCol && at < c.hexCol + 2 ? c.hexCol : at === c.asciiCol ? c.asciiCol : -1;
      if (from < 0) continue;
      const col = from % cols;
      return { start: { x: col, y: line.startRow + Math.floor(from / cols) }, length: Math.min(from === c.hexCol ? 2 : 1, cols - col) };
    }
    return null;
  }
  return null;
}

export type InterpretKey = "int8" | "uint8" | "int16" | "uint16" | "int32" | "uint32" | "int64" | "uint64" | "float32" | "float64" | "binary";

export const INTERPRET_KEYS: InterpretKey[] = ["int8", "uint8", "int16", "uint16", "int32", "uint32", "int64", "uint64", "float32", "float64", "binary"];

const SIZE: Record<InterpretKey, number> = {
  int8: 1, uint8: 1, int16: 2, uint16: 2, int32: 4, uint32: 4, int64: 8, uint64: 8, float32: 4, float64: 8, binary: 1,
};

const group = (n: number | bigint) => n.toLocaleString("en-US");

/** Shortest decimal that reads back as the same float32. */
function formatFloat32(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  for (let p = 1; p <= 9; p++) {
    const s = v.toPrecision(p);
    if (Math.fround(Number(s)) === v) return String(Number(s));
  }
  return String(v);
}

/** Value of `key` read from the start of `bytes`, or null when there are too few bytes. */
export function interpretValue(bytes: Uint8Array, key: InterpretKey, bigEndian: boolean): string | null {
  if (bytes.length < SIZE[key]) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const le = !bigEndian;
  switch (key) {
    case "int8":
      return group(view.getInt8(0));
    case "uint8":
      return group(view.getUint8(0));
    case "int16":
      return group(view.getInt16(0, le));
    case "uint16":
      return group(view.getUint16(0, le));
    case "int32":
      return group(view.getInt32(0, le));
    case "uint32":
      return group(view.getUint32(0, le));
    case "int64":
      return group(view.getBigInt64(0, le));
    case "uint64":
      return group(view.getBigUint64(0, le));
    case "float32":
      return formatFloat32(view.getFloat32(0, le));
    case "float64":
      return String(view.getFloat64(0, le));
    case "binary":
      return view.getUint8(0).toString(2).padStart(8, "0");
  }
}
