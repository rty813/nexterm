import { describe, expect, it } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { buildMatcher, contrastText, findAll } from "../utils/textMatch";

const all = (re: RegExp | null, s: string) => (re ? [...s.matchAll(re)].map((m) => m[0]) : []);

describe("buildMatcher", () => {
  it("handles case, whole word, regex and literal escaping", () => {
    expect(all(buildMatcher("error", {}).re, "Error error ERRORS")).toEqual(["Error", "error", "ERROR"]);
    expect(all(buildMatcher("error", { caseSensitive: true }).re, "Error error")).toEqual(["error"]);
    expect(all(buildMatcher("err", { wholeWord: true }).re, "err error err_x 中err")).toEqual(["err"]);
    expect(all(buildMatcher("a.c", {}).re, "abc a.c")).toEqual(["a.c"]);
    expect(all(buildMatcher("a.c", { regex: true }).re, "abc a.c")).toEqual(["abc", "a.c"]);
    expect(all(buildMatcher(String.raw`\d+ms`,{ regex: true }).re, "took 12ms and 7ms")).toEqual(["12ms", "7ms"]);
    expect(all(buildMatcher("错误", { wholeWord: true }).re, "发生错误 错误")).toEqual(["错误"]);
  });

  it("reports bad and empty-matching patterns", () => {
    expect(buildMatcher("(", { regex: true }).error).toBeTruthy();
    expect(buildMatcher("a*", { regex: true }).error).toBe("empty");
    expect(buildMatcher("", {}).re).toBeNull();
  });

  it("picks readable text color", () => {
    expect(contrastText("#fde047")).toBe("#111111");
    expect(contrastText("#1e3a8a")).toBe("#ffffff");
  });
});

/** Rows of `cols` cells; a leading ">" marks a wrapped row, "." an empty cell. */
function fakeTerm(rows: string[], cols = 10): Terminal {
  const lines = rows.map((r) => {
    const isWrapped = r.startsWith(">");
    const text = isWrapped ? r.slice(1) : r;
    const chars = (x: number) => (text[x] && text[x] !== "." ? text[x] : "");
    return {
      isWrapped,
      length: cols,
      getCell: (x: number) => ({ getWidth: () => 1, getChars: () => chars(x) }),
      translateToString: () => Array.from({ length: cols }, (_, x) => chars(x) || " ").join(""),
    };
  });
  return { cols, buffer: { active: { length: lines.length, getLine: (y: number) => lines[y] } } } as unknown as Terminal;
}

describe("findAll", () => {
  it("finds matches across wraps and skips lines without one", () => {
    const term = fakeTerm(["no hit", "error at e", ">rror x", "tail   ", "err......", ">or"]);
    const re = buildMatcher("error", {}).re!;
    // The second match spans the wrap; "err" + empty cells + "or" has blanks in between.
    expect(findAll(term, re).matches.map((m) => [m.row, m.col, m.cells])).toEqual([
      [1, 0, 5],
      [1, 9, 5],
    ]);
    expect(findAll(term, buildMatcher("tail$", { regex: true }).re!).matches.map((m) => m.row)).toEqual([3]);
    expect(findAll(term, re, 1)).toMatchObject({ truncated: true });
  });

  it("finds a match the quick line text hides behind a zero-width cell", () => {
    // What xterm.js 5.5 holds after `a\x1b[@́b`: the mark sits in a zero-width cell of
    // its own, which translateToString keeps ("áb") and the cell-by-cell read skips ("ab").
    const cells: [string, number][] = [["a", 1], ["́", 0], ["b", 1]];
    const line = {
      isWrapped: false,
      length: 10,
      getCell: (x: number) => ({ getWidth: () => cells[x]?.[1] ?? 1, getChars: () => cells[x]?.[0] ?? "" }),
      translateToString: () => cells.map((c) => c[0]).join("") + " ".repeat(7),
    };
    const term = { cols: 10, buffer: { active: { length: 1, getLine: (y: number) => (y === 0 ? line : undefined) } } } as unknown as Terminal;
    expect(findAll(term, buildMatcher("ab", {}).re!).matches.map((m) => [m.row, m.col, m.cells])).toEqual([[0, 0, 3]]);
  });

  it("limits the scan to a range of rows, widened to whole logical lines", () => {
    const term = fakeTerm(["error 0", "error 1", "error at e", ">rror x", "error 4", "error 5"]);
    const re = buildMatcher("error", {}).re!;
    const rows = (from: number, to: number) => findAll(term, re, 100, { from, to }).matches.map((m) => [m.row, m.col]);
    // Row 3 continues the logical line of row 2: that line is scanned whole.
    expect(rows(3, 5)).toEqual([[2, 0], [2, 9], [4, 0]]);
    expect(rows(-10, 1)).toEqual([[0, 0]]);
    expect(rows(5, 99)).toEqual([[5, 0]]);
  });
});
