import type { TerminalBackground, ThemeDefinition } from "../types/domain";

/** Normalize a color typed by the user: "#abc" / "abc" / "#AABBCC" -> "#aabbcc"; anything else null. */
export function normalizeHex(input: string): string | null {
  const v = input.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{3}$/.test(v)) return `#${v[0]}${v[0]}${v[1]}${v[1]}${v[2]}${v[2]}`;
  if (/^[0-9a-f]{6}$/.test(v)) return `#${v}`;
  return null;
}

/** A color for `<input type="color">`, which only takes #rrggbb. */
export function colorInputValue(color: string): string {
  return normalizeHex(color) ?? "#000000";
}

/** Relative luminance (0 dark - 1 light) of a #rrggbb color; 0 for anything else. */
export function luminance(color: string): number {
  const hex = normalizeHex(color);
  if (!hex) return 0;
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export const isLightColor = (color: string) => luminance(color) > 0.4;

export const isCustomThemeId = (id: string, builtin: ThemeDefinition[]) => !builtin.some((t) => t.id === id);

/** A unique id for a new custom theme. */
export function newThemeId(existing: ThemeDefinition[], random = () => Math.random().toString(36).slice(2, 8)): string {
  for (;;) {
    const id = `custom-${random()}`;
    if (!existing.some((t) => t.id === id)) return id;
  }
}

/** "Name", "Name (2)", "Name (3)" ... the first not taken. */
export function uniqueThemeName(base: string, existing: ThemeDefinition[]): string {
  const taken = new Set(existing.map((t) => t.name));
  const stem = base.replace(/ \(\d+\)$/, "");
  if (!taken.has(stem)) return stem;
  for (let n = 2; ; n++) {
    const name = `${stem} (${n})`;
    if (!taken.has(name)) return name;
  }
}

/** Copy a theme (built-in or custom) into a new, editable custom theme. */
export function cloneTheme(base: ThemeDefinition, name: string, all: ThemeDefinition[], random?: () => string): ThemeDefinition {
  return {
    ...base,
    ansi: [...base.ansi] as ThemeDefinition["ansi"],
    id: newThemeId(all, random),
    name: uniqueThemeName(name, all),
  };
}

/** The color fields of a theme the editor shows, in order. */
export const GUI_COLOR_KEYS = ["guiBg", "guiPanel", "guiFg", "accent"] as const;
export const TERM_COLOR_KEYS = ["termBg", "termFg", "cursorLocal", "cursorRemote"] as const;
export type ThemeColorKey = (typeof GUI_COLOR_KEYS)[number] | (typeof TERM_COLOR_KEYS)[number];

/** Every color of the theme is a valid #rrggbb and the name is not blank. */
export function themeErrors(theme: ThemeDefinition): string[] {
  const bad: string[] = [];
  if (!theme.name.trim()) bad.push("name");
  for (const k of [...GUI_COLOR_KEYS, ...TERM_COLOR_KEYS]) if (!normalizeHex(theme[k])) bad.push(k);
  if (theme.ansi.length !== 16) bad.push("ansi");
  theme.ansi.forEach((c, i) => {
    if (!normalizeHex(c)) bad.push(`ansi${i}`);
  });
  return bad;
}

/** Insert or replace a custom theme by id. */
export function upsertTheme(list: ThemeDefinition[], theme: ThemeDefinition): ThemeDefinition[] {
  const i = list.findIndex((t) => t.id === theme.id);
  if (i < 0) return [...list, theme];
  const next = [...list];
  next[i] = theme;
  return next;
}

export const BACKGROUND_FITS = ["cover", "contain", "tile", "center"] as const;

const clamp = (v: unknown, lo: number, hi: number, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;

/** The background settings with defaults and limits applied. */
export function backgroundOf(bg: TerminalBackground | undefined): Required<TerminalBackground> {
  return {
    file: typeof bg?.file === "string" ? bg.file : "",
    opacity: clamp(bg?.opacity, 0.05, 1, 0.3),
    blur: clamp(bg?.blur, 0, 20, 0),
    fit: BACKGROUND_FITS.includes(bg?.fit as never) ? (bg!.fit as Required<TerminalBackground>["fit"]) : "cover",
  };
}

/** CSS background-size / repeat for a fit mode. */
export function backgroundCss(fit: Required<TerminalBackground>["fit"]): { size: string; repeat: string } {
  switch (fit) {
    case "contain":
      return { size: "contain", repeat: "no-repeat" };
    case "tile":
      return { size: "auto", repeat: "repeat" };
    case "center":
      return { size: "auto", repeat: "no-repeat" };
    default:
      return { size: "cover", repeat: "no-repeat" };
  }
}
