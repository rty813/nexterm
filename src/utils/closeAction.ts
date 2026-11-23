import type { AppSettings } from "../types/domain";

export type CloseAction = "ask" | "tray" | "quit";

/**
 * What closing the main window does. Older settings only have `closeToTray`: off keeps
 * quitting, on (the old default) asks. Mirrors `close_action` in `src-tauri/src/lib.rs`.
 */
export function closeActionOf(s: Pick<AppSettings, "closeAction" | "closeToTray">): CloseAction {
  const a = s.closeAction;
  if (a === "ask" || a === "tray" || a === "quit") return a;
  return s.closeToTray === false ? "quit" : "ask";
}

/** Settings with a new close action; `closeToTray` follows it for older versions. */
export function withCloseAction<T extends Pick<AppSettings, "closeAction" | "closeToTray">>(s: T, action: CloseAction): T {
  return { ...s, closeAction: action, closeToTray: action !== "quit" };
}
