import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, CircleAlert, Clock, Ellipsis, Globe, GripVertical, Pencil, Pin, Server, SquareTerminal, Star, X } from "lucide-react";
import type { SftpBookmark } from "../types/domain";
import { useContextMenu } from "./ContextMenu";
import {
  bookmarkLabel,
  bookmarksFor,
  expandHome,
  moveBookmark,
  removeBookmark,
  renameBookmark,
  setBookmarkHost,
  tildePath,
} from "../utils/sftpBookmarks";

/** Drag of a bookmark (reorder on the bar / in the list). */
const BM_DRAG = "application/x-nexterm-sftp-bookmark";

/** Height the chips may take before the rest go into "⋯" (two rows of 24px + gap). */
const BAR_MAX = 52;

export type BookmarkPopover = "all" | "recent" | null;

/** Inline rename of a bookmark (Enter / blur saves, Esc cancels: `onDone(null)`). */
const RenameBox: React.FC<{ initial: string; onDone: (value: string | null) => void }> = ({ initial, onDone }) => {
  const [value, setValue] = useState(initial);
  const finished = useRef(false);
  const done = (v: string | null) => {
    if (finished.current) return;
    finished.current = true;
    onDone(v);
  };
  return (
    <input
      className="text-input bm-rename"
      autoFocus
      value={value}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onBlur={() => done(value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") done(value);
        else if (e.key === "Escape") done(null);
      }}
    />
  );
};

/**
 * Bookmarks bar of the file browser (under the path bar) and its list popover: this server's
 * bookmarks, the all-servers ones, recent folders. Chips that do not fit in two rows go into "⋯".
 */
export const SftpBookmarkBar: React.FC<{
  hostKey: string;
  hostTitle: string;
  home: string;
  cwd: string;
  bookmarks: SftpBookmark[];
  onBookmarks: (next: SftpBookmark[]) => void;
  /** This server's recent folders, most recent first. */
  recent: string[];
  onForgetRecent: (dir: string | null) => void;
  /** Folders that failed to open (drawn as broken). */
  missing: ReadonlySet<string>;
  popover: BookmarkPopover;
  onPopover: (v: BookmarkPopover) => void;
  onOpen: (abs: string, alsoTerminal: boolean) => void;
  onCdTerminal: (abs: string) => void;
  /** Bookmark a folder (`host` "" = all servers), before `beforeId` or at the end. */
  onAdd: (abs: string, host: string, beforeId?: string | null) => void;
  onToggleCurrent: () => void;
  /** Folders inside a drag of file rows (`rowDragType` payload), or [] when it holds none. */
  draggedDirs: (e: React.DragEvent) => string[] | null;
  rowDragType: string;
}> = (p) => {
  const { t } = useTranslation();
  const openMenu = useContextMenu();
  const { own, global, all } = bookmarksFor(p.bookmarks, p.hostKey);
  const absOf = (b: SftpBookmark) => expandHome(b.path, p.home);
  const shortcutOf = (b: SftpBookmark) => {
    const n = all.indexOf(b) + 1;
    return n >= 1 && n <= 9 ? n : 0;
  };

  const [renaming, setRenaming] = useState<{ id: string; where: "bar" | "list" } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string | null } | null>(null);
  const [hidden, setHidden] = useState(0);
  const [filter, setFilter] = useState("");
  const [cursor, setCursor] = useState(-1);
  const [, setWidthTick] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const chipsRef = useRef<HTMLDivElement | null>(null);
  const filterRef = useRef<HTMLInputElement | null>(null);

  // Two rows of chips at most; the rest are reachable from "⋯" (which shows how many).
  useLayoutEffect(() => {
    const box = chipsRef.current;
    if (!box) return;
    const items = Array.from(box.querySelectorAll<HTMLElement>("[data-chip], .bm-chip-sep"));
    items.forEach((el) => el.removeAttribute("data-hidden"));
    const r = box.getBoundingClientRect();
    let n = 0;
    let overflow = false;
    for (const el of items) {
      if (overflow || el.getBoundingClientRect().bottom > r.top + BAR_MAX + 0.5) {
        overflow = true;
        el.setAttribute("data-hidden", "");
        if (el.hasAttribute("data-chip")) n++;
      }
    }
    // A separator that starts a row reads as a stray line.
    for (const el of items) if (el.classList.contains("bm-chip-sep") && el.getBoundingClientRect().left - r.left < 4) el.setAttribute("data-hidden", "");
    if (n !== hidden) setHidden(n);
  });

  useEffect(() => {
    const box = chipsRef.current;
    if (!box) return;
    const ro = new ResizeObserver(() => setWidthTick((x) => x + 1));
    ro.observe(box);
    return () => ro.disconnect();
  }, []);

  // The list closes on a click elsewhere.
  useEffect(() => {
    if (!p.popover) return;
    setFilter("");
    setCursor(-1);
    requestAnimationFrame(() => filterRef.current?.focus());
    const down = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) p.onPopover(null);
    };
    document.addEventListener("mousedown", down, true);
    return () => document.removeEventListener("mousedown", down, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.popover]);

  const openBm = (b: SftpBookmark, e: { altKey: boolean }) => {
    p.onPopover(null);
    p.onOpen(absOf(b), e.altKey);
  };

  const chipMenu = (e: React.MouseEvent, b: SftpBookmark) => {
    e.preventDefault();
    e.stopPropagation();
    openMenu(e, [
      { label: t("sftp.open"), onClick: () => p.onOpen(absOf(b), false) },
      { label: t("sftp.cdTerminal"), icon: <SquareTerminal size={13} />, onClick: () => p.onCdTerminal(absOf(b)) },
      { type: "separator" },
      { label: t("sftp.bm.rename"), icon: <Pencil size={13} />, onClick: () => setRenaming({ id: b.id, where: "bar" }) },
      b.host
        ? { label: t("sftp.bm.toGlobal"), icon: <Globe size={13} />, onClick: () => p.onBookmarks(setBookmarkHost(p.bookmarks, b.id, "")) }
        : { label: t("sftp.bm.toOwn"), icon: <Server size={13} />, onClick: () => p.onBookmarks(setBookmarkHost(p.bookmarks, b.id, p.hostKey)) },
      { type: "separator" },
      { label: t("sftp.bm.remove"), icon: <X size={13} />, danger: true, onClick: () => p.onBookmarks(removeBookmark(p.bookmarks, b.id)) },
    ]);
  };

  // ------------------------------------------------------------------- drag and drop

  const dragKind = (e: React.DragEvent): "bookmark" | "rows" | null =>
    e.dataTransfer.types.includes(BM_DRAG) ? "bookmark" : e.dataTransfer.types.includes(p.rowDragType) ? "rows" : null;

  /** Drop handlers of the bar (`id` null) and of each chip / list row (insert before it). */
  const dropProps = (id: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      const kind = dragKind(e);
      if (!kind) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      if (over?.id !== id) setOver({ id });
    },
    onDrop: (e: React.DragEvent) => {
      const kind = dragKind(e);
      if (!kind) return;
      e.preventDefault();
      e.stopPropagation();
      setOver(null);
      if (kind === "bookmark") {
        const from = e.dataTransfer.getData(BM_DRAG);
        if (from) p.onBookmarks(moveBookmark(p.bookmarks, from, id));
      } else {
        const target = id ? p.bookmarks.find((b) => b.id === id) : undefined;
        for (const dir of p.draggedDirs(e) ?? []) p.onAdd(dir, target ? target.host ?? "" : p.hostKey, id);
      }
      setDragId(null);
    },
  });

  const dragProps = (b: SftpBookmark) => ({
    draggable: renaming?.id !== b.id,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData(BM_DRAG, b.id);
      e.dataTransfer.setData("text/plain", absOf(b));
      e.dataTransfer.effectAllowed = "move";
      setDragId(b.id);
    },
    onDragEnd: () => {
      setDragId(null);
      setOver(null);
    },
  });

  const renameBox = (b: SftpBookmark) => (
    <RenameBox
      initial={bookmarkLabel(b, p.home)}
      onDone={(value) => {
        setRenaming(null);
        if (value !== null) p.onBookmarks(renameBookmark(p.bookmarks, b.id, value, p.home));
      }}
    />
  );

  // ------------------------------------------------------------------- bar

  const icon = (b: SftpBookmark, size: number) =>
    p.missing.has(absOf(b)) ? (
      <CircleAlert size={size} className="bm-ico missing" />
    ) : b.host ? (
      <Star size={size} className="bm-ico own" fill="currentColor" />
    ) : (
      <Globe size={size} className="bm-ico global" />
    );

  const chip = (b: SftpBookmark) => {
    const abs = absOf(b);
    const n = shortcutOf(b);
    if (renaming?.id === b.id && renaming.where === "bar") {
      return (
        <span key={b.id} className="bm-chip" data-chip>
          {icon(b, 12)}
          {renameBox(b)}
        </span>
      );
    }
    return (
      <span
        key={b.id}
        data-chip
        className={`bm-chip ${abs === p.cwd ? "current" : ""} ${p.missing.has(abs) ? "missing" : ""} ${dragId === b.id ? "dragging" : ""} ${
          over?.id === b.id ? "drag-over" : ""
        }`}
        title={t("sftp.bm.chipTip", { path: abs, key: n ? ` (Ctrl+${n})` : "" })}
        onClick={(e) => openBm(b, e)}
        onContextMenu={(e) => chipMenu(e, b)}
        {...dragProps(b)}
        {...dropProps(b.id)}
      >
        {icon(b, 12)}
        <span className="bm-chip-label">{bookmarkLabel(b, p.home)}</span>
      </span>
    );
  };

  // ------------------------------------------------------------------- list popover

  const q = filter.trim().toLowerCase();
  const match = (path: string, label = "") => !q || path.toLowerCase().includes(q) || label.toLowerCase().includes(q);
  const onlyRecent = p.popover === "recent";
  const listOwn = onlyRecent ? [] : own.filter((b) => match(b.path, b.label) || match(absOf(b)));
  const listGlobal = onlyRecent ? [] : global.filter((b) => match(b.path, b.label) || match(absOf(b)));
  const listRecent = p.recent.filter((d) => d !== p.cwd && !all.some((b) => absOf(b) === d) && (match(d) || match(tildePath(d, p.home))));
  const flat: { open: (alt: boolean) => void }[] = [
    ...[...listOwn, ...listGlobal].map((b) => ({ open: (alt: boolean) => openBm(b, { altKey: alt }) })),
    ...listRecent.map((d) => ({
      open: (alt: boolean) => {
        p.onPopover(null);
        p.onOpen(d, alt);
      },
    })),
  ];

  let k = 0;
  const bmRow = (b: SftpBookmark) => {
    const abs = absOf(b);
    const idx = k++;
    const n = shortcutOf(b);
    if (renaming?.id === b.id && renaming.where === "list") {
      return (
        <div key={b.id} className="bm-row">
          {icon(b, 12)}
          {renameBox(b)}
        </div>
      );
    }
    return (
      <div
        key={b.id}
        className={`bm-row ${abs === p.cwd ? "current" : ""} ${cursor === idx ? "cursor" : ""} ${dragId === b.id ? "dragging" : ""} ${over?.id === b.id ? "drag-over" : ""}`}
        title={abs}
        onClick={(e) => openBm(b, e)}
        onContextMenu={(e) => chipMenu(e, b)}
        {...dragProps(b)}
        {...dropProps(b.id)}
      >
        <GripVertical size={11} className="bm-grip" />
        {icon(b, 12)}
        <span className="bm-row-text">
          <span className={`bm-row-label ${p.missing.has(abs) ? "missing" : ""}`}>{bookmarkLabel(b, p.home)}</span>
          <span className="bm-row-path mono">{b.path}</span>
        </span>
        {n > 0 && <kbd className="bm-key">Ctrl+{n}</kbd>}
        <span className="bm-tools">
          <button type="button" className="icon-btn-xs" title={t("sftp.bm.rename")} onClick={(e) => (e.stopPropagation(), setRenaming({ id: b.id, where: "list" }))}>
            <Pencil size={11} />
          </button>
          <button
            type="button"
            className="icon-btn-xs"
            title={b.host ? t("sftp.bm.toGlobal") : t("sftp.bm.toOwn")}
            onClick={(e) => (e.stopPropagation(), p.onBookmarks(setBookmarkHost(p.bookmarks, b.id, b.host ? "" : p.hostKey)))}
          >
            {b.host ? <Globe size={11} /> : <Server size={11} />}
          </button>
          <button
            type="button"
            className="icon-btn-xs danger-hover"
            title={t("sftp.bm.remove")}
            onClick={(e) => (e.stopPropagation(), p.onBookmarks(removeBookmark(p.bookmarks, b.id)))}
          >
            <X size={11} />
          </button>
        </span>
      </div>
    );
  };

  const recentRow = (d: string) => {
    const idx = k++;
    return (
      <div
        key={`r:${d}`}
        className={`bm-row ${cursor === idx ? "cursor" : ""}`}
        title={d}
        onClick={(e) => {
          p.onPopover(null);
          p.onOpen(d, e.altKey);
        }}
      >
        <Clock size={12} className="bm-ico recent" />
        <span className="bm-row-text">
          <span className="bm-row-path mono strong">{tildePath(d, p.home)}</span>
        </span>
        <span className="bm-tools">
          <button type="button" className="icon-btn-xs" title={t("sftp.bm.pin")} onClick={(e) => (e.stopPropagation(), p.onAdd(d, p.hostKey))}>
            <Pin size={11} />
          </button>
          <button type="button" className="icon-btn-xs danger-hover" title={t("sftp.bm.forget")} onClick={(e) => (e.stopPropagation(), p.onForgetRecent(d))}>
            <X size={11} />
          </button>
        </span>
      </div>
    );
  };

  const empty = (text: string) => <div className="bm-empty">{q ? t("sftp.bm.noMatch") : text}</div>;

  const popKeys = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!flat.length) return;
      setCursor((c) => (e.key === "ArrowDown" ? (c + 1) % flat.length : c <= 0 ? flat.length - 1 : c - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      flat[Math.max(0, cursor)]?.open(e.altKey);
    } else if (e.key === "Escape") {
      e.preventDefault();
      p.onPopover(null);
    }
  };

  const currentBookmarked = all.some((b) => absOf(b) === p.cwd);

  return (
    <div className="bm-wrap" ref={rootRef}>
      <div className={`bm-bar ${over?.id === null ? "drop" : ""}`} {...dropProps(null)} onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setOver(null)}>
        <div className="bm-chips" ref={chipsRef}>
          {all.length ? (
            <>
              {own.map(chip)}
              {own.length > 0 && global.length > 0 && <span className="bm-chip-sep" />}
              {global.map(chip)}
            </>
          ) : (
            <span className="bm-chip-empty" onClick={p.onToggleCurrent}>
              <Star size={12} />
              {t("sftp.bm.emptyBar")}
            </span>
          )}
        </div>
        <button
          type="button"
          className={`bm-bar-btn ${p.popover === "recent" ? "open" : ""}`}
          title={t("sftp.bm.recentTitle")}
          disabled={!p.recent.length}
          onClick={() => p.onPopover(p.popover === "recent" ? null : "recent")}
        >
          <Clock size={12} />
          {t("sftp.bm.recent")}
          <ChevronDown size={10} />
        </button>
        <button type="button" className={`bm-bar-btn ${p.popover === "all" ? "open" : ""}`} title={t("sftp.bm.all")} onClick={() => p.onPopover(p.popover === "all" ? null : "all")}>
          {hidden > 0 && <span className="bm-count">+{hidden}</span>}
          <Ellipsis size={14} />
        </button>
      </div>

      {p.popover && (
        <div className="bm-pop" onKeyDown={popKeys}>
          <input ref={filterRef} className="text-input input-sm bm-filter" placeholder={t("sftp.bm.filter")} value={filter} onChange={(e) => (setFilter(e.target.value), setCursor(-1))} />
          <div className="bm-scroll">
            {!onlyRecent && (
              <>
                <div className="bm-sec">
                  <Server size={11} />
                  {t("sftp.bm.thisServer")}
                  <span className="bm-sec-host">{p.hostTitle}</span>
                </div>
                {listOwn.length ? listOwn.map(bmRow) : empty(t("sftp.bm.emptyOwn"))}
                <div className="bm-sec">
                  <Globe size={11} />
                  {t("sftp.bm.allServers")}
                </div>
                {listGlobal.length ? listGlobal.map(bmRow) : empty(t("sftp.bm.emptyGlobal"))}
              </>
            )}
            <div className="bm-sec">
              <Clock size={11} />
              {t("sftp.bm.recentTitle")}
              {p.recent.length > 0 && (
                <button type="button" className="bm-sec-act" onClick={() => p.onForgetRecent(null)}>
                  {t("sftp.bm.clear")}
                </button>
              )}
            </div>
            {listRecent.length ? listRecent.map(recentRow) : empty(t("sftp.bm.emptyRecent"))}
          </div>
          <div className="bm-foot">
            <button type="button" className="pill-btn bm-add" disabled={currentBookmarked} onClick={p.onToggleCurrent}>
              <Star size={11} />
              {t("sftp.bm.addCurrent")}
            </button>
            <span className="muted">{t("sftp.bm.altHint")}</span>
          </div>
        </div>
      )}
    </div>
  );
};
