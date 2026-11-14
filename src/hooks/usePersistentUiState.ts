import { useEffect, useRef, useState } from "react";
import { backend } from "../services/backend";

export interface UiState {
  sidebarOpen: boolean;
  sidebarWidth: number;
  quickBarOpen: boolean;
  /** Collapsed sidebar sections ("recent", ...). */
  sidebarRecentOpen: boolean;
}

const DEFAULTS: UiState = { sidebarOpen: true, sidebarWidth: 268, quickBarOpen: true, sidebarRecentOpen: true };

/**
 * Layout chrome the user arranged (sidebar open / width, quick bar ...), kept in
 * ui_state.json. Only the main window persists it; other windows start from defaults.
 */
export function usePersistentUiState(persist: boolean) {
  const [ui, setUi] = useState<UiState>(DEFAULTS);
  const loaded = useRef(!persist);

  useEffect(() => {
    if (!persist) return;
    void backend.loadDataFile<Partial<UiState>>("ui_state").then((saved) => {
      if (saved && typeof saved === "object") {
        setUi((cur) => ({
          ...cur,
          ...saved,
          sidebarWidth: Math.min(480, Math.max(190, Number(saved.sidebarWidth) || cur.sidebarWidth)),
        }));
      }
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
  };
}
