import { describe, expect, it } from "vitest";
import { COLOR_DEFAULT, COLOR_RGB, F_BOLD, F_INVERSE, KIND_CLEARED, lineKey, linesToAnsi, segments, sgr, type HistoryLine } from "../utils/historyView";

const line = (text: string, runs: [number, number][] = [], kind = 0): HistoryLine => ({ text, runs, ts: 0, kind });

describe("historyView", () => {
  it("splits style segments", () => {
    const styles = [
      { fg: 1, bg: COLOR_DEFAULT, flags: 0 },
      { fg: COLOR_DEFAULT, bg: COLOR_DEFAULT, flags: 0 },
    ];
    const l = line("abcdef", [
      [0, 1],
      [2, 0],
      [4, 1],
    ]);
    expect(segments(l, styles, 1, 5).map((s) => [s.text, s.start, s.style?.fg])).toEqual([
      ["b", 1, COLOR_DEFAULT],
      ["cd", 2, 1],
      ["e", 4, COLOR_DEFAULT],
    ]);
    expect(segments(line("plain"), styles)).toEqual([{ text: "plain", style: null, start: 0 }]);
    expect(segments(l, styles, 3, 3)).toEqual([]);
  });

  it("writes SGR for styles", () => {
    expect(sgr(null)).toBe("\x1b[0m");
    expect(sgr({ fg: 1, bg: COLOR_DEFAULT, flags: F_BOLD })).toBe("\x1b[0;1;31m");
    expect(sgr({ fg: 12, bg: 200, flags: F_INVERSE })).toBe("\x1b[0;7;94;48;5;200m");
    expect(sgr({ fg: COLOR_RGB | 0x0a0b0c, bg: COLOR_DEFAULT, flags: 0 })).toBe("\x1b[0;38;2;10;11;12m");
  });

  it("renders history lines as terminal output", () => {
    const styles = [{ fg: 2, bg: COLOR_DEFAULT, flags: 0 }];
    const lines = [
      line("plain"),
      line("ok done", [
        [0, 0],
        [2, -1],
      ]),
      line("", [], KIND_CLEARED),
    ];
    expect(linesToAnsi(lines, styles, "-- cleared --")).toBe(
      "plain\r\n\x1b[0;32mok\x1b[0m done\x1b[0m\r\n\x1b[0;2m-- cleared --\x1b[0m\r\n"
    );
    expect(lineKey("abc   ")).toBe("abc");
  });
});
