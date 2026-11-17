import { describe, expect, it } from "vitest";
import { formatStamp, gutterChars } from "../utils/timestampGutter";

describe("timestampGutter", () => {
  it("sizes the margin for the numbers and the time", () => {
    // At least 4 digits plus a space, then HH:MM:SS.
    expect(gutterChars(12, true, false)).toBe(5 + 8);
    expect(gutterChars(1234567, true, false)).toBe(8 + 8);
    expect(gutterChars(1234567, true, true)).toBe(8 + 12);
    expect(gutterChars(1234567, false, false)).toBe(8);
  });

  it("formats times", () => {
    const t = new Date(2026, 10, 16, 9, 5, 7, 42).getTime();
    expect(formatStamp(t, false)).toBe("09:05:07");
    expect(formatStamp(t, true)).toBe("09:05:07.042");
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
