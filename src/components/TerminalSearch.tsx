import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, Highlighter, List, Search, X } from "lucide-react";
import type { IDecoration, IMarker, Terminal } from "@xterm/xterm";
import { buildMatcher, contrastText, findAll, HIGHLIGHT_PRESETS, locateMatch, type BufferMatch } from "../utils/textMatch";
import { backend, type HistoryMatch, type HistoryQuery } from "../services/backend";
import type { HistoryScroll } from "../services/historyScroll";
import { useContextMenu } from "./ContextMenu";

export interface SearchOptionsState {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

/** Search options are shared by every pane of the window. */
let lastOptions: SearchOptionsState = { caseSensitive: false, wholeWord: false, regex: false };
let lastQuery = "";

const MAX_MATCHES = 5000;
const MATCH_BG = "#6b5410";
const MATCH_RULER = "#d4a017";
/** Full history: wait this long after typing before searching. */
const DEBOUNCE_MS = 250;
/** Full history: results shown in the list. */
const LIST_LIMIT = 1000;
/** Full history: the list is searched this many history lines per request. */
const LIST_STEP_LINES = 2_000_000;
/** Full history: matches are painted this many screens above and below the view. */
const PAINT_SCREENS = 2;

interface Painted {
  marker: IMarker;
  decorations: IDecoration[];
}

/**
 * Find bar: one matcher drives the counter, the decorations, next / previous and
 * the results list, so they always agree (the search addon counts overlapping
 * regex matches such as 3000ms, 000ms, 00ms ...).
 *
 * With a full history (services/historyScroll.ts) the counter, next / previous, the
 * results list and the scrollbar marks cover the whole history: the backend searches
 * it, and a match outside the loaded lines is loaded when it is jumped to. Matches in
 * the loaded lines are painted in the terminal as before.
 */
export const TerminalSearch: React.FC<{
  term: Terminal;
  paneId: string;
  /** The pane's full history, if it has one. */
  history?: HistoryScroll | null;
  accent: string;
  initialQuery?: string;
  onClose: () => void;
  /** Turn the current search into a permanent text highlight. */
  onHighlight: (pattern: string, options: SearchOptionsState, color: string) => void;
}> = ({ term, paneId, history, accent, initialQuery, onClose, onHighlight }) => {
  const { t } = useTranslation();
  const openMenu = useContextMenu();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState(initialQuery || lastQuery);
  const [opts, setOpts] = useState<SearchOptionsState>(lastOptions);
  const [result, setResult] = useState<{ matches: BufferMatch[]; truncated: boolean }>({ matches: [], truncated: false });
  const [active, setActive] = useState(-1);
  const [showList, setShowList] = useState(false);
  const painted = useRef<Painted[]>([]);
  const activePaint = useRef<Painted[]>([]);

  // Full history: whole-history count, the match jumped to and its position, the list.
  const full = Boolean(history?.hasHistory());
  const [fullCount, setFullCount] = useState<number | null>(null);
  const [backendError, setBackendError] = useState<string | null>(null);
  const [fullActive, setFullActive] = useState<HistoryMatch | null>(null);
  const [fullRank, setFullRank] = useState<number | null>(null);
  const [fullList, setFullList] = useState<{ matches: HistoryMatch[]; more: boolean; loading: boolean } | null>(null);
  /** False while the count still grows (the history is being scanned in steps). */
  const [fullComplete, setFullComplete] = useState(false);
  const stepSeq = useRef(0);
  // The history's size arrives shortly after the pane opens: look again until it is known.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!history || history.hasHistory()) return;
    const timer = window.setTimeout(() => setTick((n) => n + 1), 500);
    return () => window.clearTimeout(timer);
  });

  const matcher = useMemo(() => buildMatcher(query, opts), [query, opts]);
  const invalid = Boolean(query) && (matcher.error !== null || (full && backendError !== null));
  const spec = useMemo<HistoryQuery | null>(
    () => (query && matcher.re ? { pattern: query, regex: opts.regex, caseSensitive: opts.caseSensitive, wholeWord: opts.wholeWord } : null),
    [query, opts, matcher]
  );

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    lastOptions = opts;
    lastQuery = query;
  }, [opts, query]);

  const clear = (list: React.MutableRefObject<Painted[]>) => {
    for (const p of list.current) {
      p.decorations.forEach((d) => d.dispose());
      p.marker.dispose();
    }
    list.current = [];
  };

  /** Decorate one match; a match crossing a wrap gets one piece per row. */
  const paint = useCallback(
    (m: BufferMatch, bg: string, fg: string | undefined, ruler: string): Painted[] => {
      const buf = term.buffer.active;
      if (buf.type !== "normal") return [];
      const cursorAbs = buf.baseY + buf.cursorY;
      const out: Painted[] = [];
      let row = m.row;
      let col = m.col;
      let left = m.cells;
      while (left > 0) {
        const width = Math.min(left, term.cols - col);
        const marker = term.registerMarker(row - cursorAbs);
        if (!marker) break;
        const deco = term.registerDecoration({
          marker,
          x: col,
          width,
          backgroundColor: bg,
          ...(fg ? { foregroundColor: fg } : {}),
          layer: "top",
          overviewRulerOptions: out.length === 0 ? { color: ruler, position: "left" } : undefined,
        });
        out.push({ marker, decorations: deco ? [deco] : [] });
        left -= width;
        row += 1;
        col = 0;
      }
      return out;
    },
    [term]
  );

  const recompute = useCallback(() => {
    clear(painted);
    if (!matcher.re) {
      setResult({ matches: [], truncated: false });
      setActive(-1);
      return;
    }
    // Full history: the counter, next / previous and the list come from the backend, so only
    // the matches around the view need painting (all of a 30000-row segment for a common
    // word is thousands of decorations, redone after every jump).
    const view = term.buffer.active.viewportY;
    const range = full ? { from: view - term.rows * PAINT_SCREENS, to: view + term.rows * (PAINT_SCREENS + 1) } : undefined;
    const r = findAll(term, matcher.re, MAX_MATCHES, range);
    setResult(r);
    painted.current = r.matches.flatMap((m) => paint(m, MATCH_BG, undefined, MATCH_RULER));
    // Start from the first match at or below the top of the viewport.
    const top = term.buffer.active.viewportY;
    setActive((prev) => {
      if (prev >= 0 && prev < r.matches.length) return prev;
      const i = r.matches.findIndex((m) => m.row >= top);
      return r.matches.length ? (i >= 0 ? i : r.matches.length - 1) : -1;
    });
  }, [term, matcher, paint, full]);

  useEffect(() => {
    setActive(-1);
    recompute();
  }, [recompute]);

  // Full history: the painted window follows the view.
  useEffect(() => {
    if (!full) return;
    let timer = 0;
    const sub = term.onScroll(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(recompute, 100);
    });
    return () => {
      sub.dispose();
      window.clearTimeout(timer);
    };
  }, [term, recompute, full]);

  // New output, or history lines loaded / dropped: refresh the painted matches (debounced).
  useEffect(() => {
    let timer = 0;
    const later = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(recompute, 250);
    };
    const sub = term.onWriteParsed(later);
    const loaded = history?.onLoaded(later);
    return () => {
      sub.dispose();
      loaded?.dispose();
      window.clearTimeout(timer);
    };
  }, [term, recompute, history]);

  // Full history: count and scrollbar marks, after typing settles.
  useEffect(() => {
    if (!history) return;
    setFullActive(null);
    setFullRank(null);
    setFullList(null);
    setBackendError(null);
    setFullCount(null);
    setFullComplete(false);
    if (!spec) {
      history.setMarkLayer("search", null);
      return;
    }
    const timer = window.setTimeout(() => {
      history.setMarkLayer("search", {
        specs: [spec],
        colors: [MATCH_RULER],
        position: "left",
        onResult: ({ counts, errors, complete }) => {
          setFullCount(counts[0] ?? 0);
          setFullComplete(complete);
          setBackendError(errors[0] ?? null);
        },
      });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [history, spec]);

  useEffect(() => () => history?.setMarkLayer("search", null), [history]);

  // Full history: the results list, when it is open.
  useEffect(() => {
    if (!full || !showList || !spec) return;
    let alive = true;
    // In steps of LIST_STEP_LINES lines: the first matches can be clicked while a search
    // with few hits goes on through the rest of a long history.
    const load = async () => {
      const got: HistoryMatch[] = [];
      let from = 0;
      try {
        for (;;) {
          const r = await backend.historySearch(paneId, spec, from, false, LIST_LIMIT - got.length, LIST_STEP_LINES);
          if (!alive) return;
          got.push(...r.matches);
          const filled = got.length >= LIST_LIMIT;
          const done = filled || r.next === null;
          setFullList({ matches: [...got], more: filled && r.next !== null, loading: !done });
          if (done || r.next === null) return;
          from = r.next;
        }
      } catch (e) {
        if (alive) setBackendError(String(e));
      }
    };
    const timer = window.setTimeout(() => void load(), DEBOUNCE_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [full, showList, spec, paneId]);

  // Active match: stronger decoration, selection and scroll into view.
  const reveal = useCallback(
    (i: number, scroll: boolean) => {
      clear(activePaint);
      const m = result.matches[i];
      if (!m) return;
      activePaint.current = paint(m, accent, contrastText(accent), accent);
      if (scroll) {
        const buf = term.buffer.active;
        if (m.row < buf.viewportY || m.row >= buf.viewportY + term.rows) {
          term.scrollToLine(Math.max(0, Math.min(m.row - Math.floor(term.rows / 3), buf.length - term.rows)));
        }
        term.select(m.col, m.row, m.cells);
      }
    },
    [result, paint, accent, term]
  );

  useEffect(() => {
    if (!full) reveal(active, false);
  }, [active, reveal, full]);

  /**
   * Full history: load the match's line if needed, then select and mark it. `rank`: its
   * place among all matches when the caller knows it (a step from a known place, an entry
   * of the list); else the backend counts the matches before it, a pass over the history.
   */
  const revealFull = useCallback(
    async (m: HistoryMatch, seq: number, rank: number | null = null) => {
      if (!history || !spec) return;
      // The active match and its rank change together (a step counts on from the rank).
      setFullActive(m);
      setFullRank(rank);
      const row = await history.reveal(m.line);
      if (seq !== stepSeq.current) return;
      clear(activePaint);
      const bm = row === null ? null : locateMatch(term, row, m);
      if (bm) {
        activePaint.current = paint(bm, accent, contrastText(accent), accent);
        term.select(bm.col, bm.row, bm.cells);
        const buf = term.buffer.active;
        if (bm.row < buf.viewportY || bm.row >= buf.viewportY + term.rows) {
          term.scrollToLine(Math.max(0, Math.min(bm.row - Math.floor(term.rows / 3), buf.length - term.rows)));
        }
      } else {
        term.clearSelection();
      }
      if (rank !== null) return;
      const counted = await backend.historyRank(paneId, spec, m.line, m.start).catch(() => null);
      if (seq === stepSeq.current) setFullRank(counted);
    },
    [history, spec, term, paint, accent, paneId]
  );

  /** Full history: the next / previous match after the active one (or the view), wrapping. */
  const stepFull = async (next: boolean) => {
    if (!history || !spec || invalid) return;
    const seq = ++stepSeq.current;
    const cur = fullActive;
    const top = history.topLine() ?? 0;
    let from = cur ? cur.line : next ? top : top + term.rows;
    const after = (m: HistoryMatch) =>
      !cur || (next ? m.line > cur.line || (m.line === cur.line && m.start > cur.start) : m.line < cur.line || (m.line === cur.line && m.start < cur.start));
    try {
      let found: HistoryMatch | null = null;
      // One match per request: the backend stops at the first line with a match and returns
      // all of that line's matches. The first request (from the active match's own line)
      // may hold only matches before it; the next one starts on the following line.
      for (;;) {
        const r = await backend.historySearch(paneId, spec, from, !next, 1);
        if (seq !== stepSeq.current) return;
        found = r.matches.find(after) ?? null;
        if (found || r.next === null || r.next === from) break;
        from = r.next;
      }
      // Its place among all matches, counted on from the active one when that is known.
      let rank: number | null = cur && fullRank !== null ? fullRank + (next ? 1 : -1) : null;
      if (!found) {
        // Wrap around to the other end.
        const r = await backend.historySearch(paneId, spec, next ? 0 : Number.MAX_SAFE_INTEGER, !next, 1);
        if (seq !== stepSeq.current) return;
        // Backward results come last match first.
        found = r.matches[0] ?? null;
        rank = next ? 0 : fullComplete && fullCount !== null && fullCount > 0 ? fullCount - 1 : null;
      }
      if (found && seq === stepSeq.current) await revealFull(found, seq, rank);
    } catch (e) {
      setBackendError(String(e));
    }
  };

  useEffect(
    () => () => {
      clear(painted);
      clear(activePaint);
    },
    []
  );

  const close = () => {
    clear(painted);
    clear(activePaint);
    onClose();
  };

  const step = (next: boolean) => {
    if (full) {
      void stepFull(next);
      return;
    }
    const n = result.matches.length;
    if (!n) return;
    const i = active < 0 ? (next ? 0 : n - 1) : (active + (next ? 1 : -1) + n) % n;
    setActive(i);
    reveal(i, true);
  };

  const jump = (i: number) => {
    setActive(i);
    reveal(i, true);
  };

  const toggle = (key: keyof SearchOptionsState) => setOpts((o) => ({ ...o, [key]: !o[key] }));

  const highlightMenu = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openMenu(
      { clientX: r.left, clientY: r.bottom + 4 },
      HIGHLIGHT_PRESETS.map((c) => ({
        label: t(`highlight.color.${c}`),
        swatch: c,
        onClick: () => onHighlight(query, opts, c),
      }))
    );
  };

  const count = full ? fullCount ?? 0 : result.matches.length;
  const counter = invalid
    ? t("search.badRegex")
    : !query
    ? ""
    : full
    ? fullCount === null || (fullCount === 0 && !fullComplete)
      ? t("search.searching")
      : fullCount === 0
      ? t("search.noResults")
      : // "+": the history is still being scanned and the count goes up.
        `${fullRank !== null ? fullRank + 1 : "?"}/${fullCount}${fullComplete ? "" : "+"}`
    : count === 0
    ? t("search.noResults")
    : `${active >= 0 ? active + 1 : "?"}/${count}${result.truncated ? "+" : ""}`;

  return (
    <div className="terminal-search-wrap" onMouseDown={(e) => e.stopPropagation()}>
      <div className="terminal-search-bar">
        <Search size={13} className="muted-icon" />
        <input
          ref={inputRef}
          type="text"
          className={invalid ? "invalid" : ""}
          placeholder={full ? t("search.placeholderFull") : t("pane.findPlaceholder")}
          title={invalid ? (backendError ?? (matcher.error !== "empty" ? matcher.error ?? "" : "")) : ""}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") step(!e.shiftKey);
            else if (e.key === "Escape") close();
            else if (e.altKey && e.key.toLowerCase() === "c") toggle("caseSensitive");
            else if (e.altKey && e.key.toLowerCase() === "w") toggle("wholeWord");
            else if (e.altKey && e.key.toLowerCase() === "r") toggle("regex");
            else return;
            e.preventDefault();
          }}
        />
        <button type="button" className={`search-opt ${opts.caseSensitive ? "on" : ""}`} title={t("search.caseSensitive")} onClick={() => toggle("caseSensitive")}>
          Aa
        </button>
        <button type="button" className={`search-opt ${opts.wholeWord ? "on" : ""}`} title={t("search.wholeWord")} onClick={() => toggle("wholeWord")}>
          <span className="whole-word">ab</span>
        </button>
        <button type="button" className={`search-opt ${opts.regex ? "on" : ""}`} title={t("search.regex")} onClick={() => toggle("regex")}>
          .*
        </button>
        <span className={`search-count ${query && !invalid && count === 0 && (!full || (fullCount !== null && fullComplete)) ? "none" : ""}`}>{counter}</span>
        <button type="button" className="icon-btn-xs" onClick={() => step(false)} title={t("pane.prev")}>
          <ChevronUp size={14} />
        </button>
        <button type="button" className="icon-btn-xs" onClick={() => step(true)} title={t("pane.next")}>
          <ChevronDown size={14} />
        </button>
        <button
          type="button"
          className={`icon-btn-xs ${showList ? "active" : ""}`}
          onClick={() => setShowList((v) => !v)}
          title={t("search.showAll")}
        >
          <List size={13} />
        </button>
        <button
          type="button"
          className="icon-btn-xs"
          disabled={!query || invalid}
          onClick={highlightMenu}
          title={t("search.toHighlight")}
        >
          <Highlighter size={13} />
        </button>
        <button type="button" className="icon-btn-xs" onClick={close} title={t("search.close")}>
          <X size={14} />
        </button>
      </div>

      {showList && full && (
        <div className="search-results">
          <div className="search-results-head">
            {t("search.resultsHead", { count })}
            {fullList?.more && <span className="muted"> · {t("search.truncated", { count: LIST_LIMIT })}</span>}
          </div>
          <div className="search-results-list">
            {(fullList?.matches ?? []).map((m, i) => (
              <button
                key={`${m.line}-${m.start}-${i}`}
                type="button"
                className={`search-result ${fullActive?.line === m.line && fullActive.start === m.start ? "selected" : ""}`}
                // The list runs from the first match on, so entry i is match i.
                onClick={() => void revealFull(m, ++stepSeq.current, i)}
              >
                <span className="search-line-no">{m.no}</span>
                <span className="search-line-text">{snippetOf(m.ctx, m.start - m.ctxOffset, m.end - m.ctxOffset, m.ctxOffset > 0)}</span>
              </button>
            ))}
            {(fullList === null || fullList.loading) && query && !invalid && <div className="search-results-empty">{t("search.searching")}</div>}
            {fullList !== null && !fullList.loading && fullList.matches.length === 0 && (
              <div className="search-results-empty">{t("search.noResults")}</div>
            )}
          </div>
        </div>
      )}

      {showList && !full && (
        <div className="search-results">
          <div className="search-results-head">
            {t("search.resultsHead", { count })}
            {result.truncated && <span className="muted"> · {t("search.truncated", { count: MAX_MATCHES })}</span>}
          </div>
          <div className="search-results-list">
            {result.matches.map((m, i) => (
              <button
                key={`${m.row}-${m.col}-${i}`}
                type="button"
                className={`search-result ${i === active ? "selected" : ""}`}
                onClick={() => jump(i)}
              >
                <span className="search-line-no">{m.row + 1}</span>
                <span className="search-line-text">{snippetOf(m.lineText, m.start, m.end, false)}</span>
              </button>
            ))}
            {count === 0 && <div className="search-results-empty">{t("search.noResults")}</div>}
          </div>
        </div>
      )}
    </div>
  );
};

/** The matching line around the hit, with the hit marked. */
function snippetOf(text: string, start: number, end: number, cutBefore: boolean): React.ReactNode {
  const from = Math.max(0, start - 40);
  const to = Math.min(text.length, end + 80);
  return (
    <>
      {(from > 0 || cutBefore) && "…"}
      {text.slice(from, start).trimStart()}
      <mark>{text.slice(start, end)}</mark>
      {text.slice(end, to)}
      {to < text.length && "…"}
    </>
  );
}
