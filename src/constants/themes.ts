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
  scheme("dracula", "Dracula", false, ["#21222c", "#282a36", "#d6d7e0", "#bd93f9"], ["#282a36", "#f8f8f2", "#f8f8f2", "#ffb86c"], [
    "#21222c", "#ff5555", "#50fa7b", "#f1fa8c", "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2",
    "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5", "#d6acff", "#ff92df", "#a4ffff", "#ffffff",
  ]),
  scheme("one-dark", "One Dark", false, ["#21252b", "#282c34", "#abb2bf", "#61afef"], ["#282c34", "#abb2bf", "#528bff", "#e5c07b"], [
    "#3f4451", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#abb2bf",
    "#5c6370", "#ef7b84", "#a9d48a", "#f0cc8c", "#74bdf7", "#d48ce6", "#66c6d2", "#ffffff",
  ]),
  scheme("one-light", "One Light", true, ["#eaeaeb", "#fafafa", "#383a42", "#4078f2"], ["#fafafa", "#383a42", "#526fff", "#c18401"], [
    "#383a42", "#e45649", "#50a14f", "#c18401", "#4078f2", "#a626a4", "#0184bc", "#a0a1a7",
    "#696c77", "#ca1243", "#3e953a", "#986801", "#2e5fd8", "#8c1f8a", "#0a6f97", "#d4d4d6",
  ]),
  scheme("nord", "Nord", false, ["#2e3440", "#3b4252", "#d8dee9", "#88c0d0"], ["#2e3440", "#d8dee9", "#eceff4", "#ebcb8b"], [
    "#3b4252", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#88c0d0", "#e5e9f0",
    "#4c566a", "#d08770", "#a3be8c", "#ebcb8b", "#5e81ac", "#b48ead", "#8fbcbb", "#eceff4",
  ]),
  scheme("solarized-dark", "Solarized Dark", false, ["#00212b", "#002b36", "#93a1a1", "#268bd2"], ["#002b36", "#839496", "#93a1a1", "#cb4b16"], [
    "#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5",
    "#586e75", "#cb4b16", "#9cb300", "#d4a000", "#4ba3e3", "#6c71c4", "#3bc4b9", "#fdf6e3",
  ]),
  scheme("solarized-light", "Solarized Light", true, ["#eee8d5", "#fdf6e3", "#586e75", "#268bd2"], ["#fdf6e3", "#657b83", "#586e75", "#cb4b16"], [
    "#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#93a1a1",
    "#586e75", "#cb4b16", "#6c7d00", "#946f00", "#1a6fae", "#6c71c4", "#1f8079", "#eee8d5",
  ]),
  scheme("gruvbox-dark", "Gruvbox Dark", false, ["#1d2021", "#282828", "#d5c4a1", "#d79921"], ["#282828", "#ebdbb2", "#ebdbb2", "#fe8019"], [
    "#3c3836", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#a89984",
    "#928374", "#fb4934", "#b8bb26", "#fabd2f", "#83a598", "#d3869b", "#8ec07c", "#ebdbb2",
  ]),
  scheme("gruvbox-light", "Gruvbox Light", true, ["#f2e5bc", "#fbf1c7", "#3c3836", "#076678"], ["#fbf1c7", "#3c3836", "#3c3836", "#af3a03"], [
    "#3c3836", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#7c6f64",
    "#928374", "#9d0006", "#79740e", "#b57614", "#076678", "#8f3f71", "#427b58", "#282828",
  ]),
  scheme("tokyo-night", "Tokyo Night", false, ["#16161e", "#1a1b26", "#a9b1d6", "#7aa2f7"], ["#1a1b26", "#c0caf5", "#c0caf5", "#ff9e64"], [
    "#15161e", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#a9b1d6",
    "#414868", "#ff8ba0", "#b0e07c", "#f0c27c", "#8db2ff", "#c9aaff", "#94d9ff", "#c0caf5",
  ]),
  scheme("catppuccin-mocha", "Catppuccin Mocha", false, ["#181825", "#1e1e2e", "#bac2de", "#cba6f7"], ["#1e1e2e", "#cdd6f4", "#f5e0dc", "#fab387"], [
    "#45475a", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#bac2de",
    "#585b70", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#a6adc8",
  ]),
  scheme("catppuccin-latte", "Catppuccin Latte", true, ["#e6e9ef", "#eff1f5", "#4c4f69", "#8839ef"], ["#eff1f5", "#4c4f69", "#dc8a78", "#fe640b"], [
    "#5c5f77", "#d20f39", "#40a02b", "#df8e1d", "#1e66f5", "#ea76cb", "#179299", "#acb0be",
    "#6c6f85", "#d20f39", "#40a02b", "#df8e1d", "#1e66f5", "#ea76cb", "#179299", "#bcc0cc",
  ]),
  scheme("rose-pine", "Rosé Pine", false, ["#191724", "#1f1d2e", "#e0def4", "#c4a7e7"], ["#191724", "#e0def4", "#ebbcba", "#f6c177"], [
    "#26233a", "#eb6f92", "#31748f", "#f6c177", "#9ccfd8", "#c4a7e7", "#ebbcba", "#e0def4",
    "#6e6a86", "#eb6f92", "#3e8fb0", "#f6c177", "#9ccfd8", "#c4a7e7", "#ebbcba", "#ffffff",
  ]),
  scheme("monokai", "Monokai", false, ["#1e1f1c", "#272822", "#d6d6ce", "#a6e22e"], ["#272822", "#f8f8f2", "#f8f8f0", "#fd971f"], [
    "#3e3d32", "#f92672", "#a6e22e", "#f4bf75", "#66d9ef", "#ae81ff", "#a1efe4", "#f8f8f2",
    "#75715e", "#ff4f8b", "#bdf55a", "#ffd08f", "#8ae6f7", "#c4a3ff", "#bdf7ef", "#f9f8f5",
  ]),
  scheme("github-dark", "GitHub Dark", false, ["#010409", "#0d1117", "#c9d1d9", "#2f81f7"], ["#0d1117", "#e6edf3", "#58a6ff", "#d29922"], [
    "#484f58", "#ff7b72", "#3fb950", "#d29922", "#58a6ff", "#bc8cff", "#39c5cf", "#b1bac4",
    "#6e7681", "#ffa198", "#56d364", "#e3b341", "#79c0ff", "#d2a8ff", "#56d4dd", "#f0f6fc",
  ]),
  scheme("github-light", "GitHub Light", true, ["#f6f8fa", "#ffffff", "#24292f", "#0969da"], ["#ffffff", "#24292f", "#0969da", "#bc4c00"], [
    "#24292f", "#cf222e", "#116329", "#4d2d00", "#0969da", "#8250df", "#1b7c83", "#6e7781",
    "#57606a", "#a40e26", "#1a7f37", "#633c01", "#218bff", "#a475f9", "#3192aa", "#8c959f",
  ]),
  scheme("synthwave", "Synthwave", false, ["#1e1a2b", "#262335", "#e4dff0", "#ff7edb"], ["#262335", "#f4eeff", "#72f1b8", "#fede5d"], [
    "#2a2139", "#fe4450", "#72f1b8", "#fede5d", "#03edf9", "#ff7edb", "#36f9f6", "#f0eff1",
    "#614d85", "#ff6b74", "#97f7cc", "#fff08f", "#5af3fb", "#ffa3e6", "#7cfbf9", "#ffffff",
  ]),
];

/** A built-in scheme: [guiBg, guiPanel, guiFg, accent], [termBg, termFg, cursorLocal, cursorRemote], 16 ANSI colors. */
function scheme(
  id: string,
  name: string,
  isLight: boolean,
  [guiBg, guiPanel, guiFg, accent]: string[],
  [termBg, termFg, cursorLocal, cursorRemote]: string[],
  ansi: string[]
): ThemeDefinition {
  return { id, name, isLight, guiBg, guiPanel, guiFg, accent, termBg, termFg, cursorLocal, cursorRemote, ansi: ansi as ThemeDefinition["ansi"] };
}

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

/**
 * `transparent`: a background image is drawn behind the terminal (the pane paints the
 * theme's background color under it), so xterm.js leaves its own background clear.
 */
export function buildXtermTheme(
  theme: ThemeDefinition,
  isRemote: boolean,
  transparent = false
): ITheme {
  const cursor = isRemote ? theme.cursorRemote : theme.cursorLocal;
  return {
    background: transparent ? "rgba(0, 0, 0, 0)" : theme.termBg,
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
