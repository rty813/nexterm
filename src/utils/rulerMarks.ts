import type { IDecoration, IDisposable, IMarker, Terminal } from "@xterm/xterm";
import { findAll } from "./textMatch";

interface Mark {
  marker: IMarker;
  decorations: IDecoration[];
}

const MAX_OCCURRENCES = 3000;

/** `fg` mixed into `bg` by `amount` (0..1), as #rrggbb (decorations take no alpha). */
function mix(bg: string, fg: string, amount: number): string {
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
 * Selection helpers on the overview ruler (the strip over the scrollbar):
 * - every other occurrence of the selected text gets a soft background, like
 *   WindTerm, and a mark on the ruler;
 * - the selection itself gets a mark.
 * Search hits and text highlights add their own ruler marks via their decorations.
 */
export function installRulerMarks(term: Terminal, colors: { accent: string; termBg: string }): IDisposable & {
  setColors: (c: { accent: string; termBg: string }) => void;
} {
  let palette = colors;
  let marks: Mark[] = [];
  let timer = 0;

  const clear = () => {
    for (const m of marks) {
      m.decorations.forEach((d) => d.dispose());
      m.marker.dispose();
    }
    marks = [];
  };

  const place = (row: number, opts: Parameters<Terminal["registerDecoration"]>[0] extends infer O ? Omit<O & object, "marker"> : never) => {
    const buf = term.buffer.active;
    const marker = term.registerMarker(row - (buf.baseY + buf.cursorY));
    if (!marker) return;
    const deco = term.registerDecoration({ marker, ...opts });
    marks.push({ marker, decorations: deco ? [deco] : [] });
  };

  const refresh = () => {
    clear();
    const buf = term.buffer.active;
    const pos = term.getSelectionPosition();
    if (!pos || buf.type !== "normal") return;
    // Light gray, like WindTerm: same color on the text and on the ruler.
    const gray = mix(palette.termBg, "#ffffff", 0.3);
    place(pos.start.y, { overviewRulerOptions: { color: gray, position: "full" } });

    // Occurrences only for a single-line selection with something to match.
    const text = term.getSelection();
    if (!text || text.includes("\n") || !text.trim() || text.trim().length < 2) return;
    const re = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gu");
    const { matches } = findAll(term, re, MAX_OCCURRENCES);
    for (const m of matches) {
      // The selection itself already shows; mark the others.
      if (m.row === pos.start.y && m.col === pos.start.x) continue;
      let row = m.row;
      let col = m.col;
      let left = m.cells;
      let first = true;
      while (left > 0) {
        const width = Math.min(left, term.cols - col);
        place(row, {
          x: col,
          width,
          backgroundColor: gray,
          layer: "bottom",
          overviewRulerOptions: first ? { color: gray, position: "full" } : undefined,
        });
        first = false;
        left -= width;
        row += 1;
        col = 0;
      }
    }
  };

  const schedule = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(refresh, 60);
  };

  const subs = [
    term.onSelectionChange(schedule),
    // New output can add occurrences while the selection stays.
    term.onWriteParsed(() => {
      if (term.hasSelection()) schedule();
    }),
  ];

  return {
    setColors: (c) => {
      palette = c;
      if (term.hasSelection()) schedule();
    },
    dispose: () => {
      window.clearTimeout(timer);
      subs.forEach((s) => s.dispose());
      clear();
    },
  };
}
