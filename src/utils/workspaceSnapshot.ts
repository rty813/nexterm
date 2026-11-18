import type { LayoutNode, PaneGroup, SessionConfig, SplitDirection, TerminalLeafNode, WorkspaceState } from "../types/domain";
import { withoutSessionSecrets } from "./paneSession";

/**
 * The workspace as saved between runs: split tree, tab order, active tabs, tab titles,
 * colors and locks. Saved sessions are stored by id (their secrets stay in
 * sessions.json); ad-hoc tabs (quick shells, quick connect) keep their config without
 * passwords.
 */
export interface TabSnapshot {
  sessionId?: string;
  session?: SessionConfig;
  title?: string;
  color?: string | null;
  locked?: boolean;
}

export type NodeSnapshot =
  | { kind: "group"; tabs: TabSnapshot[]; active: number }
  | { kind: "split"; direction: SplitDirection; ratio: number; first: NodeSnapshot; second: NodeSnapshot };

export interface WorkspaceSnapshot {
  version: 1;
  root: NodeSnapshot | null;
  /** Index of the active group, in tree order. */
  activeGroup: number;
}

function tabOf(leaf: TerminalLeafNode, saved: Set<string>): TabSnapshot {
  const tab: TabSnapshot = saved.has(leaf.session.id) ? { sessionId: leaf.session.id } : { session: withoutSessionSecrets(leaf.session) };
  if (leaf.title) tab.title = leaf.title;
  if (leaf.color) tab.color = leaf.color;
  if (leaf.locked) tab.locked = true;
  return tab;
}

export function snapshotWorkspace(ws: WorkspaceState, savedSessionIds: Iterable<string>): WorkspaceSnapshot {
  const saved = new Set(savedSessionIds);
  const groupIds: string[] = [];
  const walk = (node: LayoutNode): NodeSnapshot => {
    if (node.kind === "group") {
      groupIds.push(node.id);
      return {
        kind: "group",
        tabs: node.tabs.map((l) => tabOf(l, saved)),
        active: Math.max(0, node.tabs.findIndex((l) => l.paneId === node.activeTabId)),
      };
    }
    return { kind: "split", direction: node.direction, ratio: node.ratio, first: walk(node.first), second: walk(node.second) };
  };
  const root = ws.root ? walk(ws.root) : null;
  return { version: 1, root, activeGroup: Math.max(0, groupIds.indexOf(ws.activeGroupId ?? "")) };
}

export interface RestoreDeps {
  sessions: SessionConfig[];
  makeLeaf: (session: SessionConfig) => TerminalLeafNode;
  newId: (prefix: string) => string;
}

/**
 * Rebuild a workspace from a snapshot with fresh pane / group ids. Tabs whose saved
 * session was deleted are dropped, and so are groups and splits left empty.
 */
export function restoreWorkspace(snap: WorkspaceSnapshot | null | undefined, deps: RestoreDeps): WorkspaceState {
  if (!snap || snap.version !== 1 || !snap.root) return { root: null, activeGroupId: null };
  const byId = new Map(deps.sessions.map((s) => [s.id, s]));
  const groups: (PaneGroup | null)[] = [];

  const build = (node: NodeSnapshot): LayoutNode | null => {
    if (node.kind === "group") {
      const tabs: TerminalLeafNode[] = [];
      let activeTabId: string | null = null;
      node.tabs.forEach((tab, i) => {
        const session = tab.sessionId ? byId.get(tab.sessionId) : tab.session;
        if (!session) return;
        const leaf: TerminalLeafNode = {
          ...deps.makeLeaf(session),
          ...(tab.title ? { title: tab.title } : {}),
          ...(tab.color !== undefined ? { color: tab.color } : {}),
          ...(tab.locked ? { locked: true } : {}),
        };
        tabs.push(leaf);
        // The saved active tab, else the first one that still exists.
        if (activeTabId === null || i === node.active) activeTabId = leaf.paneId;
      });
      if (!tabs.length) {
        groups.push(null);
        return null;
      }
      const group: PaneGroup = { kind: "group", id: deps.newId("group"), tabs, activeTabId: activeTabId ?? tabs[0].paneId };
      groups.push(group);
      return group;
    }
    const first = build(node.first);
    const second = build(node.second);
    if (!first) return second;
    if (!second) return first;
    const ratio = Math.min(0.9, Math.max(0.1, Number(node.ratio) || 0.5));
    return { kind: "split", id: deps.newId("split"), direction: node.direction, ratio, first, second };
  };

  const root = build(snap.root);
  const active = groups[snap.activeGroup] ?? groups.find((g): g is PaneGroup => g !== null) ?? null;
  return { root, activeGroupId: root ? active?.id ?? null : null };
}
