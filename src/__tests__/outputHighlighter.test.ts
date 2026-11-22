import { describe, expect, it } from "vitest";
import { FLOOD_ROWS_PER_SEC, FloodGauge, scanRows } from "../utils/outputHighlighter";

const ROWS = 50;

/** Feed writes of `advanced` rows every `step` ms from `from` to `to`; the answers in order. */
function stream(g: FloodGauge, advanced: number, step: number, from: number, to: number): boolean[] {
  const out: boolean[] = [];
  for (let t = from; t <= to; t += step) out.push(g.write(advanced, ROWS, t));
  return out;
}

describe("FloodGauge", () => {
  it("lets a burst through: it is over before a window has passed", () => {
    const g = new FloodGauge();
    // `cat` of a large file arriving in 60 ms, then the prompt.
    expect(stream(g, 4000, 12, 0, 60)).not.toContain(true);
    expect(g.write(1, ROWS, 75)).toBe(false);
  });

  it("reports a flood once it has lasted a window", () => {
    const g = new FloodGauge();
    const answers = stream(g, 4000, 12, 0, 300);
    expect(answers.slice(0, 9)).not.toContain(true); // up to 96 ms
    expect(answers.slice(9)).not.toContain(false);
  });

  it("ends with the first write that leaves part of the screen", () => {
    const g = new FloodGauge();
    stream(g, 4000, 12, 0, 300);
    expect(g.write(ROWS - 1, ROWS, 312)).toBe(false);
    // And has to last a window again.
    expect(g.write(4000, ROWS, 324)).toBe(false);
    expect(g.write(4000, ROWS, 336)).toBe(false);
  });

  it("starts over after a pause", () => {
    const g = new FloodGauge();
    stream(g, 4000, 12, 0, 300);
    expect(stream(g, 4000, 12, 500, 590)).not.toContain(true);
    expect(g.write(4000, ROWS, 602)).toBe(true);
  });

  it("is not a flood below the rate, however long it lasts", () => {
    const g = new FloodGauge();
    // A build log: a screenful every 50 ms is 1000 rows a second.
    expect(ROWS * 20).toBeLessThan(FLOOD_ROWS_PER_SEC);
    expect(stream(g, ROWS, 50, 0, 5000)).not.toContain(true);
  });

  it("follows the rate down when a flood turns into a steady stream", () => {
    const g = new FloodGauge();
    stream(g, 4000, 12, 0, 300);
    const answers = stream(g, ROWS, 50, 350, 1000);
    expect(answers[answers.length - 1]).toBe(false);
  });
});

describe("scanRows", () => {
  const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

  it("colors the viewport and a screen around it when not flooded", () => {
    // Following the output: view = baseY = 950, new output from row 990.
    expect(scanRows(950, ROWS, 950, 990, 1000, false)).toEqual({ lines: [...range(950, 990), ...range(990, 1000)], keepFrom: 900, keepTo: 1050 });
    // Up in the history: the viewport, then the new output.
    expect(scanRows(100, ROWS, 950, 990, 1000, false)).toEqual({ lines: [...range(100, 150), ...range(990, 1000)], keepFrom: 50, keepTo: 200 });
  });

  it("colors nothing during a flood the viewport follows", () => {
    expect(scanRows(950, ROWS, 950, 990, 1000, true)).toEqual({ lines: range(990, 1000), keepFrom: 0, keepTo: 0 });
  });

  it("keeps the screen of a viewport held up in the history colored during a flood", () => {
    expect(scanRows(100, ROWS, 950, 990, 1000, true)).toEqual({ lines: [...range(100, 150), ...range(990, 1000)], keepFrom: 100, keepTo: 150 });
    // One row up from the bottom is held as well.
    const near = scanRows(949, ROWS, 950, 990, 1000, true);
    expect([near.keepFrom, near.keepTo]).toEqual([949, 999]);
    expect(near.lines).toEqual([...range(949, 990), ...range(990, 1000)]);
  });
});
