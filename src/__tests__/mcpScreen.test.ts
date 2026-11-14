import { describe, expect, it, vi } from "vitest";

vi.mock("../services/backend", () => ({ backend: {} }));
import { screenSnapshot } from "../services/mcpScreen";
import type { Terminal } from "@xterm/xterm";

function fakeTerm(rows: string[], opts: { viewportY: number; baseY: number; cursorX: number; cursorY: number; height: number; wrapped?: number[] }) {
  return {
    cols: 20,
    rows: opts.height,
    buffer: {
      active: {
        type: "normal",
        viewportY: opts.viewportY,
        baseY: opts.baseY,
        cursorX: opts.cursorX,
        cursorY: opts.cursorY,
        getLine: (y: number) =>
          y < rows.length ? { translateToString: () => rows[y], isWrapped: opts.wrapped?.includes(y) ?? false } : undefined,
      },
    },
  } as unknown as Terminal;
}

describe("screenSnapshot", () => {
  it("returns the visible rows, joins wrapped lines, drops trailing blanks", () => {
    const term = fakeTerm(["old", "$ echo aaaa", "aaaaaaaaaaaaaaaaaaaa", "bbb", "$", "", ""], {
      viewportY: 1,
      baseY: 1,
      cursorX: 2,
      cursorY: 3,
      height: 6,
      wrapped: [3],
    });
    const s = screenSnapshot(term, 0);
    expect(s.text).toBe("$ echo aaaa\naaaaaaaaaaaaaaaaaaaabbb\n$");
    expect(s.cursorY).toBe(3);
    expect(s.alternate).toBe(false);
  });

  it("adds scrollback rows above the screen", () => {
    const term = fakeTerm(["a", "b", "c", "d"], { viewportY: 2, baseY: 2, cursorX: 0, cursorY: 1, height: 2 });
    expect(screenSnapshot(term, 1).text).toBe("b\nc\nd");
    expect(screenSnapshot(term, 99).text).toBe("a\nb\nc\nd");
  });
});
