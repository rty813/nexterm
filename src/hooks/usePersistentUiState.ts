import { useEffect, useRef, useState } from "react";
import { backend } from "../services/backend";

export interface UiState {
  sidebarOpen: boolean;
  sidebarWidth: number;
  quickBarOpen: boolean;
  /** Collapsed sidebar sections ("recent", ...). */
  sidebarRecentOpen: boolean;
  /** Side panels left open at exit, reopened on the next start. */
  senderOpen: boolean;
  historyOpen: boolean;
  filesOpen: boolean;
  monitorOpen: boolean;
  portForwardOpen: boolean;
  tmuxOpen: boolean;
}

export const UI_DEFAULTS: UiState = {
  sidebarOpen: true,
  sidebarWidth: 268,
  quickBarOpen: true,
  sidebarRecentOpen: true,
  senderOpen: false,
  historyOpen: false,
  filesOpen: false,
  monitorOpen: false,
  portForwardOpen: false,
  tmuxOpen: false,
};

/** Merges saved ui_state.json over the current state, keeping only well-typed values. */
export function mergeUiState(cur: UiState, saved: unknown): UiState {
  if (!saved || typeof saved !== "object") return cur;
  const src = saved as Record<string, unknown>;
  const next = { ...cur };
  for (const key of Object.keys(UI_DEFAULTS) as (keyof UiState)[]) {
    if (key === "sidebarWidth") continue;
    if (typeof src[key] === "boolean") (next as Record<string, unknown>)[key] = src[key];
  }
  const width = Number(src.sidebarWidth);
  if (Number.isFinite(width) && width > 0) next.sidebarWidth = Math.min(480, Math.max(190, width));
  return next;
}

/**
 * Layout chrome the user arranged (sidebar open / width, quick bar, side panels ...), kept in
 * ui_state.json. Only the main window persists it; other windows start from defaults.
 */
export function usePersistentUiState(persist: boolean) {
  const [ui, setUi] = useState<UiState>(UI_DEFAULTS);
  const loaded = useRef(!persist);

  useEffect(() => {
    if (!persist) return;
    void backend.loadDataFile<Partial<UiState>>("ui_state").then((saved) => {
      setUi((cur) => mergeUiState(cur, saved));
      loaded.current = true;
    });
  }, [persist]);

  useEffect(() => {
    if (!persist || !loaded.current) return;
    const timer = window.setTimeout(() => void backend.saveDataFile("ui_state", ui), 400);
    return () => window.clearTimeout(timer);
  }, [ui, persist]);

  const set = <K extends keyof UiState>(key: K) => (value: UiState[K] | ((prev: UiState[K]) => UiState[K])) =>
    setUi((cur) => ({
      ...cur,
      [key]: typeof value === "function" ? (value as (p: UiState[K]) => UiState[K])(cur[key]) : value,
    }));

  return {
    ui,
    setSidebarOpen: set("sidebarOpen"),
    setSidebarWidth: set("sidebarWidth"),
    setQuickBarOpen: set("quickBarOpen"),
    setSidebarRecentOpen: set("sidebarRecentOpen"),
    setSenderOpen: set("senderOpen"),
    setHistoryOpen: set("historyOpen"),
    setFilesOpen: set("filesOpen"),
    setMonitorOpen: set("monitorOpen"),
    setPortForwardOpen: set("portForwardOpen"),
    setTmuxOpen: set("tmuxOpen"),
  };
}
