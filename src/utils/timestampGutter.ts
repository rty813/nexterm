import type { IDisposable, IMarker, Terminal } from "@xterm/xterm";
import { logicalRows } from "./lineHighlight";

/**
 * WindTerm-style timestamp margin: remembers when each line first received output
 * and paints its line number and time beside the visible rows.
 *
 * Stamps hang off one xterm marker per block of lines, so they follow their lines
 * through scrolling and are dropped with them when scrollback is trimmed. Not one
 * marker per line: xterm visits every marker for each line it trims, so a full
 * scrollback with thousands of markers made large output many times slower.
 *
 * Offsets count logical lines (wrapped rows belong to the line above), not rows: when a
 * resize re-wraps long lines, rows are added or removed inside a block, but its logical
 * lines stay the same, so the stamps stay on their lines.
 *
 * Line numbers count logical lines (a wrapped line is one) since the pane opened or was
 * last cleared, so they keep counting when old lines are trimmed. As in WindTerm, a clear
 * (`clear` sends ESC[3J; the Clear menu items) starts them over: the lines left are
 * renumbered from 1, and the backend drops the full history before it. Rows loaded from
 * the full history (services/historyScroll.ts) carry the backend's own numbers;
 * `alignNumbers` shifts the live count to match them.
 */
interface Block {
  /** First line of the block. */
  marker: IMarker;
  /** Stamped lines, as logical-line offsets from the marker, ascending, with their times and numbers. */
  offsets: number[];
  /** Last row resolved by `indexOf` and its logical offset (cleared on resize). */
  cacheRow?: number;
  cacheIdx?: number;
  times: number[];
  nos: number[];
  /** Rows from the full history: numbers are absolute (no live offset applied). */
  abs: boolean;
}

/** A stamp by absolute buffer line (exported / imported around output folding). */
export interface LineStamp {
  line: number;
  /** 0: unknown. */
  time: number;
  no?: number;
  abs?: boolean;
}

/** Live stamps kept before the oldest are released (bounded by scrollback anyway). */
const MAX_STAMPS = 20000;
/** Lines covered by one marker. */
const BLOCK_LINES = 512;

/**
 * The stamps that survive ESC[3J, numbered from 1: xterm.js drops the rows above `top`
 * (the scrollback), and rows from `lastText` down are blank (`clear` erased the screen
 * first), so they are not lines any more. A row stamped twice keeps its later stamp.
 */
export function clearSurvivors(
  stamps: { line: number; time: number }[],
  top: number,
  lastText: number
): { line: number; time: number; no: number }[] {
  const byLine = new Map<number, number>();
  for (const s of stamps) if (s.line >= top && s.line <= lastText) byLine.set(s.line, s.time);
  return [...byLine.entries()].sort((a, b) => a[0] - b[0]).map(([line, time], i) => ({ line, time, no: i + 1 }));
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function formatStamp(time: number, withMs: boolean): string {
  const d = new Date(time);
  const base = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return withMs ? `${base}.${String(d.getMilliseconds()).padStart(3, "0")}` : base;
}

/** Margin width in characters: number column (at least 4 digits) and time column. */
export function gutterChars(maxNo: number, showNumbers: boolean, withMs: boolean): number {
  const digits = showNumbers ? Math.max(4, String(Math.max(0, maxNo)).length) + 1 : 0;
  return digits + (withMs ? 12 : 8);
}

interface PaneRow {
  el: HTMLDivElement;
  no: HTMLSpanElement;
  time: HTMLSpanElement;
}

export class TimestampGutter implements IDisposable {
  private blocks: Block[] = [];
  private stampCount = 0;
  /** Absolute line of the last stamped row, so a write only stamps rows it reached. */
  private lastLine = -1;
  /** Follows `lastLine` through trims of a full scrollback (absolute lines shift then). */
  private lastMarker: IMarker | null = null;
  /** Number of the next live line (before `numberOffset`). */
  private nextNo = 1;
  /** Added to live numbers so they match the full history's numbering. */
  private numberOffset = 0;
  private rows: PaneRow[] = [];
  private frame = 0;
  private readonly subs: IDisposable[];
  private visible = false;
  private chars = 0;
  /** Output folding is rewriting the buffer: do not stamp the rows it writes. */
  private suspended = false;

  constructor(
    private readonly term: Terminal,
    private readonly host: HTMLDivElement,
    private withMs = false,
    private showNumbers = true
  ) {
    this.subs = [
      term.onWriteParsed(() => this.stampNewLines()),
      // A cursor move renders the cursor's row, so this also follows the current line.
      term.onRender(() => this.schedule()),
      term.onResize(() => {
        // Rows moved within blocks (re-wrap): row caches are stale.
        for (const b of this.blocks) b.cacheRow = b.cacheIdx = undefined;
        this.schedule();
      }),
      term.buffer.onBufferChange(() => this.schedule()),
      // ESC[3J: runs before xterm.js's own handler (return false lets it run next).
      term.parser.registerCsiHandler({ final: "J" }, (params) => {
        if (params[0] === 3) this.clearScrollback();
        return false;
      }),
    ];
    this.setWidth(0);
  }

  /** Stamps are recorded all the time; this only shows / hides the margin. */
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.host.style.display = visible ? "block" : "none";
    this.schedule();
  }

  setWithMs(withMs: boolean): void {
    this.withMs = withMs;
    this.chars = 0;
    this.schedule();
  }

  setShowNumbers(show: boolean): void {
    this.showNumbers = show;
    this.chars = 0;
    this.schedule();
  }

  /**
   * Stamps by absolute line, for output folding. Stops stamping until importStamps:
   * the rows the fold rewrites are not new output.
   */
  exportStamps(): LineStamp[] {
    this.suspended = true;
    const out: LineStamp[] = [];
    for (const b of this.live()) {
      const rows = this.rowsOf(b, Infinity);
      b.offsets.forEach((_, i) => {
        if (rows[i] !== undefined) out.push({ line: rows[i], time: b.times[i], no: b.nos[i], abs: b.abs });
      });
    }
    return out;
  }

  /** Replace every stamp after a rewrite (cursorLine = absolute cursor row now). */
  importStamps(list: LineStamp[], cursorLine: number): void {
    this.clear();
    for (const s of list.sort((a, b) => a.line - b.line)) {
      this.add(s.line, cursorLine, s.time, s.no ?? 0, Boolean(s.abs));
    }
    // The cursor row is stamped when output lands there, as usual.
    this.setLastStamped(list.some((s) => s.line === cursorLine) ? cursorLine : cursorLine - 1, cursorLine);
    this.suspended = false;
    this.schedule();
  }

  /**
   * Rows just loaded from the full history (ascending absolute lines), with the
   * backend's line numbers. They go above the live stamps, anywhere among earlier ones.
   */
  addHistoryStamps(list: LineStamp[]): void {
    const buf = this.term.buffer.active;
    if (buf.type !== "normal" || list.length === 0) return;
    const cursorLine = buf.baseY + buf.cursorY;
    const made: Block[] = [];
    let b: Block | null = null;
    for (const s of list) {
      if (!b || b.offsets.length >= BLOCK_LINES) {
        const marker = this.term.registerMarker(s.line - cursorLine);
        if (!marker) continue;
        b = { marker, offsets: [], times: [], nos: [], abs: true };
        made.push(b);
      }
      b.offsets.push(this.indexOf(b, s.line));
      b.times.push(s.time);
      b.nos.push(s.no ?? 0);
    }
    // Keep blocks in buffer order (painting skips the ones above the view by it).
    this.blocks = [...made, ...this.live()].sort((a, b) => a.marker.line - b.marker.line);
    this.schedule();
  }

  /** The live line at absolute `line` is number `no` of the full history. */
  alignNumbers(line: number, no: number): void {
    for (const b of this.live()) {
      if (b.abs) continue;
      if (line < b.marker.line) continue;
      const i = b.offsets.indexOf(this.indexOf(b, line));
      if (i >= 0) {
        this.numberOffset = no - b.nos[i];
        this.schedule();
        return;
      }
    }
  }

  /** The user cleared the terminal (menu, shortcut; after `term.clear()`): numbers start over. */
  restart(): void {
    this.clear();
    this.lastMarker?.dispose();
    this.lastMarker = null;
    this.lastLine = -1;
    this.nextNo = 1;
    this.numberOffset = 0;
    this.schedule();
  }

  /**
   * ESC[3J (what `clear` sends after ESC[H ESC[2J): the scrollback goes, and like WindTerm
   * the numbering starts over. Called before xterm.js trims the scrollback; the lines left
   * on screen are renumbered from 1.
   */
  private clearScrollback(): void {
    const buf = this.term.buffer.active;
    if (buf.type !== "normal" || this.suspended) return;
    const top = Math.max(0, buf.length - this.term.rows);
    let lastText = top - 1;
    for (let r = buf.length - 1; r >= top; r--) {
      if ((buf.getLine(r)?.translateToString(true) ?? "") !== "") {
        lastText = r;
        break;
      }
    }
    const stamps: { line: number; time: number }[] = [];
    for (const b of this.live()) {
      if (b.abs) continue;
      this.rowsOf(b, Infinity).forEach((line, i) => stamps.push({ line, time: b.times[i] }));
    }
    const cursorLine = buf.baseY + buf.cursorY;
    const last = this.lastStamped();
    this.clear();
    this.nextNo = 1;
    this.numberOffset = 0;
    for (const s of clearSurvivors(stamps, top, lastText)) this.add(s.line, cursorLine, s.time, s.no);
    this.setLastStamped(Math.min(last, lastText), cursorLine);
    this.schedule();
  }

  /** Stamp time of an absolute buffer line, if any. */
  timeOfLine(line: number): number | undefined {
    let time: number | undefined;
    for (const b of this.live()) {
      if (line < b.marker.line) continue;
      const i = b.offsets.indexOf(this.indexOf(b, line));
      if (i >= 0) time = b.times[i];
    }
    return time;
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.subs.forEach((s) => s.dispose());
    this.lastMarker?.dispose();
    this.clear();
    this.host.replaceChildren();
  }

  private clear(): void {
    this.blocks.forEach((b) => b.marker.dispose());
    this.blocks = [];
    this.stampCount = 0;
  }

  /** Blocks still in the buffer (trimmed ones are dropped here). */
  private live(): Block[] {
    if (this.blocks.some((b) => b.marker.isDisposed)) {
      this.blocks = this.blocks.filter((b) => !b.marker.isDisposed);
      this.stampCount = this.blocks.reduce((n, b) => n + (b.abs ? 0 : b.offsets.length), 0);
    }
    return this.blocks;
  }

  /** Stamp absolute `line` (cursor at `cursorLine`), opening a new block when needed. */
  private add(line: number, cursorLine: number, time: number, no: number, abs = false): void {
    let b = this.blocks[this.blocks.length - 1];
    const offset = b && !b.marker.isDisposed && line >= b.marker.line ? this.indexOf(b, line) : -1;
    if (!b || b.abs !== abs || offset < 0 || offset >= BLOCK_LINES || offset <= (b.offsets[b.offsets.length - 1] ?? -1)) {
      const marker = this.term.registerMarker(line - cursorLine);
      if (!marker) return;
      b = { marker, offsets: [], times: [], nos: [], abs };
      this.blocks.push(b);
      b.offsets.push(0);
    } else {
      b.offsets.push(offset);
    }
    b.times.push(time);
    b.nos.push(no);
    if (!abs) {
      this.stampCount++;
      this.nextNo = Math.max(this.nextNo, no + 1);
    }
  }

  /** Logical-line offset of absolute row `line` (>= the block's marker) in block `b`. */
  private indexOf(b: Block, line: number): number {
    const buf = this.term.buffer.active;
    let row = b.marker.line;
    let idx = 0;
    if (b.cacheRow !== undefined && b.cacheIdx !== undefined && b.cacheRow <= line && b.cacheRow >= row) {
      row = b.cacheRow;
      idx = b.cacheIdx;
    }
    for (let r = row + 1; r <= line; r++) if (!buf.getLine(r)?.isWrapped) idx++;
    b.cacheRow = line;
    b.cacheIdx = idx;
    return idx;
  }

  /** Absolute rows of a block's stamps, up to row `until`. */
  private rowsOf(b: Block, until: number): number[] {
    const buf = this.term.buffer.active;
    const out: number[] = [];
    let idx = 0;
    let k = 0;
    const end = Math.min(until, buf.length - 1);
    for (let r = b.marker.line; r <= end && k < b.offsets.length; r++) {
      if (r > b.marker.line && buf.getLine(r)?.isWrapped) continue;
      if (r > b.marker.line) idx++;
      while (k < b.offsets.length && b.offsets[k] < idx) k++;
      if (b.offsets[k] === idx) out[k++] = r;
    }
    return out;
  }

  /** Where `lastLine` is now: the buffer's numbering shifts when full scrollback trims rows. */
  private lastStamped(): number {
    if (this.lastMarker) {
      if (this.lastMarker.isDisposed) {
        // Trimmed away: every row still in the buffer is newer.
        this.lastMarker = null;
        this.lastLine = -1;
      } else {
        this.lastLine = this.lastMarker.line;
      }
    }
    return this.lastLine;
  }

  private setLastStamped(line: number, cursorLine: number): void {
    if (line === this.lastLine && this.lastMarker && !this.lastMarker.isDisposed) return;
    this.lastMarker?.dispose();
    this.lastMarker = line >= 0 ? this.term.registerMarker(line - cursorLine) ?? null : null;
    this.lastLine = line;
  }

  private stampNewLines(): void {
    if (this.suspended) return;
    const buf = this.term.buffer.active;
    if (buf.type !== "normal") return;
    const cursorLine = buf.baseY + buf.cursorY;
    let last = this.lastStamped();
    // After a clear / reset the cursor moves back up; start over from there.
    if (cursorLine < last) last = cursorLine - 1;
    const now = Date.now();
    // Every new line, also those a burst of output already scrolled past: the line
    // numbers count them all.
    for (let line = last + 1; line <= cursorLine; line++) {
      const bufLine = buf.getLine(line);
      // Continuation rows of a wrapped line belong to the line that started it.
      if (bufLine?.isWrapped) {
        last = line;
        continue;
      }
      // An empty cursor row is not output yet; stamp it when something lands there.
      if (line === cursorLine && (bufLine?.translateToString(true) ?? "").length === 0) break;
      this.add(line, cursorLine, now, this.nextNo);
      last = line;
    }
    this.setLastStamped(last, cursorLine);
    this.live();
    while (this.stampCount > MAX_STAMPS) {
      // Oldest live block first; history rows go when the history scroller drops them.
      const i = this.blocks.findIndex((b) => !b.abs);
      if (i < 0 || i === this.blocks.length - 1) break;
      const [b] = this.blocks.splice(i, 1);
      b.marker.dispose();
      this.stampCount -= b.offsets.length;
    }
    this.schedule();
  }

  private schedule(): void {
    if (!this.visible) return;
    // Called on every rendered frame while output streams: keep the frame already requested.
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.paint();
    });
  }

  private setWidth(maxNo: number): void {
    const chars = gutterChars(maxNo, this.showNumbers, this.withMs);
    if (chars === this.chars) return;
    this.chars = chars;
    this.host.style.minWidth = `calc(${chars}ch + 16px)`;
  }

  private paint(): void {
    const buf = this.term.buffer.active;
    const screen = this.term.element?.querySelector(".xterm-screen") as HTMLElement | null;
    if (!screen) return;
    const rowHeight = screen.clientHeight / this.term.rows;
    const top = screen.getBoundingClientRect().top - this.host.getBoundingClientRect().top;

    while (this.rows.length < this.term.rows) {
      const el = document.createElement("div");
      el.className = "ts-row";
      const no = document.createElement("span");
      no.className = "ts-no";
      const time = document.createElement("span");
      time.className = "ts-time";
      // Time first, the line number next to the text (as in WindTerm).
      el.append(time, no);
      this.host.appendChild(el);
      this.rows.push({ el, no, time });
    }
    while (this.rows.length > this.term.rows) this.rows.pop()!.el.remove();

    const byLine = new Map<number, { time: number; no: number }>();
    if (buf.type === "normal") {
      const first = buf.viewportY;
      const last = first + this.term.rows;
      const blocks = this.live();
      blocks.forEach((b, bi) => {
        if (b.marker.line >= last) return;
        // Blocks are in buffer order: one followed by a block starting above the view ends there too.
        const next = blocks[bi + 1];
        if (next && next.marker.line <= first) return;
        const shift = b.abs ? 0 : this.numberOffset;
        const rows = this.rowsOf(b, last - 1);
        rows.forEach((row, i) => {
          if (row >= first && row < last) byLine.set(row, { time: b.times[i], no: b.nos[i] + shift });
        });
      });
    }
    // The cursor's line (all its rows), drawn in the "current line" color.
    let current: [number, number] | null = null;
    if (buf.type === "normal") {
      const cursorRow = buf.baseY + buf.cursorY;
      current = logicalRows(cursorRow, (l) => Boolean(buf.getLine(l)?.isWrapped), buf.length);
      // The prompt row before anything is printed on it: show the number it will get.
      if (!byLine.has(current[0])) byLine.set(current[0], { time: 0, no: this.nextNo + this.numberOffset });
    }
    let maxNo = this.nextNo + this.numberOffset;
    for (const v of byLine.values()) maxNo = Math.max(maxNo, v.no);
    this.setWidth(maxNo);

    let previous = "";
    this.rows.forEach((row, i) => {
      row.el.style.top = `${top + i * rowHeight}px`;
      row.el.style.height = `${rowHeight}px`;
      row.el.style.lineHeight = `${rowHeight}px`;
      const abs = buf.viewportY + i;
      const stamp = byLine.get(abs);
      row.el.classList.toggle("ts-current", current !== null && abs >= current[0] && abs <= current[1]);
      const text = stamp?.time ? formatStamp(stamp.time, this.withMs) : "";
      row.no.textContent = this.showNumbers && stamp && stamp.no > 0 ? String(stamp.no) : "";
      row.no.style.display = this.showNumbers ? "" : "none";
      row.time.textContent = text;
      // Repeated times are dimmed, like WindTerm, so bursts of output stay readable.
      row.time.classList.toggle("ts-repeat", text !== "" && text === previous);
      row.el.title = stamp?.time ? new Date(stamp.time).toLocaleString() : "";
      if (text) previous = text;
    });
  }
}
