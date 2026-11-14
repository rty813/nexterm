import type { IDisposable, IMarker, Terminal } from "@xterm/xterm";

/**
 * WindTerm-style timestamp margin: remembers when each line first received output
 * and paints the time beside the visible rows.
 *
 * Stamps hang off one xterm marker per block of lines, so they follow their lines
 * through scrolling and are dropped with them when scrollback is trimmed. Not one
 * marker per line: xterm visits every marker for each line it trims, so a full
 * scrollback with thousands of markers made large output many times slower.
 */
interface Block {
  /** First line of the block. */
  marker: IMarker;
  /** Stamped lines, as offsets from the marker, ascending, with their times. */
  offsets: number[];
  times: number[];
}

/** Stamps kept before the oldest are released (bounded by scrollback anyway). */
const MAX_STAMPS = 20000;
/** Lines covered by one marker. */
const BLOCK_LINES = 512;

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function formatStamp(time: number, withMs: boolean): string {
  const d = new Date(time);
  const base = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return withMs ? `${base}.${String(d.getMilliseconds()).padStart(3, "0")}` : base;
}

export class TimestampGutter implements IDisposable {
  private blocks: Block[] = [];
  private stampCount = 0;
  /** Absolute line of the last stamped row, so a write only stamps rows it reached. */
  private lastLine = -1;
  private rows: HTMLDivElement[] = [];
  private frame = 0;
  private readonly subs: IDisposable[];
  private visible = false;
  /** Output folding is rewriting the buffer: do not stamp the rows it writes. */
  private suspended = false;

  constructor(
    private readonly term: Terminal,
    private readonly host: HTMLDivElement,
    private withMs = false
  ) {
    this.subs = [
      term.onWriteParsed(() => this.stampNewLines()),
      term.onRender(() => this.schedule()),
      term.onResize(() => this.schedule()),
      term.buffer.onBufferChange(() => this.schedule()),
    ];
    this.host.style.minWidth = withMs ? "96px" : "68px";
  }

  /** Stamps are recorded all the time; this only shows / hides the margin. */
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.host.style.display = visible ? "block" : "none";
    this.schedule();
  }

  setWithMs(withMs: boolean): void {
    this.withMs = withMs;
    this.host.style.minWidth = withMs ? "96px" : "68px";
    this.schedule();
  }

  /**
   * Stamps by absolute line, for output folding. Stops stamping until importStamps:
   * the rows the fold rewrites are not new output.
   */
  exportStamps(): { line: number; time: number }[] {
    this.suspended = true;
    const out: { line: number; time: number }[] = [];
    for (const b of this.live()) b.offsets.forEach((o, i) => out.push({ line: b.marker.line + o, time: b.times[i] }));
    return out;
  }

  /** Replace every stamp after a rewrite (cursorLine = absolute cursor row now). */
  importStamps(list: { line: number; time: number }[], cursorLine: number): void {
    this.clear();
    for (const s of list.sort((a, b) => a.line - b.line)) this.add(s.line, cursorLine, s.time);
    // The cursor row is stamped when output lands there, as usual.
    this.lastLine = list.some((s) => s.line === cursorLine) ? cursorLine : cursorLine - 1;
    this.suspended = false;
    this.schedule();
  }

  /** Stamp time of an absolute buffer line, if any. */
  timeOfLine(line: number): number | undefined {
    let time: number | undefined;
    for (const b of this.live()) {
      const i = b.offsets.indexOf(line - b.marker.line);
      if (i >= 0) time = b.times[i];
    }
    return time;
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.subs.forEach((s) => s.dispose());
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
      this.stampCount = this.blocks.reduce((n, b) => n + b.offsets.length, 0);
    }
    return this.blocks;
  }

  /** Stamp absolute `line` (cursor at `cursorLine`), opening a new block when needed. */
  private add(line: number, cursorLine: number, time: number): void {
    let b = this.blocks[this.blocks.length - 1];
    const offset = b && !b.marker.isDisposed ? line - b.marker.line : -1;
    if (!b || offset < 0 || offset >= BLOCK_LINES || offset <= (b.offsets[b.offsets.length - 1] ?? -1)) {
      const marker = this.term.registerMarker(line - cursorLine);
      if (!marker) return;
      b = { marker, offsets: [], times: [] };
      this.blocks.push(b);
    }
    b.offsets.push(line - b.marker.line);
    b.times.push(time);
    this.stampCount++;
  }

  private stampNewLines(): void {
    if (this.suspended) return;
    const buf = this.term.buffer.active;
    if (buf.type !== "normal") return;
    const cursorLine = buf.baseY + buf.cursorY;
    // After a clear / reset the cursor moves back up; start over from there.
    if (cursorLine < this.lastLine) this.lastLine = cursorLine - 1;
    const now = Date.now();
    for (let line = Math.max(this.lastLine + 1, buf.baseY); line <= cursorLine; line++) {
      const bufLine = buf.getLine(line);
      // Continuation rows of a wrapped line belong to the line that started it.
      if (bufLine?.isWrapped) {
        this.lastLine = line;
        continue;
      }
      const text = bufLine?.translateToString(true) ?? "";
      // An empty cursor row is not output yet; stamp it when something lands there.
      if (line === cursorLine && text.length === 0) break;
      this.add(line, cursorLine, now);
      this.lastLine = line;
    }
    this.live();
    while (this.stampCount > MAX_STAMPS && this.blocks.length > 1) {
      const b = this.blocks.shift()!;
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

  private paint(): void {
    const buf = this.term.buffer.active;
    const screen = this.term.element?.querySelector(".xterm-screen") as HTMLElement | null;
    if (!screen) return;
    const rowHeight = screen.clientHeight / this.term.rows;
    const top = screen.getBoundingClientRect().top - this.host.getBoundingClientRect().top;

    while (this.rows.length < this.term.rows) {
      const row = document.createElement("div");
      row.className = "ts-row";
      this.host.appendChild(row);
      this.rows.push(row);
    }
    while (this.rows.length > this.term.rows) this.rows.pop()!.remove();

    const byLine = new Map<number, number>();
    if (buf.type === "normal") {
      const first = buf.viewportY;
      const last = first + this.term.rows;
      for (const b of this.live()) {
        const base = b.marker.line;
        if (base >= last || base + BLOCK_LINES <= first) continue;
        b.offsets.forEach((o, i) => {
          if (base + o >= first && base + o < last) byLine.set(base + o, b.times[i]);
        });
      }
    }
    let previous = "";
    this.rows.forEach((row, i) => {
      row.style.top = `${top + i * rowHeight}px`;
      row.style.height = `${rowHeight}px`;
      row.style.lineHeight = `${rowHeight}px`;
      const time = byLine.get(buf.viewportY + i);
      const text = time === undefined ? "" : formatStamp(time, this.withMs);
      // Repeated times are dimmed, like WindTerm, so bursts of output stay readable.
      row.textContent = text;
      row.classList.toggle("ts-repeat", text !== "" && text === previous);
      row.title = time === undefined ? "" : new Date(time).toLocaleString();
      if (text) previous = text;
    });
  }
}
