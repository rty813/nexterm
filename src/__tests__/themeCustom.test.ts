import { describe, expect, it } from "vitest";
import { BUILTIN_THEMES } from "../constants/themes";
import {
  backgroundCss,
  backgroundOf,
  cloneTheme,
  isLightColor,
  normalizeHex,
  themeErrors,
  uniqueThemeName,
  upsertTheme,
} from "../utils/themeCustom";

describe("normalizeHex", () => {
  it("accepts short and long forms", () => {
    expect(normalizeHex("#ABC")).toBe("#aabbcc");
    expect(normalizeHex("abc")).toBe("#aabbcc");
    expect(normalizeHex(" #1A2b3C ")).toBe("#1a2b3c");
  });
  it("rejects others", () => {
    expect(normalizeHex("#12345")).toBeNull();
    expect(normalizeHex("red")).toBeNull();
    expect(normalizeHex("rgba(0,0,0,0)")).toBeNull();
  });
});

describe("built-in themes", () => {
  it("are valid and have unique ids", () => {
    const ids = new Set<string>();
    for (const t of BUILTIN_THEMES) {
      expect(themeErrors(t), t.id).toEqual([]);
      expect(ids.has(t.id), t.id).toBe(false);
      ids.add(t.id);
    }
    expect(BUILTIN_THEMES.length).toBeGreaterThanOrEqual(20);
  });
  it("mark light GUIs as light", () => {
    for (const t of BUILTIN_THEMES) expect(isLightColor(t.guiPanel), t.id).toBe(t.isLight);
  });
});

describe("custom themes", () => {
  it("clone gets a new id, a free name and its own ansi array", () => {
    const base = BUILTIN_THEMES[0];
    const a = cloneTheme(base, "Mine", BUILTIN_THEMES, () => "aaa");
    expect(a.id).toBe("custom-aaa");
    expect(a.ansi).not.toBe(base.ansi);
    expect(a.ansi).toEqual(base.ansi);
    const b = cloneTheme(a, a.name, [...BUILTIN_THEMES, a], (() => {
      const ids = ["aaa", "bbb"];
      return () => ids.shift()!;
    })());
    expect(b.id).toBe("custom-bbb");
    expect(b.name).toBe("Mine (2)");
  });
  it("uniqueThemeName strips an existing counter", () => {
    const list = [{ name: "X" }, { name: "X (2)" }] as never;
    expect(uniqueThemeName("X (2)", list)).toBe("X (3)");
    expect(uniqueThemeName("Y", list)).toBe("Y");
  });
  it("reports invalid fields", () => {
    const t = { ...BUILTIN_THEMES[0], name: " ", accent: "blue" };
    t.ansi = [...t.ansi] as typeof t.ansi;
    t.ansi[3] = "#zzzzzz";
    expect(themeErrors(t)).toEqual(["name", "accent", "ansi3"]);
  });
  it("upsert replaces by id or appends", () => {
    const a = { ...BUILTIN_THEMES[0], id: "c1" };
    expect(upsertTheme([], a)).toEqual([a]);
    const renamed = { ...a, name: "new" };
    expect(upsertTheme([a], renamed)).toEqual([renamed]);
  });
});

describe("background", () => {
  it("defaults and clamps", () => {
    expect(backgroundOf(undefined)).toEqual({ file: "", opacity: 0.3, blur: 0, fit: "cover" });
    expect(backgroundOf({ file: "bg-a.png", opacity: 5, blur: -1, fit: "tile" })).toEqual({ file: "bg-a.png", opacity: 1, blur: 0, fit: "tile" });
    expect(backgroundOf({ opacity: NaN, fit: "weird" as never })).toMatchObject({ opacity: 0.3, fit: "cover" });
  });
  it("maps fit to css", () => {
    expect(backgroundCss("tile")).toEqual({ size: "auto", repeat: "repeat" });
    expect(backgroundCss("cover").size).toBe("cover");
  });
});
