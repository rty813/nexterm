// Autocomplete for the logcat query box (pure, see LogcatPane): which term the caret is
// in, what could complete it, and the text after picking a suggestion.

export interface SuggestContext {
  /** Installed packages (device app list). */
  packages: string[];
  /** Packages with a running process (shown first, marked). */
  running: Set<string>;
  /** The app in the foreground, if known. */
  foreground?: string | null;
  /** Tags seen in the log, with how often. */
  tags: Map<string, number>;
  /** Running processes. */
  processes: { pid: number; name: string }[];
  /** Earlier queries, newest first (shown when the box is empty). */
  recent: string[];
}

export interface Suggestion {
  /** Text that replaces the term (or the whole query for `whole`). */
  insert: string;
  label: string;
  /** Muted text on the right (process name, "running", count ...). */
  detail?: string;
  kind: "key" | "package" | "tag" | "pid" | "level" | "recent";
  /** Replaces the whole query (recent queries). */
  whole?: boolean;
}

export interface SuggestResult {
  /** Range of the query the suggestion replaces. */
  start: number;
  end: number;
  items: Suggestion[];
}

const KEYS = ["package:", "tag:", "pid:", "level:", "-tag:", "-package:", "tag:=", "re:"];
const LEVELS: [string, string][] = [
  ["V", "Verbose"],
  ["D", "Debug"],
  ["I", "Info"],
  ["W", "Warn"],
  ["E", "Error"],
  ["F", "Fatal"],
];
const LIMIT = 40;

/** Bounds of the whitespace-separated term around `caret` (a quoted value counts as one). */
export function termAt(query: string, caret: number): { start: number; end: number; text: string } {
  let start = caret;
  let quotes = 0;
  for (let i = 0; i < caret; i++) if (query[i] === '"') quotes++;
  // Inside an open quote: the term starts before the quote's key.
  while (start > 0 && (quotes % 2 === 1 || !/\s/.test(query[start - 1]))) {
    start--;
    if (query[start] === '"') quotes--;
  }
  let end = caret;
  while (end < query.length && !/\s/.test(query[end])) end++;
  return { start, end, text: query.slice(start, caret) };
}

/** A value as it goes into a term: quoted when it holds spaces. */
export function quoteValue(v: string): string {
  return /\s/.test(v) ? `"${v}"` : v;
}

/** Package of a process name: "com.foo:remote" -> "com.foo"; null for native daemons. */
export function packageOfProcess(name: string): string | null {
  const base = name.split(":")[0];
  return /^[a-zA-Z][\w]*(\.[\w]+)+$/.test(base) ? base : null;
}

function rank(value: string, needle: string): number {
  const v = value.toLowerCase();
  if (!needle) return 2;
  if (v === needle) return 0;
  if (v.startsWith(needle)) return 1;
  // A segment starts with it ("chrome" in "com.android.chrome").
  if (v.split(/[.:_/\s]/).some((s) => s.startsWith(needle))) return 2;
  return v.includes(needle) ? 3 : -1;
}

export function suggest(query: string, caret: number, ctx: SuggestContext): SuggestResult {
  const term = termAt(query, caret);
  const empty = { start: term.start, end: term.end, items: [] as Suggestion[] };
  const neg = term.text.startsWith("-") ? "-" : "";
  const body = term.text.slice(neg.length);
  const colon = body.indexOf(":");

  // Empty box: recent queries, then the keys.
  if (!query.trim()) {
    return {
      start: 0,
      end: query.length,
      items: [
        ...ctx.recent.slice(0, 8).map((r): Suggestion => ({ insert: r, label: r, kind: "recent", whole: true })),
        ...(ctx.foreground ? [{ insert: `package:${ctx.foreground}`, label: `package:${ctx.foreground}`, kind: "package" as const, detail: "foreground" }] : []),
        ...KEYS.slice(0, 4).map((k): Suggestion => ({ insert: k, label: k, kind: "key" })),
      ],
    };
  }

  if (colon < 0) {
    if (term.text === "" ) return empty;
    const needle = body.toLowerCase();
    const keys = KEYS.filter((k) => k.startsWith(term.text.toLowerCase()) && k !== term.text).map(
      (k): Suggestion => ({ insert: k, label: k, kind: "key" })
    );
    // A bare word that names a package or tag: offer the term for it.
    const pkgs = needle.length >= 2 ? packageItems(ctx, needle, neg).slice(0, 6) : [];
    const tags = needle.length >= 2 ? tagItems(ctx, needle, neg, false).slice(0, 4) : [];
    return { start: term.start, end: term.end, items: [...keys, ...pkgs, ...tags] };
  }

  const key = body.slice(0, colon).toLowerCase();
  let value = body.slice(colon + 1);
  const exact = value.startsWith("=");
  if (exact) value = value.slice(1);
  const needle = value.replace(/^"/, "").replace(/"$/, "").toLowerCase();
  let items: Suggestion[] = [];
  if (key === "package" || key === "pkg") items = packageItems(ctx, needle, neg);
  else if (key === "tag") items = tagItems(ctx, needle, neg, exact);
  else if (key === "pid") items = pidItems(ctx, needle, neg);
  else if (key === "level")
    items = LEVELS.filter(([l, name]) => !needle || l.toLowerCase() === needle || name.toLowerCase().startsWith(needle)).map(
      ([l, name]): Suggestion => ({ insert: `level:${l}`, label: `level:${l}`, detail: name, kind: "level" })
    );
  // Already exactly what is typed: nothing to add.
  items = items.filter((s) => s.insert !== term.text);
  return { start: term.start, end: term.end, items: items.slice(0, LIMIT) };
}

function packageItems(ctx: SuggestContext, needle: string, neg: string): Suggestion[] {
  const all = new Set([...ctx.packages, ...ctx.running]);
  const scored: [number, string][] = [];
  for (const p of all) {
    const r = rank(p, needle);
    if (r < 0) continue;
    // Foreground, then running, then the rest; within each, by match quality.
    const tier = p === ctx.foreground ? 0 : ctx.running.has(p) ? 1 : 2;
    scored.push([tier * 10 + r, p]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
  return scored.slice(0, LIMIT).map(([, p]) => ({
    insert: `${neg}package:${p}`,
    label: `${neg}package:${p}`,
    detail: p === ctx.foreground ? "foreground" : ctx.running.has(p) ? "running" : undefined,
    kind: "package",
  }));
}

function tagItems(ctx: SuggestContext, needle: string, neg: string, exact: boolean): Suggestion[] {
  const scored: [number, number, string][] = [];
  for (const [tag, count] of ctx.tags) {
    if (!tag) continue;
    const r = rank(tag, needle);
    if (r >= 0) scored.push([r, -count, tag]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2].localeCompare(b[2]));
  return scored.slice(0, LIMIT).map(([, count, tag]) => {
    const insert = `${neg}tag:${exact ? "=" : ""}${quoteValue(tag)}`;
    return { insert, label: insert, detail: String(-count), kind: "tag" };
  });
}

function pidItems(ctx: SuggestContext, needle: string, neg: string): Suggestion[] {
  return ctx.processes
    .filter((p) => !needle || String(p.pid).startsWith(needle) || p.name.toLowerCase().includes(needle))
    .sort((a, b) => Number(!packageOfProcess(a.name)) - Number(!packageOfProcess(b.name)) || b.pid - a.pid)
    .slice(0, LIMIT)
    .map((p) => ({ insert: `${neg}pid:${p.pid}`, label: `${neg}pid:${p.pid}`, detail: p.name, kind: "pid" as const }));
}

/** The query after picking `s`, and where the caret goes (after a space, ready for more). */
export function applySuggestion(query: string, r: SuggestResult, s: Suggestion): { value: string; caret: number } {
  if (s.whole) return { value: s.insert, caret: s.insert.length };
  // Keys keep the caret right after the colon to type the value.
  const tail = s.kind === "key" ? "" : " ";
  const before = query.slice(0, r.start);
  // A key keeps the space before the next term (the value is typed in between).
  const after = s.kind === "key" ? query.slice(r.end) : query.slice(r.end).replace(/^\s+/, "");
  const value = `${before}${s.insert}${tail}${after}`;
  return { value, caret: before.length + s.insert.length + tail.length };
}

/** `query` with its package terms replaced by `package:<pkg>` (the "foreground app" button). */
export function withOnlyPackage(query: string, pkg: string): string {
  const rest = query
    .split(/\s+/)
    .filter((t) => t && !/^-?(package|pkg):/i.test(t))
    .join(" ");
  return `package:${pkg}${rest ? ` ${rest}` : ""}`;
}

/** Recent queries: newest first, without duplicates, at most `max`. */
export function pushRecent(list: string[], query: string, max = 10): string[] {
  const q = query.trim();
  if (!q) return list;
  return [q, ...list.filter((x) => x !== q)].slice(0, max);
}
