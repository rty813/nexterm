/**
 * Pure helpers of the SSH file browser: POSIX remote paths, listing order, permissions,
 * preview formats and their size limits, CSV parsing, duplicate names of drops.
 */

export interface RemoteEntry {
  name: string;
  path: string;
  kind: "dir" | "file" | "link" | "other";
  /** A link that points to a folder. */
  linkDir: boolean;
  linkTarget?: string | null;
  size: number;
  mtime?: number | null;
  atime?: number | null;
  mode?: number | null;
  uid?: number | null;
  gid?: number | null;
  user?: string | null;
  group?: string | null;
}

/** Opens like a folder (folders and links to folders). */
export const isDirLike = (e: RemoteEntry): boolean => e.kind === "dir" || (e.kind === "link" && e.linkDir);

export function joinRemote(dir: string, name: string): string {
  if (!dir) return name;
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

export function parentOf(path: string): string {
  const p = path.length > 1 ? path.replace(/\/+$/, "") : path;
  const i = p.lastIndexOf("/");
  if (i <= 0) return "/";
  return p.slice(0, i);
}

export function baseName(path: string): string {
  const p = path.length > 1 ? path.replace(/\/+$/, "") : path;
  return p.slice(p.lastIndexOf("/") + 1) || p;
}

/** Breadcrumbs of an absolute path: "/a/b" -> ["/", "/a", "/a/b"]. */
export function crumbs(path: string): { name: string; path: string }[] {
  const out = [{ name: "/", path: "/" }];
  let cur = "";
  for (const part of path.split("/").filter(Boolean)) {
    cur += `/${part}`;
    out.push({ name: part, path: cur });
  }
  return out;
}

/** Path typed in the path bar, against the current folder: "~", "~/x", "..", "sub", "/abs". */
export function resolveTyped(input: string, cwd: string, home: string): string {
  let p = input.trim();
  if (!p) return cwd;
  if (p === "~") return home;
  if (p.startsWith("~/")) p = joinRemote(home, p.slice(2));
  else if (!p.startsWith("/")) p = joinRemote(cwd, p);
  return normalize(p);
}

/** Collapse ".", ".." and repeated slashes of an absolute path. */
export function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/** A valid single file name (what the rename / new file boxes accept). */
export function validName(name: string): boolean {
  const n = name.trim();
  return n.length > 0 && n !== "." && n !== ".." && !n.includes("/") && !n.includes("\0");
}

/** Directory of an OSC 7 report (`file://host/path`), percent-decoded. */
export function cwdFromOsc7(data: string): string | null {
  const m = /^file:\/\/[^/]*(\/.*)$/i.exec(data.trim());
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

export type SortKey = "name" | "size" | "mtime" | "kind";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Folders first, then by `key`; names compare naturally (file2 < file10). */
export function sortEntries(list: RemoteEntry[], key: SortKey, desc: boolean): RemoteEntry[] {
  const dir = desc ? -1 : 1;
  const ext = (n: string) => (n.lastIndexOf(".") > 0 ? n.slice(n.lastIndexOf(".") + 1).toLowerCase() : "");
  return [...list].sort((a, b) => {
    const fa = isDirLike(a) ? 0 : 1;
    const fb = isDirLike(b) ? 0 : 1;
    if (fa !== fb) return fa - fb;
    let c = 0;
    if (key === "size") c = a.size - b.size;
    else if (key === "mtime") c = (a.mtime ?? 0) - (b.mtime ?? 0);
    else if (key === "kind") c = collator.compare(ext(a.name), ext(b.name));
    return (c || collator.compare(a.name, b.name)) * dir;
  });
}

/** "rwxr-xr-x" of 0o755, with a leading type letter when `kind` is given. */
export function modeString(mode: number | null | undefined, kind?: RemoteEntry["kind"]): string {
  if (mode == null) return "";
  const bits = "rwxrwxrwx";
  let s = "";
  for (let i = 0; i < 9; i++) s += mode & (1 << (8 - i)) ? bits[i] : "-";
  // setuid / setgid / sticky
  const set = (i: number, on: boolean, lower: string, upper: string) => {
    if (on) s = s.slice(0, i) + (s[i] === "x" ? lower : upper) + s.slice(i + 1);
  };
  set(2, (mode & 0o4000) !== 0, "s", "S");
  set(5, (mode & 0o2000) !== 0, "s", "S");
  set(8, (mode & 0o1000) !== 0, "t", "T");
  if (!kind) return s;
  return (kind === "dir" ? "d" : kind === "link" ? "l" : "-") + s;
}

/** "755" of 0o755 (four digits when special bits are set). */
export function modeOctal(mode: number): string {
  const s = (mode & 0o7777).toString(8);
  return mode & 0o7000 ? s.padStart(4, "0") : s.padStart(3, "0");
}

/** Mode from "755" / "0644"; null when invalid. */
export function parseOctal(text: string): number | null {
  const t = text.trim();
  if (!/^[0-7]{3,4}$/.test(t)) return null;
  return parseInt(t, 8);
}

export function fmtSize(n = 0): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function fmtTime(secs?: number | null): string {
  if (!secs) return "";
  const d = new Date(secs * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** "1m 05s" style remaining time; "" when unknown. */
export function fmtEta(left: number, speed: number): string {
  if (speed <= 0 || left <= 0) return "";
  const s = Math.ceil(left / speed);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

// ------------------------------------------------------------------------------- preview

export type PreviewKind = "text" | "json" | "markdown" | "csv" | "tsv" | "image" | "pdf";

const TEXT_EXT = new Set(
  (
    "txt log conf cfg ini toml yaml yml xml html htm css scss less js mjs cjs ts tsx jsx py rb go rs c h cc cpp hpp java kt " +
    "swift sh bash zsh fish ps1 bat cmd sql lua pl php r m mm cs vb dart scala gradle properties env service socket timer " +
    "mount desktop rules patch diff gitignore gitattributes dockerfile makefile cmake mk srt vtt tex rst adoc proto graphql " +
    "vue svelte lock sum mod nix tf hcl"
  ).split(" ")
);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "avif"]);
/** Names without an extension that are text. */
const TEXT_NAMES = new Set(["makefile", "dockerfile", "readme", "license", "authors", "changelog", "hosts", "fstab", "crontab", "passwd", "group"]);

/** Preview format of a file name; null when the browser cannot show it. */
export function previewKind(name: string): PreviewKind | null {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  const ext = dot > 0 ? lower.slice(dot + 1) : dot === 0 ? lower.slice(1) : "";
  if (ext === "json" || ext === "jsonc" || ext === "geojson" || ext === "ipynb") return "json";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "csv") return "csv";
  if (ext === "tsv" || ext === "tab") return "tsv";
  if (ext === "pdf") return "pdf";
  if (IMAGE_EXT.has(ext)) return "image";
  if (TEXT_EXT.has(ext) || (!ext && TEXT_NAMES.has(lower)) || /^\.?(bash|zsh|profile|vim)rc$/.test(lower)) return "text";
  if (!ext || dot === 0) return "text"; // probably text; checked for binary after loading
  return null;
}

/** Largest file each preview loads (bytes); bigger ones get a message instead. */
export const PREVIEW_LIMIT: Record<PreviewKind, number> = {
  text: 5 * 1024 * 1024,
  markdown: 2 * 1024 * 1024,
  json: 10 * 1024 * 1024,
  csv: 10 * 1024 * 1024,
  tsv: 10 * 1024 * 1024,
  image: 30 * 1024 * 1024,
  pdf: 50 * 1024 * 1024,
};

/** Rows of a CSV / TSV preview at most. */
export const TABLE_ROW_LIMIT = 5000;

/** Looks like binary data (NUL bytes, or many control characters at the start). */
export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8000);
  let ctrl = 0;
  for (let i = 0; i < n; i++) {
    const b = bytes[i];
    if (b === 0) return true;
    if (b < 9 || (b > 13 && b < 32)) ctrl++;
  }
  return n > 0 && ctrl / n > 0.1;
}

/** RFC 4180 rows (quoted fields, doubled quotes, newlines inside quotes); stops at `maxRows`. */
export function parseDelimited(text: string, sep: string, maxRows = TABLE_ROW_LIMIT): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  while (i < src.length) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else field += c;
      i++;
      continue;
    }
    if (c === '"' && field === "") quoted = true;
    else if (c === sep) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      if (c === "\r" && src[i + 1] === "\n") i++;
      if (rows.length >= maxRows) return { rows, truncated: i + 1 < src.length };
    } else field += c;
    i++;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return { rows, truncated: false };
}

/** "name (1).ext" for a duplicate; mirrors transfer.rs numbered_name. */
export function numberedName(name: string, n: number): string {
  const i = name.indexOf(".", 1);
  if (i > 0) {
    const ext = name.slice(i);
    if (ext.length <= 8 || ext.startsWith(".tar.")) return `${name.slice(0, i)} (${n})${ext}`;
  }
  return `${name} (${n})`;
}
