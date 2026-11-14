import type { IBuffer, IDisposable, Terminal } from "@xterm/xterm";

/**
 * Follows the command line being typed in a terminal, for command history and auto
 * completion.
 *
 * The input starts where the cursor was at the first keystroke after a prompt (or where
 * OSC 133;B says the prompt ends). At Enter, the text from there to the end of the cursor's
 * logical line is the command, read from the screen: shell editing, history recall and
 * tab completion are all included. Passwords never show on screen, so they are never
 * recorded. Full-screen programs (alternate buffer) are ignored.
 *
 * A right-hand prompt (zsh RPROMPT, powerlevel10k time ...) shares the row but is not
 * part of the command: it is drawn after a gap of erased cells, or was already right of
 * the cursor when typing began. Both are cut off.
 */
export class InputTracker implements IDisposable {
  /** Where the input begins: absolute buffer row and column. */
  private start: { line: number; col: number } | null = null;
  /** OSC 133;B: end of the last prompt. */
  private promptEnd: { line: number; col: number } | null = null;
  /** Text right of the cursor when the input started: a right-hand prompt. */
  private right = "";
  /** Printable text was typed since the input started (auto completion shows only then). */
  typed = false;
  private readonly subs: IDisposable[];

  constructor(private readonly term: Terminal) {
    this.subs = [
      term.parser.registerOscHandler(133, (data) => {
        const buf = term.buffer.active;
        if (data.startsWith("B")) this.promptEnd = { line: buf.baseY + buf.cursorY, col: buf.cursorX };
        else if (data.startsWith("A")) this.reset();
        return false;
      }),
      term.buffer.onBufferChange(() => this.reset()),
    ];
  }

  dispose(): void {
    this.subs.forEach((s) => s.dispose());
  }

  reset(): void {
    this.start = null;
    this.right = "";
    this.typed = false;
  }

  /** Absolute row of the logical line holding the input start (the prompt line). */
  get startLine(): number | null {
    return this.start?.line ?? null;
  }

  /** Where the command being typed begins (absolute row, column), while typing one. */
  get inputStart(): { line: number; col: number } | null {
    return this.start ? { ...this.start } : null;
  }

  /**
   * Call with every chunk of keyboard / paste input before it is sent.
   * Returns the command lines the chunk submits (Enter), each with the absolute row it was
   * typed on (-1 for later lines of a paste, not on screen yet).
   */
  input(data: string): { command: string; line: number }[] | null {
    const buf = this.term.buffer.active;
    if (buf.type !== "normal") {
      this.reset();
      return null;
    }
    if (!this.start) {
      const abs = buf.baseY + buf.cursorY;
      this.start =
        this.promptEnd && this.promptEnd.line === abs && this.promptEnd.col <= buf.cursorX
          ? { ...this.promptEnd }
          : { line: abs, col: buf.cursorX };
      this.right = buf.getLine(abs)?.translateToString(true, buf.cursorX).trim() ?? "";
    }
    const normalized = data.replace(/\r\n/g, "\r").replace(/\n/g, "\r");
    const enter = normalized.indexOf("\r");
    if (enter >= 0) {
      const clean = (t: string) => t.replace(/\x1b\[20[01]~/g, "").replace(/[\x00-\x1f\x7f]/g, "");
      // Pasted text arrives before its echo: add what was not on screen yet.
      const first = (this.read(false) ?? "") + clean(normalized.slice(0, enter));
      const line = logicalStart(buf, buf.baseY + buf.cursorY);
      const rest = normalized.slice(enter + 1).split("\r");
      // The part after the last Enter is still being typed.
      rest.pop();
      this.reset();
      return [first, ...rest.map(clean)]
        .map((c, i) => ({ command: c.replace(/\s+$/, ""), line: i === 0 ? line : -1 }))
        .filter((c) => c.command.trim());
    }
    if (data === "\x03" || data === "\x04") {
      // Ctrl+C / Ctrl+D: the line is gone.
      this.reset();
      return null;
    }
    if (/[^\x00-\x1f\x7f]/.test(data) && !data.startsWith("\x1b")) this.typed = true;
    return null;
  }

  /**
   * The input typed so far: from its start up to the cursor (`toCursor`) or to the end
   * of the line. Null when the cursor left the input's line.
   */
  read(toCursor: boolean): string | null {
    if (!this.start) return null;
    const buf = this.term.buffer.active;
    if (buf.type !== "normal") return null;
    const cursor = buf.baseY + buf.cursorY;
    const first = logicalStart(buf, cursor);
    // Same logical line as when typing began; otherwise the prompt was redrawn below
    // (tab completion listing ...): it has the same width, so reuse the column.
    const startRow = this.start.line >= first && this.start.line <= cursor ? this.start.line : first;
    const startCol = this.start.col;
    const cell = buf.getNullCell();
    let text = "";
    for (let row = startRow; ; row++) {
      const line = buf.getLine(row);
      if (!line) break;
      const from = row === startRow ? startCol : 0;
      const atCursor = toCursor && row === cursor;
      const end = atCursor ? Math.min(buf.cursorX, line.length) : line.length;
      let rowText = "";
      let stop = false;
      for (let x = from; x < end; x++) {
        const c = line.getCell(x, cell);
        if (!c) break;
        if (c.getWidth() === 0) continue;
        const ch = c.getChars();
        if (ch === "") {
          // Erased cells, then more text on the row: that text is a right-hand prompt.
          if (!atCursor && hasTextAfter(line, x + 1, cell)) {
            stop = true;
            break;
          }
          rowText += " ";
          continue;
        }
        rowText += ch;
      }
      const wraps = Boolean(buf.getLine(row + 1)?.isWrapped);
      text += atCursor || (wraps && !stop) ? rowText : rowText.replace(/\s+$/, "");
      if (stop || atCursor || !wraps) break;
    }
    return toCursor ? text : this.stripRight(text);
  }

  /** Remove the right-hand prompt seen when typing began, if the line still ends with it. */
  private stripRight(text: string): string {
    const t = text.replace(/\s+$/, "");
    if (!this.right || !t.endsWith(this.right)) return t;
    const before = t.slice(0, t.length - this.right.length);
    // Only a separate trailing segment, never part of a word.
    return before === "" || /\s$/.test(before) ? before.replace(/\s+$/, "") : t;
  }

  /** Nothing but blanks (or the right-hand prompt) right of the cursor: typing at the end. */
  atLineEnd(): boolean {
    const buf = this.term.buffer.active;
    const cursor = buf.baseY + buf.cursorY;
    const line = buf.getLine(cursor);
    if (!line) return true;
    if (buf.getLine(cursor + 1)?.isWrapped) return false;
    const rest = line.translateToString(true, buf.cursorX).trim();
    if (rest === "" || (this.right && rest === this.right)) return true;
    // Erased cells right at the cursor, the right prompt further on.
    return line.getCell(buf.cursorX, buf.getNullCell())?.getChars() === "";
  }
}

function hasTextAfter(line: NonNullable<ReturnType<IBuffer["getLine"]>>, from: number, cell: ReturnType<IBuffer["getNullCell"]>): boolean {
  for (let x = from; x < line.length; x++) {
    const ch = line.getCell(x, cell)?.getChars() ?? "";
    if (ch !== "" && ch !== " ") return true;
  }
  return false;
}

export function logicalStart(buf: IBuffer, row: number): number {
  let r = row;
  while (r > 0 && buf.getLine(r)?.isWrapped) r--;
  return r;
}
