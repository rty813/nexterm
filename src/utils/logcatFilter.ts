import type { LogEntry } from "../types/domain";

/** Severity order; S (markers) always passes. */
export const LEVELS = ["V", "D", "I", "W", "E", "F"] as const;
export type Level = (typeof LEVELS)[number];

export function levelRank(level: string): number {
  const i = LEVELS.indexOf(level as Level);
  return i < 0 ? -1 : i;
}

/**
 * A logcat query, Android Studio style. Space-separated terms, all of which must match:
 * - `tag:Foo` / `-tag:Foo`        tag contains (or not); `tag:=Foo` exact
 * - `pid:123` / `-pid:123`
 * - `package:com.a` / `-package:` process belongs to the package (uid lookup, follows restarts)
 * - `level:W`                      at least W (overrides the level picker)
 * - `/regex/` or `re:regex`        message or tag matches
 * - `-word`                        message and tag must not contain it
 * - `word`                         message or tag contains it (case-insensitive)
 * Quotes group words: `"connection reset"`.
 */
export interface LogQuery {
  tags: { value: string; exact: boolean; not: boolean }[];
  pids: { value: number; not: boolean }[];
  packages: { value: string; not: boolean }[];
  level: number | null;
  regexes: { re: RegExp; not: boolean }[];
  words: { value: string; not: boolean }[];
  /** Terms that did not parse (bad regex), shown to the user. */
  errors: string[];
}

function tokens(q: string): string[] {
  const out: string[] = [];
  const re = /(-?[a-z]+:)?"([^"]*)"|\S+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q))) out.push(m[2] !== undefined ? `${m[1] ?? ""}${m[2]}` : m[0]);
  return out;
}

export function parseQuery(q: string): LogQuery {
  const out: LogQuery = { tags: [], pids: [], packages: [], level: null, regexes: [], words: [], errors: [] };
  for (const raw of tokens(q)) {
    const not = raw.startsWith("-") && raw.length > 1;
    const term = not ? raw.slice(1) : raw;
    const colon = term.indexOf(":");
    const key = colon > 0 ? term.slice(0, colon).toLowerCase() : "";
    const value = colon > 0 ? term.slice(colon + 1) : term;
    // A key still being typed ("tag:", "package:", "tag:="): no condition yet.
    if (["tag", "pid", "package", "pkg", "level", "re"].includes(key) && (value === "" || value === "=")) continue;
    if (key === "tag" && value) {
      const exact = value.startsWith("=");
      out.tags.push({ value: (exact ? value.slice(1) : value).toLowerCase(), exact, not });
    } else if (key === "pid" && /^\d+$/.test(value)) {
      out.pids.push({ value: Number(value), not });
    } else if ((key === "package" || key === "pkg") && value) {
      out.packages.push({ value, not });
    } else if (key === "level" && levelRank(value.toUpperCase()) >= 0) {
      out.level = levelRank(value.toUpperCase());
    } else if (key === "re" || (term.length > 2 && term.startsWith("/") && term.endsWith("/"))) {
      const src = key === "re" ? value : term.slice(1, -1);
      try {
        out.regexes.push({ re: new RegExp(src, "i"), not });
      } catch {
        out.errors.push(raw);
      }
    } else if (term) {
      out.words.push({ value: term.toLowerCase(), not });
    }
  }
  return out;
}

/** uids of packages by name (from the app list), to resolve `package:` terms. */
export type PackageUids = Map<string, number>;

function packageUids(q: LogQuery, uids: PackageUids): { value: Set<number>; not: boolean }[] {
  return q.packages.map((p) => {
    const set = new Set<number>();
    const needle = p.value.toLowerCase();
    for (const [name, uid] of uids) if (name.toLowerCase() === needle || name.toLowerCase().includes(needle)) set.add(uid);
    return { value: set, not: p.not };
  });
}

/** A compiled filter for many entries. */
export function makeFilter(q: LogQuery, minLevel: Level, uids: PackageUids = new Map()): (e: LogEntry) => boolean {
  const min = q.level ?? levelRank(minLevel);
  const pkgs = packageUids(q, uids);
  return (e) => {
    if (e.level !== "S" && levelRank(e.level) < min) return false;
    const tag = e.tag.toLowerCase();
    for (const t of q.tags) {
      const hit = t.exact ? tag === t.value : tag.includes(t.value);
      if (hit === t.not) return false;
    }
    if (q.pids.some((p) => p.not && p.value === e.pid)) return false;
    const want = q.pids.filter((p) => !p.not);
    if (want.length && !want.some((p) => p.value === e.pid)) return false;
    for (const p of pkgs) {
      const hit = e.uid !== null && p.value.has(e.uid);
      if (hit === p.not) return false;
    }
    if (q.words.length || q.regexes.length) {
      const msg = e.msg.toLowerCase();
      for (const w of q.words) {
        const hit = msg.includes(w.value) || tag.includes(w.value);
        if (hit === w.not) return false;
      }
      for (const r of q.regexes) {
        const hit = r.re.test(e.msg) || r.re.test(e.tag);
        if (hit === r.not) return false;
      }
    }
    return true;
  };
}

/** One line of an export, logcat's threadtime layout. */
export function formatEntry(e: LogEntry): string {
  if (e.level === "S") return `--------- ${e.msg}`;
  return `${e.ts} ${String(e.pid).padStart(5)} ${String(e.tid).padStart(5)} ${e.level} ${e.tag}: ${e.msg}`;
}

/**
 * Fixed-capacity log store: appends batches, drops the oldest beyond `max`. `base` counts
 * dropped entries so row indexes stay stable while scrolling.
 */
export class LogBuffer {
  entries: LogEntry[] = [];
  base = 0;
  constructor(public max: number) {}
  push(batch: LogEntry[]): void {
    for (const e of batch) this.entries.push(e);
    const over = this.entries.length - this.max;
    if (over > 0) {
      this.entries.splice(0, over);
      this.base += over;
    }
  }
  clear(): void {
    this.base += this.entries.length;
    this.entries = [];
  }
}
