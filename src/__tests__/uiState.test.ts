import { describe, expect, it } from "vitest";
import { UI_DEFAULTS, mergeUiState } from "../hooks/usePersistentUiState";

describe("mergeUiState", () => {
  it("restores side panels left open", () => {
    const next = mergeUiState(UI_DEFAULTS, { senderOpen: true, filesOpen: true, monitorOpen: false });
    expect(next.senderOpen).toBe(true);
    expect(next.filesOpen).toBe(true);
    expect(next.monitorOpen).toBe(false);
    expect(next.historyOpen).toBe(false);
  });

  it("keeps defaults for files written before panels were saved", () => {
    expect(mergeUiState(UI_DEFAULTS, { sidebarOpen: false, sidebarWidth: 300 })).toEqual({
      ...UI_DEFAULTS,
      sidebarOpen: false,
      sidebarWidth: 300,
    });
  });

  it("ignores malformed values and clamps the sidebar width", () => {
    const next = mergeUiState(UI_DEFAULTS, { senderOpen: "yes", tmuxOpen: 1, sidebarWidth: 9999, other: true });
    expect(next.senderOpen).toBe(false);
    expect(next.tmuxOpen).toBe(false);
    expect(next.sidebarWidth).toBe(480);
    expect("other" in next).toBe(false);
    expect(mergeUiState(UI_DEFAULTS, null)).toBe(UI_DEFAULTS);
  });
});
