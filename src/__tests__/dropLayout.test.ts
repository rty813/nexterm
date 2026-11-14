import { describe, expect, it } from "vitest";
import { allGroups, placeLeaves } from "../utils/layout";
import { dropZoneAt } from "../utils/dropZones";
import type { LayoutNode, PaneGroup, TerminalLeafNode } from "../types/domain";

const leaf = (id: string) => ({ paneId: id }) as unknown as TerminalLeafNode;
const group = (id: string, ...tabs: string[]): PaneGroup => ({
  kind: "group",
  id,
  tabs: tabs.map(leaf),
  activeTabId: tabs[0],
});
const ids = { group: "gNew", split: "sNew" };

describe("placeLeaves", () => {
  it("creates the first group in an empty workspace", () => {
    const r = placeLeaves(null, [leaf("a")], null, null, ids);
    expect(r.root?.kind).toBe("group");
    expect(r.activeGroupId).toBe("gNew");
  });

  it("joins the target group's tabs for the center", () => {
    const r = placeLeaves(group("g1", "a"), [leaf("b"), leaf("c")], { groupId: "g1", side: "center" }, null, ids);
    const g = allGroups(r.root)[0];
    expect(g.tabs.map((t) => t.paneId)).toEqual(["a", "b", "c"]);
    expect(g.activeTabId).toBe("b");
  });

  it("splits a group on the dropped side", () => {
    const r = placeLeaves(group("g1", "a"), [leaf("b")], { groupId: "g1", side: "left" }, null, ids);
    const root = r.root as Extract<LayoutNode, { kind: "split" }>;
    expect(root.kind).toBe("split");
    expect(root.direction).toBe("horizontal");
    expect((root.first as PaneGroup).id).toBe("gNew");
    expect(r.activeGroupId).toBe("gNew");
  });

  it("splits the whole workspace without a group", () => {
    const two: LayoutNode = { kind: "split", id: "s1", direction: "horizontal", ratio: 0.5, first: group("g1", "a"), second: group("g2", "b") };
    const r = placeLeaves(two, [leaf("c")], { groupId: null, side: "bottom" }, null, ids);
    const root = r.root as Extract<LayoutNode, { kind: "split" }>;
    expect(root.direction).toBe("vertical");
    expect(root.first).toBe(two);
    expect((root.second as PaneGroup).id).toBe("gNew");
  });

  it("falls back to the given group without a zone", () => {
    const two: LayoutNode = { kind: "split", id: "s1", direction: "horizontal", ratio: 0.5, first: group("g1", "a"), second: group("g2", "b") };
    const r = placeLeaves(two, [leaf("c")], null, "g2", ids);
    expect(allGroups(r.root)[1].tabs.map((t) => t.paneId)).toEqual(["b", "c"]);
  });
});

describe("dropZoneAt", () => {
  const stage = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 600 }) } as HTMLElement;
  const one = group("g1", "a");

  it("tab bar and middle join the tabs; outer quarter splits", () => {
    expect(dropZoneAt(stage, one, null, 500, 10, "tab", 31)?.zone).toEqual({ groupId: "g1", side: "center" });
    expect(dropZoneAt(stage, one, null, 500, 300, "tab", 31)?.zone).toEqual({ groupId: "g1", side: "center" });
    expect(dropZoneAt(stage, one, null, 950, 300, "tab", 31)?.zone).toEqual({ groupId: "g1", side: "right" });
    expect(dropZoneAt(stage, one, null, 500, 590, "tab", 31)?.zone).toEqual({ groupId: "g1", side: "bottom" });
  });

  it("a window only docks on the tab bar or an edge band", () => {
    expect(dropZoneAt(stage, one, null, 500, 300, "window", 31)).toBeNull();
    expect(dropZoneAt(stage, one, null, 20, 300, "window", 31)?.zone).toEqual({ groupId: "g1", side: "left" });
    expect(dropZoneAt(stage, one, null, 500, 10, "window", 31)?.zone).toEqual({ groupId: "g1", side: "center" });
    expect(dropZoneAt(stage, one, null, 1200, 300, "window", 31)).toBeNull();
  });

  it("outer band of a split workspace splits the whole workspace", () => {
    const two: LayoutNode = { kind: "split", id: "s1", direction: "horizontal", ratio: 0.5, first: group("g1", "a"), second: group("g2", "b") };
    expect(dropZoneAt(stage, two, null, 5, 300, "tab", 31)?.zone).toEqual({ groupId: null, side: "left" });
    expect(dropZoneAt(stage, two, null, 700, 300, "tab", 31)?.zone).toEqual({ groupId: "g2", side: "center" });
  });
});
