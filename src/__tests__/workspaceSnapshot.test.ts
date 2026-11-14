import { describe, expect, it } from "vitest";
import { allGroups, allLeaves } from "../utils/layout";
import { restoreWorkspace, snapshotWorkspace } from "../utils/workspaceSnapshot";
import type { LayoutNode, PaneGroup, SessionConfig, TerminalLeafNode, WorkspaceState } from "../types/domain";

const session = (id: string, extra: Partial<SessionConfig> = {}): SessionConfig =>
  ({ id, label: id, group: "", protocol: "ssh", host: `${id}.example`, port: 22, username: "u", authType: "password", term: "xterm", keepAliveSecs: 0, ...extra }) as SessionConfig;

const leaf = (paneId: string, s: SessionConfig, extra: Partial<TerminalLeafNode> = {}): TerminalLeafNode => ({
  kind: "leaf",
  paneId,
  session: s,
  status: "connected",
  rows: 24,
  cols: 80,
  reconnectCount: 0,
  ...extra,
});

const group = (id: string, tabs: TerminalLeafNode[], active = 0): PaneGroup => ({
  kind: "group",
  id,
  tabs,
  activeTabId: tabs[active].paneId,
});

let n = 0;
const deps = (sessions: SessionConfig[]) => ({
  sessions,
  makeLeaf: (s: SessionConfig) => leaf(`p${++n}`, s, { status: "connecting" }),
  newId: (prefix: string) => `${prefix}${++n}`,
});

describe("workspace snapshot", () => {
  const web = session("web", { password: "secret" });
  const db = session("db");
  const quick = session("quick-1", { protocol: "powershell", password: "pw" });

  const root: LayoutNode = {
    kind: "split",
    id: "s1",
    direction: "horizontal",
    ratio: 0.3,
    first: group("g1", [leaf("a", web, { title: "Web", color: "#f00" }), leaf("b", quick)], 1),
    second: group("g2", [leaf("c", db, { locked: true })]),
  };
  const ws: WorkspaceState = { root, activeGroupId: "g2" };

  it("keeps saved sessions by id and ad-hoc tabs without secrets", () => {
    const snap = snapshotWorkspace(ws, ["web", "db"]);
    const text = JSON.stringify(snap);
    expect(text).not.toContain("secret");
    expect(text).not.toContain('"pw"');
    expect(snap.activeGroup).toBe(1);
    expect(snap.root?.kind).toBe("split");
  });

  it("restores splits, tab order, active tabs, titles, colors and locks", () => {
    const back = restoreWorkspace(snapshotWorkspace(ws, ["web", "db"]), deps([web, db]));
    expect(back.root?.kind).toBe("split");
    if (back.root?.kind !== "split") return;
    expect(back.root.ratio).toBe(0.3);
    const [g1, g2] = allGroups(back.root);
    expect(g1.tabs.map((t) => t.session.id)).toEqual(["web", "quick-1"]);
    expect(g1.activeTabId).toBe(g1.tabs[1].paneId);
    expect(g1.tabs[0].title).toBe("Web");
    expect(g1.tabs[0].color).toBe("#f00");
    // Saved sessions come back with their stored config (password included).
    expect(g1.tabs[0].session.password).toBe("secret");
    expect(g1.tabs[1].session.password).toBeUndefined();
    expect(g2.tabs[0].locked).toBe(true);
    expect(back.activeGroupId).toBe(g2.id);
    expect(allLeaves(back.root).every((l) => l.status === "connecting")).toBe(true);
  });

  it("drops tabs of deleted sessions and collapses emptied splits", () => {
    const back = restoreWorkspace(snapshotWorkspace(ws, ["web", "db"]), deps([web]));
    expect(back.root?.kind).toBe("group");
    expect(allLeaves(back.root).map((l) => l.session.id)).toEqual(["web", "quick-1"]);
    // The active group (g2) is gone: fall back to the remaining one.
    expect(back.activeGroupId).toBe(allGroups(back.root)[0].id);
  });

  it("returns an empty workspace for missing or unknown snapshots", () => {
    expect(restoreWorkspace(null, deps([])).root).toBeNull();
    expect(restoreWorkspace({ version: 2 } as never, deps([])).root).toBeNull();
  });
});
