import { describe, expect, it } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { locateMatch } from "../utils/textMatch";

/** A terminal whose buffer holds `rows` (each `cols` wide, a leading "\u21aa" marks a wrapped row). */
function fakeTerm(rows: string[], cols = 40): Terminal {
  const lines = rows.map((r) => {
    const isWrapped = r.startsWith("\u21aa");
    const text = isWrapped ? r.slice(1) : r;
    return {
      isWrapped,
      length: cols,
      getCell: (x: number) => ({ getWidth: () => 1, getChars: () => text[x] ?? "" }),
    };
  });
  return { cols, buffer: { active: { length: lines.length, getLine: (y: number) => lines[y] } } } as unknown as Terminal;
}

const match = (line: string, needle: string) => {
  const start = line.indexOf(needle);
  return { start, end: start + needle.length, ctx: line, ctxOffset: 0 };
};

describe("locateMatch", () => {
  it("uses the row it is given when the match is there", () => {
    const term = fakeTerm(["alpha", "run codex now", "omega"]);
    expect(locateMatch(term, 1, match("run codex now", "codex"))).toMatchObject({ row: 1, col: 4, cells: 5 });
  });

  it("finds the line when the history's row mapping is a few lines off", () => {
    const rows = ["  p.node.setAttribute(\"r\", p.r.toFixed(1));", "x", "y", "  // codex here", "z"];
    const term = fakeTerm(rows, 60);
    const hit = locateMatch(term, 0, match("  // codex here", "codex"));
    expect(hit).toMatchObject({ row: 3, col: 5, cells: 5 });
    // Mapped below the line too.
    expect(locateMatch(term, 4, match("  // codex here", "codex"))).toMatchObject({ row: 3, col: 5 });
  });

  it("returns null instead of marking unrelated text", () => {
    const term = fakeTerm(["  p.node.setAttribute(\"r\", p.r.toFixed(1));", "nothing"], 60);
    expect(locateMatch(term, 0, match("// codex", "codex"))).toBeNull();
  });

  it("handles a match on a wrapped row", () => {
    const term = fakeTerm(["0123456789", "\u21aaab codex"], 10);
    expect(locateMatch(term, 1, match("0123456789ab codex", "codex"))).toMatchObject({ row: 1, col: 3, cells: 5 });
  });
});
