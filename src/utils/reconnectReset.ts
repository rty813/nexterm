import type { Terminal } from "@xterm/xterm";
import type { SerializeAddon } from "@xterm/addon-serialize";

const ESC = "\x1b";
/** CAN: ends a half-written escape sequence (back to the ground state). */
const CANCEL = "\x18";

/**
 * For the backend's history terminal: abort a half-written sequence, leave the alternate
 * screen so the full reset archives the normal screen, then reset (RIS).
 */
export const HISTORY_RESET = `${CANCEL}${ESC}[?1049l${ESC}c`;

/**
 * Full reset of xterm.js. `term.reset()` leaves the parser as it was, so a half-written
 * OSC / DCS (a title cut off by a dropped connection) would swallow the output that comes
 * next; CAN aborts it.
 */
export function resetTerminal(term: Terminal): void {
  term.reset();
  term.write(CANCEL);
}

/** The grey "reconnecting" line, ending on a new line for the new shell. */
export function bannerLine(message: string): string {
  return `${ESC}[90m${message}${ESC}[0m\r\n`;
}

/**
 * Reset the terminal for a new connection while keeping what the old one printed.
 *
 * A dropped connection can leave anything behind: a full-screen program on the alternate
 * screen, mouse reporting, bracketed paste, scroll regions, a half-parsed sequence. A full
 * reset clears all of that, but also the scrollback, so the normal screen and its
 * scrollback are serialized first (without the alternate screen or modes) and written back.
 *
 * `loadedRows`: rows at the top of the normal buffer that are not output but older history
 * spliced in for scrolling; they are left out. `afterReset` runs right after the reset,
 * before anything is written back. Resolves once xterm has parsed the restored text and
 * the banner.
 */
export function resetForReconnect(
  term: Terminal,
  serializer: SerializeAddon,
  message: string,
  loadedRows = 0,
  afterReset?: () => void
): Promise<void> {
  return new Promise((resolve) => {
    // Let output already queued from the old connection be parsed first.
    term.write("", () => {
      const normal = term.buffer.normal;
      const own = Math.max(0, normal.length - loadedRows - term.rows);
      const scrollback = Math.min(term.options.scrollback ?? 1000, own);
      const kept = serializer.serialize({ scrollback, excludeAltBuffer: true, excludeModes: true });
      const cursorLine = normal.getLine(normal.baseY + normal.cursorY)?.translateToString(true) ?? "";
      const newLine = normal.cursorX > 0 || cursorLine !== "" ? "\r\n" : "";
      resetTerminal(term);
      afterReset?.();
      term.write(kept + newLine + bannerLine(message), resolve);
    });
  });
}
