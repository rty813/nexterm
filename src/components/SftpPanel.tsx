import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { downloadDir as systemDownloadDir } from "@tauri-apps/api/path";
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Download,
  Eye,
  EyeOff,
  File as FileIcon,
  FilePlus,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  FolderUp,
  HardDrive,
  Home,
  Link2,
  Locate,
  Pause,
  PencilLine,
  Play,
  RefreshCw,
  RotateCcw,
  Square,
  SquareTerminal,
  Star,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  backend,
  type SftpEditInfo,
  type TransferInfo,
  type TransferRequest,
} from "../services/backend";
import type { SftpBookmark, SftpSettings } from "../types/domain";
import { useContextMenu, type MenuItem } from "./ContextMenu";
import { SftpBookmarkBar, type BookmarkPopover } from "./SftpBookmarks";
import type { ConfirmAnswer, ConfirmRequest } from "./ConfirmDialog";
import type { PreviewRequest } from "./FilePreview";
import { paneCwd } from "../utils/paneCwd";
import {
  baseName,
  crumbs,
  fmtEta,
  fmtSize,
  fmtTime,
  isDirLike,
  joinRemote,
  modeOctal,
  modeString,
  parentOf,
  parseOctal,
  previewKind,
  resolveTyped,
  sortEntries,
  validName,
  type RemoteEntry,
  type SortKey,
} from "../utils/sftpPaths";
import {
  addBookmark,
  bookmarksFor,
  expandHome,
  findBookmark,
  forgetRecent,
  parseRecent,
  pathCandidates,
  pushRecent,
  removeBookmark,
  tildePath,
  type RecentMap,
} from "../utils/sftpBookmarks";

/** Recent folders of every server (this machine only, not synced). */
const RECENT_KEY = "nexterm.sftp.recent";

export interface SftpTarget {
  paneId: string;
  title: string;
  connected: boolean;
  /** `user@host:port`: whose bookmarks and recent folders to show. */
  hostKey: string;
}

/** Drag of rows inside the browser (move into a folder). */
const ROW_DRAG = "application/x-nexterm-sftp";

const isFileDrag = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes("Files");

/** A remote name made safe as a Windows file name. */
const localName = (name: string) => name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "") || "file";

const joinLocal = (dir: string, name: string) => `${dir.replace(/[\\/]+$/, "")}\\${name}`;

interface DropItem {
  name: string;
  /** Files and empty folders below it ("" path = the item itself). */
  files: { rel: string; file: File | null }[];
  bytes: number;
}

/** Everything inside dropped files and folders (webkitGetAsEntry, readEntries in batches). */
async function collectDrop(dt: DataTransfer): Promise<DropItem[]> {
  const entries = Array.from(dt.items)
    .map((it) => it.webkitGetAsEntry?.())
    .filter((x): x is FileSystemEntry => Boolean(x));
  const fileOf = (f: FileSystemFileEntry) => new Promise<File>((res, rej) => f.file(res, rej));
  const readAll = async (dir: FileSystemDirectoryEntry) => {
    const reader = dir.createReader();
    const out: FileSystemEntry[] = [];
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) return out;
      out.push(...batch);
    }
  };
  const items: DropItem[] = [];
  for (const top of entries) {
    const item: DropItem = { name: top.name, files: [], bytes: 0 };
    const walk = async (entry: FileSystemEntry, rel: string) => {
      if (entry.isFile) {
        const f = await fileOf(entry as FileSystemFileEntry);
        item.files.push({ rel, file: f });
        item.bytes += f.size;
      } else if (entry.isDirectory) {
        const children = await readAll(entry as FileSystemDirectoryEntry);
        if (!children.length) item.files.push({ rel, file: null });
        for (const c of children) await walk(c, `${rel}/${c.name}`);
      }
    };
    await walk(top, top.name);
    items.push(item);
  }
  return items;
}

type Prompt =
  | { kind: "mkdir" | "touch"; value: string }
  | { kind: "rename"; entry: RemoteEntry; value: string }
  | { kind: "move"; entries: RemoteEntry[]; value: string }
  | { kind: "symlink"; value: string; target: string };

/**
 * SFTP file browser of an SSH pane (docked like the other side panels): browse, upload,
 * download, rename / move, delete, permissions, links, preview, edit locally; plus the
 * transfer queue (SFTP / SCP / ZModem).
 */
export const SftpPanel: React.FC<{
  targets: SftpTarget[];
  /** The pane to show first (active SSH pane, or the one the menu was opened on). */
  preferredPaneId: string | null;
  settings: SftpSettings;
  onSettings: (patch: Partial<SftpSettings>) => void;
  ask: (req: ConfirmRequest) => Promise<ConfirmAnswer>;
  onToast: (text: string) => void;
  onPreview: (req: PreviewRequest) => void;
  /** Type a command into the pane (cd to the browsed folder). */
  onTerminalInput: (paneId: string, text: string) => void;
  onClose: () => void;
}> = ({ targets, preferredPaneId, settings, onSettings, ask, onToast, onPreview, onTerminalInput, onClose }) => {
  const { t } = useTranslation();
  const openMenu = useContextMenu();

  const [paneId, setPaneId] = useState<string | null>(null);
  const target = targets.find((x) => x.paneId === paneId) ?? null;
  const [cwd, setCwd] = useState("");
  const [home, setHome] = useState("");
  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [mode, setMode] = useState<"sftp" | "scp">("sftp");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "name", desc: false });
  const [filter, setFilter] = useState("");
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [props, setProps] = useState<{ entries: RemoteEntry[]; mode: string } | null>(null);
  const [dropOver, setDropOver] = useState<string | null>(null);
  const [staging, setStaging] = useState<{ done: number; total: number } | null>(null);
  const [transfers, setTransfers] = useState<TransferInfo[]>([]);
  const [edits, setEdits] = useState<SftpEditInfo[]>([]);
  const [queueOpen, setQueueOpen] = useState(true);
  const [queueTab, setQueueTab] = useState<"transfers" | "edits">("transfers");
  const [applyAll, setApplyAll] = useState(false);
  const history = useRef<string[]>([]);
  const [recentMap, setRecentMap] = useState<RecentMap>(() => parseRecent(localStorage.getItem(RECENT_KEY)));
  const [missing, setMissing] = useState<ReadonlySet<string>>(new Set());
  const [bmPopover, setBmPopover] = useState<BookmarkPopover>(null);
  const [suggest, setSuggest] = useState(-1);
  const hostKey = target?.hostKey ?? "";
  const hostKeyRef = useRef(hostKey);
  hostKeyRef.current = hostKey;
  const homeRef = useRef(home);
  homeRef.current = home;
  const listRef = useRef<HTMLDivElement | null>(null);
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const updateRecent = useCallback((f: (m: RecentMap) => RecentMap) => {
    setRecentMap((m) => {
      const next = f(m);
      if (next !== m) localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      return next;
    });
  }, []);
  // Other windows record recent folders too.
  useEffect(() => {
    const on = (e: StorageEvent) => e.key === RECENT_KEY && setRecentMap(parseRecent(e.newValue));
    window.addEventListener("storage", on);
    return () => window.removeEventListener("storage", on);
  }, []);

  // Follow the preferred pane while the user has not picked another live one.
  useEffect(() => {
    setPaneId((cur) => {
      if (preferredPaneId && targets.some((x) => x.paneId === preferredPaneId)) return preferredPaneId;
      if (cur && targets.some((x) => x.paneId === cur)) return cur;
      return targets[0]?.paneId ?? null;
    });
  }, [preferredPaneId, targets]);

  const load = useCallback(
    async (path: string, opts: { keepSelection?: boolean; push?: boolean; home?: string } = {}): Promise<boolean> => {
      if (!paneId) return false;
      setLoading(true);
      try {
        const listing = await backend.sftpList(paneId, path);
        if (opts.push !== false && cwdRef.current && cwdRef.current !== listing.path) {
          history.current = [...history.current.slice(-49), cwdRef.current];
        }
        setCwd(listing.path);
        setEntries(listing.entries);
        setMode(listing.mode);
        setError(null);
        if (!opts.keepSelection) setSelected(new Set());
        const key = hostKeyRef.current;
        if (key) updateRecent((m) => pushRecent(m, key, listing.path, opts.home ?? homeRef.current));
        setMissing((m) => (m.has(listing.path) ? new Set([...m].filter((x) => x !== listing.path)) : m));
        return true;
      } catch (e) {
        setError(String(e));
        return false;
      } finally {
        setLoading(false);
      }
    },
    [paneId]
  );

  // A new pane (or the same pane connected again): start at its shell's folder, else home.
  const connected = Boolean(target?.connected);
  useEffect(() => {
    setEntries([]);
    setCwd("");
    setError(null);
    history.current = [];
    setBmPopover(null);
    setMissing(new Set());
    if (!paneId || !connected) return;
    let gone = false;
    void (async () => {
      try {
        const h = await backend.sftpHome(paneId);
        if (gone) return;
        setHome(h);
        await load(paneCwd.get(paneId) ?? h, { push: false, home: h });
      } catch (e) {
        if (!gone) setError(String(e));
      }
    })();
    return () => {
      gone = true;
    };
  }, [paneId, connected, load]);

  // Follow the terminal's directory (OSC 7).
  useEffect(() => {
    if (!settings.followCwd || !paneId) return;
    return paneCwd.subscribe((id, dir) => {
      if (id === paneId && dir !== cwdRef.current) void load(dir);
    });
  }, [settings.followCwd, paneId, load]);

  // Transfer queue and local edits (shared by all windows and panes).
  useEffect(() => {
    void backend.transferList().then(setTransfers);
    void backend.sftpEditList().then(setEdits);
    const un1 = backend.onTransferUpdate((info) =>
      setTransfers((list) => {
        const i = list.findIndex((x) => x.id === info.id);
        if (i < 0) return [...list, info];
        const next = [...list];
        next[i] = info;
        return next;
      })
    );
    const un2 = backend.onTransferRemoved((ids) => setTransfers((list) => list.filter((x) => !ids.includes(x.id))));
    const un3 = backend.onSftpEdit((info) =>
      setEdits((list) => (info.state === "stopped" ? list.filter((x) => x.id !== info.id) : list.some((x) => x.id === info.id) ? list.map((x) => (x.id === info.id ? info : x)) : [...list, info]))
    );
    return () => {
      void un1.then((f) => f());
      void un2.then((f) => f());
      void un3.then((f) => f());
    };
  }, []);

  // Uploads into the folder on screen refresh it when they finish.
  const doneSeen = useRef(new Set<string>());
  useEffect(() => {
    let refresh = false;
    for (const x of transfers) {
      if (x.state !== "done" || doneSeen.current.has(x.id)) continue;
      doneSeen.current.add(x.id);
      if (x.direction === "upload" && x.instanceId === paneId && parentOf(x.remotePath) === cwdRef.current) refresh = true;
    }
    if (refresh) void load(cwdRef.current, { keepSelection: true, push: false });
  }, [transfers, paneId, load]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = entries.filter((e) => (settings.showHidden || !e.name.startsWith(".")) && (!q || e.name.toLowerCase().includes(q)));
    return sortEntries(list, sort.key, sort.desc);
  }, [entries, filter, settings.showHidden, sort]);
  const selectedEntries = visible.filter((e) => selected.has(e.path));

  const refresh = () => void load(cwd, { keepSelection: true, push: false });
  const fail = (e: unknown) => onToast(String(e));

  // ------------------------------------------------------------------- transfers

  const options = (cleanup?: string): TransferRequest["options"] => ({
    conflict: settingsRef.current.conflict,
    preserveTimes: settingsRef.current.preserveTimes,
    protocol: settingsRef.current.protocol,
    cleanup: cleanup ?? null,
  });

  const uploadPaths = async (paths: string[], dir = cwd) => {
    if (!paneId || !paths.length) return;
    await backend.transferEnqueue(
      paths.map((p) => ({
        instanceId: paneId,
        direction: "upload",
        localPath: p,
        remotePath: joinRemote(dir, p.split(/[\\/]/).filter(Boolean).pop() ?? p),
        options: options(),
      }))
    );
    setQueueOpen(true);
    setQueueTab("transfers");
  };

  const downloadDir = async (pick: boolean): Promise<string | null> => {
    const fallback = settingsRef.current.downloadDir || (await systemDownloadDir().catch(() => ""));
    if (!pick && fallback) return fallback;
    const dir = await backend.pickDirectory(t("sftp.downloadTo"), fallback);
    if (dir && dir !== settingsRef.current.downloadDir) onSettings({ downloadDir: dir });
    return dir;
  };

  const download = async (list: RemoteEntry[], pick = false, instanceId = paneId) => {
    if (!instanceId || !list.length) return;
    const dir = await downloadDir(pick);
    if (!dir) return;
    await backend.transferEnqueue(
      list.map((e) => ({
        instanceId,
        direction: "download",
        localPath: joinLocal(dir, localName(e.name)),
        remotePath: e.path,
        isDir: isDirLike(e),
        options: options(),
      }))
    );
    setQueueOpen(true);
    setQueueTab("transfers");
  };

  const uploadFiles = async () => uploadPaths(await backend.pickFiles(t("sftp.uploadFiles")));
  const uploadFolders = async () => uploadPaths(await backend.pickDirectories(t("sftp.uploadFolders")));

  /** Files dropped from Explorer: copied to a staging folder (the webview has no paths), then queued. */
  const uploadDropped = async (dt: DataTransfer, dir: string) => {
    if (!paneId) return;
    const pane = paneId;
    let items: DropItem[];
    try {
      items = await collectDrop(dt);
    } catch (e) {
      return fail(e);
    }
    if (!items.length) return;
    const total = items.reduce((n, x) => n + x.bytes, 0);
    let done = 0;
    setStaging({ done, total });
    try {
      const requests: TransferRequest[] = [];
      for (const item of items) {
        const token = `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
        let base = "";
        for (const f of item.files) {
          base = await backend.sftpStage(token, f.rel, f.file, (n) => {
            done += n;
            setStaging({ done, total });
          });
        }
        requests.push({
          instanceId: pane,
          direction: "upload",
          localPath: joinLocal(base, item.name),
          remotePath: joinRemote(dir, item.name),
          options: options(base),
        });
      }
      await backend.transferEnqueue(requests);
      setQueueOpen(true);
      setQueueTab("transfers");
    } catch (e) {
      fail(e);
    } finally {
      setStaging(null);
    }
  };

  // ------------------------------------------------------------------- actions

  const open = (e: RemoteEntry) => {
    if (isDirLike(e)) return void load(e.path);
    if (!paneId || !target) return;
    if (previewKind(e.name)) onPreview({ instanceId: paneId, sessionLabel: target.title, path: e.path, name: e.name, size: e.size });
    else void download([e]);
  };

  const editLocal = async (e: { path: string }, instanceId = paneId) => {
    if (!instanceId) return;
    try {
      await backend.sftpEditStart(instanceId, e.path, settingsRef.current.editor);
      setQueueOpen(true);
      setQueueTab("edits");
    } catch (err) {
      fail(err);
    }
  };

  const remove = async (list: RemoteEntry[]) => {
    if (!paneId || !list.length) return;
    const dirs = list.filter((e) => e.kind === "dir").length;
    const a = await ask({
      title: t("sftp.deleteTitle"),
      message: list.length === 1 ? t("sftp.deleteOne", { name: list[0].name }) : t("sftp.deleteMany", { count: list.length }),
      detail: dirs ? t("sftp.deleteDirsNote") : undefined,
      okLabel: t("sftp.delete"),
      danger: true,
    });
    if (!a.ok) return;
    try {
      await backend.sftpRemove(paneId, list.map((e) => e.path));
    } catch (e) {
      fail(e);
    }
    refresh();
  };

  const moveInto = async (paths: string[], dir: string) => {
    if (!paneId) return;
    for (const p of paths) {
      if (p === dir || dir.startsWith(`${p}/`) || parentOf(p) === dir) continue;
      try {
        await backend.sftpRename(paneId, p, joinRemote(dir, baseName(p)));
      } catch (e) {
        fail(e);
        break;
      }
    }
    refresh();
  };

  const submitPrompt = async () => {
    if (!prompt || !paneId) return;
    const p = prompt;
    try {
      if (p.kind === "mkdir" || p.kind === "touch") {
        if (!validName(p.value)) return onToast(t("sftp.badName"));
        const path = joinRemote(cwd, p.value.trim());
        await (p.kind === "mkdir" ? backend.sftpMkdir(paneId, path) : backend.sftpTouch(paneId, path));
        setPrompt(null);
        await load(cwd, { push: false });
        setSelected(new Set([path]));
      } else if (p.kind === "rename") {
        if (!validName(p.value)) return onToast(t("sftp.badName"));
        if (p.value.trim() !== p.entry.name) await backend.sftpRename(paneId, p.entry.path, joinRemote(cwd, p.value.trim()));
        setPrompt(null);
        refresh();
      } else if (p.kind === "move") {
        const dir = resolveTyped(p.value, cwd, home);
        setPrompt(null);
        await moveInto(p.entries.map((e) => e.path), dir);
      } else if (p.kind === "symlink") {
        if (!validName(p.value) || !p.target.trim()) return onToast(t("sftp.badName"));
        await backend.sftpSymlink(paneId, joinRemote(cwd, p.value.trim()), p.target.trim());
        setPrompt(null);
        refresh();
      }
    } catch (e) {
      fail(e);
    }
  };

  const openProps = (list: RemoteEntry[]) => {
    if (!list.length) return;
    setProps({ entries: list, mode: list[0].mode != null ? modeOctal(list[0].mode) : "" });
  };

  const saveProps = async () => {
    if (!props || !paneId) return;
    const mode = parseOctal(props.mode);
    if (mode == null) return onToast(t("sftp.badMode"));
    try {
      await backend.sftpChmod(paneId, props.entries.map((e) => e.path), mode);
      setProps(null);
      refresh();
    } catch (e) {
      fail(e);
    }
  };

  const copyText = (text: string) => void backend.writeClipboard(text).then(() => onToast(t("sftp.copied")));

  const cdTerminalTo = (dir: string) => {
    if (paneId) onTerminalInput(paneId, ` cd '${dir.replace(/'/g, "'\\''")}'\r`);
  };

  const cdTerminal = () => {
    if (cwd) cdTerminalTo(cwd);
  };

  // ------------------------------------------------------------------- bookmarks

  const shownBookmarks = useMemo(() => bookmarksFor(settings.bookmarks, hostKey).all, [settings.bookmarks, hostKey]);
  const bookmarkedDirs = useMemo(() => new Set(shownBookmarks.map((b) => expandHome(b.path, home))), [shownBookmarks, home]);
  const recent = recentMap[hostKey] ?? [];
  const bookmarkOf = (abs: string) => findBookmark(settingsRef.current.bookmarks, hostKey, abs, home);
  const saveBookmarks = (next: SftpBookmark[]) => onSettings({ bookmarks: next });

  const addBm = (abs: string, host: string, beforeId?: string | null) => {
    const cur = settingsRef.current.bookmarks;
    const next = addBookmark(cur, { abs, home, host, hostKey, beforeId });
    if (next === cur) return;
    // Later adds in the same event (several dropped folders) build on this one.
    settingsRef.current = { ...settingsRef.current, bookmarks: next };
    saveBookmarks(next);
    onToast(t("sftp.bm.added", { path: tildePath(abs, home) }));
  };

  const toggleBookmark = (abs = cwd) => {
    if (!abs || !hostKey) return;
    const b = bookmarkOf(abs);
    if (b) {
      saveBookmarks(removeBookmark(settingsRef.current.bookmarks, b.id));
      onToast(t("sftp.bm.removed", { path: tildePath(abs, home) }));
    } else addBm(abs, hostKey);
  };

  /** Open a bookmarked / recent folder; with Alt the terminal cds there too. */
  const openFolder = async (abs: string, alsoTerminal: boolean) => {
    if (await load(abs)) {
      if (alsoTerminal) cdTerminalTo(abs);
      return;
    }
    setMissing((m) => new Set([...m, abs]));
    onToast(t("sftp.bm.missing", { path: tildePath(abs, home) }));
  };

  /** Folders among the file rows being dragged (readable on drop only). */
  const draggedDirs = (e: React.DragEvent): string[] | null => {
    const raw = e.dataTransfer.getData(ROW_DRAG);
    if (!raw) return null;
    try {
      const paths = JSON.parse(raw) as string[];
      return paths.filter((path) => entries.some((x) => x.path === path && isDirLike(x)));
    } catch {
      return null;
    }
  };

  const suggestions = editingPath === null ? [] : pathCandidates(editingPath, { bookmarks: shownBookmarks, recent, home, cwd });
  const cwdBookmarked = Boolean(cwd && hostKey && findBookmark(settings.bookmarks, hostKey, cwd, home));

  const goTerminalCwd = () => {
    const dir = paneId ? paneCwd.get(paneId) : undefined;
    if (dir) void load(dir);
    else onToast(t("sftp.noTerminalCwd"));
  };

  // ------------------------------------------------------------------- selection / keys

  const clickRow = (e: React.MouseEvent, entry: RemoteEntry) => {
    const path = entry.path;
    if (e.shiftKey && anchor.current) {
      const a = visible.findIndex((x) => x.path === anchor.current);
      const b = visible.findIndex((x) => x.path === path);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      const range = visible.slice(lo, hi + 1).map((x) => x.path);
      setSelected(new Set(e.ctrlKey ? [...selected, ...range] : range));
      return;
    }
    anchor.current = path;
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      setSelected(next);
    } else setSelected(new Set([path]));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const one = selectedEntries.length === 1 ? selectedEntries[0] : null;
    if (e.key === "Enter" && one) open(one);
    else if (e.key === "Backspace") void load(parentOf(cwd));
    else if (e.key === "Delete") void remove(selectedEntries);
    else if (e.key === "F2" && one) setPrompt({ kind: "rename", entry: one, value: one.name });
    else if (e.key === "F5") refresh();
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") setSelected(new Set(visible.map((x) => x.path)));
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") toggleBookmark();
    else if ((e.ctrlKey || e.metaKey) && /^[1-9]$/.test(e.key) && shownBookmarks[Number(e.key) - 1])
      void openFolder(expandHome(shownBookmarks[Number(e.key) - 1].path, home), e.altKey);
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const i = visible.findIndex((x) => x.path === anchor.current);
      const n = Math.max(0, Math.min(visible.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)));
      if (visible[n]) {
        anchor.current = visible[n].path;
        setSelected(new Set([visible[n].path]));
        listRef.current?.querySelector(`[data-index="${n}"]`)?.scrollIntoView({ block: "nearest" });
      }
    } else return;
    e.preventDefault();
  };

  // ------------------------------------------------------------------- menus

  /** "Add to bookmarks ▸ this server / all servers", or "Remove bookmark". */
  const bookmarkMenuItem = (abs: string): MenuItem | null => {
    if (!hostKey || !abs) return null;
    if (bookmarkOf(abs)) return { label: t("sftp.bm.unbookmark"), icon: <Star size={13} fill="currentColor" />, onClick: () => toggleBookmark(abs) };
    return {
      label: t("sftp.bm.add"),
      icon: <Star size={13} />,
      children: [
        { label: t("sftp.bm.addOwn"), onClick: () => addBm(abs, hostKey) },
        { label: t("sftp.bm.addGlobal"), onClick: () => addBm(abs, "") },
      ],
    };
  };

  const rowMenu = (ev: React.MouseEvent, entry: RemoteEntry | null) => {
    ev.preventDefault();
    ev.stopPropagation();
    let list = selectedEntries;
    if (entry && !selected.has(entry.path)) {
      setSelected(new Set([entry.path]));
      anchor.current = entry.path;
      list = [entry];
    }
    if (!entry) list = [];
    const one = list.length === 1 ? list[0] : null;
    const items: (MenuItem | false | null)[] = one
      ? [
          { label: isDirLike(one) ? t("sftp.open") : t("sftp.preview.open"), icon: isDirLike(one) ? <FolderOpen size={13} /> : <Eye size={13} />, onClick: () => open(one) },
          !isDirLike(one) && { label: t("sftp.editLocal"), icon: <PencilLine size={13} />, onClick: () => void editLocal(one) },
          isDirLike(one) && bookmarkMenuItem(one.path),
          { type: "separator" },
        ]
      : [];
    if (list.length) {
      items.push(
        { label: t("sftp.download"), icon: <Download size={13} />, onClick: () => void download(list) },
        { label: t("sftp.downloadTo"), icon: <FolderInput size={13} />, onClick: () => void download(list, true) },
        { type: "separator" },
        one && { label: t("sftp.rename"), shortcut: "F2", onClick: () => setPrompt({ kind: "rename", entry: one, value: one.name }) },
        { label: t("sftp.moveTo"), onClick: () => setPrompt({ kind: "move", entries: list, value: cwd }) },
        {
          label: t("sftp.copyPath"),
          icon: <Copy size={13} />,
          onClick: () => copyText(list.map((e) => e.path).join("\n")),
        },
        { label: t("sftp.delete"), icon: <Trash2 size={13} />, danger: true, shortcut: "Del", onClick: () => void remove(list) },
        { type: "separator" },
        { label: t("sftp.properties"), onClick: () => openProps(list) },
        { type: "separator" }
      );
    }
    items.push(
      { label: t("sftp.newFolder"), icon: <FolderPlus size={13} />, onClick: () => setPrompt({ kind: "mkdir", value: "" }) },
      { label: t("sftp.newFile"), icon: <FilePlus size={13} />, onClick: () => setPrompt({ kind: "touch", value: "" }) },
      {
        label: t("sftp.newSymlink"),
        icon: <Link2 size={13} />,
        onClick: () => setPrompt({ kind: "symlink", value: one ? `${one.name}.link` : "", target: one ? one.path : "" }),
      },
      { type: "separator" },
      { label: t("sftp.uploadFiles"), icon: <Upload size={13} />, onClick: () => void uploadFiles() },
      { label: t("sftp.uploadFolders"), icon: <FolderUp size={13} />, onClick: () => void uploadFolders() },
      { type: "separator" },
      { label: t("sftp.cdTerminal"), icon: <SquareTerminal size={13} />, onClick: cdTerminal },
      !entry && bookmarkMenuItem(cwd),
      { label: t("sftp.refresh"), shortcut: "F5", icon: <RefreshCw size={13} />, onClick: refresh }
    );
    openMenu(ev, items.filter((x): x is MenuItem => Boolean(x)));
  };

  const optionsMenu = (ev: React.MouseEvent) => {
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    const conflict = (v: SftpSettings["conflict"]) => ({
      label: t(`sftp.conflict.${v}`),
      checked: settings.conflict === v,
      onClick: () => onSettings({ conflict: v }),
    });
    openMenu({ clientX: r.left, clientY: r.bottom + 4 }, [
      { label: t("sftp.showHidden"), checked: settings.showHidden, onClick: () => onSettings({ showHidden: !settings.showHidden }) },
      { label: t("sftp.followCwd"), checked: settings.followCwd, onClick: () => onSettings({ followCwd: !settings.followCwd }) },
      { label: t("sftp.preserveTimes"), checked: settings.preserveTimes, onClick: () => onSettings({ preserveTimes: !settings.preserveTimes }) },
      { type: "separator" },
      {
        label: t("sftp.conflictTitle"),
        children: [conflict("ask"), conflict("overwrite"), conflict("newer"), conflict("rename"), conflict("skip")],
      },
      {
        label: t("sftp.protocol"),
        children: (["auto", "sftp", "scp"] as const).map((v) => ({
          label: t(`sftp.protocolOpt.${v}`),
          checked: settings.protocol === v,
          onClick: () => onSettings({ protocol: v }),
        })),
      },
      {
        label: t("sftp.concurrency"),
        children: [1, 2, 3, 4, 6, 8].map((n) => ({
          label: String(n),
          checked: settings.concurrency === n,
          onClick: () => onSettings({ concurrency: n }),
        })),
      },
    ]);
  };

  // ------------------------------------------------------------------- drag and drop

  const dropProps = (dir: string) => ({
    onDragEnter: (e: React.DragEvent) => {
      if (!isFileDrag(e) && !e.dataTransfer.types.includes(ROW_DRAG)) return;
      e.preventDefault();
      e.stopPropagation();
      setDropOver(dir);
    },
    onDragOver: (e: React.DragEvent) => {
      const files = isFileDrag(e);
      if (!files && !e.dataTransfer.types.includes(ROW_DRAG)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = files ? "copy" : "move";
      if (dropOver !== dir) setDropOver(dir);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDropOver(null);
      if (!connected) return onToast(t("sftp.notConnected"));
      const rows = e.dataTransfer.getData(ROW_DRAG);
      if (rows) return void moveInto(JSON.parse(rows) as string[], dir);
      if (isFileDrag(e)) void uploadDropped(e.dataTransfer, dir);
    },
  });

  // ------------------------------------------------------------------- render

  const sortHead = (key: SortKey, label: string, cls: string) => (
    <span className={`sftp-col ${cls} ${sort.key === key ? "sorted" : ""}`} onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : false }))}>
      {label}
      {sort.key === key && (sort.desc ? " ▾" : " ▴")}
    </span>
  );

  const active = transfers.filter((x) => !["done", "error", "cancelled"].includes(x.state)).length;
  const finished = transfers.length - active;
  const shownTransfers = [...transfers].reverse();
  const totalSpeed = transfers.reduce((n, x) => n + (x.state === "running" ? x.speed : 0), 0);

  return (
    <aside className="side-panel sftp-panel" onKeyDown={onKeyDown} tabIndex={-1}>
      <div className="side-panel-header">
        <HardDrive size={14} /> {t("sftp.title")}
        {targets.length > 1 ? (
          <select className="text-input input-sm sftp-target" value={paneId ?? ""} onChange={(e) => setPaneId(e.target.value)}>
            {targets.map((x) => (
              <option key={x.paneId} value={x.paneId}>
                {x.title}
                {x.connected ? "" : ` (${t("sftp.offline")})`}
              </option>
            ))}
          </select>
        ) : (
          target && <span className="sftp-target-name">{target.title}</span>
        )}
        <button type="button" className="icon-btn-xs" title={t("forward.close")} onClick={onClose}>
          <X size={13} />
        </button>
      </div>

      {!target ? (
        <div className="side-panel-empty">{t("sftp.noSsh")}</div>
      ) : !target.connected ? (
        <div className="side-panel-empty">{t("sftp.notConnected")}</div>
      ) : (
        <>
          <div className="sftp-toolbar">
            <button type="button" className="icon-btn-xs" title={t("sftp.back")} disabled={!history.current.length} onClick={() => {
              const prev = history.current.pop();
              if (prev) void load(prev, { push: false });
            }}>
              <RotateCcw size={13} />
            </button>
            <button type="button" className="icon-btn-xs" title={t("sftp.up")} disabled={cwd === "/"} onClick={() => void load(parentOf(cwd))}>
              <ArrowUp size={13} />
            </button>
            <button type="button" className="icon-btn-xs" title={t("sftp.home")} onClick={() => void load(home)}>
              <Home size={13} />
            </button>
            <button type="button" className="icon-btn-xs" title={t("sftp.refresh")} onClick={refresh}>
              <RefreshCw size={13} className={loading ? "spin" : ""} />
            </button>
            <span className="sftp-sep" />
            <button type="button" className="icon-btn-xs" title={t("sftp.goTerminalCwd")} onClick={goTerminalCwd}>
              <Locate size={13} />
            </button>
            <button
              type="button"
              className={`icon-btn-xs ${settings.followCwd ? "active" : ""}`}
              title={t("sftp.followCwd")}
              onClick={() => onSettings({ followCwd: !settings.followCwd })}
            >
              <Link2 size={13} />
            </button>
            <button type="button" className="icon-btn-xs" title={t("sftp.cdTerminal")} onClick={cdTerminal}>
              <SquareTerminal size={13} />
            </button>
            <span className="sftp-sep" />
            <button type="button" className="icon-btn-xs" title={t("sftp.uploadFiles")} onClick={() => void uploadFiles()}>
              <Upload size={13} />
            </button>
            <button type="button" className="icon-btn-xs" title={t("sftp.uploadFolders")} onClick={() => void uploadFolders()}>
              <FolderUp size={13} />
            </button>
            <button type="button" className="icon-btn-xs" title={t("sftp.download")} disabled={!selectedEntries.length} onClick={() => void download(selectedEntries)}>
              <Download size={13} />
            </button>
            <button type="button" className="icon-btn-xs" title={t("sftp.newFolder")} onClick={() => setPrompt({ kind: "mkdir", value: "" })}>
              <FolderPlus size={13} />
            </button>
            <button
              type="button"
              className={`icon-btn-xs ${settings.showHidden ? "active" : ""}`}
              title={t("sftp.showHidden")}
              onClick={() => onSettings({ showHidden: !settings.showHidden })}
            >
              {settings.showHidden ? <Eye size={13} /> : <EyeOff size={13} />}
            </button>
            <button type="button" className="icon-btn-xs" title={t("sftp.options")} onClick={optionsMenu}>
              <ChevronDown size={13} />
            </button>
          </div>

          {editingPath !== null ? (
            <div className="sftp-pathwrap">
              <input
                className="text-input input-sm mono sftp-pathbar"
                autoFocus
                spellCheck={false}
                value={editingPath}
                onChange={(e) => {
                  setEditingPath(e.target.value);
                  setSuggest(-1);
                }}
                onBlur={() => setEditingPath(null)}
                onKeyDown={(e) => {
                  if ((e.key === "ArrowDown" || e.key === "ArrowUp") && suggestions.length) {
                    e.preventDefault();
                    const n = suggestions.length;
                    setSuggest((i) => (e.key === "ArrowDown" ? (i + 1) % n : i <= 0 ? n - 1 : i - 1));
                  } else if (e.key === "Tab" && suggestions.length) {
                    e.preventDefault();
                    setEditingPath(suggestions[Math.max(0, suggest)].shown);
                    setSuggest(-1);
                  } else if (e.key === "Enter") {
                    const pick = suggest >= 0 ? suggestions[suggest] : undefined;
                    if (pick) void openFolder(pick.abs, e.altKey);
                    else void load(resolveTyped(editingPath, cwd, home));
                    setEditingPath(null);
                  } else if (e.key === "Escape") setEditingPath(null);
                }}
              />
              {suggestions.length > 0 && (
                <div className="sftp-suggest">
                  {suggestions.map((c, i) => (
                    <div
                      key={c.abs}
                      className={`bm-row ${i === suggest ? "cursor" : ""}`}
                      title={c.abs}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setEditingPath(null);
                        void openFolder(c.abs, e.altKey);
                      }}
                    >
                      {c.kind === "bookmark" ? <Star size={12} className="bm-ico own" fill="currentColor" /> : <Clock size={12} className="bm-ico recent" />}
                      <span className="bm-row-text">
                        {c.label && <span className="bm-row-label">{c.label}</span>}
                        <span className="bm-row-path mono strong">{c.shown}</span>
                      </span>
                      <span className="bm-kind">{c.kind === "bookmark" ? t("sftp.bm.kindBookmark") : t("sftp.bm.kindRecent")}</span>
                    </div>
                  ))}
                  <div className="sftp-suggest-hint">{t("sftp.bm.suggestHint")}</div>
                </div>
              )}
            </div>
          ) : (
            <div className="sftp-crumbs mono" onClick={() => setEditingPath(cwd)} title={t("sftp.editPath")}>
              {crumbs(cwd).map((c, i) => (
                <React.Fragment key={c.path}>
                  {i > 1 && <ChevronRight size={11} className="muted" />}
                  <span
                    className={`sftp-crumb ${dropOver === c.path ? "drop" : ""}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void load(c.path);
                    }}
                    {...dropProps(c.path)}
                  >
                    {c.name}
                  </span>
                </React.Fragment>
              ))}
              {hostKey && cwd && (
                <button
                  type="button"
                  className={`sftp-crumb-star ${cwdBookmarked ? "on" : ""}`}
                  title={cwdBookmarked ? t("sftp.bm.unbookmarkKey") : t("sftp.bm.bookmarkKey")}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleBookmark();
                  }}
                >
                  <Star size={14} fill={cwdBookmarked ? "currentColor" : "none"} />
                </button>
              )}
            </div>
          )}

          {hostKey && (
            <SftpBookmarkBar
              hostKey={hostKey}
              hostTitle={target.title}
              home={home}
              cwd={cwd}
              bookmarks={settings.bookmarks}
              onBookmarks={saveBookmarks}
              recent={recent}
              onForgetRecent={(dir) => updateRecent((m) => forgetRecent(m, hostKey, dir))}
              missing={missing}
              popover={bmPopover}
              onPopover={setBmPopover}
              onOpen={(abs, alt) => void openFolder(abs, alt)}
              onCdTerminal={cdTerminalTo}
              onAdd={addBm}
              onToggleCurrent={() => toggleBookmark()}
              draggedDirs={draggedDirs}
              rowDragType={ROW_DRAG}
            />
          )}

          <input className="text-input input-sm sftp-filter" placeholder={t("sftp.filter")} value={filter} onChange={(e) => setFilter(e.target.value)} />

          <div className="sftp-head">
            {sortHead("name", t("sftp.colName"), "name")}
            {sortHead("size", t("sftp.colSize"), "size")}
            {sortHead("mtime", t("sftp.colTime"), "time")}
          </div>

          <div
            ref={listRef}
            className={`sftp-list ${dropOver === cwd ? "drop" : ""}`}
            onContextMenu={(e) => rowMenu(e, null)}
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setSelected(new Set());
              listRef.current?.closest<HTMLElement>(".sftp-panel")?.focus();
            }}
            {...dropProps(cwd)}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropOver(null);
            }}
          >
            {error && <div className="sftp-error">{error}</div>}
            {!error && !loading && visible.length === 0 && <div className="side-panel-empty">{filter ? t("sftp.noMatch") : t("sftp.empty")}</div>}
            {visible.map((e, i) => {
              const dirLike = isDirLike(e);
              const rowDrop = dirLike ? dropProps(e.path) : {};
              return (
                <div
                  key={e.path}
                  data-index={i}
                  className={`sftp-row ${selected.has(e.path) ? "selected" : ""} ${dropOver === e.path ? "drop" : ""} ${e.name.startsWith(".") ? "hidden-file" : ""}`}
                  onMouseDown={(ev) => ev.button === 0 && clickRow(ev, e)}
                  onDoubleClick={() => open(e)}
                  onContextMenu={(ev) => rowMenu(ev, e)}
                  draggable
                  onDragStart={(ev) => {
                    const paths = selected.has(e.path) ? selectedEntries.map((x) => x.path) : [e.path];
                    ev.dataTransfer.setData(ROW_DRAG, JSON.stringify(paths));
                    ev.dataTransfer.effectAllowed = "move";
                  }}
                  {...rowDrop}
                  title={e.kind === "link" && e.linkTarget ? `${e.name} → ${e.linkTarget}` : e.name}
                >
                  <span className="sftp-col name">
                    {dirLike ? <Folder size={13} className="sftp-ico dir" /> : <FileIcon size={13} className="sftp-ico" />}
                    {e.kind === "link" && <Link2 size={9} className="sftp-link-badge" />}
                    <span className="sftp-name">{e.name}</span>
                    {dirLike && bookmarkedDirs.has(e.path) && <Star size={10} className="sftp-row-star" fill="currentColor" />}
                  </span>
                  <span className="sftp-col size">{dirLike ? "" : fmtSize(e.size)}</span>
                  <span className="sftp-col time" title={modeString(e.mode, e.kind)}>
                    {fmtTime(e.mtime)}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="sftp-status muted">
            {t("sftp.count", { count: visible.length })}
            {selectedEntries.length > 0 && ` · ${t("sftp.selectedCount", { count: selectedEntries.length })}`}
            {selectedEntries.length > 0 && ` · ${fmtSize(selectedEntries.filter((x) => !isDirLike(x)).reduce((n, x) => n + x.size, 0))}`}
            {mode === "scp" && (
              <span className="sftp-proto" title={t("sftp.scpModeHint")}>
                SCP
              </span>
            )}
            <span className="sftp-drop-hint">{t("sftp.dropHint")}</span>
          </div>
        </>
      )}

      {staging && (
        <div className="sftp-staging">
          {t("sftp.preparing")} {fmtSize(staging.done)} / {fmtSize(staging.total)}
          <div className="zmodem-bar">
            <div style={{ width: `${staging.total ? Math.round((staging.done * 100) / staging.total) : 0}%` }} />
          </div>
        </div>
      )}

      <div className={`sftp-queue ${queueOpen ? "open" : ""}`}>
        <div className="sftp-queue-head">
          <button type="button" className="sftp-queue-toggle" onClick={() => setQueueOpen((v) => !v)}>
            {queueOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
          <button type="button" className={`adv-tab ${queueTab === "transfers" ? "active" : ""}`} onClick={() => (setQueueTab("transfers"), setQueueOpen(true))}>
            {t("sftp.transfers")}
            {active > 0 && <span className="sftp-badge">{active}</span>}
          </button>
          <button type="button" className={`adv-tab ${queueTab === "edits" ? "active" : ""}`} onClick={() => (setQueueTab("edits"), setQueueOpen(true))}>
            {t("sftp.edits")}
            {edits.length > 0 && <span className="sftp-badge">{edits.length}</span>}
          </button>
          {totalSpeed > 0 && <span className="muted sftp-speed">{fmtSize(totalSpeed)}/s</span>}
          {queueTab === "transfers" && finished > 0 && (
            <button type="button" className="icon-btn-xs sftp-clear" title={t("sftp.clearFinished")} onClick={() => void backend.transferRemove()}>
              <Trash2 size={12} />
            </button>
          )}
        </div>
        {queueOpen && queueTab === "transfers" && (
          <div className="sftp-queue-list">
            {shownTransfers.length === 0 && <div className="side-panel-empty">{t("sftp.noTransfers")}</div>}
            {shownTransfers.map((x) => (
              <TransferRow
                key={x.id}
                info={x}
                applyAll={applyAll}
                onApplyAll={setApplyAll}
                onAction={(a) => void backend.transferAction(a, x.id)}
                onAnswer={(a) => void backend.transferAnswer(x.id, a, applyAll)}
                onRemove={() => void backend.transferRemove([x.id])}
                onReveal={() => x.localPath && void backend.revealPath(x.localPath).catch(fail)}
                onOpen={() => x.localPath && void backend.openLocalPath(x.localPath).catch(fail)}
              />
            ))}
          </div>
        )}
        {queueOpen && queueTab === "edits" && (
          <div className="sftp-queue-list">
            {edits.length === 0 && <div className="side-panel-empty">{t("sftp.noEdits")}</div>}
            {edits.map((x) => (
              <div key={x.id} className={`sftp-xfer ${x.state}`}>
                <div className="sftp-xfer-line">
                  <PencilLine size={12} />
                  <span className="sftp-xfer-name" title={x.remotePath}>
                    {baseName(x.remotePath)}
                  </span>
                  <span className="sftp-xfer-state">{t(`sftp.editState.${x.state}`)}</span>
                  {x.state === "error" && (
                    <button type="button" className="icon-btn-xs" title={t("sftp.retry")} onClick={() => void backend.sftpEditRetry(x.id)}>
                      <RotateCcw size={11} />
                    </button>
                  )}
                  <button type="button" className="icon-btn-xs" title={t("sftp.openLocal")} onClick={() => void backend.openLocalPath(x.localPath).catch(fail)}>
                    <FolderOpen size={11} />
                  </button>
                  <button type="button" className="icon-btn-xs" title={t("sftp.stopEdit")} onClick={() => void backend.sftpEditStop(x.id)}>
                    <Square size={10} />
                  </button>
                </div>
                <div className="sftp-xfer-sub muted">
                  {x.error ? <span className="warn">{x.error}</span> : x.uploads > 0 ? t("sftp.editUploaded", { count: x.uploads, time: fmtTime(Math.floor((x.lastUpload ?? 0) / 1000)) }) : t("sftp.editHint")}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {prompt && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setPrompt(null)}>
          <div className="modal-panel sftp-prompt">
            <div className="modal-header">
              <h3>
                {prompt.kind === "mkdir"
                  ? t("sftp.newFolder")
                  : prompt.kind === "touch"
                  ? t("sftp.newFile")
                  : prompt.kind === "rename"
                  ? t("sftp.rename")
                  : prompt.kind === "move"
                  ? t("sftp.moveTo")
                  : t("sftp.newSymlink")}
              </h3>
            </div>
            <div className="modal-body">
              {prompt.kind === "move" && <p className="muted">{t("sftp.moveHint", { count: prompt.entries.length })}</p>}
              {prompt.kind === "symlink" && (
                <label className="field">
                  <span>{t("sftp.linkTarget")}</span>
                  <input
                    className="text-input mono"
                    value={prompt.target}
                    placeholder="/path/to/target"
                    onChange={(e) => setPrompt({ ...prompt, target: e.target.value })}
                  />
                </label>
              )}
              <label className="field">
                {prompt.kind === "symlink" && <span>{t("sftp.linkName")}</span>}
                <input
                  className="text-input mono"
                  autoFocus
                  value={prompt.value}
                  onFocus={(e) => {
                    // Rename: select the name without its extension.
                    if (prompt.kind === "rename") {
                      const dot = prompt.value.lastIndexOf(".");
                      e.target.setSelectionRange(0, dot > 0 ? dot : prompt.value.length);
                    }
                  }}
                  onChange={(e) => setPrompt({ ...prompt, value: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void submitPrompt();
                    if (e.key === "Escape") setPrompt(null);
                  }}
                />
              </label>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn-ghost" onClick={() => setPrompt(null)}>
                {t("confirm.cancel")}
              </button>
              <button type="button" className="btn-primary" onClick={() => void submitPrompt()}>
                {t("confirm.ok")}
              </button>
            </div>
          </div>
        </div>
      )}

      {props && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setProps(null)}>
          <div className="modal-panel sftp-prompt">
            <div className="modal-header">
              <h3>{t("sftp.properties")}</h3>
            </div>
            <div className="modal-body">
              {props.entries.length === 1 ? (
                <div className="hostkey-facts">
                  <span>{t("sftp.colName")}</span>
                  <b>{props.entries[0].name}</b>
                  <span>{t("sftp.path")}</span>
                  <code>{props.entries[0].path}</code>
                  {props.entries[0].kind === "link" && (
                    <>
                      <span>{t("sftp.linkTarget")}</span>
                      <code>{props.entries[0].linkTarget}</code>
                    </>
                  )}
                  <span>{t("sftp.colSize")}</span>
                  <b>
                    {fmtSize(props.entries[0].size)} ({props.entries[0].size.toLocaleString()} B)
                  </b>
                  <span>{t("sftp.colTime")}</span>
                  <b>{fmtTime(props.entries[0].mtime)}</b>
                  <span>{t("sftp.owner")}</span>
                  <b>
                    {props.entries[0].user ?? props.entries[0].uid ?? "?"}:{props.entries[0].group ?? props.entries[0].gid ?? "?"}
                  </b>
                </div>
              ) : (
                <p>{t("sftp.selectedCount", { count: props.entries.length })}</p>
              )}
              <PermissionEditor value={props.mode} onChange={(mode) => setProps({ ...props, mode })} />
            </div>
            <div className="modal-footer">
              <button type="button" className="btn-ghost" onClick={() => setProps(null)}>
                {t("confirm.cancel")}
              </button>
              <button type="button" className="btn-primary" onClick={() => void saveProps()}>
                {t("confirm.ok")}
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
};

/** rwx checkboxes bound to an octal text box. */
const PermissionEditor: React.FC<{ value: string; onChange: (v: string) => void }> = ({ value, onChange }) => {
  const { t } = useTranslation();
  const mode = parseOctal(value);
  const bit = (b: number) => mode != null && (mode & b) !== 0;
  const toggle = (b: number) => onChange(modeOctal(((mode ?? 0) ^ b) & 0o7777));
  const who = [
    { label: t("sftp.permOwner"), shift: 6 },
    { label: t("sftp.permGroup"), shift: 3 },
    { label: t("sftp.permOther"), shift: 0 },
  ];
  return (
    <div className="sftp-perms">
      <div className="sftp-perm-grid">
        <span />
        <span className="muted">r</span>
        <span className="muted">w</span>
        <span className="muted">x</span>
        {who.map((w) => (
          <React.Fragment key={w.shift}>
            <span>{w.label}</span>
            {[4, 2, 1].map((b) => (
              <input key={b} type="checkbox" checked={bit(b << w.shift)} onChange={() => toggle(b << w.shift)} />
            ))}
          </React.Fragment>
        ))}
      </div>
      <label className="field">
        <span>{t("sftp.octal")}</span>
        <input className="text-input input-sm mono" value={value} onChange={(e) => onChange(e.target.value)} />
        {mode != null && <span className="mono muted">{modeString(mode)}</span>}
      </label>
    </div>
  );
};

const TransferRow: React.FC<{
  info: TransferInfo;
  applyAll: boolean;
  onApplyAll: (v: boolean) => void;
  onAction: (a: "pause" | "resume" | "cancel" | "retry") => void;
  onAnswer: (a: "overwrite" | "skip" | "rename" | "cancel") => void;
  onRemove: () => void;
  onReveal: () => void;
  onOpen: () => void;
}> = ({ info: x, applyAll, onApplyAll, onAction, onAnswer, onRemove, onReveal, onOpen }) => {
  const { t } = useTranslation();
  const pct = x.total ? Math.min(100, Math.round((x.transferred * 100) / x.total)) : x.state === "done" ? 100 : 0;
  const live = ["queued", "running", "paused", "conflict"].includes(x.state);
  const retryable = (x.state === "error" || x.state === "cancelled") && ["", "sftp", "scp"].includes(x.protocol);
  return (
    <div className={`sftp-xfer ${x.state}`}>
      <div className="sftp-xfer-line">
        {x.direction === "upload" ? <Upload size={12} /> : <Download size={12} />}
        <span className="sftp-xfer-name" title={`${x.label}: ${x.remotePath || x.name}${x.localPath ? `\n${x.localPath}` : ""}`}>
          {x.isDir && <Folder size={11} className="sftp-ico dir" />} {x.name}
        </span>
        {x.protocol && <span className="sftp-proto">{x.protocol.toUpperCase()}</span>}
        <span className="sftp-xfer-state">{t(`sftp.state.${x.state}`)}</span>
        {x.state === "running" && (
          <button type="button" className="icon-btn-xs" title={t("sftp.pause")} onClick={() => onAction("pause")}>
            <Pause size={11} />
          </button>
        )}
        {x.state === "paused" && (
          <button type="button" className="icon-btn-xs" title={t("sftp.resume")} onClick={() => onAction("resume")}>
            <Play size={11} />
          </button>
        )}
        {live && (
          <button type="button" className="icon-btn-xs" title={t("sftp.cancel")} onClick={() => onAction("cancel")}>
            <X size={11} />
          </button>
        )}
        {retryable && (
          <button type="button" className="icon-btn-xs" title={t("sftp.retry")} onClick={() => onAction("retry")}>
            <RotateCcw size={11} />
          </button>
        )}
        {x.state === "done" && x.localPath && (
          <>
            {!x.isDir && x.direction === "download" && (
              <button type="button" className="icon-btn-xs" title={t("sftp.openLocal")} onClick={onOpen}>
                <Check size={11} />
              </button>
            )}
            <button type="button" className="icon-btn-xs" title={t("sftp.reveal")} onClick={onReveal}>
              <FolderOpen size={11} />
            </button>
          </>
        )}
        {!live && (
          <button type="button" className="icon-btn-xs" title={t("sftp.removeEntry")} onClick={onRemove}>
            <Trash2 size={11} />
          </button>
        )}
      </div>
      {(x.state === "running" || x.state === "paused" || x.state === "conflict") && (
        <div className="zmodem-bar">
          <div style={{ width: `${pct}%` }} />
        </div>
      )}
      <div className="sftp-xfer-sub muted">
        {x.state === "error" ? (
          <span className="warn">{x.error}</span>
        ) : (
          <>
            {x.label && <span>{x.label} · </span>}
            {x.total > 0 && `${fmtSize(x.transferred)} / ${fmtSize(x.total)}`}
            {x.filesTotal > 1 && ` · ${x.filesDone}/${x.filesTotal}`}
            {x.skipped > 0 && ` · ${t("sftp.skippedCount", { count: x.skipped })}`}
            {x.state === "running" && x.speed > 0 && ` · ${fmtSize(x.speed)}/s`}
            {x.state === "running" && x.speed > 0 && fmtEta(x.total - x.transferred, x.speed) && ` · ${fmtEta(x.total - x.transferred, x.speed)}`}
            {x.state === "running" && x.current && x.filesTotal > 1 && <div className="sftp-xfer-current mono">{x.current}</div>}
          </>
        )}
      </div>
      {x.state === "conflict" && x.conflict && (
        <div className="sftp-conflict">
          <div>{t("sftp.conflictAsk", { name: baseName(x.conflict.path) })}</div>
          <div className="muted">
            {t("sftp.conflictSrc")}: {fmtSize(x.conflict.srcSize)} {fmtTime(x.conflict.srcMtime)} · {t("sftp.conflictDst")}: {fmtSize(x.conflict.dstSize)}{" "}
            {fmtTime(x.conflict.dstMtime)}
          </div>
          <div className="sftp-conflict-actions">
            <button type="button" className="btn-primary btn-sm" onClick={() => onAnswer("overwrite")}>
              {t("sftp.conflict.overwrite")}
            </button>
            <button type="button" className="btn-secondary btn-sm" onClick={() => onAnswer("rename")}>
              {t("sftp.conflict.rename")}
            </button>
            <button type="button" className="btn-secondary btn-sm" onClick={() => onAnswer("skip")}>
              {t("sftp.conflict.skip")}
            </button>
            <button type="button" className="btn-ghost btn-sm" onClick={() => onAnswer("cancel")}>
              {t("sftp.cancel")}
            </button>
          </div>
          <label className="checkbox-row">
            <input type="checkbox" checked={applyAll} onChange={(e) => onApplyAll(e.target.checked)} />
            <span>{t("sftp.applyAll")}</span>
          </label>
        </div>
      )}
    </div>
  );
};
