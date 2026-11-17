import type { IBuffer, IDisposable, IMarker, Terminal } from "@xterm/xterm";
import type { SerializeAddon } from "@xterm/addon-serialize";
import { logicalStart } from "./inputTracker";
import type { LineStamp } from "./timestampGutter";

/**
 * WindTerm-style output folding: every command's output can be folded under its prompt
 * line. xterm.js cannot hide rows, so folding really rewrites the buffer: the output is
 * serialized (colors kept), replaced by one placeholder line, and written back when the
 * fold is opened. Markers that live in the buffer (command starts, timestamps) are moved
 * along.
 */

interface Fold {
  marker: IMarker;
  /** Serialized rows that were folded away. */
  hidden: string;
  /** Rows they took. */
  rows: number;
  /** Timestamps (and line numbers) of the hidden rows, by row offset. */
  stamps: (Omit<LineStamp, "line"> & { offset: number })[];
}

export interface FoldHost {
  /** Timestamps of the buffer, to carry them through a rewrite. */
  exportStamps?: () => LineStamp[];
  importStamps?: (stamps: LineStamp[], cursorLine: number) => void;
  /** Called when the buffer was rewritten: absolute old row -> new row. */
  onRemap?: (map: (line: number) => number) => void;
  placeholder: (rows: number, command: string) => string;
  tooltip: { fold: string; unfold: string; wrapped: string };
}

interface Replacement {
  /** Old rows [start, end) are replaced. */
  start: number;
  end: number;
  content: string;
  rows: number;
  /** Called with the new row of the replacement's first line. */
  placed: (newLine: number) => void;
}

/** Terminal width of a character: 2 for CJK / full-width, else 1. */
function charWidth(ch: string): number {
  return /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
}

/** Cut text with SGR sequences to `max` columns (escape sequences take no room). */
export function clipAnsi(text: string, max: number): string {
  let out = "";
  let width = 0;
  for (let i = 0; i < text.length; ) {
    const esc = /^\x1b\[[0-9;]*[A-Za-z]/.exec(text.slice(i));
    if (esc) {
      out += esc[0];
      i += esc[0].length;
      continue;
    }
    const ch = String.fromCodePoint(text.codePointAt(i)!);
    const w = charWidth(ch);
    if (width + w > max) break;
    out += ch;
    width += w;
    i += ch.length;
  }
  return out;
}

export class OutputFolder implements IDisposable {
  private commands: IMarker[] = [];
  private folds: Fold[] = [];
  private rowsEls: HTMLDivElement[] = [];
  private frame = 0;
  private busy = false;
  private foldMarks = true;
  private wrapMarks = false;
  private readonly subs: IDisposable[];

  constructor(
    private readonly term: Terminal,
    private readonly serializer: SerializeAddon,
    private readonly host: HTMLDivElement,
    private readonly cb: FoldHost
  ) {
    this.subs = [
      term.onRender(() => this.schedule()),
      term.onResize(() => this.schedule()),
      term.buffer.onBufferChange(() => this.schedule()),
      term.parser.registerOscHandler(133, (data) => {
        // Shell integration: OSC 133;A marks the start of every prompt.
        if (data.startsWith("A")) {
          const buf = term.buffer.normal;
          if (term.buffer.active.type === "normal") this.markCommand(buf.baseY + buf.cursorY);
        }
        return false;
      }),
    ];
    host.addEventListener("mousedown", (e) => e.stopPropagation());
    host.addEventListener("click", (e) => {
      if (this.busy) return;
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-row]");
      if (!el) return;
      const index = this.rowsEls.indexOf(el as HTMLDivElement);
      if (index < 0) return;
      const row = this.term.buffer.active.viewportY + index;
      if (this.isFoldedAt(row)) this.unfoldAt(row);
      else if (this.canFoldAt(row)) this.foldAt(row);
    });
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.subs.forEach((s) => s.dispose());
    this.commands.forEach((m) => m.dispose());
    this.folds.forEach((f) => f.marker.dispose());
    this.host.replaceChildren();
  }

  setVisible(fold: boolean, wrap: boolean): void {
    this.foldMarks = fold;
    this.wrapMarks = wrap;
    this.host.style.display = fold || wrap ? "block" : "none";
    this.schedule();
  }

  private get buf(): IBuffer {
    return this.term.buffer.normal;
  }

  private cursorLine(): number {
    return this.buf.baseY + this.buf.cursorY;
  }

  private live<T extends { isDisposed: boolean }>(list: T[]): T[] {
    return list.filter((m) => !m.isDisposed);
  }

  /** A command (its prompt line) starts at absolute row `line`. */
  markCommand(line: number): void {
    if (this.busy || this.term.buffer.active.type !== "normal") return;
    const start = logicalStart(this.buf, line);
    this.commands = this.live(this.commands);
    if (this.commands.some((m) => m.line === start)) return;
    const marker = this.term.registerMarker(start - this.cursorLine());
    if (!marker) return;
    this.commands.push(marker);
    this.commands.sort((a, b) => a.line - b.line);
    this.schedule();
  }

  /** Last row of the logical line starting at `row`. */
  private lineEnd(row: number): number {
    let r = row;
    while (this.buf.getLine(r + 1)?.isWrapped) r++;
    return r;
  }

  /** Output rows [start, end) of the command whose prompt is at `cmdLine`. */
  private outputOf(cmdLine: number): { start: number; end: number } | null {
    const cmds = this.live(this.commands).map((m) => m.line);
    const i = cmds.indexOf(cmdLine);
    if (i < 0) return null;
    const start = this.lineEnd(cmdLine) + 1;
    const end = i + 1 < cmds.length ? cmds[i + 1] : logicalStart(this.buf, this.cursorLine());
    if (end <= start) return null;
    // Already folded: just the placeholder is left.
    if (end - start === 1 && this.folds.some((f) => !f.marker.isDisposed && f.marker.line === start)) return null;
    return { start, end };
  }

  /** The command block containing `row` (its prompt line), for the context menu. */
  commandAt(row: number): number | null {
    const cmds = this.live(this.commands).map((m) => m.line);
    let found: number | null = null;
    for (const c of cmds) if (c <= row) found = c;
    return found;
  }

  canFoldAt(row: number): boolean {
    const c = this.commandAt(row);
    return c !== null && this.term.buffer.active.type === "normal" && Boolean(this.outputOf(c));
  }

  hasFolds(): boolean {
    this.folds = this.folds.filter((f) => !f.marker.isDisposed);
    return this.folds.length > 0;
  }

  hasFoldable(): boolean {
    return this.live(this.commands).some((m) => this.outputOf(m.line));
  }

  /** Fold the output of the command at (or above) `row`. */
  foldAt(row: number): void {
    const c = this.commandAt(row);
    if (c === null) return;
    const out = this.outputOf(c);
    if (out) this.applyFolds([{ cmd: c, ...out }], row);
  }

  foldAll(): void {
    const blocks = this.live(this.commands)
      .map((m) => ({ cmd: m.line, out: this.outputOf(m.line) }))
      .filter((b): b is { cmd: number; out: { start: number; end: number } } => Boolean(b.out))
      .map((b) => ({ cmd: b.cmd, ...b.out }));
    if (blocks.length) this.applyFolds(blocks, null);
  }

  unfoldAt(row: number): void {
    const fold = this.folds.find((f) => !f.marker.isDisposed && f.marker.line === row);
    if (fold) this.applyUnfolds([fold], row);
  }

  unfoldAll(): void {
    const folds = this.folds.filter((f) => !f.marker.isDisposed);
    if (folds.length) this.applyUnfolds(folds, null);
  }

  /** The fold whose placeholder is at `row`, if any (context menu). */
  isFoldedAt(row: number): boolean {
    return this.folds.some((f) => !f.marker.isDisposed && f.marker.line === row);
  }

  private commandText(cmdLine: number): string {
    let text = "";
    for (let r = cmdLine; r <= this.lineEnd(cmdLine); r++) text += this.buf.getLine(r)?.translateToString(r === this.lineEnd(cmdLine)) ?? "";
    return text.trim();
  }

  private applyFolds(blocks: { cmd: number; start: number; end: number }[], keepRow: number | null): void {
    if (this.term.buffer.active.type !== "normal") return;
    const stamps = this.cb.exportStamps?.() ?? [];
    const reps: Replacement[] = blocks.map((b) => {
      const rows = b.end - b.start;
      const hidden = this.serializeRows(b.start, b.end - 1);
      const hiddenStamps = stamps.filter((s) => s.line >= b.start && s.line < b.end).map(({ line, ...rest }) => ({ ...rest, offset: line - b.start }));
      return {
        start: b.start,
        end: b.end,
        rows: 1,
        // Exactly one row: a wrapped placeholder would shift every row below it.
        content: `\x1b[0m${clipAnsi(this.cb.placeholder(rows, this.commandText(b.cmd)), this.term.cols - 1)}\x1b[0m`,
        placed: (line) => this.pendingFolds.push({ line, hidden, rows, stamps: hiddenStamps }),
      };
    });
    this.rebuild(reps, keepRow, stamps);
  }

  private applyUnfolds(folds: Fold[], keepRow: number | null): void {
    if (this.term.buffer.active.type !== "normal") return;
    const stamps = this.cb.exportStamps?.() ?? [];
    const reps: Replacement[] = folds
      .map((f) => ({
        start: f.marker.line,
        end: f.marker.line + 1,
        rows: f.rows,
        content: f.hidden,
        placed: (line: number) => {
          f.stamps.forEach((s) => this.pendingStamps.push({ line: line + s.offset, time: s.time, no: s.no, abs: s.abs }));
        },
      }))
      .sort((a, b) => a.start - b.start);
    const gone = new Set(folds);
    this.folds = this.folds.filter((f) => !gone.has(f));
    folds.forEach((f) => f.marker.dispose());
    this.rebuild(reps, keepRow, stamps);
  }

  private pendingFolds: { line: number; hidden: string; rows: number; stamps: Fold["stamps"] }[] = [];
  private pendingStamps: LineStamp[] = [];

  /**
   * Rows a..b (inclusive, whole logical lines) as text with escape sequences, one CRLF
   * between logical lines, so writing it back gives the same rows.
   */
  private serializeRows(a: number, b: number): string {
    if (b < a) return "";
    // The addon drops trailing blank rows of ranges that start on the last screen;
    // serialize those line by line so every row survives.
    const tail = this.buf.length - this.term.rows;
    let split = a;
    while (split <= b && split < tail) split = this.lineEnd(split) + 1;
    const parts: string[] = [];
    if (split > a) parts.push(this.serializer.serialize({ range: { start: a, end: split - 1 }, excludeModes: true, excludeAltBuffer: true }));
    for (let r = split; r <= b; r = this.lineEnd(r) + 1) {
      parts.push(this.serializer.serialize({ range: { start: r, end: this.lineEnd(r) }, excludeModes: true, excludeAltBuffer: true }));
    }
    return parts.map((p) => `\x1b[0m${p}`).join("\r\n");
  }

  private lastContentRow(): number {
    for (let r = this.buf.length - 1; r > 0; r--) {
      if ((this.buf.getLine(r)?.translateToString(true) ?? "") !== "") return r;
    }
    return 0;
  }

  private rebuild(reps: Replacement[], keepRow: number | null, stamps: LineStamp[]): void {
    const cursor = this.cursorLine();
    const cursorX = this.buf.cursorX;
    const last = Math.max(this.lineEnd(logicalStart(this.buf, cursor)), this.lastContentRow());
    const sorted = [...reps].sort((a, b) => a.start - b.start);

    // Old row -> new row.
    const map = (line: number): number => {
      let shift = 0;
      for (const r of sorted) {
        if (line < r.start) break;
        if (line < r.end) return r.start + shift;
        shift += r.rows - (r.end - r.start);
      }
      return line + shift;
    };

    let out = "\x1b[0m\x1b[H\x1b[2J\x1b[3J";
    let pos = 0;
    const pieces: string[] = [];
    for (const r of sorted) {
      if (r.start > pos) pieces.push(this.serializeRows(pos, r.start - 1));
      pieces.push(r.content);
      pos = r.end;
    }
    if (pos <= last) pieces.push(this.serializeRows(pos, last));
    out += pieces.join("\r\n");
    const below = map(last) - map(cursor);
    out += "\r" + (below > 0 ? `\x1b[${below}A` : "") + (cursorX > 0 ? `\x1b[${cursorX}C` : "");

    const commandLines = this.live(this.commands).map((m) => m.line);
    const foldLines = this.folds.filter((f) => !f.marker.isDisposed).map((f) => ({ f, line: f.marker.line }));
    const viewTop = keepRow ?? null;

    this.busy = true;
    this.pendingFolds = [];
    this.pendingStamps = [];
    this.term.write(out, () => {
      // Markers are placed relative to the cursor row.
      const now = this.cursorLine();
      const at = (line: number) => this.term.registerMarker(line - now);
      this.commands.forEach((m) => m.dispose());
      this.commands = commandLines.map((l) => at(map(l))).filter((m): m is IMarker => Boolean(m));
      for (const { f, line } of foldLines) {
        f.marker.dispose();
        const m = at(map(line));
        if (m) f.marker = m;
      }
      this.folds = this.folds.filter((f) => !f.marker.isDisposed);
      sorted.forEach((r) => r.placed(map(r.start)));
      for (const p of this.pendingFolds) {
        const m = at(p.line);
        if (m) this.folds.push({ marker: m, hidden: p.hidden, rows: p.rows, stamps: p.stamps });
      }
      const moved = stamps
        .filter((s) => !sorted.some((r) => s.line >= r.start && s.line < r.end))
        .map((s) => ({ ...s, line: map(s.line) }))
        .concat(this.pendingStamps);
      this.cb.importStamps?.(moved, now);
      this.cb.onRemap?.(map);
      this.busy = false;
      if (viewTop !== null) this.term.scrollToLine(Math.max(0, map(viewTop) - Math.floor(this.term.rows / 3)));
      cancelAnimationFrame(this.frame);
      this.frame = 0;
      this.paint();
    });
  }

  // ------------------------------------------------------------ margin

  private schedule(): void {
    if (this.host.style.display === "none") return;
    // Called on every rendered frame while output streams: keep the frame already requested.
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.paint();
    });
  }

  private paint(): void {
    const screen = this.term.element?.querySelector(".xterm-screen") as HTMLElement | null;
    if (!screen) return;
    const rowHeight = screen.clientHeight / this.term.rows;
    const top = screen.getBoundingClientRect().top - this.host.getBoundingClientRect().top;
    while (this.rowsEls.length < this.term.rows) {
      const el = document.createElement("div");
      el.className = "fold-row";
      this.host.appendChild(el);
      this.rowsEls.push(el);
    }
    while (this.rowsEls.length > this.term.rows) this.rowsEls.pop()!.remove();

    const active = this.term.buffer.active;
    const normal = active.type === "normal";
    const first = active.viewportY;
    const foldable = new Set<number>();
    const folded = new Set<number>();
    if (normal && this.foldMarks && !this.busy) {
      for (const m of this.live(this.commands)) {
        if (m.line >= first && m.line < first + this.term.rows && this.outputOf(m.line)) foldable.add(m.line);
      }
      for (const f of this.folds) if (!f.marker.isDisposed) folded.add(f.marker.line);
    }
    this.rowsEls.forEach((el, i) => {
      const row = first + i;
      el.style.top = `${top + i * rowHeight}px`;
      el.style.height = `${rowHeight}px`;
      el.style.lineHeight = `${rowHeight}px`;
      el.dataset.row = String(row);
      let kind = "";
      if (folded.has(row)) kind = "unfold";
      else if (foldable.has(row)) kind = "fold";
      else if (this.wrapMarks && active.getLine(row)?.isWrapped) kind = "wrap";
      el.dataset.kind = kind;
      el.textContent = kind === "fold" ? "▾" : kind === "unfold" ? "▸" : kind === "wrap" ? "↪" : "";
      el.title = kind === "fold" ? this.cb.tooltip.fold : kind === "unfold" ? this.cb.tooltip.unfold : kind === "wrap" ? this.cb.tooltip.wrapped : "";
    });
  }
}
