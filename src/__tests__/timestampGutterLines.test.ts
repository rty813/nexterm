import { beforeAll, describe, expect, it } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { erasedRows, estimateLines, trimmedNewRows } from "../utils/timestampGutter";

describe("gutter line counting helpers", () => {
  it("counts only trimmed rows past the last stamped one", () => {
    expect(trimmedNewRows(10, 1)).toBe(0);
    expect(trimmedNewRows(10, 11)).toBe(0);
    expect(trimmedNewRows(10, 15)).toBe(4);
    expect(trimmedNewRows(-1, 3)).toBe(3);
  });

  it("estimates lines among trimmed rows from the rows that are left", () => {
    expect(estimateLines(1000, 50, 50)).toBe(1000);
    expect(estimateLines(1000, 25, 50)).toBe(500);
    expect(estimateLines(7, 0, 0)).toBe(7);
  });

  it("knows which rows ED resets", () => {
    // Screen rows 100..149, cursor on row 120.
    expect(erasedRows(0, 100, 120, 50)).toEqual([121, 149]);
    expect(erasedRows(1, 100, 120, 50)).toEqual([100, 119]);
    expect(erasedRows(2, 100, 120, 50)).toEqual([100, 149]);
    const [a, b] = erasedRows(3, 100, 120, 50);
    expect(a > b).toBe(true);
  });
});

/** The real xterm.js, headless (never opened), and the gutter on it. */
describe("TimestampGutter numbering", () => {
  let make: () => { term: Terminal; no: () => number | undefined; write: (s: string) => Promise<void>; at: (row: number) => number | undefined };

  beforeAll(async () => {
    (globalThis as { self?: unknown }).self ??= globalThis;
    const { Terminal } = await import("@xterm/xterm");
    const { TimestampGutter } = await import("../utils/timestampGutter");
    make = () => {
      const term = new Terminal({ cols: 40, rows: 10, scrollback: 100, allowProposedApi: true }) as Terminal;
      const host = { style: {}, replaceChildren() {} } as unknown as HTMLDivElement;
      const gutter = new TimestampGutter(term, host);
      const write = (s: string) => new Promise<void>((r) => term.write(s, r));
      const cursor = () => term.buffer.active.baseY + term.buffer.active.cursorY;
      return { term, write, no: () => gutter.numberOfLine(cursor()), at: (row: number) => gutter.numberOfLine(row) };
    };
  });

  const lines = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `line ${from + i}\r\n`).join("");

  it("counts lines a single write scrolled past the whole scrollback", async () => {
    const t = make();
    await t.write(lines(5000) + "$ ");
    expect(t.no()).toBe(5001);
    await t.write("\r\n" + lines(300) + "$ ");
    expect(t.no()).toBe(5302);
  });

  it("does not number a cursor's redraw again", async () => {
    const t = make();
    await t.write(lines(3) + "progress 1");
    // Back up one line and redraw it, as progress bars do.
    await t.write("\x1b[1A\rline 3 again\r\nprogress 2");
    expect(t.no()).toBe(4);
  });

  it("keeps counting across a cleared screen, with no numbers left on the blank rows", async () => {
    const t = make();
    await t.write(lines(25));
    await t.write("\x1b[2J\x1b[Hsummary\r\n$ ");
    // The backend keeps the cleared screen's lines: the count goes on.
    expect(t.no()).toBe(27);
    const top = t.term.buffer.active.baseY;
    for (let r = top + 2; r < top + 10; r++) expect(t.at(r)).toBeUndefined();
  });

  it("gives back the numbers of rows erased below the cursor", async () => {
    const t = make();
    await t.write("$ ls");
    await t.write("\r\nf1\r\nf2\r\nf3");
    await t.write("\x1b[3A\r\x1b[4C");
    await t.write("\x1b[J");
    await t.write("\r\na\r\nb\r\n$ ");
    expect(t.no()).toBe(4);
  });
});
