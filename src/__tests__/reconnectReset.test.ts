import { Terminal } from "@xterm/xterm";
import { SerializeAddon } from "@xterm/addon-serialize";
import { describe, expect, it } from "vitest";
import { resetForReconnect, resetTerminal } from "../utils/reconnectReset";

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

function lines(term: Terminal): string[] {
  const buffer = term.buffer.active;
  const out = Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)!.translateToString(true));
  while (out.length && out[out.length - 1] === "") out.pop();
  return out;
}

function setup(rows = 3): { term: Terminal; serializer: SerializeAddon } {
  const term = new Terminal({ rows, cols: 40, allowProposedApi: true });
  const serializer = new SerializeAddon();
  term.loadAddon(serializer);
  return { term, serializer };
}

describe("resetting a terminal for a new connection", () => {
  it("leaves a full-screen program and its modes but keeps the shell's output", async () => {
    const { term, serializer } = setup();
    try {
      await write(term, "first\r\nsecond\r\nthird\r\nfourth\x1b[?1049h\x1b[Hfull-screen app");
      await write(term, "\x1b[?1003;1006;1004;2004;1h\x1b[2;3r\x1b[4h\x1b]2;unfinished title");
      expect(term.buffer.active.type).toBe("alternate");
      await resetForReconnect(term, serializer, "reconnecting");
      await write(term, "new shell");
      expect(term.buffer.active.type).toBe("normal");
      expect(term.modes).toMatchObject({
        mouseTrackingMode: "none",
        sendFocusMode: false,
        bracketedPasteMode: false,
        applicationCursorKeysMode: false,
        insertMode: false,
      });
      expect(lines(term)).toEqual(["first", "second", "third", "fourth", "reconnecting", "new shell"]);
      // The scroll region is the whole screen again: new lines push old ones into the scrollback.
      await write(term, "\r\na\r\nb\r\nc");
      expect(lines(term).slice(-4)).toEqual(["new shell", "a", "b", "c"]);
    } finally {
      term.dispose();
    }
  });

  it("parses output still queued from the old connection first", async () => {
    const { term, serializer } = setup();
    try {
      term.write("late output");
      await resetForReconnect(term, serializer, "reconnecting");
      expect(lines(term)).toEqual(["late output", "reconnecting"]);
    } finally {
      term.dispose();
    }
  });

  it("starts the banner on a fresh line only when the cursor's line has text", async () => {
    const { term, serializer } = setup();
    try {
      await write(term, "done\r\n");
      await resetForReconnect(term, serializer, "reconnecting");
      await write(term, "$ ");
      expect(lines(term)).toEqual(["done", "reconnecting", "$ "]);
    } finally {
      term.dispose();
    }
  });

  it("keeps colors and ignores a saved cursor from before", async () => {
    const { term, serializer } = setup();
    try {
      await write(term, "earlier\x1b7\r\n\x1b[31mred\x1b[0m\r\nlast line\x1b[?1002h");
      await resetForReconnect(term, serializer, "reconnecting");
      await write(term, "new shell");
      expect(term.modes.mouseTrackingMode).toBe("none");
      expect(lines(term)).toEqual(["earlier", "red", "last line", "reconnecting", "new shell"]);
      const red = term.buffer.active.getLine(1)!.getCell(0)!;
      expect(red.isFgPalette() && red.getFgColor()).toBe(1);
    } finally {
      term.dispose();
    }
  });

  it("leaves out history rows spliced in above the output", async () => {
    const { term, serializer } = setup();
    try {
      await write(term, "loaded 1\r\nloaded 2\r\nown 1\r\nown 2\r\nown 3");
      await resetForReconnect(term, serializer, "reconnecting", 2);
      expect(lines(term)).toEqual(["own 1", "own 2", "own 3", "reconnecting"]);
    } finally {
      term.dispose();
    }
  });
});

describe("resetting a terminal", () => {
  it("does not let a half-written title swallow the output after it", async () => {
    const { term } = setup();
    try {
      await write(term, "before\x1b]2;cut off title");
      resetTerminal(term);
      await write(term, "after");
      expect(lines(term)).toEqual(["after"]);
    } finally {
      term.dispose();
    }
  });
});
