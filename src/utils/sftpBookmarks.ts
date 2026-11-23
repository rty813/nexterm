/**
 * Bookmarked and recent folders of the SSH file browser (pure helpers).
 *
 * Bookmarks live in settings.sftp.bookmarks (synced with the rest of the settings). A bookmark
 * with `host` belongs to one server (`user@host:port`); without it, it shows on every server.
 * Paths under the home folder are kept as "~/..." so a bookmark like "~/.ssh" works for any
 * user. Recent folders are per machine (localStorage), keyed the same way.
 */

import type { SftpBookmark } from "../types/domain";
import { baseName, isDirLike, joinRemote, normalize, resolveTyped, type RemoteEntry } from "./sftpPaths";

/** Recent folders kept per server. */
export const RECENT_MAX = 10;

/** The server a pane is connected to, as bookmarks and recent folders key it. */
export function hostKeyOf(s: { username?: string | null; host: string; port?: number | null }): string {
  const user = (s.username ?? "").trim();
  const host = s.host.trim().toLowerCase();
  return `${user ? `${user}@` : ""}${host}:${s.port || 22}`;
}

/** "~" / "~/x" against the home folder; anything else is returned as an absolute path. */
export function expandHome(path: string, home: string): string {
  if (home && (path === "~" || path.startsWith("~/"))) return path === "~" ? home : joinRemote(home, path.slice(2));
  return normalize(path);
}

/** An absolute path written relative to the home folder when it is inside it. */
export function tildePath(path: string, home: string): string {
  if (!home || home === "/") return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export const isGlobal = (b: SftpBookmark): boolean => !b.host;

/** Bookmarks shown for a server: its own first, then the all-servers ones (each in saved order). */
export function bookmarksFor(list: SftpBookmark[], hostKey: string): { own: SftpBookmark[]; global: SftpBookmark[]; all: SftpBookmark[] } {
  const own = list.filter((b) => b.host === hostKey);
  const global = list.filter(isGlobal);
  return { own, global, all: [...own, ...global] };
}

/** The bookmark shown for this server that points at `abs`. */
export function findBookmark(list: SftpBookmark[], hostKey: string, abs: string, home: string): SftpBookmark | undefined {
  return bookmarksFor(list, hostKey).all.find((b) => expandHome(b.path, home) === abs);
}

/** Display name: the label, else the folder's name. */
export function bookmarkLabel(b: SftpBookmark, home: string): string {
  return b.label?.trim() || baseName(expandHome(b.path, home)) || b.path;
}

const newId = () => `bm${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/**
 * Bookmark `abs` (no-op when this server already shows a bookmark for it). `host` "" = all
 * servers. With `beforeId` it is placed before that bookmark, else at the end.
 */
export function addBookmark(
  list: SftpBookmark[],
  opts: { abs: string; home: string; host: string; hostKey: string; beforeId?: string | null }
): SftpBookmark[] {
  if (findBookmark(list, opts.hostKey, opts.abs, opts.home)) return list;
  const b: SftpBookmark = { id: newId(), path: tildePath(opts.abs, opts.home) };
  if (opts.host) b.host = opts.host;
  const i = opts.beforeId ? list.findIndex((x) => x.id === opts.beforeId) : -1;
  return i < 0 ? [...list, b] : [...list.slice(0, i), b, ...list.slice(i)];
}

export function removeBookmark(list: SftpBookmark[], id: string): SftpBookmark[] {
  return list.filter((b) => b.id !== id);
}

/** Rename; a label equal to the folder's name (or empty) clears it. */
export function renameBookmark(list: SftpBookmark[], id: string, label: string, home: string): SftpBookmark[] {
  return list.map((b) => {
    if (b.id !== id) return b;
    const v = label.trim();
    const { label: _old, ...rest } = b;
    return !v || v === baseName(expandHome(b.path, home)) ? rest : { ...rest, label: v };
  });
}

/** Move between "this server" (`host` = its key) and "all servers" (`host` = ""). */
export function setBookmarkHost(list: SftpBookmark[], id: string, host: string): SftpBookmark[] {
  return list.map((b) => {
    if (b.id !== id) return b;
    const { host: _old, ...rest } = b;
    return host ? { ...rest, host } : rest;
  });
}

/**
 * Drag to reorder: put `id` before `beforeId` and give it that bookmark's scope; with no
 * `beforeId` it goes to the end of the list keeping its scope.
 */
export function moveBookmark(list: SftpBookmark[], id: string, beforeId: string | null): SftpBookmark[] {
  const from = list.find((b) => b.id === id);
  if (!from || id === beforeId) return list;
  const rest = list.filter((b) => b.id !== id);
  const target = beforeId ? rest.find((b) => b.id === beforeId) : undefined;
  if (!target) return [...rest, from];
  const { host: _old, ...plain } = from;
  const moved: SftpBookmark = target.host ? { ...plain, host: target.host } : plain;
  const i = rest.indexOf(target);
  return [...rest.slice(0, i), moved, ...rest.slice(i)];
}

/** Bookmarks saved by other versions or edited by hand: drop broken entries and give each an id. */
export function cleanBookmarks(raw: unknown): SftpBookmark[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: SftpBookmark[] = [];
  raw.forEach((x, n) => {
    if (!x || typeof x !== "object") return;
    const r = x as Record<string, unknown>;
    if (typeof r.path !== "string" || !r.path.trim()) return;
    // Stable fallback ids: this runs on every read of the settings.
    let id = typeof r.id === "string" && r.id ? r.id : `bm-${n}-${r.path.trim()}`;
    for (let k = 2; seen.has(id); k++) id = `${id}-${k}`;
    seen.add(id);
    const b: SftpBookmark = { id, path: r.path.trim() };
    if (typeof r.label === "string" && r.label.trim()) b.label = r.label.trim();
    if (typeof r.host === "string" && r.host) b.host = r.host;
    out.push(b);
  });
  return out;
}

// ------------------------------------------------------------------- recent folders

export type RecentMap = Record<string, string[]>;

/** Remember a visited folder (most recent first). The home folder and "/" are not recorded. */
export function pushRecent(map: RecentMap, hostKey: string, dir: string, home: string, max = RECENT_MAX): RecentMap {
  if (!dir || dir === "/" || dir === home) return map;
  const list = map[hostKey] ?? [];
  if (list[0] === dir) return map;
  return { ...map, [hostKey]: [dir, ...list.filter((p) => p !== dir)].slice(0, max) };
}

export function forgetRecent(map: RecentMap, hostKey: string, dir: string | null): RecentMap {
  const { [hostKey]: list = [], ...rest } = map;
  if (dir === null) return rest;
  const next = list.filter((p) => p !== dir);
  return next.length ? { ...rest, [hostKey]: next } : rest;
}

export function parseRecent(text: string | null): RecentMap {
  try {
    const v = JSON.parse(text ?? "") as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: RecentMap = {};
    for (const [k, list] of Object.entries(v as Record<string, unknown>)) {
      if (Array.isArray(list)) out[k] = list.filter((p): p is string => typeof p === "string" && p.startsWith("/")).slice(0, RECENT_MAX);
    }
    return out;
  } catch {
    return {};
  }
}

// ------------------------------------------------------------------- path bar suggestions

export interface PathCandidate {
  /** Absolute path to open. */
  abs: string;
  /** As shown (and completed with Tab): "~/x" when under home. */
  shown: string;
  label: string;
  kind: "bookmark" | "recent" | "dir";
}

/** What the path bar is completing: the folder to list, the typed text up to it, and the partial name after it. */
export interface CompletionTarget {
  dir: string;
  head: string;
  prefix: string;
}

/**
 * Splits the typed path at its last "/": "/etc/ng" -> list "/etc" for names starting with "ng".
 * Null while the box still holds the current folder untouched, or for "~" without a known home.
 */
export function completionTarget(input: string, cwd: string, home: string): CompletionTarget | null {
  const p = input.replace(/^\s+/, "");
  if (!cwd || p === cwd || p === tildePath(cwd, home)) return null;
  if (p.startsWith("~") && !home) return null;
  if (p === "~") return { dir: home, head: "~/", prefix: "" };
  const i = p.lastIndexOf("/");
  const head = p.slice(0, i + 1);
  const prefix = p.slice(i + 1);
  if (prefix === "." || prefix === "..") return null;
  return { dir: head ? resolveTyped(head, cwd, home) : cwd, head, prefix };
}

/** Folders of `entries` (the listing of `target.dir`) whose names start with the typed prefix. */
export function dirCompletions(entries: RemoteEntry[], target: CompletionTarget, showHidden: boolean, limit = 8): PathCandidate[] {
  const q = target.prefix.toLowerCase();
  const hidden = showHidden || target.prefix.startsWith(".");
  const exact = (name: string) => (name.startsWith(target.prefix) ? 0 : 1);
  return entries
    .filter((e) => isDirLike(e) && (hidden || !e.name.startsWith(".")) && e.name.toLowerCase().startsWith(q))
    .sort((a, b) => exact(a.name) - exact(b.name) || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((e) => ({ abs: joinRemote(target.dir, e.name), shown: `${target.head}${e.name}/`, label: "", kind: "dir" as const }));
}

/** Longest common prefix of names (what Tab fills in when several folders match, like a shell). */
export function commonPrefix(names: string[]): string {
  if (!names.length) return "";
  let p = names[0];
  for (const n of names.slice(1)) {
    let i = 0;
    while (i < p.length && i < n.length && p[i] === n[i]) i++;
    p = p.slice(0, i);
  }
  return p;
}

/**
 * Suggestions while typing in the path bar: bookmarks, then recent folders, matched on the
 * shown path, the absolute path or the label (prefix matches first). With nothing typed yet
 * (or the current folder untouched) every one is offered.
 */
export function pathCandidates(
  query: string,
  ctx: { bookmarks: SftpBookmark[]; recent: string[]; home: string; cwd: string },
  limit = 8
): PathCandidate[] {
  const pool: PathCandidate[] = [];
  const seen = new Set<string>();
  for (const b of ctx.bookmarks) {
    const abs = expandHome(b.path, ctx.home);
    if (seen.has(abs)) continue;
    seen.add(abs);
    pool.push({ abs, shown: tildePath(abs, ctx.home), label: b.label?.trim() ?? "", kind: "bookmark" });
  }
  for (const abs of ctx.recent) {
    if (seen.has(abs)) continue;
    seen.add(abs);
    pool.push({ abs, shown: tildePath(abs, ctx.home), label: "", kind: "recent" });
  }
  const q = query.trim().toLowerCase();
  if (!q || q === ctx.cwd.toLowerCase() || q === tildePath(ctx.cwd, ctx.home).toLowerCase()) return pool.slice(0, limit);
  const hits = pool.filter((c) => c.shown.toLowerCase().includes(q) || c.abs.toLowerCase().includes(q) || c.label.toLowerCase().includes(q));
  const starts = (c: PathCandidate) => (c.shown.toLowerCase().startsWith(q) || c.abs.toLowerCase().startsWith(q) ? 0 : 1);
  return hits.map((c, i) => ({ c, i })).sort((a, b) => starts(a.c) - starts(b.c) || a.i - b.i).map((x) => x.c).slice(0, limit);
}
