import { describe, expect, it } from "vitest";
import {
  baseName,
  crumbs,
  cwdFromOsc7,
  fmtEta,
  joinRemote,
  looksBinary,
  modeOctal,
  modeString,
  normalize,
  numberedName,
  parentOf,
  parseDelimited,
  parseOctal,
  previewKind,
  resolveTyped,
  sortEntries,
  validName,
  type RemoteEntry,
} from "../utils/sftpPaths";

const e = (name: string, kind: RemoteEntry["kind"], extra: Partial<RemoteEntry> = {}): RemoteEntry => ({
  name,
  path: `/x/${name}`,
  kind,
  linkDir: false,
  size: 0,
  ...extra,
});

describe("remote paths", () => {
  it("joins, splits and normalizes", () => {
    expect(joinRemote("/", "a")).toBe("/a");
    expect(joinRemote("/a", "b")).toBe("/a/b");
    expect(parentOf("/a/b")).toBe("/a");
    expect(parentOf("/a")).toBe("/");
    expect(parentOf("/")).toBe("/");
    expect(baseName("/a/b/")).toBe("b");
    expect(normalize("/a//b/./../c")).toBe("/a/c");
    expect(normalize("/../..")).toBe("/");
  });

  it("resolves what is typed in the path bar", () => {
    expect(resolveTyped("~", "/etc", "/home/me")).toBe("/home/me");
    expect(resolveTyped("~/src", "/etc", "/home/me")).toBe("/home/me/src");
    expect(resolveTyped("..", "/etc/nginx", "/home/me")).toBe("/etc");
    expect(resolveTyped("conf.d", "/etc/nginx", "/home/me")).toBe("/etc/nginx/conf.d");
    expect(resolveTyped("/var/log/", "/etc", "/home/me")).toBe("/var/log");
    expect(resolveTyped("  ", "/etc", "/home/me")).toBe("/etc");
  });

  it("builds breadcrumbs", () => {
    expect(crumbs("/a/b").map((c) => c.path)).toEqual(["/", "/a", "/a/b"]);
    expect(crumbs("/")).toEqual([{ name: "/", path: "/" }]);
  });

  it("reads the directory of OSC 7", () => {
    expect(cwdFromOsc7("file://box/home/me/my%20dir")).toBe("/home/me/my dir");
    expect(cwdFromOsc7("file:///tmp")).toBe("/tmp");
    expect(cwdFromOsc7("http://x/y")).toBeNull();
  });

  it("checks names", () => {
    expect(validName("a.txt")).toBe(true);
    expect(validName("..")).toBe(false);
    expect(validName("a/b")).toBe(false);
    expect(validName("  ")).toBe(false);
  });
});

describe("listing", () => {
  it("puts folders first and sorts names naturally", () => {
    const list = [e("file10", "file"), e("file2", "file"), e("zdir", "dir"), e("link", "link", { linkDir: true })];
    expect(sortEntries(list, "name", false).map((x) => x.name)).toEqual(["link", "zdir", "file2", "file10"]);
    expect(sortEntries(list, "name", true).map((x) => x.name)).toEqual(["zdir", "link", "file10", "file2"]);
  });

  it("sorts by size and time", () => {
    const list = [e("a", "file", { size: 5, mtime: 3 }), e("b", "file", { size: 1, mtime: 9 })];
    expect(sortEntries(list, "size", false).map((x) => x.name)).toEqual(["b", "a"]);
    expect(sortEntries(list, "mtime", true).map((x) => x.name)).toEqual(["b", "a"]);
  });

  it("formats permissions", () => {
    expect(modeString(0o755, "dir")).toBe("drwxr-xr-x");
    expect(modeString(0o4755)).toBe("rwsr-xr-x");
    expect(modeString(0o1777)).toBe("rwxrwxrwt");
    expect(modeString(0o2644)).toBe("rw-r-Sr--");
    expect(modeOctal(0o644)).toBe("644");
    expect(modeOctal(0o4755)).toBe("4755");
    expect(parseOctal("0755")).toBe(0o755);
    expect(parseOctal("789")).toBeNull();
  });

  it("estimates remaining time", () => {
    expect(fmtEta(100, 10)).toBe("10s");
    expect(fmtEta(65, 1)).toBe("1m 05s");
    expect(fmtEta(10, 0)).toBe("");
  });
});

describe("preview", () => {
  it("knows formats by name", () => {
    expect(previewKind("a.JSON")).toBe("json");
    expect(previewKind("README.md")).toBe("markdown");
    expect(previewKind("x.csv")).toBe("csv");
    expect(previewKind("x.tsv")).toBe("tsv");
    expect(previewKind("p.PNG")).toBe("image");
    expect(previewKind("doc.pdf")).toBe("pdf");
    expect(previewKind("nginx.conf")).toBe("text");
    expect(previewKind("Makefile")).toBe("text");
    expect(previewKind(".bashrc")).toBe("text");
    expect(previewKind("app.exe")).toBeNull();
    expect(previewKind("a.tar.gz")).toBeNull();
  });

  it("detects binary data", () => {
    expect(looksBinary(new TextEncoder().encode("hello\nworld\t1"))).toBe(false);
    expect(looksBinary(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 1]))).toBe(true);
  });

  it("parses CSV with quotes and newlines", () => {
    const { rows } = parseDelimited('﻿a,b\r\n"x, y","say ""hi"""\n"multi\nline",3', ",");
    expect(rows).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
      ["multi\nline", "3"],
    ]);
    expect(parseDelimited("a\tb\n1\t2\n", "\t").rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("stops at the row limit", () => {
    const r = parseDelimited("1\n2\n3\n4\n", ",", 2);
    expect(r.rows).toEqual([["1"], ["2"]]);
    expect(r.truncated).toBe(true);
  });
});

it("numbers duplicate names like the backend", () => {
  expect(numberedName("a.txt", 1)).toBe("a (1).txt");
  expect(numberedName("a.tar.gz", 2)).toBe("a (2).tar.gz");
  expect(numberedName(".bashrc", 1)).toBe(".bashrc (1)");
  expect(numberedName("Makefile", 1)).toBe("Makefile (1)");
});
