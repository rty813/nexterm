import { describe, expect, it } from "vitest";
import { parseQuickConnectInput } from "../utils/quickConnect";
import { buildSessionTree } from "../utils/sessionTree";
import {
  allGroups,
  allLeaves,
  equalizeSplits,
  moveTab,
  neighborGroup,
  resizeGroup,
  swapGroups,
  removeTab,
  splitGroup,
  updateSplitRatio,
} from "../utils/layout";
import type { LayoutNode, PaneGroup, SessionConfig, TerminalLeafNode } from "../types/domain";

function dummySession(id: string, label: string, group = ""): SessionConfig {
  return {
    id,
    label,
    group,
    protocol: "ssh",
    host: "10.0.0.1",
    port: 22,
    username: "root",
    authType: "password",
    term: "xterm-256color",
    keepAliveSecs: 60,
  };
}

function makeLeaf(paneId: string): TerminalLeafNode {
  return {
    kind: "leaf",
    paneId,
    session: dummySession(paneId, paneId),
    status: "connected",
    rows: 24,
    cols: 80,
    reconnectCount: 0,
  };
}

describe("parseQuickConnectInput", () => {
  it("parses ssh user@host:port and -p flags", () => {
    const a = parseQuickConnectInput("ssh deploy@192.168.10.5:2222");
    expect(a?.protocol).toBe("ssh");
    expect(a?.username).toBe("deploy");
    expect(a?.host).toBe("192.168.10.5");
    expect(a?.port).toBe(2222);

    const b = parseQuickConnectInput("ssh -p 2022 -i ~/.ssh/id_ed25519 ubuntu@prod.internal");
    expect(b?.protocol).toBe("ssh");
    expect(b?.username).toBe("ubuntu");
    expect(b?.host).toBe("prod.internal");
    expect(b?.port).toBe(2022);
    expect(b?.authType).toBe("privatekey");
    expect(b?.privateKeyPath).toBe("~/.ssh/id_ed25519");
  });

  it("parses local shells and raw tcp targets", () => {
    expect(parseQuickConnectInput("powershell")?.protocol).toBe("powershell");
    expect(parseQuickConnectInput("cmd")?.protocol).toBe("cmd");
    expect(parseQuickConnectInput("wsl")?.protocol).toBe("wsl");
    expect(parseQuickConnectInput("gitbash")?.protocol).toBe("gitbash");
    expect(parseQuickConnectInput("Git Bash")?.protocol).toBe("gitbash");

    const tcp = parseQuickConnectInput("tcp://127.0.0.1:47331");
    expect(tcp?.protocol).toBe("tcp");
    expect(tcp?.host).toBe("127.0.0.1");
    expect(tcp?.port).toBe(47331);
  });

  it("parses rdp and vnc addresses with their default ports", () => {
    const rdp = parseQuickConnectInput("rdp://CORP%5Calice@10.0.0.8");
    expect(rdp?.protocol).toBe("rdp");
    expect(rdp?.username).toBe("CORP\\alice");
    expect(rdp?.host).toBe("10.0.0.8");
    expect(rdp?.port).toBe(3389);

    const vnc = parseQuickConnectInput("vnc pi.local:5901");
    expect(vnc?.protocol).toBe("vnc");
    expect(vnc?.username).toBe("");
    expect(vnc?.host).toBe("pi.local");
    expect(vnc?.port).toBe(5901);

    expect(parseQuickConnectInput("vnc://")).toBeNull();
  });
});

function makeGroup(id: string, paneIds: string[]): PaneGroup {
  return { kind: "group", id, tabs: paneIds.map(makeLeaf), activeTabId: paneIds[0] };
}

describe("layout groups", () => {
  it("splits groups, moves tabs between them and collapses emptied groups", () => {
    let root: LayoutNode = makeGroup("g1", ["p1", "p2"]);
    root = splitGroup(root, "g1", "horizontal", makeGroup("g2", ["p3"]), "s1");
    root = splitGroup(root, "g2", "vertical", makeGroup("g3", ["p4"]), "s2");
    expect(allGroups(root).map((g) => g.id)).toEqual(["g1", "g2", "g3"]);

    root = updateSplitRatio(root, "s1", 0.3)!;
    expect(root.kind === "split" && root.ratio).toBe(0.3);

    // Moving keeps the same leaf object (no new connection) and activates it.
    const p2 = allLeaves(root).find((l) => l.paneId === "p2");
    root = moveTab(root, "p2", "g3", 0)!;
    const g3 = allGroups(root).find((g) => g.id === "g3")!;
    expect(g3.tabs.map((t) => t.paneId)).toEqual(["p2", "p4"]);
    expect(g3.tabs[0]).toBe(p2);
    expect(g3.activeTabId).toBe("p2");

    // Reorder inside a group.
    root = moveTab(root, "p2", "g3", 2)!;
    expect(allGroups(root).find((g) => g.id === "g3")!.tabs.map((t) => t.paneId)).toEqual(["p4", "p2"]);

    // Closing the only tab of g2 removes the group from the tree.
    root = removeTab(root, "p3")!;
    expect(allGroups(root).map((g) => g.id)).toEqual(["g1", "g3"]);
    expect(allLeaves(root).map((l) => l.paneId)).toEqual(["p1", "p4", "p2"]);

    expect(removeTab(removeTab(removeTab(root, "p1"), "p4"), "p2")).toBeNull();
  });
});

describe("split operations", () => {
  it("finds neighbours, resizes by keyboard, swaps and equalizes", () => {
    // g1 | (g2 / g3)
    let root: LayoutNode = makeGroup("g1", ["p1"]);
    root = splitGroup(root, "g1", "horizontal", makeGroup("g2", ["p2"]), "s1");
    root = splitGroup(root, "g2", "vertical", makeGroup("g3", ["p3"]), "s2");
    expect(neighborGroup(root, "g1", "right")).toBe("g2");
    expect(neighborGroup(root, "g3", "up")).toBe("g2");
    expect(neighborGroup(root, "g3", "left")).toBe("g1");
    expect(neighborGroup(root, "g1", "left")).toBeUndefined();

    root = resizeGroup(root, "g1", "right")!;
    expect(root.kind === "split" && root.ratio).toBeCloseTo(0.55);
    root = resizeGroup(root, "g3", "up")!;
    const inner = root.kind === "split" ? root.second : null;
    expect(inner && inner.kind === "split" && inner.ratio).toBeCloseTo(0.45);

    root = swapGroups(root, "g1", "g3")!;
    expect(allGroups(root).map((g) => g.tabs[0].paneId)).toEqual(["p3", "p2", "p1"]);
    root = equalizeSplits(root)!;
    expect(root.kind === "split" && root.ratio).toBe(0.5);
  });
});

describe("buildSessionTree", () => {
  it("builds nested folders from WindTerm '>' group paths and filters accurately", () => {
    const sessions: SessionConfig[] = [
      dummySession("1", "Gateway-01", "Prod>CN-North"),
      dummySession("2", "DB-Primary", "Prod>CN-North"),
      dummySession("3", "Dev-Box", "Staging"),
    ];

    const tree = buildSessionTree(sessions, "");
    expect(tree.length).toBe(2);
    const prod = tree[0];
    expect(prod.kind).toBe("folder");
    if (prod.kind === "folder") {
      expect(prod.name).toBe("Prod");
      expect(prod.sessionCount).toBe(2);
      expect(prod.children[0].kind).toBe("folder");
    }

    const filtered = buildSessionTree(sessions, "db-primary");
    expect(filtered.length).toBe(1);
  });
});

describe("session sidebar sorting", () => {
  const mk = (id: string, label: string, group = "") =>
    ({ id, label, group, protocol: "ssh", host: "h", port: 22, username: "u", authType: "password", term: "xterm", keepAliveSecs: 0 }) as const;
  const sessions = [mk("b", "beta", "Prod"), mk("a", "alpha", "Prod"), mk("z", "zed", "Dev"), mk("r", "root1")];
  const names = (nodes: ReturnType<typeof buildSessionTree>): string[] =>
    nodes.map((n) => (n.kind === "folder" ? `${n.name}[${names(n.children).join(",")}]` : n.session.label));

  it("keeps the saved order by default and sorts by name", () => {
    expect(names(buildSessionTree(sessions as never, ""))).toEqual(["Dev[zed]", "Prod[beta,alpha]", "root1"]);
    expect(names(buildSessionTree(sessions as never, "", "name"))).toEqual(["Dev[zed]", "Prod[alpha,beta]", "root1"]);
  });

  it("ranks by last use or use count, folders by their best session", () => {
    const usage = { a: { count: 1, lastUsed: 300 }, z: { count: 9, lastUsed: 100 }, r: { count: 2, lastUsed: 200 } };
    expect(names(buildSessionTree(sessions as never, "", "recent", usage))).toEqual(["Prod[alpha,beta]", "root1", "Dev[zed]"]);
    expect(names(buildSessionTree(sessions as never, "", "frequent", usage))).toEqual(["Dev[zed]", "root1", "Prod[alpha,beta]"]);
  });
});
