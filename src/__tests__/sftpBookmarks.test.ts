import { describe, expect, it } from "vitest";
import type { SftpBookmark } from "../types/domain";
import {
  addBookmark,
  bookmarkLabel,
  bookmarksFor,
  cleanBookmarks,
  expandHome,
  findBookmark,
  forgetRecent,
  hostKeyOf,
  moveBookmark,
  parseRecent,
  pathCandidates,
  pushRecent,
  removeBookmark,
  renameBookmark,
  setBookmarkHost,
  tildePath,
} from "../utils/sftpBookmarks";

const WEB = "deploy@10.0.0.12:22";
const DB = "root@10.0.0.30:22";
const HOME = "/home/deploy";

const list = (): SftpBookmark[] => [
  { id: "a", host: WEB, path: "~/app/current", label: "app" },
  { id: "b", path: "/var/log" },
  { id: "c", host: DB, path: "/data/backup" },
  { id: "d", host: WEB, path: "/etc/nginx" },
  { id: "e", path: "~/.ssh" },
];

describe("hostKeyOf", () => {
  it("joins user, host and port; lowercases the host; defaults the port", () => {
    expect(hostKeyOf({ username: "deploy", host: "Web.Example.com", port: 2222 })).toBe("deploy@web.example.com:2222");
    expect(hostKeyOf({ username: "", host: "10.0.0.1", port: 0 })).toBe("10.0.0.1:22");
  });
});

describe("home paths", () => {
  it("expands ~ and keeps absolute paths", () => {
    expect(expandHome("~", HOME)).toBe(HOME);
    expect(expandHome("~/.ssh", HOME)).toBe("/home/deploy/.ssh");
    expect(expandHome("/var//log/", HOME)).toBe("/var/log");
  });
  it("writes paths under home with ~", () => {
    expect(tildePath(HOME, HOME)).toBe("~");
    expect(tildePath("/home/deploy/app", HOME)).toBe("~/app");
    expect(tildePath("/home/deployer", HOME)).toBe("/home/deployer");
    expect(tildePath("/etc", "/")).toBe("/etc");
  });
});

describe("bookmarks", () => {
  it("lists this server's bookmarks before the all-servers ones", () => {
    const v = bookmarksFor(list(), WEB);
    expect(v.own.map((b) => b.id)).toEqual(["a", "d"]);
    expect(v.global.map((b) => b.id)).toEqual(["b", "e"]);
    expect(v.all.map((b) => b.id)).toEqual(["a", "d", "b", "e"]);
  });

  it("finds a bookmark by absolute path, ignoring other servers", () => {
    expect(findBookmark(list(), WEB, "/home/deploy/app/current", HOME)?.id).toBe("a");
    expect(findBookmark(list(), WEB, "/root/.ssh", "/root")?.id).toBe("e");
    expect(findBookmark(list(), DB, "/root/.ssh", "/root")?.id).toBe("e");
    expect(findBookmark(list(), WEB, "/data/backup", HOME)).toBeUndefined();
  });

  it("labels with the label, else the folder name", () => {
    expect(bookmarkLabel(list()[0], HOME)).toBe("app");
    expect(bookmarkLabel(list()[4], HOME)).toBe(".ssh");
  });

  it("adds once, under home as ~, at the end or before another", () => {
    const one = addBookmark(list(), { abs: "/home/deploy/logs", home: HOME, host: WEB, hostKey: WEB });
    expect(one[one.length - 1]).toMatchObject({ path: "~/logs", host: WEB });
    expect(addBookmark(one, { abs: "/home/deploy/logs", home: HOME, host: "", hostKey: WEB })).toBe(one);
    const before = addBookmark(list(), { abs: "/tmp", home: HOME, host: "", hostKey: WEB, beforeId: "b" });
    expect(before.map((b) => b.path).slice(0, 3)).toEqual(["~/app/current", "/tmp", "/var/log"]);
    expect(before[1].host).toBeUndefined();
  });

  it("removes, renames and changes scope", () => {
    expect(removeBookmark(list(), "b").map((b) => b.id)).toEqual(["a", "c", "d", "e"]);
    expect(renameBookmark(list(), "d", "  nginx conf ", HOME).find((b) => b.id === "d")?.label).toBe("nginx conf");
    expect(renameBookmark(list(), "a", "current", HOME).find((b) => b.id === "a")).not.toHaveProperty("label");
    expect(renameBookmark(list(), "a", "", HOME).find((b) => b.id === "a")).not.toHaveProperty("label");
    expect(setBookmarkHost(list(), "a", "").find((b) => b.id === "a")).not.toHaveProperty("host");
    expect(setBookmarkHost(list(), "b", WEB).find((b) => b.id === "b")?.host).toBe(WEB);
  });

  it("moves before another bookmark and takes its scope", () => {
    const m = moveBookmark(list(), "e", "a");
    expect(m.map((b) => b.id)).toEqual(["e", "a", "b", "c", "d"]);
    expect(m[0].host).toBe(WEB);
    const g = moveBookmark(list(), "a", "e");
    expect(g.find((b) => b.id === "a")).not.toHaveProperty("host");
    const end = moveBookmark(list(), "a", null);
    expect(end.map((b) => b.id)).toEqual(["b", "c", "d", "e", "a"]);
    expect(end[end.length - 1].host).toBe(WEB);
    expect(moveBookmark(list(), "a", "a")).toEqual(list());
  });

  it("cleans saved data with stable ids", () => {
    const raw = [{ path: "/x" }, { id: "k", path: " /y ", label: " ", host: WEB }, { id: "k", path: "/z" }, { path: "" }, 3, null];
    const a = cleanBookmarks(raw);
    expect(a.map((b) => b.path)).toEqual(["/x", "/y", "/z"]);
    expect(a[1]).toEqual({ id: "k", path: "/y", host: WEB });
    expect(new Set(a.map((b) => b.id)).size).toBe(3);
    expect(cleanBookmarks(raw)).toEqual(a);
    expect(cleanBookmarks(undefined)).toEqual([]);
  });
});

describe("recent folders", () => {
  it("keeps the most recent first, deduplicated and capped; skips home and /", () => {
    let m = {};
    for (const d of ["/a", "/b", "/a", HOME, "/"]) m = pushRecent(m, WEB, d, HOME, 3);
    expect(m).toEqual({ [WEB]: ["/a", "/b"] });
    for (const d of ["/c", "/d"]) m = pushRecent(m, WEB, d, HOME, 3);
    expect(m).toEqual({ [WEB]: ["/d", "/c", "/a"] });
    expect(pushRecent(m, WEB, "/d", HOME)).toBe(m);
  });

  it("forgets one folder or a whole server", () => {
    const m = { [WEB]: ["/a", "/b"], [DB]: ["/x"] };
    expect(forgetRecent(m, WEB, "/a")).toEqual({ [WEB]: ["/b"], [DB]: ["/x"] });
    expect(forgetRecent(m, DB, "/x")).toEqual({ [WEB]: ["/a", "/b"] });
    expect(forgetRecent(m, WEB, null)).toEqual({ [DB]: ["/x"] });
  });

  it("parses stored data defensively", () => {
    expect(parseRecent(null)).toEqual({});
    expect(parseRecent("[1]")).toEqual({});
    expect(parseRecent(JSON.stringify({ [WEB]: ["/a", 3, "rel"], x: "no" }))).toEqual({ [WEB]: ["/a"] });
  });
});

describe("pathCandidates", () => {
  const ctx = {
    bookmarks: bookmarksFor(list(), WEB).all,
    recent: ["/var/log/nginx", "/home/deploy/app/current", "/etc/systemd"],
    home: HOME,
    cwd: "/home/deploy",
  };

  it("offers everything when nothing is typed, bookmarks first, without duplicates", () => {
    expect(pathCandidates("~", ctx).map((c) => c.shown)).toEqual(["~/app/current", "/etc/nginx", "/var/log", "~/.ssh", "/var/log/nginx", "/etc/systemd"]);
    expect(pathCandidates("", ctx, 2)).toHaveLength(2);
  });

  it("matches path or label, prefix matches first", () => {
    expect(pathCandidates("ng", ctx).map((c) => [c.shown, c.kind])).toEqual([
      ["/etc/nginx", "bookmark"],
      ["/var/log/nginx", "recent"],
    ]);
    expect(pathCandidates("/var", ctx).map((c) => c.shown)).toEqual(["/var/log", "/var/log/nginx"]);
    expect(pathCandidates("APP", ctx)[0]).toMatchObject({ abs: "/home/deploy/app/current", label: "app" });
    expect(pathCandidates("zzz", ctx)).toEqual([]);
  });
});
