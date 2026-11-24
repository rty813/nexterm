import { describe, expect, it } from "vitest";
import {
  applySuggestion,
  packageOfProcess,
  pushRecent,
  suggest,
  termAt,
  withOnlyPackage,
  type SuggestContext,
} from "../utils/logcatSuggest";

const ctx: SuggestContext = {
  packages: ["com.android.chrome", "com.example.app", "com.example.tools", "org.mozilla.firefox"],
  running: new Set(["com.example.tools"]),
  foreground: "com.android.chrome",
  tags: new Map([
    ["ActivityManager", 50],
    ["chromium", 200],
    ["Choreographer", 10],
    ["My Tag", 3],
  ]),
  processes: [
    { pid: 100, name: "system_server" },
    { pid: 4321, name: "com.example.tools:remote" },
    { pid: 4400, name: "/system/bin/surfaceflinger" },
  ],
  recent: ["tag:chromium level:E", "package:com.example.app"],
};

describe("logcat suggestions", () => {
  it("finds the term at the caret", () => {
    expect(termAt("tag:Foo pac", 11)).toEqual({ start: 8, end: 11, text: "pac" });
    expect(termAt("tag:Foo pac", 3)).toEqual({ start: 0, end: 7, text: "tag" });
    expect(termAt('a tag:"My Ta', 12)).toEqual({ start: 2, end: 12, text: 'tag:"My Ta' });
  });

  it("shows recent queries and keys in an empty box", () => {
    const r = suggest("", 0, ctx);
    expect(r.items.slice(0, 2).map((s) => s.kind)).toEqual(["recent", "recent"]);
    expect(r.items.some((s) => s.insert === "package:com.android.chrome" && s.detail === "foreground")).toBe(true);
    expect(r.items.some((s) => s.insert === "package:")).toBe(true);
  });

  it("completes keys and bare words", () => {
    const r = suggest("pa", 2, ctx);
    expect(r.items[0]).toMatchObject({ insert: "package:", kind: "key" });
    const word = suggest("chrom", 5, ctx);
    expect(word.items.map((s) => s.insert)).toContain("package:com.android.chrome");
    expect(word.items.map((s) => s.insert)).toContain("tag:chromium");
  });

  it("orders packages: foreground, running, then the rest", () => {
    const r = suggest("package:", 8, ctx);
    expect(r.items.map((s) => s.insert).slice(0, 3)).toEqual([
      "package:com.android.chrome",
      "package:com.example.tools",
      "package:com.example.app",
    ]);
    const ex = suggest("package:exam", 12, ctx);
    expect(ex.items.map((s) => s.insert)).toEqual(["package:com.example.tools", "package:com.example.app"]);
    expect(suggest("-package:fire", 13, ctx).items[0].insert).toBe("-package:org.mozilla.firefox");
  });

  it("completes tags by match then frequency, quoting spaces", () => {
    const r = suggest("tag:ch", 6, ctx);
    expect(r.items.map((s) => s.insert)).toEqual(["tag:chromium", "tag:Choreographer"]);
    expect(suggest("tag:=my", 7, ctx).items[0].insert).toBe('tag:="My Tag"');
  });

  it("completes pids by number or name", () => {
    expect(suggest("pid:43", 6, ctx).items.map((s) => s.insert)).toEqual(["pid:4321"]);
    expect(suggest("pid:surface", 11, ctx).items[0]).toMatchObject({ insert: "pid:4400", detail: "/system/bin/surfaceflinger" });
  });

  it("completes levels", () => {
    expect(suggest("level:w", 7, ctx).items.map((s) => s.insert)).toEqual(["level:W"]);
  });

  it("applies a suggestion in the middle of a query", () => {
    const q = "tag:Foo pack -x";
    const r = suggest(q, 12, ctx);
    const key = r.items.find((s) => s.insert === "package:")!;
    expect(applySuggestion(q, r, key)).toEqual({ value: "tag:Foo package: -x", caret: 16 });
    const r2 = suggest("tag:Foo package:exa", 19, ctx);
    expect(applySuggestion("tag:Foo package:exa", r2, r2.items[0])).toEqual({ value: "tag:Foo package:com.example.tools ", caret: 34 });
  });

  it("helpers", () => {
    expect(packageOfProcess("com.foo.bar:remote")).toBe("com.foo.bar");
    expect(packageOfProcess("/system/bin/init")).toBeNull();
    expect(packageOfProcess("system_server")).toBeNull();
    expect(withOnlyPackage("package:a tag:X -package:b boom", "com.c")).toBe("package:com.c tag:X boom");
    expect(pushRecent(["b", "a"], " a ")).toEqual(["a", "b"]);
    expect(pushRecent(["a"], "  ")).toEqual(["a"]);
  });
});
