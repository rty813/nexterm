import type { SessionConfig } from "../types/domain";

export interface SessionGroupFolder {
  kind: "folder";
  name: string;
  fullPath: string;
  children: SessionTreeNode[];
  sessionCount: number;
}

export interface SessionLeafItem {
  kind: "session";
  session: SessionConfig;
}

export type SessionTreeNode = SessionGroupFolder | SessionLeafItem;

/** How the sidebar orders folders and sessions. */
export type SessionSortMode = "default" | "name" | "recent" | "frequent";

/** Per session id: times opened and last open time (ms). */
export type SessionUsage = Record<string, { count: number; lastUsed: number }>;

const byName = (a: string, b: string) => a.localeCompare(b, "zh-CN", { numeric: true, sensitivity: "base" });

/**
 * Sort a tree in place. default: folders by name, sessions in saved order (the original
 * behaviour). name: everything by name. recent / frequent: sessions by last use / use
 * count, folders by their best session, never-used ones after the used ones by name.
 */
export function sortSessionTree(nodes: SessionTreeNode[], mode: SessionSortMode, usage: SessionUsage = {}): SessionTreeNode[] {
  const metric = (id: string) => {
    const u = usage[id];
    if (!u) return 0;
    return mode === "recent" ? u.lastUsed || 0 : u.count || 0;
  };
  const score = new Map<SessionTreeNode, number>();
  const scoreOf = (n: SessionTreeNode): number => {
    const cached = score.get(n);
    if (cached !== undefined) return cached;
    const v = n.kind === "session" ? metric(n.session.id) : Math.max(0, ...n.children.map(scoreOf));
    score.set(n, v);
    return v;
  };
  const nameOf = (n: SessionTreeNode) => (n.kind === "folder" ? n.name : n.session.label);
  const sortLevel = (list: SessionTreeNode[]) => {
    for (const n of list) if (n.kind === "folder") sortLevel(n.children);
    if (mode === "default") {
      // Folders by name first, sessions keep their saved order.
      const folders = list.filter((n) => n.kind === "folder").sort((a, b) => byName(nameOf(a), nameOf(b)));
      const leaves = list.filter((n) => n.kind === "session");
      list.splice(0, list.length, ...folders, ...leaves);
      return;
    }
    list.sort((a, b) => {
      if (mode !== "name") {
        // Recent / frequent: one ranking for folders and sessions alike.
        const d = scoreOf(b) - scoreOf(a);
        if (d !== 0) return d;
      } else if (a.kind !== b.kind) {
        return a.kind === "folder" ? -1 : 1;
      }
      return byName(nameOf(a), nameOf(b));
    });
  };
  sortLevel(nodes);
  return nodes;
}

/**
 * Build WindTerm-compatible hierarchical folder tree where `session.group` uses `>` as path separator
 * (e.g. `"Production>CN-East>Gateways"`).
 */
export function buildSessionTree(
  sessions: SessionConfig[],
  filterQuery: string,
  sort: SessionSortMode = "default",
  usage: SessionUsage = {}
): SessionTreeNode[] {
  const q = filterQuery.trim().toLowerCase();
  const filtered = q
    ? sessions.filter((s) => {
        const hay = `${s.label} ${s.group} ${s.host} ${s.username} ${s.protocol}`.toLowerCase();
        return hay.includes(q);
      })
    : sessions;

  const rootFolders = new Map<string, SessionGroupFolder>();
  const rootLeaves: SessionLeafItem[] = [];

  for (const sess of filtered) {
    const segments = (sess.group || "")
      .split(">")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);

    if (segments.length === 0) {
      rootLeaves.push({ kind: "session", session: sess });
      continue;
    }

    let currentChildren: SessionTreeNode[] = [];
    let currentFolder: SessionGroupFolder | undefined;
    let builtPath = "";

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      builtPath = builtPath ? `${builtPath}>${seg}` : seg;

      if (i === 0) {
        let folder = rootFolders.get(seg);
        if (!folder) {
          folder = {
            kind: "folder",
            name: seg,
            fullPath: builtPath,
            children: [],
            sessionCount: 0,
          };
          rootFolders.set(seg, folder);
        }
        folder.sessionCount += 1;
        currentFolder = folder;
        currentChildren = folder.children;
      } else {
        let nextFolder = currentChildren.find(
          (n): n is SessionGroupFolder =>
            n.kind === "folder" && n.name === seg
        );
        if (!nextFolder) {
          nextFolder = {
            kind: "folder",
            name: seg,
            fullPath: builtPath,
            children: [],
            sessionCount: 0,
          };
          currentChildren.push(nextFolder);
        }
        nextFolder.sessionCount += 1;
        currentFolder = nextFolder;
        currentChildren = nextFolder.children;
      }
    }

    if (currentFolder) {
      currentFolder.children.push({ kind: "session", session: sess });
    }
  }

  return sortSessionTree([...rootFolders.values(), ...rootLeaves], sort, usage);
}
