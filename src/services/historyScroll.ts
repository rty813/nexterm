import type { IDisposable, Terminal } from "@xterm/xterm";
import { backend, type HistoryQuery } from "./backend";
import { lineKey, linesToAnsi, liveNumber, type HistoryInfo, type HistoryPage } from "../utils/historyView";

/**
 * Seamless full scrollback: xterm.js holds only its recent lines (settings.scrollback),
 * the backend (src-tauri/src/history/) holds every line.
 *
 * The buffer becomes [segment][native]: "native" is what xterm.js got from live output;
 * the "segment" is a window of older history lines rendered into rows and spliced in above
 * it. Scrolling near the segment's edges loads more lines into it (and drops lines far from
 * the view, so it stays bounded); the segment need not touch the native part (a gap of
 * unloaded lines may sit between them, filled as the view comes near).
 *
 * The scrollbar covers the whole history: xterm.js's own thumb is hidden and replaced by
 * one sized and placed by history line, so dragging it to the top reaches line 1, loading
 * that part of the history on the way. Back at the bottom, the segment is dropped again.
 *
 * Marks on the bar (search hits, highlight rules, the selection's other occurrences) also
 * cover the whole history: the backend reports which slots of the bar have matches.
 *
 * Uses xterm.js internals (buffer lines, viewport and selection), version 5.5.
 */

/** Lines loaded per step while scrolling. */
const FETCH_LINES = 1000;
/** Lines loaded around a position jumped to with the scrollbar. */
const JUMP_LINES = 2000;
/** Load more when the view is this many rows from the segment's edge. */
const PREFETCH_ROWS = 300;
/** Logical lines of xterm.js compared with the history to find where its buffer starts. */
const SIG_LINES = 6;
/** Rows the segment may hold; lines far from the view are dropped past this. */
const MAX_SEG_ROWS = 30_000;
const INFO_MS = 1000;
const MIN_THUMB = 24;

interface CoreLine {
  isWrapped: boolean;
  translateToString(trimRight?: boolean): string;
}

interface CoreList {
  length: number;
  maxLength: number;
  get(i: number): CoreLine | undefined;
  splice(start: number, deleteCount: number, ...items: CoreLine[]): void;
  trimStart(count: number): void;
  onTrim(listener: (amount: number) => void): IDisposable;
}

interface CoreBuffer {
  lines: CoreList;
  ybase: number;
  ydisp: number;
  y: number;
  savedY: number;
}

interface SelectionModel {
  selectionStart?: [number, number];
  selectionEnd?: [number, number];
  clearSelection(): void;
}

interface Core {
  buffers: { normal: CoreBuffer; active: CoreBuffer };
  viewport?: { syncScrollArea(immediate?: boolean): void };
  _selectionService?: { _model: SelectionModel; refresh(): void };
  refresh(start: number, end: number): void;
}

function coreOf(term: Terminal): Core | null {
  const core = (term as unknown as { _core?: Core })._core;
  return core?.buffers?.normal?.lines ? core : null;
}

/** Loaded history lines at the top of the buffer. */
interface Segment {
  /** History line of the first entry. */
  start: number;
  /** Rows of each loaded line, in order. */
  rows: number[];
  /** Output trimmed the first line's top rows: what is left of it starts the buffer. */
  cut: boolean;
}

/** Marks on the full-history scrollbar. */
export interface MarkLayer {
  /** Queries whose matches are marked, each in its color. */
  specs?: HistoryQuery[];
  colors?: string[];
  /** History lines marked directly (the selection), in `lineColor`. */
  lines?: number[];
  lineColor?: string;
  position: "left" | "right" | "full";
  /** Match counts and compile errors of `specs`, after each refresh. */
  onResult?: (r: { counts: number[]; errors: (string | null)[] }) => void;
}

interface LayerState {
  layer: MarkLayer;
  /** Slots (of `slots`) with matches, per spec. */
  marks: number[][];
  slots: number;
}

export interface HistoryScrollOptions {
  /** Label of the "screen cleared" marker line. */
  clearedLabel: string;
  /** History lines just inserted: absolute buffer row, line number (1-based; 0: none) and time of each. */
  onInserted?: (stamps: { line: number; no: number; time: number }[]) => void;
  /** The logical line at buffer row `line` is line number `no` (1-based) of the history. */
  onAligned?: (line: number, no: number) => void;
}

export class HistoryScroll implements IDisposable {
  /** History line of the first full native line; null: not aligned yet. */
  private anchor: number | null = null;
  private seg: Segment | null = null;
  private segRowCount = 0;
  private info: HistoryInfo | null = null;
  private infoAt = 0;
  private infoLoading = false;
  private busy = false;
  /** Bumped whenever the buffer changes under a running load (clear, reset, native trim). */
  private gen = 0;
  private pendingJump: number | null = null;
  /** Loads that changed the buffer; a load that adds nothing waits until `retryAt`. */
  private loads = 0;
  private retryAt = 0;
  private disposed = false;
  /** Our own trims are not output pushing rows out. */
  private selfTrim = false;
  private scratch: Terminal | null = null;
  private readonly subs: IDisposable[];
  private releaseTimer = 0;
  private trimSub: IDisposable | null = null;
  private trimList: CoreList | null = null;
  private frame = 0;
  private track: HTMLDivElement | null = null;
  private thumb: HTMLDivElement | null = null;
  /** Thumb being dragged: pointer offset from its top. */
  private drag: { offset: number } | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private layers = new Map<string, LayerState>();
  private marksTimer = 0;
  private marksBusy = false;
  private marksDirty = false;
  private marksTotal = -1;
  /** Track height the marks were drawn for. */
  private drawnHeight = -1;
  private loadedListeners = new Set<() => void>();

  constructor(
    private readonly term: Terminal,
    private readonly paneId: string,
    private readonly opts: HistoryScrollOptions
  ) {
    // Not term.onScroll: it fires once per scrolled line (10 million times for `seq 1 1e7`),
    // and scrolling renders anyway, so onRender (once per frame) sees every view change.
    this.subs = [
      term.onRender(() => this.check()),
      term.onResize(() => {
        this.vpBox = null;
        this.check();
      }),
      term.buffer.onBufferChange(() => this.check()),
      // ESC[3J (`clear`): the backend drops the full history too. Forget what was loaded
      // once xterm.js has trimmed its scrollback (after this chunk is parsed).
      term.parser.registerCsiHandler({ final: "J" }, (params) => {
        if (params[0] === 3 && term.buffer.active.type === "normal") queueMicrotask(() => !this.disposed && this.reset());
        return false;
      }),
    ];
    this.check();
  }

  dispose(): void {
    this.disposed = true;
    this.subs.forEach((s) => s.dispose());
    this.trimSub?.dispose();
    window.clearTimeout(this.releaseTimer);
    window.clearTimeout(this.marksTimer);
    cancelAnimationFrame(this.frame);
    this.scratch?.dispose();
    this.scratch = null;
    this.track?.remove();
    this.term.element?.classList.remove("hist-bar-on");
    window.removeEventListener("mousemove", this.onDragMove);
    window.removeEventListener("mouseup", this.onDragEnd);
  }

  /** The user cleared or reset the terminal: nothing loaded is left. */
  reset(): void {
    this.anchor = null;
    this.seg = null;
    this.segRowCount = 0;
    this.gen++;
    this.retryAt = 0;
    const lines = coreOf(this.term)?.buffers.normal.lines;
    const limit = this.limit();
    if (lines && lines.maxLength > limit && lines.length <= limit) lines.maxLength = limit;
    this.infoAt = 0;
    this.check();
  }

  /** Line up the gutter's line numbers with the history (after a tab moved windows). */
  async syncNumbers(): Promise<void> {
    const core = coreOf(this.term);
    if (!core || this.busy || this.seg) return;
    try {
      this.anchor = await this.align(core);
    } catch {
      // no history
    }
  }

  /** The backend keeps a history for this pane (search and marks can use it). */
  hasHistory(): boolean {
    return this.info !== null && this.info.end + this.info.tail > this.info.first;
  }

  /** Lines were loaded into or dropped from the buffer (decorations may need repainting). */
  onLoaded(listener: () => void): IDisposable {
    this.loadedListeners.add(listener);
    return { dispose: () => this.loadedListeners.delete(listener) };
  }

  /** History line shown at the top of the view (null: no history). */
  topLine(): number | null {
    const core = coreOf(this.term);
    if (!core || !this.info) return null;
    return this.lineAtRow(core, core.buffers.normal.ydisp, this.info.end + this.info.tail);
  }

  /** History line of the logical line holding buffer row `row`. */
  lineOfRow(row: number): number | null {
    const core = coreOf(this.term);
    if (!core || !this.info || this.term.buffer.active.type !== "normal") return null;
    return this.lineAtRow(core, row, this.info.end + this.info.tail);
  }

  /**
   * Bring history line `line` into view (about a third down), loading it when needed.
   * Returns the buffer row where it starts, or null.
   */
  async reveal(line: number): Promise<number | null> {
    for (let i = 0; this.busy && i < 100; i++) await new Promise((r) => setTimeout(r, 30));
    const core = coreOf(this.term);
    if (!core || this.term.buffer.active.type !== "normal") return null;
    this.retryAt = 0;
    await this.run(() => this.jumpTo(Math.max(0, line - Math.floor(this.term.rows / 3))));
    const row = this.rowOfLine(core, line);
    if (row === null) return null;
    const buf = this.term.buffer.active;
    if (row < buf.viewportY || row >= buf.viewportY + this.term.rows) {
      this.term.scrollToLine(Math.max(0, row - Math.floor(this.term.rows / 3)));
    }
    return row;
  }

  /** Set (or with null remove) a layer of marks on the scrollbar. */
  setMarkLayer(id: string, layer: MarkLayer | null): void {
    if (!layer) {
      this.layers.delete(id);
      this.drawMarks(true);
      return;
    }
    const old = this.layers.get(id);
    const same = old && JSON.stringify(old.layer.specs ?? []) === JSON.stringify(layer.specs ?? []);
    this.layers.set(id, { layer, marks: same ? old.marks : [], slots: same ? old.slots : 0 });
    this.drawMarks(true);
    if (!same && layer.specs?.length) this.scheduleMarks(30, true);
  }

  // ---------------------------------------------------------------- reacting to the view

  private limit(): number {
    return (this.term.options.scrollback ?? 1000) + this.term.rows;
  }

  private check(): void {
    if (this.disposed) return;
    this.schedulePaint();
    void this.refreshInfo(false);
    const buf = this.term.buffer.active;
    if (buf.type !== "normal") return;
    const core = coreOf(this.term);
    if (!core) return;
    this.watchTrim(core);
    // Back at the bottom: drop the segment after a moment (not while output streams in).
    if (this.seg && buf.viewportY >= buf.baseY) {
      window.clearTimeout(this.releaseTimer);
      this.releaseTimer = window.setTimeout(() => this.release(), 1500);
    }
    if (this.busy || this.drag) return;
    const top = buf.viewportY;
    const first = this.info?.first ?? 0;
    if (top <= PREFETCH_ROWS && buf.baseY > 0) {
      const above = this.seg ? this.seg.start > first || this.seg.cut : this.anchor === null || this.anchor > first;
      if (above) void this.run(() => this.loadAbove());
      return;
    }
    if (this.seg && this.anchor !== null && this.segEnd() < this.anchor) {
      // A gap of unloaded lines below the segment: fill it as the view comes near.
      const near = top + this.term.rows >= this.segRowCount - PREFETCH_ROWS && top <= this.segRowCount + this.term.rows;
      if (near) void this.run(() => this.loadBelow());
    }
  }

  private async refreshInfo(force: boolean): Promise<HistoryInfo | null> {
    if (this.infoLoading || (!force && Date.now() - this.infoAt < INFO_MS)) return this.info;
    this.infoLoading = true;
    try {
      this.info = await backend.historyInfo(this.paneId);
      this.infoAt = Date.now();
      const total = this.info ? this.info.end + this.info.tail : -1;
      // New output: refresh the marks, at most about once a second while it streams.
      if (total !== this.marksTotal) this.scheduleMarks(800, false);
      this.schedulePaint();
    } catch {
      this.info = null;
    } finally {
      this.infoLoading = false;
    }
    return this.info;
  }

  /**
   * Output arriving while scrolled up pushes rows out at the top (the buffer is at its
   * limit): segment rows go first; once native rows go, the anchor is lost.
   */
  private watchTrim(core: Core): void {
    const lines = core.buffers.normal.lines;
    if (this.trimList === lines) return;
    this.trimSub?.dispose();
    // A new buffer (reset): nothing of ours is in it.
    if (this.trimList) {
      this.seg = null;
      this.segRowCount = 0;
      this.anchor = null;
      this.gen++;
    }
    this.trimList = lines;
    this.trimSub = lines.onTrim((amount) => {
      if (this.selfTrim) return;
      let rem = amount;
      const seg = this.seg;
      if (seg) {
        while (rem > 0 && seg.rows.length > 0) {
          if (seg.rows[0] <= rem) {
            rem -= seg.rows[0];
            this.segRowCount -= seg.rows[0];
            seg.rows.shift();
            seg.start++;
            seg.cut = false;
          } else {
            seg.rows[0] -= rem;
            this.segRowCount -= rem;
            seg.cut = true;
            rem = 0;
          }
        }
        if (seg.rows.length === 0) this.seg = null;
      }
      if (rem > 0) {
        this.anchor = null;
        this.gen++;
      }
    });
  }

  // ---------------------------------------------------------------- buffer bookkeeping

  private segEnd(): number {
    return this.seg ? this.seg.start + this.seg.rows.length : 0;
  }

  /** Rows of a line cut by a trim at the top of the native part (continuation rows). */
  private nativePartial(core: Core): number {
    const lines = core.buffers.normal.lines;
    let i = this.segRowCount;
    while (i < lines.length && lines.get(i)?.isWrapped) i++;
    return i - this.segRowCount;
  }

  private cursorRow(core: Core): number {
    const b = core.buffers.normal;
    return b.ybase + b.y;
  }

  /** Logical lines of the native part (up to the cursor's line). */
  private nativeLogical(core: Core): number {
    const lines = core.buffers.normal.lines;
    const end = this.cursorRow(core);
    let n = 0;
    for (let i = this.segRowCount + this.nativePartial(core); i <= end && i < lines.length; i++) if (!lines.get(i)?.isWrapped) n++;
    return n;
  }

  /** Buffer row where native line `k` (0 = first full native line) starts. */
  private rowOfNative(core: Core, k: number): number {
    const lines = core.buffers.normal.lines;
    let n = -1;
    for (let i = this.segRowCount + this.nativePartial(core); i < lines.length; i++) {
      if (!lines.get(i)?.isWrapped && ++n === k) return i;
    }
    return lines.length - 1;
  }

  private rowOfSegLine(k: number): number {
    let row = 0;
    for (let i = 0; i < k && this.seg && i < this.seg.rows.length; i++) row += this.seg.rows[i];
    return row;
  }

  /** History line at the top of the view. */
  private viewLine(core: Core, total: number): number {
    return this.lineAtRow(core, core.buffers.normal.ydisp, total);
  }

  /** History line of the logical line holding buffer row `row`. */
  private lineAtRow(core: Core, row: number, total: number): number {
    const buf = core.buffers.normal;
    const lines = buf.lines;
    let r = row;
    while (r > 0 && lines.get(r)?.isWrapped && r !== this.segRowCount) r--;
    if (this.seg && r < this.segRowCount) {
      let acc = 0;
      for (let i = 0; i < this.seg.rows.length; i++) {
        acc += this.seg.rows[i];
        if (r < acc) return this.seg.start + i;
      }
    }
    // Native: count lines from the row to the cursor's line, which is the last history line.
    const end = this.cursorRow(core);
    let n = lines.get(r)?.isWrapped ? 1 : 0;
    for (let i = r; i <= end && i < lines.length; i++) if (!lines.get(i)?.isWrapped) n++;
    return Math.max(0, total - n);
  }

  /**
   * Replace rows [index, index + deleteCount) with `rows`, keeping the view, the saved
   * cursor and the selection on the same content. Never touches the screen rows.
   */
  private splice(core: Core, index: number, deleteCount: number, rows: CoreLine[]): void {
    const buf = core.buffers.normal;
    const lines = buf.lines;
    const net = rows.length - deleteCount;
    const end = index + deleteCount;
    if (net > 0) lines.maxLength = Math.max(lines.maxLength, lines.length + net);
    const view = buf.ydisp;
    const sel = core._selectionService?._model;
    const ys = [sel?.selectionStart?.[1], sel?.selectionEnd?.[1]].filter((y): y is number => y !== undefined);
    const selLo = ys.length ? Math.min(...ys) : -1;
    const selHi = ys.length ? Math.max(...ys) : -1;
    if (deleteCount > 0) lines.splice(index, deleteCount);
    // Large inserts go in slices: spreading tens of thousands of arguments can overflow the stack.
    for (let i = 0; i < rows.length; i += 4096) lines.splice(index + i, 0, ...rows.slice(i, i + 4096));
    buf.ybase += net;
    if (view >= end) buf.ydisp = view + net;
    else if (view >= index) buf.ydisp = index;
    buf.ydisp = Math.max(0, Math.min(buf.ydisp, buf.ybase));
    if (buf.savedY >= end) buf.savedY += net;
    if (sel && ys.length) {
      if (deleteCount > 0 && selHi >= index && selLo < end) sel.clearSelection();
      else {
        if (sel.selectionStart && sel.selectionStart[1] >= end) sel.selectionStart[1] += net;
        if (sel.selectionEnd && sel.selectionEnd[1] >= end) sel.selectionEnd[1] += net;
      }
    }
  }

  /** Drop `count` rows from the top of the buffer (ours, not output's). */
  private dropTop(core: Core, count: number): void {
    if (count <= 0) return;
    const buf = core.buffers.normal;
    this.selfTrim = true;
    try {
      buf.lines.trimStart(count);
    } finally {
      this.selfTrim = false;
    }
    buf.ybase = Math.max(0, buf.ybase - count);
    buf.ydisp = Math.max(0, buf.ydisp - count);
    buf.savedY = Math.max(0, buf.savedY - count);
  }

  private synced(core: Core): void {
    this.loads++;
    core.viewport?.syncScrollArea(true);
    core.refresh(0, this.term.rows - 1);
    this.schedulePaint();
    this.loadedListeners.forEach((l) => l());
  }

  // ---------------------------------------------------------------- loading

  private async run(op: () => Promise<void>): Promise<void> {
    if (this.busy || Date.now() < this.retryAt) return;
    this.busy = true;
    const before = this.loads;
    try {
      await op();
    } catch {
      // History unavailable (closed pane, turned off): xterm.js's own scrollback still works.
    } finally {
      this.busy = false;
      if (this.pendingJump !== null && !this.disposed) {
        const l = this.pendingJump;
        this.pendingJump = null;
        void this.run(() => this.jumpTo(l));
      } else if (this.loads !== before) {
        // Something was loaded: the view may still be near an edge.
        this.check();
      } else {
        // Nothing to load (no history, not aligned yet, at line 1): try again only after a
        // pause, not on every frame.
        this.retryAt = Date.now() + 1000;
      }
    }
  }

  /** Logical lines at the top of the native part, for aligning with the history. */
  private topSignature(core: Core): string[] {
    const lines = core.buffers.normal.lines;
    const sig: string[] = [];
    let i = this.segRowCount + this.nativePartial(core);
    while (i < lines.length && sig.length < SIG_LINES) {
      let text = lines.get(i)?.translateToString(true) ?? "";
      i++;
      while (i < lines.length && lines.get(i)?.isWrapped) {
        text += lines.get(i)?.translateToString(true) ?? "";
        i++;
      }
      sig.push(lineKey(text));
    }
    // Blank lines match too many places; keep the signature only if it says something.
    return sig.some((s) => s.trim() !== "") ? sig : [];
  }

  private async align(core: Core): Promise<number | null> {
    const info = await this.refreshInfo(true);
    if (!info) return null;
    const total = info.end + info.tail;
    const sig = this.topSignature(core);
    if (sig.length === 0) return null;
    const logical = this.nativeLogical(core);
    const hint = Math.max(info.first, total - logical);
    const found = await backend.historyLocate(this.paneId, sig, hint, Math.max(5000, logical * 2));
    const no = found === null ? null : liveNumber(found, info);
    if (no !== null) this.opts.onAligned?.(this.segRowCount + this.nativePartial(core), no);
    return found;
  }

  private async ensureAnchor(core: Core): Promise<number | null> {
    if (this.anchor === null) this.anchor = await this.align(core);
    return this.anchor;
  }

  private async fetch(from: number, to: number): Promise<HistoryPage | null> {
    if (to <= from) return null;
    const page = await backend.historyLines(this.paneId, from, to - from);
    if (!page || page.first !== from || page.lines.length !== to - from) return null;
    return page;
  }

  /** Lines rendered into rows at the pane's width, and how many rows each took. */
  private render(page: HistoryPage): { rows: CoreLine[]; perLine: number[] } | null {
    const cols = this.term.cols;
    if (!this.scratch || this.scratch.cols !== cols) {
      this.scratch?.dispose();
      this.scratch = null;
      const ctor = this.term.constructor as new (o: object) => Terminal;
      this.scratch = new ctor({ cols, rows: 1, scrollback: 0, allowProposedApi: true });
      try {
        this.scratch.unicode.activeVersion = this.term.unicode.activeVersion;
      } catch {
        // version not registered on the scratch terminal: default widths
      }
    }
    const ansi = linesToAnsi(page.lines, page.styles, this.opts.clearedLabel);
    const scratch = this.scratch;
    const sc = coreOf(scratch);
    if (!sc) return null;
    scratch.reset();
    // Room for every row: wide characters take two columns.
    scratch.options.scrollback = Math.ceil((ansi.length * 2) / Math.max(1, cols)) + page.lines.length + 16;
    (scratch as unknown as { _core: { writeSync?: (d: string) => void } })._core.writeSync?.(ansi);
    const buf = sc.buffers.normal;
    const used = buf.ybase + buf.y;
    const rows: CoreLine[] = [];
    const perLine: number[] = [];
    for (let i = 0; i < used; i++) {
      const l = buf.lines.get(i) as (CoreLine & { clone?: () => CoreLine }) | undefined;
      if (!l?.clone) return null;
      if (l.isWrapped && perLine.length) perLine[perLine.length - 1]++;
      else perLine.push(1);
      rows.push(l.clone());
    }
    return perLine.length === page.lines.length ? { rows, perLine } : null;
  }

  private stamps(page: HistoryPage, perLine: number[], at: number): void {
    if (!this.opts.onInserted) return;
    const out: { line: number; no: number; time: number }[] = [];
    let row = at;
    perLine.forEach((n, k) => {
      out.push({ line: row, no: page.lines[k].no, time: page.lines[k].ts });
      row += n;
    });
    this.opts.onInserted(out);
  }

  /** The view nears the top of the buffer: load the lines above it. */
  private async loadAbove(): Promise<void> {
    const core = coreOf(this.term);
    if (!core) return;
    const gen = this.gen;
    const info = await this.refreshInfo(true);
    const anchor = await this.ensureAnchor(core);
    if (!info || anchor === null || gen !== this.gen) return;
    const seg = this.seg;
    const top = seg ? seg.start : anchor;
    // A cut first line is loaded again, whole.
    const to = top + (seg?.cut ? 1 : 0);
    const from = Math.max(info.first, top - FETCH_LINES);
    if (from >= to) return;
    const page = await this.fetch(from, to);
    if (!page || gen !== this.gen || this.seg !== seg || this.term.buffer.active.type !== "normal") return;
    const r = this.render(page);
    if (!r) return;
    const del = seg ? (seg.cut ? seg.rows[0] : 0) : this.nativePartial(core);
    this.splice(core, 0, del, r.rows);
    const rest = seg ? seg.rows.slice(seg.cut ? 1 : 0) : [];
    this.seg = { start: page.first, rows: [...r.perLine, ...rest], cut: false };
    this.segRowCount = this.seg.rows.reduce((a, b) => a + b, 0);
    this.stamps(page, r.perLine, 0);
    this.shrinkBelow(core);
    this.synced(core);
  }

  /** The view nears the bottom of the segment and lines are missing below it: load them. */
  private async loadBelow(): Promise<void> {
    const core = coreOf(this.term);
    const seg = this.seg;
    const anchor = this.anchor;
    if (!core || !seg || anchor === null) return;
    const gen = this.gen;
    const from = this.segEnd();
    const to = Math.min(anchor, from + FETCH_LINES);
    const page = await this.fetch(from, to);
    if (!page || gen !== this.gen || this.seg !== seg || this.term.buffer.active.type !== "normal") return;
    const r = this.render(page);
    if (!r) return;
    const at = this.segRowCount;
    // Reaching the native part: its cut first rows belong to the line now loaded whole.
    const del = to === anchor ? this.nativePartial(core) : 0;
    this.splice(core, at, del, r.rows);
    seg.rows.push(...r.perLine);
    this.segRowCount += r.rows.length;
    this.stamps(page, r.perLine, at);
    this.shrinkAbove(core);
    this.synced(core);
  }

  /** Drop segment lines far below the view (the view is near the top). */
  private shrinkBelow(core: Core): void {
    const seg = this.seg;
    if (!seg || this.segRowCount <= MAX_SEG_ROWS) return;
    const keepTo = core.buffers.normal.ydisp + this.term.rows * 3;
    let drop = 0;
    let lines = 0;
    while (this.segRowCount - drop > MAX_SEG_ROWS && lines < seg.rows.length - 1) {
      const n = seg.rows[seg.rows.length - 1 - lines];
      if (this.segRowCount - drop - n < keepTo) break;
      drop += n;
      lines++;
    }
    if (!drop) return;
    this.splice(core, this.segRowCount - drop, drop, []);
    seg.rows.length -= lines;
    this.segRowCount -= drop;
  }

  /** Drop segment lines far above the view (the view is near the segment's bottom). */
  private shrinkAbove(core: Core): void {
    const seg = this.seg;
    if (!seg || this.segRowCount <= MAX_SEG_ROWS) return;
    const keepFrom = core.buffers.normal.ydisp - this.term.rows * 2;
    let drop = 0;
    let lines = 0;
    while (this.segRowCount - drop > MAX_SEG_ROWS && lines < seg.rows.length - 1) {
      const n = seg.rows[lines];
      if (drop + n > keepFrom) break;
      drop += n;
      lines++;
    }
    if (!drop) return;
    this.dropTop(core, drop);
    seg.rows.splice(0, lines);
    seg.start += lines;
    seg.cut = false;
    this.segRowCount -= drop;
  }

  /** Buffer row where history line `line` starts, if it is loaded. */
  private rowOfLine(core: Core, line: number): number | null {
    const seg = this.seg;
    if (seg && line >= seg.start + (seg.cut ? 1 : 0) && line < this.segEnd()) return this.rowOfSegLine(line - seg.start);
    const info = this.info;
    if (!info) return null;
    const nativeStart = this.anchor ?? info.end + info.tail - this.nativeLogical(core);
    if (line < nativeStart) return null;
    const row = this.rowOfNative(core, line - nativeStart);
    return row <= this.cursorRow(core) ? row : null;
  }

  /** Show history line `line` at the top of the view, loading it when needed. */
  private async jumpTo(line: number): Promise<void> {
    const core = coreOf(this.term);
    if (!core || this.term.buffer.active.type !== "normal") return;
    const gen = this.gen;
    const info = await this.refreshInfo(true);
    if (!info || gen !== this.gen) return;
    const total = info.end + info.tail;
    const l = Math.max(info.first, Math.min(line, total - 1));
    // Exact positions need the alignment (estimating from line counts is off after a reconnect).
    await this.ensureAnchor(core);
    if (gen !== this.gen) return;
    const nativeStart = this.anchor ?? total - this.nativeLogical(core);
    if (l >= nativeStart) {
      this.term.scrollToLine(this.rowOfNative(core, l - nativeStart));
      this.loads++;
      return;
    }
    const seg = this.seg;
    if (seg && l >= seg.start + (seg.cut ? 1 : 0) && l < this.segEnd()) {
      this.term.scrollToLine(this.rowOfSegLine(l - seg.start));
      this.loads++;
      return;
    }
    const anchor = await this.ensureAnchor(core);
    if (anchor === null || gen !== this.gen) return;
    if (l >= anchor) {
      this.term.scrollToLine(this.rowOfNative(core, l - anchor));
      this.loads++;
      return;
    }
    // Somewhere not loaded: a new window around the line replaces the segment.
    const from = Math.max(info.first, l - Math.floor(JUMP_LINES / 4));
    const to = Math.min(anchor, from + JUMP_LINES);
    const page = await this.fetch(from, to);
    if (!page || gen !== this.gen || this.seg !== seg || this.term.buffer.active.type !== "normal") return;
    const r = this.render(page);
    if (!r) return;
    const del = this.segRowCount + (to === anchor ? this.nativePartial(core) : 0);
    this.splice(core, 0, del, r.rows);
    this.seg = { start: page.first, rows: r.perLine, cut: false };
    this.segRowCount = r.rows.length;
    this.stamps(page, r.perLine, 0);
    this.synced(core);
    this.term.scrollToLine(this.rowOfSegLine(l - page.first));
  }

  /** Back at the bottom: drop the segment and give the scrollback its own limit again. */
  private release(): void {
    const core = coreOf(this.term);
    const buf = this.term.buffer.active;
    if (!core || this.busy || buf.type !== "normal" || buf.viewportY < buf.baseY) return;
    const nb = core.buffers.normal;
    this.dropTop(core, this.segRowCount);
    this.seg = null;
    this.segRowCount = 0;
    const limit = this.limit();
    // Output that came in while scrolled up grew the native part past the limit.
    const extra = nb.lines.length - limit;
    if (extra > 0) {
      this.dropTop(core, extra);
      this.anchor = null;
    }
    nb.lines.maxLength = Math.max(limit, nb.lines.length);
    this.gen++;
    this.synced(core);
  }

  // ---------------------------------------------------------------- scrollbar

  private schedulePaint(): void {
    if (this.frame || this.disposed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.paintBar();
    });
  }

  private ensureBar(): boolean {
    const el = this.term.element;
    if (!el) return false;
    if (!this.track || this.track.parentElement !== el) {
      this.track?.remove();
      const track = document.createElement("div");
      track.className = "hist-bar";
      const canvas = document.createElement("canvas");
      canvas.className = "hist-bar-marks";
      const thumb = document.createElement("div");
      thumb.className = "hist-bar-thumb";
      track.append(canvas, thumb);
      this.canvas = canvas;
      this.drawnHeight = -1;
      track.addEventListener("mousedown", this.onTrackDown);
      thumb.addEventListener("mousedown", this.onThumbDown);
      el.appendChild(track);
      this.track = track;
      this.thumb = thumb;
    }
    return true;
  }

  private showBar(show: boolean): void {
    this.term.element?.classList.toggle("hist-bar-on", show);
    if (this.track) this.track.style.display = show ? "block" : "none";
  }

  /**
   * The viewport's height and top, measured when the terminal resizes (or the bar is
   * created), not on every frame: reading layout while output streams forces a reflow.
   */
  private vpBox: { top: number; height: number } | null = null;

  private viewportBox(): { top: number; height: number } | null {
    if (!this.vpBox) {
      const vp = this.term.element?.querySelector(".xterm-viewport") as HTMLElement | null;
      if (!vp || !vp.clientHeight) return null;
      this.vpBox = { top: vp.offsetTop, height: vp.clientHeight };
    }
    return this.vpBox;
  }

  /** Geometry of the bar: total lines, first line, track height and thumb height. */
  private geometry(): { total: number; first: number; span: number; track: number; thumb: number } | null {
    const info = this.info;
    const vp = this.viewportBox();
    if (!info || !vp) return null;
    const total = info.end + info.tail;
    const span = total - info.first;
    if (span <= this.term.rows) return null;
    const track = vp.height;
    const thumb = Math.max(MIN_THUMB, Math.min(track, (track * this.term.rows) / span));
    return { total, first: info.first, span, track, thumb };
  }

  /** What the last paint drew; a frame with the same inputs is skipped. */
  private painted = "";

  private paintBar(): void {
    const core = coreOf(this.term);
    const buf = this.term.buffer.active;
    const g = this.geometry();
    const key = g ? `${g.total}|${g.first}|${g.track}|${buf.type}|${buf.viewportY}|${buf.baseY}|${this.drag ? 1 : 0}|${this.drawnHeight}` : "";
    if (key && key === this.painted && this.track?.parentElement === this.term.element) return;
    this.painted = key;
    if (!core || !g || buf.type !== "normal" || !this.ensureBar()) {
      this.showBar(false);
      return;
    }
    this.showBar(true);
    this.track!.style.top = `${this.vpBox!.top}px`;
    this.track!.style.height = `${g.track}px`;
    this.thumb!.style.height = `${g.thumb}px`;
    if (Math.round(g.track) !== this.drawnHeight) {
      this.drawMarks(false);
      // Slots follow the track's height: ask again for the new size.
      if ([...this.layers.values()].some((s) => s.layer.specs?.length && s.slots !== this.slotCount())) this.scheduleMarks(100, true);
    }
    if (this.drag) return;
    const atBottom = buf.viewportY >= buf.baseY;
    const frac = atBottom ? 1 : Math.min(1, Math.max(0, (this.viewLine(core, g.total) - g.first) / Math.max(1, g.span - this.term.rows)));
    this.thumb!.style.top = `${(g.track - g.thumb) * frac}px`;
  }

  // ---------------------------------------------------------------- marks

  /** Slots the bar is split into: one per pixel of the track. */
  private slotCount(): number {
    return Math.max(1, Math.min(4000, Math.round(this.viewportBox()?.height ?? 1)));
  }

  /** `reset`: a layer changed (start over now); otherwise new output (no sooner than `delay`). */
  private scheduleMarks(delay: number, reset: boolean): void {
    if (![...this.layers.values()].some((s) => s.layer.specs?.length)) return;
    if (this.marksTimer && !reset) return;
    window.clearTimeout(this.marksTimer);
    this.marksTimer = window.setTimeout(() => {
      this.marksTimer = 0;
      void this.loadMarks();
    }, delay);
  }

  private async loadMarks(): Promise<void> {
    if (this.marksBusy) {
      this.marksDirty = true;
      return;
    }
    const entries = [...this.layers.entries()].filter(([, s]) => s.layer.specs?.length);
    if (!entries.length) return;
    const slots = this.slotCount();
    const specs = entries.flatMap(([, s]) => s.layer.specs!);
    this.marksBusy = true;
    try {
      const res = await backend.historyMarks(this.paneId, specs, slots);
      if (!res) return;
      this.marksTotal = res.total;
      let k = 0;
      for (const [id, s] of entries) {
        const n = s.layer.specs!.length;
        // The layer may have changed while the request ran: its results are stale then.
        if (this.layers.get(id) !== s) {
          k += n;
          continue;
        }
        s.marks = res.buckets.slice(k, k + n);
        s.slots = slots;
        s.layer.onResult?.({ counts: res.counts.slice(k, k + n), errors: res.errors.slice(k, k + n) });
        k += n;
      }
    } catch (e) {
      for (const [, s] of entries) s.layer.onResult?.({ counts: [], errors: s.layer.specs!.map(() => String(e)) });
    } finally {
      this.marksBusy = false;
      this.drawMarks(true);
      if (this.marksDirty) {
        this.marksDirty = false;
        this.scheduleMarks(30, true);
      }
    }
  }

  private drawMarks(force: boolean): void {
    const canvas = this.canvas;
    const g = this.geometry();
    if (!canvas || !g) return;
    const h = Math.round(g.track);
    if (!force && h === this.drawnHeight) return;
    this.drawnHeight = h;
    const dpr = window.devicePixelRatio || 1;
    const w = 14;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const x = { left: [1, 4], right: [9, 4], full: [1, 12] } as const;
    for (const s of this.layers.values()) {
      const [x0, width] = x[s.layer.position];
      s.marks.forEach((slots, j) => {
        ctx.fillStyle = s.layer.colors?.[j] ?? "#d4a017";
        const per = h / Math.max(1, s.slots);
        for (const b of slots) ctx.fillRect(x0, Math.min(h - 2, b * per), width, Math.max(2, per));
      });
      if (s.layer.lines?.length) {
        ctx.fillStyle = s.layer.lineColor ?? "#888888";
        const span = Math.max(1, g.total - g.first);
        for (const l of s.layer.lines) ctx.fillRect(x0, Math.min(h - 2, ((l - g.first) / span) * h), width, 2);
      }
    }
  }

  /** The history line for a thumb top at `y` (pixels in the track). */
  private lineAt(y: number): number | null {
    const g = this.geometry();
    if (!g) return null;
    const frac = Math.min(1, Math.max(0, y / Math.max(1, g.track - g.thumb)));
    return g.first + Math.round(frac * Math.max(0, g.span - this.term.rows));
  }

  private requestJump(line: number | null): void {
    if (line === null) return;
    if (this.busy) {
      this.pendingJump = line;
      return;
    }
    void this.run(() => this.jumpTo(line));
  }

  private readonly onThumbDown = (e: MouseEvent): void => {
    if (e.button !== 0 || !this.thumb) return;
    e.preventDefault();
    e.stopPropagation();
    this.drag = { offset: e.clientY - this.thumb.getBoundingClientRect().top };
    window.addEventListener("mousemove", this.onDragMove);
    window.addEventListener("mouseup", this.onDragEnd);
  };

  private readonly onDragMove = (e: MouseEvent): void => {
    const g = this.geometry();
    if (!this.drag || !this.track || !this.thumb || !g) return;
    const y = Math.min(g.track - g.thumb, Math.max(0, e.clientY - this.track.getBoundingClientRect().top - this.drag.offset));
    this.thumb.style.top = `${y}px`;
    this.requestJump(this.lineAt(y));
  };

  private readonly onDragEnd = (): void => {
    window.removeEventListener("mousemove", this.onDragMove);
    window.removeEventListener("mouseup", this.onDragEnd);
    const y = this.thumb ? parseFloat(this.thumb.style.top) || 0 : 0;
    this.drag = null;
    this.requestJump(this.lineAt(y));
  };

  /** A click on the track: center the thumb there. */
  private readonly onTrackDown = (e: MouseEvent): void => {
    if (e.button !== 0 || e.target !== this.track || !this.track) return;
    e.preventDefault();
    e.stopPropagation();
    const g = this.geometry();
    if (!g) return;
    this.requestJump(this.lineAt(e.clientY - this.track.getBoundingClientRect().top - g.thumb / 2));
  };
}
