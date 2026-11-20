import type { IDisposable, Terminal } from "@xterm/xterm";

export interface OverlayOptions {
  /** text.alternatingLineColors: every other buffer line gets a slightly different background. */
  alternateRows: boolean;
  /** text.whiteSpaceVisibility: dots on spaces the program wrote. */
  whitespace: "none" | "all" | "leading" | "trailing";
  fg: string;
  bg: string;
}

/** `fg` mixed into `bg` by `amount` (0..1) as #rrggbb. */
export function mixColor(bg: string, fg: string, amount: number): string {
  const p = (c: string) => {
    const m = /^#?([0-9a-f]{6})/i.exec(c.trim());
    const n = m ? parseInt(m[1], 16) : 0;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const a = p(bg);
  const b = p(fg);
  return `#${a.map((v, i) => Math.round(v + (b[i] - v) * amount).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * WindTerm display details drawn over xterm's DOM renderer:
 * - alternating row colors: a translucent striped layer over the screen (the WebGL
 *   renderer has no row elements to style), shifted with the scroll position so the
 *   stripes stay with their lines;
 * - visible whitespace: a canvas over the screen with a dot on every space written by
 *   the program (erased cells stay blank, as in WindTerm).
 */
export class ScreenOverlay implements IDisposable {
  private canvas: HTMLCanvasElement | null = null;
  private stripes: HTMLDivElement | null = null;
  private frame = 0;
  private readonly subs: IDisposable[];

  constructor(
    private readonly term: Terminal,
    private opts: OverlayOptions,
    /** Start of the command being typed (absolute row, column), if any. */
    private readonly inputStart: () => { line: number; col: number } | null = () => null
  ) {
    this.subs = [
      term.onRender(() => this.schedule()),
      term.onResize(() => this.schedule()),
      term.buffer.onBufferChange(() => this.schedule()),
    ];
    this.apply();
  }

  update(opts: OverlayOptions): void {
    this.opts = opts;
    this.apply();
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.subs.forEach((s) => s.dispose());
    this.canvas?.remove();
    this.canvas = null;
    this.stripes?.remove();
    this.stripes = null;
  }

  private apply(): void {
    const el = this.term.element;
    if (!el) return;
    // Translucent, so it also works over a background image.
    el.style.setProperty("--alt-row-bg", `color-mix(in srgb, ${this.opts.fg} 4.5%, transparent)`);
    if (!this.opts.alternateRows) {
      this.stripes?.remove();
      this.stripes = null;
    }
    if (this.opts.whitespace === "none") {
      this.canvas?.remove();
      this.canvas = null;
    }
    this.schedule();
  }

  private schedule(): void {
    // Called on every rendered frame while output streams: keep the frame already requested.
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.paint();
    });
  }

  /** Every other buffer line tinted: odd absolute lines, so the stripes move with scrolling. */
  private paintStripes(screen: HTMLElement, viewportY: number): void {
    if (!this.stripes || this.stripes.parentElement !== screen) {
      this.stripes?.remove();
      this.stripes = document.createElement("div");
      this.stripes.className = "xterm-alt-rows";
      screen.appendChild(this.stripes);
    }
    const rowHeight = screen.clientHeight / Math.max(1, this.term.rows);
    const s = this.stripes.style;
    s.backgroundSize = `100% ${rowHeight * 2}px`;
    s.backgroundPositionY = viewportY % 2 ? `${-rowHeight}px` : "0px";
  }

  private paint(): void {
    const el = this.term.element;
    if (!el) return;
    const buf = this.term.buffer.active;
    const screen = el.querySelector(".xterm-screen") as HTMLElement | null;
    if (!screen) return;
    if (this.opts.alternateRows) this.paintStripes(screen, buf.viewportY);

    if (this.opts.whitespace === "none") return;
    if (!this.canvas) {
      this.canvas = document.createElement("canvas");
      this.canvas.className = "xterm-ws-overlay";
      screen.appendChild(this.canvas);
    }
    const dpr = window.devicePixelRatio || 1;
    const w = screen.clientWidth;
    const h = screen.clientHeight;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${h}px`;
    }
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = mixColor(this.opts.bg, this.opts.fg, 0.35);
    const cw = w / this.term.cols;
    const ch = h / this.term.rows;
    const r = Math.max(0.8, Math.min(cw, ch) * 0.09);
    const cell = buf.getNullCell();
    const mode = this.opts.whitespace;
    // The command being typed counts as its own line: spaces typed after a prompt are
    // leading, and those before a right-hand prompt (zsh RPROMPT) are trailing.
    const input = buf.type === "normal" ? this.inputStart() : null;
    const cursorRow = buf.baseY + buf.cursorY;
    for (let y = 0; y < this.term.rows; y++) {
      const abs = buf.viewportY + y;
      const line = buf.getLine(abs);
      if (!line) continue;
      let from = 0;
      let to = line.length;
      if (input && abs >= input.line && abs <= cursorRow) {
        from = abs === input.line ? Math.min(input.col, line.length) : 0;
        // The input ends at the first erased cell (what follows is a right prompt).
        to = from;
        while (to < line.length && (line.getCell(to, cell)?.getChars() ?? "") !== "") to++;
      }
      // First / last cell holding a visible character.
      let firstText = -1;
      let lastText = -1;
      for (let x = from; x < to; x++) {
        const c = line.getCell(x, cell)?.getChars() ?? "";
        if (c && c !== " ") {
          if (firstText < 0) firstText = x;
          lastText = x;
        }
      }
      for (let x = 0; x < line.length; x++) {
        if (line.getCell(x, cell)?.getChars() !== " ") continue;
        const inside = x >= from && x < to;
        if (mode === "leading" && !(inside && (firstText < 0 || x < firstText))) continue;
        if (mode === "trailing" && !(inside && x > lastText)) continue;
        ctx.beginPath();
        ctx.arc(x * cw + cw / 2, y * ch + ch / 2, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}
