import { VIEW_SIZE_LIMITS, viewSize, type PluginViewSize } from "../plugins/model";

const STORAGE_KEY = "nexterm.plugin.dialogSizes";
/** Space the dialog keeps from the window edges (matches `max-width: calc(100vw - 40px)`). */
export const DIALOG_MARGIN = 40;

/** Size of a dialog dragged by its corner; the dialog is centred, so it grows by twice the pointer movement. */
export function draggedDialogSize(start: {width: number; height: number}, dx: number, dy: number, viewport: {width: number; height: number}): {width: number; height: number} {
  const clamp = (value: number, [min, max]: readonly [number, number], room: number) => Math.round(Math.max(min, Math.min(max, room, value)));
  return {
    width: clamp(start.width + dx * 2, VIEW_SIZE_LIMITS.width, viewport.width - DIALOG_MARGIN),
    height: clamp(start.height + dy * 2, VIEW_SIZE_LIMITS.height, viewport.height - DIALOG_MARGIN),
  };
}

function readAll(): Record<string, unknown> {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

/** The size the user last dragged this plugin dialog to, if any. */
export function savedDialogSize(key: string): PluginViewSize | undefined {
  try { return viewSize(readAll()[key]); } catch { return undefined; }
}

export function saveDialogSize(key: string, size: PluginViewSize | undefined): void {
  const all = readAll();
  if (size) all[key] = size; else delete all[key];
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(all)); } catch { /* storage full or unavailable */ }
}
