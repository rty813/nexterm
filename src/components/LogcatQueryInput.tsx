import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Crosshair } from "lucide-react";
import { applySuggestion, pushRecent, suggest, withOnlyPackage, type SuggestContext } from "../utils/logcatSuggest";

const RECENT_KEY = "nexterm.logcat.recent";

function loadRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The logcat filter box with completion: keys (`package:`, `tag:` ...), installed and
 * running packages, tags seen in the log, process ids, levels, and recent queries.
 * ↑ / ↓ choose, Tab / Enter take, Esc closes, Ctrl+Space opens.
 */
export function LogcatQueryInput({
  value,
  onChange,
  invalid,
  context,
  onWantDevice,
  onForeground,
}: {
  value: string;
  onChange: (value: string) => void;
  invalid: boolean;
  /** What to complete from (device data may still be loading). */
  context: Omit<SuggestContext, "recent">;
  /** The box got focus: load packages / processes / foreground app. */
  onWantDevice: () => void;
  /** Look up the foreground app's package (button). */
  onForeground: () => Promise<string | null>;
}) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState(value.length);
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const [busy, setBusy] = useState(false);

  const result = useMemo(
    () => (open ? suggest(value, caret, { ...context, recent }) : { start: 0, end: 0, items: [] }),
    [open, value, caret, context, recent]
  );
  const items = result.items;
  useEffect(() => setIndex(0), [value, caret]);
  useEffect(() => {
    listRef.current?.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const remember = (q: string) => {
    const next = pushRecent(recent, q);
    if (next !== recent) {
      setRecent(next);
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    }
  };

  const setValue = (v: string, c: number) => {
    onChange(v);
    setCaret(c);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(c, c);
      }
    });
  };

  const take = (i: number) => {
    const s = items[i];
    if (!s) return;
    const next = applySuggestion(value, result, s);
    setValue(next.value, next.caret);
    // Keys open the value list right away; a finished term closes it.
    setOpen(s.kind === "key");
    if (s.kind !== "key") remember(next.value);
  };

  const syncCaret = () => setCaret(inputRef.current?.selectionStart ?? value.length);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === " " && e.ctrlKey) {
      e.preventDefault();
      onWantDevice();
      setOpen(true);
      return;
    }
    if (!open || items.length === 0) {
      if (e.key === "Enter") remember(value);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setOpen(true);
      }
      if (e.key === "Escape" && value) {
        e.preventDefault();
        onChange("");
      }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const d = e.key === "ArrowDown" ? 1 : -1;
      setIndex((i) => (i + d + items.length) % items.length);
    } else if (e.key === "Tab" || e.key === "Enter") {
      e.preventDefault();
      take(index);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  };

  const pickForeground = async () => {
    setBusy(true);
    try {
      const pkg = await onForeground();
      if (pkg) {
        const next = withOnlyPackage(value, pkg);
        setValue(next, next.length);
        remember(next);
        setOpen(false);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="logcat-query-wrap">
      <input
        ref={inputRef}
        className={`text-input logcat-query ${invalid ? "invalid" : ""}`}
        placeholder={t("logcat.queryPlaceholder")}
        title={t("logcat.queryHelp")}
        value={value}
        spellCheck={false}
        autoComplete="off"
        role="combobox"
        aria-expanded={open && items.length > 0}
        aria-autocomplete="list"
        onChange={(e) => {
          onChange(e.target.value);
          setCaret(e.target.selectionStart ?? e.target.value.length);
          setOpen(true);
        }}
        onFocus={() => {
          onWantDevice();
          setOpen(true);
          syncCaret();
        }}
        onClick={() => {
          syncCaret();
          setOpen(true);
        }}
        onKeyUp={(e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") syncCaret();
        }}
        onBlur={() => {
          setOpen(false);
          remember(value);
        }}
        onKeyDown={onKeyDown}
      />
      <button
        type="button"
        className="btn-ghost btn-xs logcat-foreground"
        title={t("logcat.foreground")}
        disabled={busy}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => void pickForeground()}
      >
        <Crosshair size={13} />
      </button>
      {open && items.length > 0 && (
        <div ref={listRef} className="logcat-suggest" role="listbox">
          {items.map((s, i) => (
            <div
              key={`${s.kind}:${s.insert}`}
              role="option"
              aria-selected={i === index}
              className={`logcat-suggest-item kind-${s.kind} ${i === index ? "active" : ""}`}
              // Keep focus in the box while clicking.
              onMouseDown={(e) => {
                e.preventDefault();
                take(i);
              }}
              onMouseEnter={() => setIndex(i)}
            >
              <span className="logcat-suggest-label">{s.label}</span>
              {s.detail && (
                <span className="logcat-suggest-detail">
                  {s.detail === "foreground" ? t("logcat.foregroundTag") : s.detail === "running" ? t("logcat.running") : s.detail}
                </span>
              )}
              {s.kind === "recent" && <span className="logcat-suggest-detail">{t("logcat.recent")}</span>}
            </div>
          ))}
          <div className="logcat-suggest-hint">{t("logcat.suggestHint")}</div>
        </div>
      )}
    </div>
  );
}
