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

/**
 * Rows of output lost to a trim: `amount` rows leave the top of the buffer, and the last
 * stamped row is `last` (rows above it and it were counted already; -1: none).
 */
export function trimmedNewRows(last: number, amount: number): number {
  return Math.max(0, amount - Math.max(0, last + 1));
}

/**
 * Lines among `rows` trimmed rows, which can no longer tell whether they continued a
 * wrapped line: estimated from the new rows still in the buffer (`logical` of `total`
 * start a line), which came from the same output.
 */
export function estimateLines(rows: number, logical: number, total: number): number {
  return total > 0 ? Math.round((rows * logical) / total) : rows;
}

/**
 * Rows ED (`CSI Ps J`) resets whole, as absolute rows [from, to] (from > to: none):
 * 0 below the cursor's row, 1 above it, 2 the whole screen (`top` is its first row).
 * xterm.js also disposes every marker on those rows.
 */
export function erasedRows(ps: number, top: number, cursorLine: number, rows: number): [number, number] {
  if (ps === 0) return [cursorLine + 1, top + rows - 1];
  if (ps === 1) return [top, cursorLine - 1];
  if (ps === 2) return [top, top + rows - 1];
  return [0, -1];
}

/**
 * Digits the number column always has room for. Every change of the margin's width
 * resizes the terminal, and the remote shell redraws its prompt on that (fish leaves an
 * empty line), so it is not sized to the numbers shown: 7 digits cover 10 million lines.
 */
export const RESERVED_DIGITS = 7;

/** Margin width in characters: number column (at least `RESERVED_DIGITS`) and time column. */
export function gutterChars(maxNo: number, showNumbers: boolean, withMs: boolean): number {
  const digits = showNumbers ? Math.max(RESERVED_DIGITS, String(Math.max(0, maxNo)).length) + 1 : 0;
  return digits + (withMs ? 12 : 8);
}

/** xterm.js's line list of the normal buffer (internal, 5.5). */
interface TrimList {
  onTrim(listener: (amount: number) => void): IDisposable;
}

function normalLines(term: Terminal): TrimList | null {
  const core = (term as unknown as { _core?: { buffers?: { normal?: { lines?: TrimList } } } })._core;
  return core?.buffers?.normal?.lines ?? null;
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
  /**
   * Follows `lastLine` through trims of a full scrollback (absolute lines shift then): the
   * line is `lastDelta` rows from the marker's (not 0 when its own row was being erased).
   * Without a marker, `trimmed` keeps `lastLine` up to date itself.
   */
  private lastMarker: IMarker | null = null;
  private lastDelta = 0;
  /**
   * Output rows trimmed off the top before they were stamped: a write that scrolls more
   * than the whole scrollback (`cat` of a large file, `seq 1 1000000`) still counts them.
   */
  private lost = 0;
  private trimSub: IDisposable | null = null;
  private trimList: TrimList | null = null;
  /**
   * Numbers were estimated for trimmed rows (wrapped lines make that inexact): the full
   * history can line them up with its own count (`alignNumbers`) once output pauses.
   */
  onEstimated?: () => void;
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
      term.buffer.onBufferChange(() => {
        // A reset replaces the normal buffer: follow the new one's trims from its first write.
        this.watchTrim();
        this.schedule();
      }),
      // ED (ESC[J, ESC[2J, ESC[3J): runs before xterm.js's own handler (return false lets it run next).
      term.parser.registerCsiHandler({ final: "J" }, (params) => {
        const ps = typeof params[0] === "number" ? params[0] : 0;
        if (ps === 3) this.clearScrollback();
        else this.erase(ps);
        return false;
      }),
    ];
    // Before any marker of ours exists: `trimmed` must see their lines before they move.
    this.watchTrim();
    this.setWidth(0);
  }

  /** Number (as the margin shows it) of the stamp at absolute buffer line `line`, if any. */
  numberOfLine(line: number): number | undefined {
    let no: number | undefined;
    for (const b of this.live()) {
      if (line < b.marker.line) continue;
      const i = b.offsets.indexOf(this.indexOf(b, line));
      if (i >= 0 && this.rowsOf(b, line)[i] === line) no = b.nos[i] + (b.abs ? 0 : this.numberOffset);
    }
    return no;
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
    // Rows the rewrite pushed out were not new output.
    this.lost = 0;
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
    this.setLastStamped(-1, 0);
    this.lost = 0;
    this.nextNo = 1;
    this.numberOffset = 0;
    this.schedule();
  }

  /**
   * ED 0 / 1 / 2 is about to reset rows (xterm.js disposes their markers too): their stamps
   * go, so blank rows show no number, and the last stamped line moves off them.
   * Numbered like the backend's history (alacritty): a cleared screen's lines stay counted
   * (it scrolls them into its history), rows erased below the cursor do not.
   */
  private erase(ps: number): void {
    const buf = this.term.buffer.active;
    if (buf.type !== "normal" || this.suspended) return;
    // Output before this sequence in the same write is not stamped yet.
    this.stampNewLines();
    const cursorLine = buf.baseY + buf.cursorY;
    const [a, b] = erasedRows(ps, buf.baseY, cursorLine, this.term.rows);
    const last = this.lastStamped();
    // Nothing stamped there (a shell redrawing its prompt with ESC[J, usually).
    if (a > b || last < a) return;
    const dropped = this.dropRows(a, b, cursorLine);
    if (last > b) return;
    if (ps === 0) {
      // Never scrolled out, so not lines of the history: their numbers are given back.
      if (dropped.live > 0 && dropped.maxNo === this.nextNo - 1) this.nextNo -= dropped.live;
      this.setLastStamped(this.numberOfLine(cursorLine) !== undefined ? cursorLine : cursorLine - 1, cursorLine);
    } else if (ps === 2) {
      // Output after a clear starts new lines.
      this.setLastStamped(a - 1, cursorLine);
    } else {
      // Blank now, but still lines: the count stays, held by the cursor's row.
      this.setLastStamped(last, cursorLine, b + 1);
    }
  }

  /** Remove the stamps on rows [a, b]; returns how many live ones went and the highest number among them. */
  private dropRows(a: number, b: number, cursorLine: number): { live: number; maxNo: number } {
    const blocks = this.live();
    // Blocks are in buffer order: the last one starting above `a` is the first that can reach it.
    let from = 0;
    blocks.forEach((blk, i) => {
      if (blk.marker.line < a) from = i;
    });
    let live = 0;
    let maxNo = 0;
    const kept = blocks.slice(0, from);
    const survivors: (LineStamp & { no: number; abs: boolean })[] = [];
    for (const blk of blocks.slice(from)) {
      const rows = this.rowsOf(blk, Infinity);
      const touched = blk.marker.line >= a && blk.marker.line <= b ? true : rows.some((r) => r !== undefined && r >= a);
      if (!touched) {
        kept.push(blk);
        continue;
      }
      blk.offsets.forEach((_, k) => {
        const r = rows[k];
        if (r === undefined) return;
        if (r >= a && r <= b) {
          if (!blk.abs) {
            live++;
            maxNo = Math.max(maxNo, blk.nos[k]);
          }
        } else survivors.push({ line: r, time: blk.times[k], no: blk.nos[k], abs: blk.abs });
      });
      blk.marker.dispose();
    }
    // New blocks for the rest, never spanning the erased rows: resetting them clears their
    // wrap flags, which would shift the logical offsets of a block across them.
    const made = [
      ...this.buildBlocks(survivors.filter((s) => s.line < a), cursorLine),
      ...this.buildBlocks(survivors.filter((s) => s.line > b), cursorLine),
    ];
    this.blocks = [...kept, ...made].sort((x, y) => x.marker.line - y.marker.line);
    this.stampCount = this.blocks.reduce((n, x) => n + (x.abs ? 0 : x.offsets.length), 0);
    this.schedule();
    return { live, maxNo };
  }

  /** Blocks for stamps in ascending rows (cursor at absolute row `cursorLine`). */
  private buildBlocks(list: (LineStamp & { no: number; abs: boolean })[], cursorLine: number): Block[] {
    const made: Block[] = [];
    let b: Block | null = null;
    for (const s of list) {
      if (!b || b.abs !== s.abs || b.offsets.length >= BLOCK_LINES) {
        const marker = this.term.registerMarker(s.line - cursorLine);
        if (!marker) {
          b = null;
          continue;
        }
        b = { marker, offsets: [], times: [], nos: [], abs: s.abs };
        made.push(b);
      }
      b.offsets.push(this.indexOf(b, s.line));
      b.times.push(s.time);
      b.nos.push(s.no);
    }
    return made;
  }

  /** Follow the normal buffer's trims (a reset replaces the buffer: what was stamped is gone). */
  private watchTrim(): void {
    const lines = normalLines(this.term);
    if (!lines || lines === this.trimList) return;
    this.trimSub?.dispose();
    if (this.trimList) {
      this.clear();
      this.setLastStamped(-1, 0);
    }
    this.trimList = lines;
    this.trimSub = lines.onTrim((amount) => this.trimmed(amount));
  }

  /**
   * Rows left the top of the buffer. Runs before the markers' own trim handling (it was
   * subscribed before any of them), so `lastMarker` still has its line from before.
   */
  private trimmed(amount: number): void {
    const m = this.lastMarker;
    const alive = m !== null && !m.isDisposed;
    const last = alive ? m.line + this.lastDelta : this.lastLine;
    this.lost += trimmedNewRows(last, amount);
    if (alive && m.line - amount >= 0) return;
    // The marker's row goes (or there is none): keep the line as a plain number.
    m?.dispose();
    this.lastMarker = null;
    this.lastDelta = 0;
    this.lastLine = Math.max(-1, last - amount);
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
        // Gone some way `trimmed` and `erase` did not see (DECSED): every row left is newer.
        this.lastMarker = null;
        this.lastDelta = 0;
        this.lastLine = -1;
      } else {
        this.lastLine = this.lastMarker.line + this.lastDelta;
      }
    }
    return this.lastLine;
  }

  /** `anchor`: the row holding the marker, when `line`'s own row is being erased. */
  private setLastStamped(line: number, cursorLine: number, anchor = line): void {
    if (line === this.lastLine && anchor === line && this.lastDelta === 0 && this.lastMarker && !this.lastMarker.isDisposed) return;
    this.lastMarker?.dispose();
    this.lastMarker = line >= 0 && anchor >= 0 ? this.term.registerMarker(anchor - cursorLine) ?? null : null;
    this.lastDelta = this.lastMarker ? line - anchor : 0;
    this.lastLine = line;
  }

  private stampNewLines(): void {
    if (this.suspended) return;
    this.watchTrim();
    const buf = this.term.buffer.active;
    if (buf.type !== "normal") return;
    const cursorLine = buf.baseY + buf.cursorY;
    // A cursor moved back up (a redraw) writes over lines already stamped: nothing is new
    // above `last`. Clears are handled in `erase`.
    let last = this.lastStamped();
    if (this.lost > 0) {
      // Lines this write scrolled out of the scrollback before they could be stamped.
      let logical = 0;
      let total = 0;
      for (let r = Math.max(0, last + 1); r <= cursorLine; r++, total++) if (!buf.getLine(r)?.isWrapped) logical++;
      this.nextNo += estimateLines(this.lost, logical, total);
      this.lost = 0;
      this.onEstimated?.();
    }
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
    // Past the reserve it only grows (a clear starting over at 1 does not shrink it back);
    // changing what it shows resets `chars`.
    if (chars <= this.chars) return;
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
