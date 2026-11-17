import type { ITheme } from "@xterm/xterm";
import type { ThemeDefinition } from "../types/domain";

export const BUILTIN_THEMES: ThemeDefinition[] = [
  {
    id: "dige-black",
    name: "Dige 经典暗黑 (默认)",
    isLight: false,
    guiBg: "#1c1c1c",
    guiPanel: "#242424",
    guiFg: "#bbbbbb",
    accent: "#007acc",
    termBg: "#1c1c1c",
    termFg: "#F8F8F2",
    cursorLocal: "#FFFFFF",
    cursorRemote: "#FFA500",
    ansi: [
      "#333333",
      "#C4265E",
      "#86B42B",
      "#D0A500",
      "#3465A4",
      "#8C6BC8",
      "#56ADBC",
      "#e3e3dd",
      "#666666",
      "#f92672",
      "#A6E22E",
      "#9e862f",
      "#819aff",
      "#AE81FF",
      "#66D9EF",
      "#f8f8f2",
    ],
  },
  {
    id: "dige-black-and-white",
    name: "Dige 黑白混搭",
    isLight: true,
    guiBg: "#f3f3f3",
    guiPanel: "#ffffff",
    guiFg: "#333333",
    accent: "#007acc",
    termBg: "#272822",
    termFg: "#F8F8F2",
    cursorLocal: "#FFFFFF",
    cursorRemote: "#FFA500",
    ansi: [
      "#333333",
      "#C4265E",
      "#86B42B",
      "#D0A500",
      "#3465A4",
      "#8C6BC8",
      "#56ADBC",
      "#e3e3dd",
      "#666666",
      "#f92672",
      "#A6E22E",
      "#9e862f",
      "#819aff",
      "#AE81FF",
      "#66D9EF",
      "#f8f8f2",
    ],
  },
  {
    id: "dige-white",
    name: "Dige 明亮浅色",
    isLight: true,
    guiBg: "#f5f5f5",
    guiPanel: "#ffffff",
    guiFg: "#333333",
    accent: "#007acc",
    termBg: "#ffffff",
    termFg: "#333333",
    cursorLocal: "#272822",
    cursorRemote: "#FF8C00",
    ansi: [
      "#272822",
      "#dc322f",
      "#32CD32",
      "#DAA520",
      "#3465A4",
      "#d33682",
      "#3A96DD",
      "#d3d3d3",
      "#333333",
      "#ff7882",
      "#3CB371",
      "#D2691E",
      "#80baff",
      "#d778ff",
      "#008B8B",
      "#708090",
    ],
  },
  {
    id: "wind-abyss",
    name: "Wind 深渊暗黑 (OLED)",
    isLight: false,
    guiBg: "#111318",
    guiPanel: "#181b22",
    guiFg: "#cfd6e6",
    accent: "#3b82f6",
    termBg: "#0d0f14",
    termFg: "#e5e9f0",
    cursorLocal: "#60a5fa",
    cursorRemote: "#f59e0b",
    ansi: [
      "#1f2430",
      "#f87171",
      "#4ade80",
      "#facc15",
      "#60a5fa",
      "#c084fc",
      "#22d3ee",
      "#cbd5e1",
      "#475569",
      "#fca5a5",
      "#86efac",
      "#fde047",
      "#93c5fd",
      "#d8b4fe",
      "#67e8f9",
      "#f8fafc",
    ],
  },
];

export function applyThemeCssVars(theme: ThemeDefinition): void {
  const light = theme.isLight;
  const vars: Record<string, string> = {
    "--bg-app": theme.guiBg,
    "--bg-panel": theme.guiPanel,
    // Window backdrop behind the floating panels: a step darker than the GUI background.
    "--bg-base": `color-mix(in srgb, ${theme.guiBg} ${light ? 91 : 60}%, #000)`,
    "--bg-elevated": light ? "#ffffff" : `color-mix(in srgb, ${theme.guiPanel} 94%, #fff)`,
    "--bg-hover": light ? "rgba(0, 0, 0, 0.05)" : "rgba(255, 255, 255, 0.06)",
    "--bg-active": light ? "rgba(0, 0, 0, 0.08)" : "rgba(255, 255, 255, 0.1)",
    "--bg-selected": `color-mix(in srgb, ${theme.accent} ${light ? 14 : 20}%, ${theme.guiPanel})`,
    "--border-subtle": light ? "rgba(0, 0, 0, 0.09)" : "rgba(255, 255, 255, 0.07)",
    "--border-strong": light ? "rgba(0, 0, 0, 0.16)" : "rgba(255, 255, 255, 0.13)",
    "--fg-primary": theme.guiFg,
    "--fg-strong": light ? "#111827" : "#f3f4f6",
    "--fg-muted": `color-mix(in srgb, ${theme.guiFg} 62%, ${theme.guiBg})`,
    "--accent": theme.accent,
    "--term-bg": theme.termBg,
    "--term-fg": theme.termFg,
    "--term-blue": theme.ansi[12] ?? theme.ansi[4],
    "--term-magenta": theme.ansi[13] ?? theme.ansi[5],
    "--shadow-pop": light
      ? "0 0 0 1px rgba(0, 0, 0, 0.08), 0 12px 32px -8px rgba(0, 0, 0, 0.22)"
      : "0 0 0 1px rgba(0, 0, 0, 0.5), 0 16px 40px -8px rgba(0, 0, 0, 0.6)",
  };
  setThemeVars(vars, light);
  // Windows opened later paint their first frame in this theme (see applyCachedThemeVars).
  try {
    localStorage.setItem(THEME_CACHE_KEY, JSON.stringify({ vars, light }));
  } catch {
    // storage full or disabled
  }
}

const THEME_CACHE_KEY = "wtn-theme-vars";

function setThemeVars(vars: Record<string, string>, light: boolean): void {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  // A class, not a data attribute: the context-menu window copies className and style.
  root.classList.toggle("scheme-light", light);
}

/**
 * Apply the last theme before the first render. A new window otherwise draws the
 * stylesheet's default colors until its settings load, then switches to the theme.
 */
export function applyCachedThemeVars(): void {
  try {
    const raw = localStorage.getItem(THEME_CACHE_KEY);
    if (!raw) return;
    const { vars, light } = JSON.parse(raw) as { vars: Record<string, string>; light: boolean };
    if (vars && typeof vars === "object") setThemeVars(vars, Boolean(light));
  } catch {
    // corrupt cache: the theme arrives with the settings
  }
}

export function buildXtermTheme(
  theme: ThemeDefinition,
  isRemote: boolean
): ITheme {
  const cursor = isRemote ? theme.cursorRemote : theme.cursorLocal;
  return {
    background: theme.termBg,
    foreground: theme.termFg,
    cursor,
    cursorAccent: theme.termBg,
    selectionBackground: theme.isLight
      ? "rgba(0, 122, 204, 0.25)"
      : "rgba(77, 144, 254, 0.32)",
    black: theme.ansi[0],
    red: theme.ansi[1],
    green: theme.ansi[2],
    yellow: theme.ansi[3],
    blue: theme.ansi[4],
    magenta: theme.ansi[5],
    cyan: theme.ansi[6],
    white: theme.ansi[7],
    brightBlack: theme.ansi[8],
    brightRed: theme.ansi[9],
    brightGreen: theme.ansi[10],
    brightYellow: theme.ansi[11],
    brightBlue: theme.ansi[12],
    brightMagenta: theme.ansi[13],
    brightCyan: theme.ansi[14],
    brightWhite: theme.ansi[15],
  };
}
