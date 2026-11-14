import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, Highlighter, List, Search, X } from "lucide-react";
import type { IDecoration, IMarker, Terminal } from "@xterm/xterm";
import { buildMatcher, contrastText, findAll, HIGHLIGHT_PRESETS, type BufferMatch } from "../utils/textMatch";
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

interface Painted {
  marker: IMarker;
  decorations: IDecoration[];
}

/**
 * Find bar: one matcher drives the counter, the decorations, next / previous and
 * the results list, so they always agree (the search addon counts overlapping
 * regex matches such as 3000ms, 000ms, 00ms ...).
 */
export const TerminalSearch: React.FC<{
  term: Terminal;
  accent: string;
  initialQuery?: string;
  onClose: () => void;
  /** Turn the current search into a permanent text highlight. */
  onHighlight: (pattern: string, options: SearchOptionsState, color: string) => void;
}> = ({ term, accent, initialQuery, onClose, onHighlight }) => {
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

  const matcher = useMemo(() => buildMatcher(query, opts), [query, opts]);
  const invalid = Boolean(query) && matcher.error !== null;

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
    const r = findAll(term, matcher.re, MAX_MATCHES);
    setResult(r);
    painted.current = r.matches.flatMap((m) => paint(m, MATCH_BG, undefined, MATCH_RULER));
    // Start from the first match at or below the top of the viewport.
    const top = term.buffer.active.viewportY;
    setActive((prev) => {
      if (prev >= 0 && prev < r.matches.length) return prev;
      const i = r.matches.findIndex((m) => m.row >= top);
      return r.matches.length ? (i >= 0 ? i : r.matches.length - 1) : -1;
    });
  }, [term, matcher, paint]);

  useEffect(() => {
    setActive(-1);
    recompute();
  }, [recompute]);

  // New output: refresh the matches (debounced).
  useEffect(() => {
    let timer = 0;
    const sub = term.onWriteParsed(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(recompute, 250);
    });
    return () => {
      sub.dispose();
      window.clearTimeout(timer);
    };
  }, [term, recompute]);

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
    reveal(active, false);
  }, [active, reveal]);

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

  const count = result.matches.length;

  return (
    <div className="terminal-search-wrap" onMouseDown={(e) => e.stopPropagation()}>
      <div className="terminal-search-bar">
        <Search size={13} className="muted-icon" />
        <input
          ref={inputRef}
          type="text"
          className={invalid ? "invalid" : ""}
          placeholder={t("pane.findPlaceholder")}
          title={invalid && matcher.error !== "empty" ? matcher.error ?? "" : ""}
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
        <span className={`search-count ${query && !invalid && count === 0 ? "none" : ""}`}>
          {invalid
            ? t("search.badRegex")
            : !query
            ? ""
            : count === 0
            ? t("search.noResults")
            : `${active >= 0 ? active + 1 : "?"}/${count}${result.truncated ? "+" : ""}`}
        </span>
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

      {showList && (
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
                <span className="search-line-text">{snippet(m)}</span>
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
function snippet(m: BufferMatch): React.ReactNode {
  const from = Math.max(0, m.start - 40);
  const to = Math.min(m.lineText.length, m.end + 80);
  return (
    <>
      {from > 0 && "…"}
      {m.lineText.slice(from, m.start).trimStart()}
      <mark>{m.lineText.slice(m.start, m.end)}</mark>
      {m.lineText.slice(m.end, to)}
      {to < m.lineText.length && "…"}
    </>
  );
}
