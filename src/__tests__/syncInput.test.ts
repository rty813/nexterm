import { describe, expect, it } from "vitest";
import { syncTargets } from "../utils/syncInput";

const base = {
  scope: "all" as const,
  pausedAll: false,
  pausedPanes: {} as Record<string, boolean>,
  channels: {},
  allPanes: ["a", "b", "c"],
  visiblePanes: ["a", "c"],
  sourcePaneId: "a",
};

describe("syncTargets", () => {
  it("broadcasts to every pane of the scope", () => {
    expect(syncTargets(base)).toEqual(["a", "b", "c"]);
    expect(syncTargets({ ...base, scope: "visible" })).toEqual(["a", "c"]);
    expect(syncTargets({ ...base, scope: "visible", sourcePaneId: "b" })).toEqual(["b"]);
    expect(syncTargets({ ...base, scope: "off" })).toEqual(["a"]);
  });

  it("global pause keeps input in the source pane", () => {
    expect(syncTargets({ ...base, pausedAll: true })).toEqual(["a"]);
  });

  it("a paused pane does not receive input from the others", () => {
    expect(syncTargets({ ...base, pausedPanes: { b: true } })).toEqual(["a", "c"]);
    expect(syncTargets({ ...base, sourcePaneId: "c", pausedPanes: { b: true } })).toEqual(["a", "c"]);
  });

  it("a paused pane does not send its input to the others", () => {
    expect(syncTargets({ ...base, sourcePaneId: "b", pausedPanes: { b: true } })).toEqual(["b"]);
  });

  it("per-pane pause works in channels", () => {
    const channels = { a: "A", b: "A", c: "B" } as const;
    expect(syncTargets({ ...base, scope: "channels", channels })).toEqual(["a", "b"]);
    expect(syncTargets({ ...base, scope: "channels", channels, pausedPanes: { b: true } })).toEqual(["a"]);
    expect(syncTargets({ ...base, scope: "channels", channels, sourcePaneId: "c" })).toEqual(["c"]);
  });
});
