import type { IDisposable, IMarker, Terminal } from "@xterm/xterm";

/**
 * WindTerm-style line backgrounds: a band behind the line the cursor is on, and another
 * behind the line last clicked with the mouse. Translucent bands laid over the screen
 * (works with the WebGL and DOM renderers, keeps the program's own colors), covering
 * every row of a wrapped line. Not shown in full-screen programs (alternate screen).
 */

/** Rows [first, last] (absolute) of the logical line holding absolute row `row`. */
export function logicalRows(row: number, isWrapped: (line: number) => boolean, length: number): [number, number] {
  let first = row;
  while (first > 0 && isWrapped(first)) first--;
  let last = row;
  while (last + 1 < length && isWrapped(last + 1)) last++;
  return [first, last];
}

/**
 * The last row that is a line: the cursor's row, or a row below it with text (a program
 * can move the cursor up after printing). Rows past it are blank screen, not lines yet.
 */
export function lastLine(cursorRow: number, length: number, textOf: (line: number) => string): number {
  for (let r = length - 1; r > cursorRow; r--) if (textOf(r) !== "") return r;
  return cursorRow;
}

export class LineHighlight implements IDisposable {
  private current: HTMLDivElement | null = null;
  private clicked: HTMLDivElement | null = null;
  /** The clicked line, kept through scrolling and trims. */
  private clickMarker: IMarker | null = null;
  private frame = 0;
  private enabled: boolean;
  private readonly subs: IDisposable[];
  private readonly onDown = (e: MouseEvent) => this.mark(e);

  constructor(private readonly term: Terminal, enabled = true) {
    this.enabled = enabled;
    this.subs = [
      // Not onCursorMove / onScroll, which fire about once per line of output: a cursor
      // move or a scroll renders, so onRender (once per frame) covers both.
      term.onRender(() => this.schedule()),
      term.onResize(() => this.schedule()),
      term.buffer.onBufferChange(() => this.schedule()),
    ];
    term.element?.addEventListener("mousedown", this.onDown);
    this.schedule();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.schedule();
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.subs.forEach((s) => s.dispose());
    this.term.element?.removeEventListener("mousedown", this.onDown);
    this.clickMarker?.dispose();
    this.current?.remove();
    this.clicked?.remove();
  }

  private mark(e: MouseEvent): void {
    if (e.button !== 0) return;
    const buf = this.term.buffer.active;
    const screen = this.screen();
    if (!screen || buf.type !== "normal") return;
    const r = screen.getBoundingClientRect();
    const y = Math.floor(((e.clientY - r.top) / r.height) * this.term.rows);
    if (y < 0 || y >= this.term.rows) return;
    // Below the output there are no lines yet: a click there picks the last line.
    const row = Math.min(buf.viewportY + y, lastLine(buf.baseY + buf.cursorY, buf.length, (l) => buf.getLine(l)?.translateToString(true) ?? ""));
    this.clickMarker?.dispose();
    this.clickMarker = this.term.registerMarker(row - (buf.baseY + buf.cursorY)) ?? null;
    this.schedule();
  }

  private screen(): HTMLElement | null {
    return (this.term.element?.querySelector(".xterm-screen") as HTMLElement | null) ?? null;
  }

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.paint();
    });
  }

  private band(kind: "current" | "clicked"): HTMLDivElement | null {
    const screen = this.screen();
    if (!screen) return null;
    let el = kind === "current" ? this.current : this.clicked;
    if (!el || el.parentElement !== screen) {
      el?.remove();
      el = document.createElement("div");
      el.className = `term-line-band term-line-${kind}`;
      screen.appendChild(el);
      if (kind === "current") this.current = el;
      else this.clicked = el;
    }
    return el;
  }

  private place(el: HTMLDivElement | null, rows: [number, number] | null): void {
    if (!el) return;
    const buf = this.term.buffer.active;
    const screen = this.screen();
    if (!rows || !screen) {
      el.style.display = "none";
      return;
    }
    const top = Math.max(rows[0], buf.viewportY);
    const bottom = Math.min(rows[1], buf.viewportY + this.term.rows - 1);
    if (top > bottom) {
      el.style.display = "none";
      return;
    }
    const rowHeight = screen.clientHeight / this.term.rows;
    el.style.display = "block";
    el.style.top = `${(top - buf.viewportY) * rowHeight}px`;
    el.style.height = `${(bottom - top + 1) * rowHeight}px`;
  }

  private paint(): void {
    const buf = this.term.buffer.active;
    const on = this.enabled && buf.type === "normal";
    const wrapped = (line: number) => Boolean(buf.getLine(line)?.isWrapped);
    const cursorRows = on ? logicalRows(buf.baseY + buf.cursorY, wrapped, buf.length) : null;
    let clickRows: [number, number] | null = null;
    if (on && this.clickMarker && !this.clickMarker.isDisposed && this.clickMarker.line >= 0) {
      clickRows = logicalRows(this.clickMarker.line, wrapped, buf.length);
      // Clicking the cursor's line: the current-line band says it already.
      if (cursorRows && clickRows[0] === cursorRows[0]) clickRows = null;
    }
    this.place(this.band("current"), cursorRows);
    this.place(this.band("clicked"), clickRows);
  }
}

interface SelectionInternals {
  _getMouseBufferCoords(event: MouseEvent): [number, number] | undefined;
  _dragScroll(): void;
  _model: { selectionEnd?: [number, number] };
  refresh(isLinuxMouseSelection?: boolean): void;
}

/**
 * Mouse selection stops at the last line: rows below the output are blank screen, not
 * lines, so pressing or dragging there selects up to the end of the last line (like a
 * text editor). Patches xterm.js 5.5's selection service (mouse coordinates and the
 * auto-scroll while dragging past the bottom).
 */
export function installSelectionClamp(term: Terminal): IDisposable {
  const svc = (term as unknown as { _core?: { _selectionService?: SelectionInternals } })._core?._selectionService;
  if (!svc || typeof svc._getMouseBufferCoords !== "function" || typeof svc._dragScroll !== "function") {
    return { dispose: () => {} };
  }
  const limit = (): number | null => {
    const buf = term.buffer.active;
    if (buf.type !== "normal") return null;
    return lastLine(buf.baseY + buf.cursorY, buf.length, (l) => buf.getLine(l)?.translateToString(true) ?? "");
  };
  const clamp = (c: [number, number] | undefined): boolean => {
    const max = limit();
    if (!c || max === null || c[1] <= max) return false;
    c[0] = term.cols;
    c[1] = max;
    return true;
  };
  const coords = svc._getMouseBufferCoords;
  const dragScroll = svc._dragScroll;
  svc._getMouseBufferCoords = function (event: MouseEvent) {
    const c = coords.call(this, event);
    clamp(c);
    return c;
  };
  svc._dragScroll = function () {
    dragScroll.call(this);
    if (clamp(this._model.selectionEnd)) this.refresh();
  };
  return {
    dispose: () => {
      svc._getMouseBufferCoords = coords;
      svc._dragScroll = dragScroll;
    },
  };
}
