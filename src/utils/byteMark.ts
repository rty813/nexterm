import type { IDecoration, IMarker, Terminal } from "@xterm/xterm";
import type { ByteSelection, CellSpan } from "./dataInterpreter";

/**
 * Marks the byte the data interpreter reads (binary data type), WinHex style: a box over
 * its two hex digits and its ASCII character, so the position stays visible after the
 * selection is gone. It blinks briefly each time it moves.
 */
export class ByteMark {
  private marks: { marker: IMarker; deco: IDecoration }[] = [];

  constructor(private term: Terminal) {}

  show(sel: ByteSelection): void {
    this.clear();
    const buf = this.term.buffer.active;
    const cursor = buf.baseY + buf.cursorY;
    const put = (span: CellSpan, kind: "hex" | "ascii") => {
      const marker = this.term.registerMarker(span.y - cursor);
      if (!marker) return;
      const deco = this.term.registerDecoration({ marker, x: span.x, width: span.width, layer: "top" });
      if (!deco) {
        marker.dispose();
        return;
      }
      deco.onRender((el) => {
        el.classList.add("byte-mark", `byte-mark-${kind}`);
      });
      this.marks.push({ marker, deco });
    };
    sel.cells.hex.forEach((s) => put(s, "hex"));
    sel.cells.ascii.forEach((s) => put(s, "ascii"));
    // The decoration layer draws on the next render; nothing else may trigger one soon.
    const rows = [...sel.cells.hex, ...sel.cells.ascii].map((s) => s.y - buf.viewportY);
    if (rows.length) this.term.refresh(Math.max(0, Math.min(...rows)), Math.min(this.term.rows - 1, Math.max(...rows)));
  }

  clear(): void {
    for (const m of this.marks) {
      m.deco.dispose();
      m.marker.dispose();
    }
    this.marks = [];
  }

  dispose(): void {
    this.clear();
  }
}
