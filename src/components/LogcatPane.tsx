import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDownToLine, Download, Eraser, Pause, Play, RotateCw, Trash2 } from "lucide-react";
import { adb } from "../services/adb";
import { backend } from "../services/backend";
import { DEFAULT_LOGCAT, type LogEntry, type LogcatPrefs, type TerminalLeafNode } from "../types/domain";
import { LEVELS, LogBuffer, formatEntry, makeFilter, parseQuery, type Level, type PackageUids } from "../utils/logcatFilter";
import { adbSerialOf } from "../utils/adbSession";
import { useContextMenu } from "./ContextMenu";
import type { PaneApi, PaneExtras } from "./TerminalPane";

const ROW = 18;
const BUFFERS = ["main", "system", "crash", "events", "radio"];
const noop = () => {};

interface LogcatPaneProps {
  leaf: TerminalLeafNode;
  visible: boolean;
  isActive: boolean;
  extras: PaneExtras;
  onActivate: (paneId: string) => void;
  onReconnectPane: (paneId: string) => void;
  /** Filters changed: kept on the tab's session (saved with it). */
  onPrefs: (paneId: string, prefs: LogcatPrefs) => void;
}

/**
 * A logcat tab: the device log in the workspace like a terminal. The backend streams parsed
 * entries (`adb/logcat.rs`); everything is kept here (up to `maxLines`) and the filter
 * only decides what is shown, so changing it never loses lines.
 */
export const LogcatPane: React.FC<LogcatPaneProps> = ({ leaf, visible, isActive, extras, onActivate, onReconnectPane, onPrefs }) => {
  const { t } = useTranslation();
  const paneId = leaf.paneId;
  const prefs: LogcatPrefs = { ...DEFAULT_LOGCAT, ...(leaf.session.adb?.logcat ?? {}) };
  const [level, setLevel] = useState<Level>(prefs.level);
  const [query, setQuery] = useState(prefs.query);
  const [buffers, setBuffers] = useState<string[]>(prefs.buffers);
  const [paused, setPaused] = useState(false);
  const [follow, setFollow] = useState(true);
  const [wrap, setWrap] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [uids, setUids] = useState<PackageUids>(new Map());
  // Bumped when entries arrive (render trigger; the data lives in the buffer).
  const [version, setVersion] = useState(0);

  const store = useRef(new LogBuffer(prefs.maxLines));
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const held = useRef<LogEntry[]>([]);
  const frame = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 400 });
  const openMenu = useContextMenu();

  // Persist filters on the tab (debounced through React batching; cheap).
  useEffect(() => {
    const next: LogcatPrefs = { ...prefs, level, query, buffers };
    if (JSON.stringify(next) !== JSON.stringify(prefs)) onPrefs(paneId, next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level, query, buffers]);

  // ---- stream (again on reconnect or when the buffers change)
  const onBatch = useCallback((batch: LogEntry[]) => {
    if (pausedRef.current) {
      held.current.push(...batch);
      return;
    }
    store.current.push(batch);
    // Repaint at most once per frame; when hidden, timers are throttled but data is kept.
    if (!frame.current) {
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        setVersion((v) => v + 1);
      });
    }
  }, []);

  useEffect(() => {
    void adb.logcatStart(paneId, leaf.session, { buffers, tail: 5000 }, onBatch).catch((e) => extras.onToast(String(e)));
    return () => adb.logcatStop(paneId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, leaf.reconnectCount, buffers.join(",")]);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  // Resume: deliver what was held.
  useEffect(() => {
    if (!paused && held.current.length) {
      store.current.push(held.current);
      held.current = [];
      setVersion((v) => v + 1);
    }
  }, [paused]);

  // Package -> uid map, for `package:` filters (loaded when such a term appears).
  const q = useMemo(() => parseQuery(query), [query]);
  const needsPackages = q.packages.length > 0;
  useEffect(() => {
    if (!needsPackages || leaf.status !== "connected" || uids.size) return;
    // A logcat tab has no shell of its own: ask the device by serial.
    void (async () => {
      try {
        let serial = adbSerialOf(leaf.session);
        if (!serial) serial = (await adb.devices()).find((d) => d.state === "device")?.serial ?? "";
        if (!serial) return;
        const apps = await adb.apps({ serial }, false);
        setUids(new Map(apps.filter((a) => a.uid !== null).map((a) => [a.package, a.uid as number])));
      } catch {
        /* the package filter then matches nothing */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsPackages, leaf.status, uids.size]);

  // ---- filtered view
  const filter = useMemo(() => makeFilter(q, level, uids), [q, level, uids]);
  const rows = useMemo(() => {
    const out: number[] = [];
    const list = store.current.entries;
    for (let i = 0; i < list.length; i++) if (filter(list[i])) out.push(i);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, version]);

  // Follow the end while at the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && follow && visible) el.scrollTop = el.scrollHeight;
  }, [rows, follow, visible]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewport({ top: el.scrollTop, height: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setViewport({ top: el.scrollTop, height: el.clientHeight });
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < ROW * 2;
    if (atBottom !== follow) setFollow(atBottom);
  };

  const first = Math.max(0, Math.floor(viewport.top / ROW) - 20);
  const last = Math.min(rows.length, Math.ceil((viewport.top + viewport.height) / ROW) + 20);
  const entries = store.current.entries;

  // ---- actions
  const selectedText = () =>
    (selected.size ? rows.filter((i) => selected.has(i + store.current.base)) : rows).map((i) => formatEntry(entries[i])).join("\n");

  const exportLog = async () => {
    const name = `logcat-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.txt`;
    const path = await backend.pickSavePath(t("logcat.export"), name, [{ name: "Text", extensions: ["txt", "log"] }]);
    if (path) await backend.writeTextFile(path, rows.map((i) => formatEntry(entries[i])).join("\r\n"));
  };

  const clearLocal = () => {
    store.current.clear();
    setSelected(new Set());
    setVersion((v) => v + 1);
  };

  const clearDevice = async () => {
    try {
      await adb.logcatClear(leaf.session, buffers);
      clearLocal();
    } catch (e) {
      extras.onToast(String(e));
    }
  };

  const addTerm = (term: string) => setQuery((cur) => (cur.split(/\s+/).includes(term) ? cur : `${cur} ${term}`.trim()));

  const rowMenu = (e: React.MouseEvent, entry: LogEntry, abs: number) => {
    e.preventDefault();
    if (!selected.has(abs)) setSelected(new Set([abs]));
    openMenu(e, [
      { label: t("logcat.copy"), onClick: () => void backend.writeClipboard(selected.has(abs) ? selectedText() : formatEntry(entry)) },
      { label: t("logcat.copyMessage"), onClick: () => void backend.writeClipboard(entry.msg) },
      { type: "separator" },
      { label: t("logcat.onlyTag", { tag: entry.tag }), onClick: () => addTerm(`tag:=${quoteTerm(entry.tag)}`), disabled: !entry.tag },
      { label: t("logcat.hideTag", { tag: entry.tag }), onClick: () => addTerm(`-tag:=${quoteTerm(entry.tag)}`), disabled: !entry.tag },
      { label: t("logcat.onlyPid", { pid: entry.pid }), onClick: () => addTerm(`pid:${entry.pid}`), disabled: !entry.pid },
    ]);
  };

  const onRowClick = (e: React.MouseEvent, abs: number) => {
    setSelected((cur) => {
      if (e.ctrlKey || e.metaKey) {
        const next = new Set(cur);
        if (next.has(abs)) next.delete(abs);
        else next.add(abs);
        return next;
      }
      if (e.shiftKey && cur.size) {
        const anchor = Math.max(...cur);
        const [a, b] = anchor < abs ? [anchor, abs] : [abs, anchor];
        const next = new Set<number>();
        for (const i of rows) {
          const n = i + store.current.base;
          if (n >= a && n <= b) next.add(n);
        }
        return next;
      }
      return new Set([abs]);
    });
  };

  // App-level pane commands (copy, find, select all, save).
  useEffect(() => {
    const api: PaneApi = {
      copy: () => void backend.writeClipboard(selectedText()),
      paste: noop,
      selectAll: () => setSelected(new Set(rows.map((i) => i + store.current.base))),
      clear: clearLocal,
      find: () => containerRef.current?.querySelector<HTMLInputElement>(".logcat-query")?.focus(),
      focus: () => containerRef.current?.focus(),
      toggleTimestamps: noop,
      reset: clearLocal,
      clearScrollback: clearLocal,
      saveToFile: () => void exportLog(),
      pasteText: noop,
      foldAll: noop,
      unfoldAll: noop,
      sendText: noop,
    };
    extras.registerTerminal(paneId, api);
    return () => extras.registerTerminal(paneId, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, rows, selected]);

  useEffect(() => {
    if (isActive && visible) containerRef.current?.focus({ preventScroll: true });
  }, [isActive, visible]);

  const failed = leaf.status === "disconnected" || leaf.status === "error";

  return (
    <div
      ref={containerRef}
      className={`logcat-pane ${wrap ? "logcat-wrap" : ""}`}
      tabIndex={0}
      onMouseDown={() => onActivate(paneId)}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && !(e.target as HTMLElement).closest("input")) {
          e.preventDefault();
          void backend.writeClipboard(selectedText());
        }
      }}
    >
      <div className="logcat-toolbar">
        <select className="text-input logcat-level" value={level} onChange={(e) => setLevel(e.target.value as Level)} title={t("logcat.level")}>
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              {t(`logcat.levels.${l}`)}
            </option>
          ))}
        </select>
        <input
          className={`text-input logcat-query ${q.errors.length ? "invalid" : ""}`}
          placeholder={t("logcat.queryPlaceholder")}
          title={t("logcat.queryHelp")}
          value={query}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
        />
        <details className="logcat-buffers">
          <summary title={t("logcat.buffers")}>{buffers.join(", ") || t("logcat.defaultBuffers")}</summary>
          <div className="logcat-buffers-menu">
            {BUFFERS.map((b) => (
              <label key={b} className="checkbox-row">
                <input
                  type="checkbox"
                  checked={buffers.includes(b)}
                  onChange={(e) => setBuffers((cur) => (e.target.checked ? [...cur, b] : cur.filter((x) => x !== b)))}
                />
                {b}
              </label>
            ))}
          </div>
        </details>
        <span className="logcat-count">
          {rows.length.toLocaleString()} / {entries.length.toLocaleString()}
          {paused && held.current.length ? ` (+${held.current.length})` : ""}
        </span>
        <button type="button" className="btn-ghost btn-xs" title={paused ? t("logcat.resume") : t("logcat.pause")} onClick={() => setPaused((p) => !p)}>
          {paused ? <Play size={13} /> : <Pause size={13} />}
        </button>
        <button
          type="button"
          className={`btn-ghost btn-xs ${follow ? "active" : ""}`}
          title={t("logcat.follow")}
          onClick={() => {
            setFollow(true);
            const el = scrollRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
        >
          <ArrowDownToLine size={13} />
        </button>
        <button type="button" className={`btn-ghost btn-xs ${wrap ? "active" : ""}`} title={t("logcat.wrap")} onClick={() => setWrap((w) => !w)}>
          ↵
        </button>
        <button type="button" className="btn-ghost btn-xs" title={t("logcat.clearLocal")} onClick={clearLocal}>
          <Eraser size={13} />
        </button>
        <button type="button" className="btn-ghost btn-xs" title={t("logcat.clearDevice")} onClick={() => void clearDevice()}>
          <Trash2 size={13} />
        </button>
        <button type="button" className="btn-ghost btn-xs" title={t("logcat.export")} onClick={() => void exportLog()}>
          <Download size={13} />
        </button>
        {failed && (
          <button type="button" className="btn-ghost btn-xs" title={t("logcat.reconnect")} onClick={() => onReconnectPane(paneId)}>
            <RotateCw size={13} />
          </button>
        )}
      </div>

      <div ref={scrollRef} className="logcat-scroll" onScroll={onScroll}>
        {wrap ? (
          // Wrapped lines have no fixed height: render the last rows only.
          <div className="logcat-rows">
            {rows.slice(-3000).map((i) => (
              <Row key={i + store.current.base} e={entries[i]} abs={i + store.current.base} selected={selected} onClick={onRowClick} onMenu={rowMenu} />
            ))}
          </div>
        ) : (
          <div className="logcat-rows" style={{ height: rows.length * ROW, position: "relative" }}>
            <div style={{ position: "absolute", top: first * ROW, left: 0, right: 0 }}>
              {rows.slice(first, last).map((i) => (
                <Row key={i + store.current.base} e={entries[i]} abs={i + store.current.base} selected={selected} onClick={onRowClick} onMenu={rowMenu} />
              ))}
            </div>
          </div>
        )}
        {entries.length === 0 && (
          <div className="logcat-empty">
            {leaf.status === "connecting" ? t("logcat.connecting") : failed ? leaf.statusMessage || t("logcat.disconnected") : t("logcat.waiting")}
          </div>
        )}
      </div>
    </div>
  );
};

const Row = React.memo(function Row({
  e,
  abs,
  selected,
  onClick,
  onMenu,
}: {
  e: LogEntry;
  abs: number;
  selected: Set<number>;
  onClick: (ev: React.MouseEvent, abs: number) => void;
  onMenu: (ev: React.MouseEvent, e: LogEntry, abs: number) => void;
}) {
  if (e.level === "S") {
    return <div className="logcat-row logcat-marker">--------- {e.msg}</div>;
  }
  return (
    <div
      className={`logcat-row lv-${e.level} ${selected.has(abs) ? "selected" : ""}`}
      onMouseDown={(ev) => ev.button === 0 && onClick(ev, abs)}
      onContextMenu={(ev) => onMenu(ev, e, abs)}
    >
      <span className="lc-ts">{e.ts}</span>
      <span className="lc-pid">{e.pid}</span>
      <span className="lc-tid">{e.tid}</span>
      <span className="lc-lv">{e.level}</span>
      <span className="lc-tag" title={e.tag}>
        {e.tag}
      </span>
      <span className="lc-msg">{e.msg}</span>
    </div>
  );
});

function quoteTerm(s: string): string {
  return /\s/.test(s) ? `"${s}"` : s;
}
