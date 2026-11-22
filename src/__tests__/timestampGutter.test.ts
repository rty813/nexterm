import { describe, expect, it } from "vitest";
import { clearSurvivors, formatStamp, gutterChars } from "../utils/timestampGutter";

describe("timestampGutter", () => {
  it("sizes the margin for the numbers and the time", () => {
    // Room for 7 digits plus a space whatever the numbers (a width change resizes the
    // terminal), then HH:MM:SS.
    expect(gutterChars(12, true, false)).toBe(8 + 8);
    expect(gutterChars(1234567, true, false)).toBe(8 + 8);
    expect(gutterChars(12345678, true, false)).toBe(9 + 8);
    expect(gutterChars(1234567, true, true)).toBe(8 + 12);
    expect(gutterChars(1234567, false, false)).toBe(8);
  });

  it("formats times", () => {
    const t = new Date(2026, 10, 16, 9, 5, 7, 42).getTime();
    expect(formatStamp(t, false)).toBe("09:05:07");
    expect(formatStamp(t, true)).toBe("09:05:07.042");
  });

  it("renumbers the lines a clear leaves from 1", () => {
    const stamps = [
      { line: 990, time: 1 },
      { line: 1000, time: 2 },
      { line: 1001, time: 3 },
      { line: 1002, time: 4 },
      // Stamped again later (after an earlier clear moved the cursor up): the later one wins.
      { line: 1001, time: 5 },
    ];
    // Scrollback above row 1000 goes; rows past 1001 were blanked.
    expect(clearSurvivors(stamps, 1000, 1001)).toEqual([
      { line: 1000, time: 2, no: 1 },
      { line: 1001, time: 5, no: 2 },
    ]);
    // `clear` erased the whole screen first: nothing is left, the prompt will be line 1.
    expect(clearSurvivors(stamps, 1000, 999)).toEqual([]);
  });
});

import { lastLine, logicalRows } from "../utils/lineHighlight";

describe("logicalRows", () => {
  it("spans the rows of a wrapped line", () => {
    // Rows 3 and 4 continue row 2.
    const wrapped = (l: number) => l === 3 || l === 4;
    expect(logicalRows(3, wrapped, 10)).toEqual([2, 4]);
    expect(logicalRows(2, wrapped, 10)).toEqual([2, 4]);
    expect(logicalRows(5, wrapped, 10)).toEqual([5, 5]);
    expect(logicalRows(0, () => true, 3)).toEqual([0, 2]);
  });
});

describe("lastLine", () => {
  it("stops at the cursor or the last row with text below it", () => {
    const text = ["a", "b", "", "", ""];
    expect(lastLine(1, 5, (l) => text[l])).toBe(1);
    expect(lastLine(0, 5, (l) => text[l])).toBe(1);
    expect(lastLine(3, 5, (l) => text[l])).toBe(3);
  });
});
