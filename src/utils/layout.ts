import type {
  LayoutNode,
  PaneGroup,
  SplitDirection,
  TerminalLeafNode,
} from "../types/domain";

/**
 * Workspace layout in the WindTerm model: the window is split into groups, every
 * group owns its own tab bar, and every tab is exactly one terminal.
 */

export function allGroups(node: LayoutNode | null): PaneGroup[] {
  if (!node) return [];
  if (node.kind === "group") return [node];
  return [...allGroups(node.first), ...allGroups(node.second)];
}

export function allLeaves(node: LayoutNode | null): TerminalLeafNode[] {
  return allGroups(node).flatMap((g) => g.tabs);
}

export function findGroup(node: LayoutNode | null, groupId: string): PaneGroup | undefined {
  return allGroups(node).find((g) => g.id === groupId);
}

export function findGroupOfPane(node: LayoutNode | null, paneId: string): PaneGroup | undefined {
  return allGroups(node).find((g) => g.tabs.some((t) => t.paneId === paneId));
}

export function findLeaf(node: LayoutNode | null, paneId: string): TerminalLeafNode | undefined {
  return allLeaves(node).find((l) => l.paneId === paneId);
}

export function activeLeafOf(group: PaneGroup | undefined): TerminalLeafNode | undefined {
  if (!group) return undefined;
  return group.tabs.find((t) => t.paneId === group.activeTabId) ?? group.tabs[0];
}

/**
 * Rebuild the tree with every group passed through `fn`. Returning null removes the
 * group; its sibling then takes the parent split's place.
 */
export function mapGroups(
  node: LayoutNode | null,
  fn: (group: PaneGroup) => PaneGroup | null
): LayoutNode | null {
  if (!node) return null;
  if (node.kind === "group") return fn(node);
  const first = mapGroups(node.first, fn);
  const second = mapGroups(node.second, fn);
  if (!first && !second) return null;
  if (!first) return second;
  if (!second) return first;
  if (first === node.first && second === node.second) return node;
  return { ...node, first, second };
}

export function updateLeaf(
  node: LayoutNode | null,
  paneId: string,
  updater: (leaf: TerminalLeafNode) => TerminalLeafNode
): LayoutNode | null {
  return mapGroups(node, (g) => {
    const idx = g.tabs.findIndex((t) => t.paneId === paneId);
    if (idx < 0) return g;
    const next = updater(g.tabs[idx]);
    if (next === g.tabs[idx]) return g;
    const tabs = [...g.tabs];
    tabs[idx] = next;
    return { ...g, tabs };
  });
}

/** Place `newGroup` beside `targetGroupId` (right / below, or left / above with `before`). */
export function splitGroup(
  node: LayoutNode,
  targetGroupId: string,
  direction: SplitDirection,
  newGroup: PaneGroup,
  splitId: string,
  before = false
): LayoutNode {
  if (node.kind === "group") {
    if (node.id !== targetGroupId) return node;
    return {
      kind: "split",
      id: splitId,
      direction,
      ratio: 0.5,
      first: before ? newGroup : node,
      second: before ? node : newGroup,
    };
  }
  const first = splitGroup(node.first, targetGroupId, direction, newGroup, splitId, before);
  const second = splitGroup(node.second, targetGroupId, direction, newGroup, splitId, before);
  if (first === node.first && second === node.second) return node;
  return { ...node, first, second };
}

/** Remove a tab; an emptied group disappears. Picks the neighbouring tab as active. */
export function removeTab(node: LayoutNode | null, paneId: string): LayoutNode | null {
  return mapGroups(node, (g) => {
    const idx = g.tabs.findIndex((t) => t.paneId === paneId);
    if (idx < 0) return g;
    const tabs = g.tabs.filter((t) => t.paneId !== paneId);
    if (tabs.length === 0) return null;
    const activeTabId =
      g.activeTabId === paneId ? tabs[Math.max(0, idx - 1)].paneId : g.activeTabId;
    return { ...g, tabs, activeTabId };
  });
}

/** Move an existing tab (same terminal, no reconnect) into another group at `index`. */
export function moveTab(
  node: LayoutNode | null,
  paneId: string,
  targetGroupId: string,
  index?: number
): LayoutNode | null {
  const leaf = findLeaf(node, paneId);
  const source = findGroupOfPane(node, paneId);
  if (!leaf || !source || !findGroup(node, targetGroupId)) return node;

  if (source.id === targetGroupId) {
    return mapGroups(node, (g) => {
      if (g.id !== targetGroupId) return g;
      const from = g.tabs.findIndex((t) => t.paneId === paneId);
      const tabs = g.tabs.filter((t) => t.paneId !== paneId);
      let to = index ?? tabs.length;
      if (index !== undefined && from < index) to -= 1;
      tabs.splice(Math.max(0, Math.min(to, tabs.length)), 0, leaf);
      return { ...g, tabs, activeTabId: paneId };
    });
  }

  const withoutTab = removeTab(node, paneId);
  return mapGroups(withoutTab, (g) => {
    if (g.id !== targetGroupId) return g;
    const tabs = [...g.tabs];
    tabs.splice(Math.max(0, Math.min(index ?? tabs.length, tabs.length)), 0, leaf);
    return { ...g, tabs, activeTabId: paneId };
  });
}

export function updateSplitRatio(
  node: LayoutNode | null,
  splitId: string,
  ratio: number
): LayoutNode | null {
  if (!node || node.kind === "group") return node;
  if (node.id === splitId) {
    return { ...node, ratio: Math.min(0.9, Math.max(0.1, ratio)) };
  }
  const first = updateSplitRatio(node.first, splitId, ratio)!;
  const second = updateSplitRatio(node.second, splitId, ratio)!;
  if (first === node.first && second === node.second) return node;
  return { ...node, first, second };
}

/** Tab title: the user's custom name, else the session label. */
export function tabTitle(leaf: TerminalLeafNode): string {
  return leaf.title || leaf.session.label;
}

/** Group rects in percent of the workspace (same math the renderer uses). */
export interface GroupRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export function groupRects(node: LayoutNode | null): GroupRect[] {
  const out: GroupRect[] = [];
  const walk = (n: LayoutNode, x: number, y: number, w: number, h: number) => {
    if (n.kind === "group") {
      out.push({ id: n.id, x, y, w, h });
      return;
    }
    const r = Math.min(0.9, Math.max(0.1, n.ratio));
    if (n.direction === "horizontal") {
      walk(n.first, x, y, w * r, h);
      walk(n.second, x + w * r, y, w * (1 - r), h);
    } else {
      walk(n.first, x, y, w, h * r);
      walk(n.second, x, y + h * r, w, h * (1 - r));
    }
  };
  if (node) walk(node, 0, 0, 100, 100);
  return out;
}

export type Side = "left" | "right" | "up" | "down";

/** Nearest group in a direction from `groupId`, by overlapping edge. */
export function neighborGroup(node: LayoutNode | null, groupId: string, side: Side): string | undefined {
  const rects = groupRects(node);
  const me = rects.find((r) => r.id === groupId);
  if (!me) return undefined;
  const cx = me.x + me.w / 2;
  const cy = me.y + me.h / 2;
  const eps = 0.01;
  const candidates = rects.filter((r) => {
    if (r.id === me.id) return false;
    const overlapY = r.y < me.y + me.h - eps && r.y + r.h > me.y + eps;
    const overlapX = r.x < me.x + me.w - eps && r.x + r.w > me.x + eps;
    if (side === "left") return overlapY && r.x + r.w <= me.x + eps;
    if (side === "right") return overlapY && r.x >= me.x + me.w - eps;
    if (side === "up") return overlapX && r.y + r.h <= me.y + eps;
    return overlapX && r.y >= me.y + me.h - eps;
  });
  const dist = (r: GroupRect) => Math.hypot(r.x + r.w / 2 - cx, r.y + r.h / 2 - cy);
  return candidates.sort((a, b) => dist(a) - dist(b))[0]?.id;
}

/**
 * Move the divider on `side` of a group by `delta` (fraction of the parent split),
 * growing the group toward that side.
 */
export function resizeGroup(node: LayoutNode | null, groupId: string, side: Side, delta = 0.05): LayoutNode | null {
  const want = side === "left" || side === "right" ? "horizontal" : "vertical";
  // Walk up from the group to the nearest split of the right direction where the group
  // sits on the side being grown.
  const path: { split: Extract<LayoutNode, { kind: "split" }>; inFirst: boolean }[] = [];
  const find = (n: LayoutNode): boolean => {
    if (n.kind === "group") return n.id === groupId;
    if (find(n.first)) {
      path.push({ split: n, inFirst: true });
      return true;
    }
    if (find(n.second)) {
      path.push({ split: n, inFirst: false });
      return true;
    }
    return false;
  };
  if (!node || !find(node)) return node;
  const growsFirst = side === "right" || side === "down";
  const hit = path.find((p) => p.split.direction === want && p.inFirst === growsFirst);
  if (!hit) return node;
  const next = hit.split.ratio + (growsFirst ? delta : -delta);
  return updateSplitRatio(node, hit.split.id, next);
}

/** Swap the contents (tabs) of two groups; layout stays the same. */
export function swapGroups(node: LayoutNode | null, a: string, b: string): LayoutNode | null {
  const ga = findGroup(node, a);
  const gb = findGroup(node, b);
  if (!ga || !gb || a === b) return node;
  return mapGroups(node, (g) =>
    g.id === a ? { ...g, tabs: gb.tabs, activeTabId: gb.activeTabId } : g.id === b ? { ...g, tabs: ga.tabs, activeTabId: ga.activeTabId } : g
  );
}

/** Reset every split to 50 / 50. */
export function equalizeSplits(node: LayoutNode | null): LayoutNode | null {
  if (!node || node.kind === "group") return node;
  return { ...node, ratio: 0.5, first: equalizeSplits(node.first)!, second: equalizeSplits(node.second)! };
}

/** Where a dragged tab or window lands: a group (or the whole workspace with null) and a side. */
export type DropSide = "left" | "right" | "top" | "bottom" | "center";
export interface DropZone {
  groupId: string | null;
  side: DropSide;
}

/**
 * Put `leaves` (all moved together) at a drop zone: into a group's tabs (center) or
 * as a new group on one side of a group or of the whole workspace. Without a zone
 * they join `fallbackGroupId`.
 */
export function placeLeaves(
  root: LayoutNode | null,
  leaves: TerminalLeafNode[],
  zone: DropZone | null,
  fallbackGroupId: string | null,
  ids: { group: string; split: string }
): { root: LayoutNode | null; activeGroupId: string | null } {
  if (!leaves.length) return { root, activeGroupId: fallbackGroupId };
  const fresh: PaneGroup = { kind: "group", id: ids.group, tabs: leaves, activeTabId: leaves[0].paneId };
  if (!root) return { root: fresh, activeGroupId: fresh.id };

  const intoGroup = (groupId: string) => ({
    root: mapGroups(root, (g) =>
      g.id === groupId ? { ...g, tabs: [...g.tabs, ...leaves], activeTabId: leaves[0].paneId } : g
    ),
    activeGroupId: groupId,
  });
  const target = zone?.groupId && findGroup(root, zone.groupId) ? zone.groupId : null;
  if (!zone || zone.side === "center") {
    const id = target ?? (fallbackGroupId && findGroup(root, fallbackGroupId) ? fallbackGroupId : allGroups(root)[0].id);
    return intoGroup(id);
  }
  const direction: SplitDirection = zone.side === "left" || zone.side === "right" ? "horizontal" : "vertical";
  const before = zone.side === "left" || zone.side === "top";
  if (target) return { root: splitGroup(root, target, direction, fresh, ids.split, before), activeGroupId: fresh.id };
  return {
    root: { kind: "split", id: ids.split, direction, ratio: 0.5, first: before ? fresh : root, second: before ? root : fresh },
    activeGroupId: fresh.id,
  };
}
