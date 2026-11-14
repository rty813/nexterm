/**
 * Every command that can be bound to a key. Labels are i18n keys under "actions.".
 * Users override `defaultKey` per action in Settings > Shortcuts (AppSettings.keymap).
 */
export interface ActionDef {
  id: string;
  group: "view" | "terminal" | "tab" | "split" | "window";
  defaultKey: string;
}

export const ACTIONS: ActionDef[] = [
  { id: "view.commandPalette", group: "view", defaultKey: "Ctrl+Shift+Space" },
  { id: "view.toggleSidebar", group: "view", defaultKey: "Ctrl+Shift+B" },
  { id: "view.toggleQuickBar", group: "view", defaultKey: "" },
  { id: "view.quickCommands", group: "view", defaultKey: "" },
  { id: "view.focusMode", group: "view", defaultKey: "F11" },
  { id: "view.sessionManager", group: "view", defaultKey: "" },
  { id: "view.settings", group: "view", defaultKey: "Ctrl+," },
  { id: "view.portForward", group: "view", defaultKey: "Ctrl+Shift+P" },
  { id: "view.sender", group: "view", defaultKey: "Alt+S" },
  { id: "view.history", group: "view", defaultKey: "Alt+H" },
  { id: "view.toggleStatusBar", group: "view", defaultKey: "" },

  { id: "terminal.copy", group: "terminal", defaultKey: "Ctrl+Shift+C" },
  { id: "terminal.paste", group: "terminal", defaultKey: "Ctrl+Shift+V" },
  { id: "terminal.find", group: "terminal", defaultKey: "Ctrl+Shift+F" },
  { id: "terminal.selectAll", group: "terminal", defaultKey: "" },
  { id: "terminal.clear", group: "terminal", defaultKey: "" },
  { id: "terminal.syncPause", group: "terminal", defaultKey: "Ctrl+Shift+M" },
  { id: "terminal.syncPausePane", group: "terminal", defaultKey: "" },
  { id: "terminal.toggleLog", group: "terminal", defaultKey: "" },
  { id: "terminal.tmux", group: "terminal", defaultKey: "" },
  { id: "terminal.toggleTimestamp", group: "terminal", defaultKey: "Ctrl+Shift+S" },
  { id: "terminal.notifyWhenDone", group: "terminal", defaultKey: "Ctrl+Shift+E" },
  { id: "terminal.reset", group: "terminal", defaultKey: "" },
  { id: "terminal.saveToFile", group: "terminal", defaultKey: "" },
  { id: "terminal.foldAll", group: "terminal", defaultKey: "Alt+[" },
  { id: "terminal.unfoldAll", group: "terminal", defaultKey: "Alt+]" },
  { id: "terminal.pauseLog", group: "terminal", defaultKey: "" },

  { id: "tab.newShell", group: "tab", defaultKey: "Ctrl+Shift+T" },
  { id: "tab.close", group: "tab", defaultKey: "Ctrl+Shift+W" },
  { id: "tab.next", group: "tab", defaultKey: "Ctrl+Tab" },
  { id: "tab.prev", group: "tab", defaultKey: "Ctrl+Shift+Tab" },
  { id: "tab.duplicate", group: "tab", defaultKey: "Ctrl+Shift+D" },
  { id: "tab.reconnect", group: "tab", defaultKey: "Ctrl+Shift+R" },
  { id: "tab.moveToNewWindow", group: "tab", defaultKey: "" },
  { id: "tab.lock", group: "tab", defaultKey: "Ctrl+Shift+L" },

  { id: "split.right", group: "split", defaultKey: "Alt+Shift+=" },
  { id: "split.down", group: "split", defaultKey: "Alt+Shift+-" },
  { id: "split.zoom", group: "split", defaultKey: "Alt+Z" },
  { id: "split.focusLeft", group: "split", defaultKey: "Alt+Left" },
  { id: "split.focusRight", group: "split", defaultKey: "Alt+Right" },
  { id: "split.focusUp", group: "split", defaultKey: "Alt+Up" },
  { id: "split.focusDown", group: "split", defaultKey: "Alt+Down" },
  { id: "split.growLeft", group: "split", defaultKey: "Alt+Shift+Left" },
  { id: "split.growRight", group: "split", defaultKey: "Alt+Shift+Right" },
  { id: "split.growUp", group: "split", defaultKey: "Alt+Shift+Up" },
  { id: "split.growDown", group: "split", defaultKey: "Alt+Shift+Down" },
  { id: "split.swapNext", group: "split", defaultKey: "" },
  { id: "split.equalize", group: "split", defaultKey: "" },

  { id: "window.alwaysOnTop", group: "window", defaultKey: "" },
  { id: "window.lock", group: "window", defaultKey: "" },
];

const CODE_NAMES: Record<string, string> = {
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  Equal: "=",
  Minus: "-",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backquote: "`",
  Space: "Space",
  Enter: "Enter",
  Tab: "Tab",
  Escape: "Esc",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  NumpadAdd: "Num+",
  NumpadSubtract: "Num-",
};

/** "Ctrl+Shift+F" style name of a key event, or null for a lone modifier. */
export function comboFromEvent(e: KeyboardEvent): string | null {
  const code = e.code;
  let key: string | undefined;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^F([1-9]|1[0-2])$/.test(code)) key = code;
  else if (/^Numpad[0-9]$/.test(code)) key = `Num${code.slice(6)}`;
  else key = CODE_NAMES[code];
  if (!key) return null;
  const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Meta"].filter(Boolean);
  return [...mods, key].join("+");
}

/** Effective key per action after user overrides. */
export function resolveKeymap(overrides: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of ACTIONS) out[a.id] = overrides && a.id in overrides ? overrides[a.id] : a.defaultKey;
  return out;
}

export function actionForCombo(keymap: Record<string, string>, combo: string): string | undefined {
  return Object.keys(keymap).find((id) => keymap[id] && keymap[id] === combo);
}

// ------------------------------------------------------------------ toolbar

export const TOOLBAR_ITEMS = [
  "sidebar",
  "newSession",
  "palette",
  "reconnect",
  "disconnect",
  "quickConnect",
  "splitRight",
  "splitDown",
  "sync",
  "quickBar",
  "portForward",
  "sender",
  "history",
  "settings",
  "focusMode",
] as const;

export type ToolbarItem = (typeof TOOLBAR_ITEMS)[number];

/**
 * Buttons kept off the toolbar by default: they live in the "More" menu, the tab bars and
 * the command palette. Users who never customized the toolbar get this layout once
 * (AppSettings.toolbarLayout < 2).
 */
export const DEFAULT_TOOLBAR_HIDDEN: ToolbarItem[] = [
  "reconnect",
  "disconnect",
  "splitRight",
  "splitDown",
  "portForward",
  "sender",
  "history",
];
export const TOOLBAR_LAYOUT_VERSION = 2;
