import { describe, expect, it } from "vitest";
import { resources } from "../i18n";
import { cleanLabel, searchSettings, SETTINGS_SEARCH_INDEX, type SettingsSearchTab } from "../utils/settingsSearch";

type Tree = Record<string, unknown>;
const lookup = (lng: "zh-CN" | "en-US", key: string): string | undefined => {
  let node: unknown = resources[lng].translation;
  for (const part of key.split(".")) node = (node as Tree | undefined)?.[part];
  return typeof node === "string" ? node : undefined;
};
const tabs: SettingsSearchTab[] = ["general", "theme", "terminal", "mouse", "logs", "xserver", "remote", "sync", "triggers", "keys", "toolbar", "plugins"];
const zhFirst = (key: string) => [lookup("zh-CN", key) ?? key, lookup("en-US", key) ?? key];
const enFirst = (key: string) => [lookup("en-US", key) ?? key, lookup("zh-CN", key) ?? key];

describe("settings search", () => {
  it("indexes only labels that exist in both languages", () => {
    const missing = [...SETTINGS_SEARCH_INDEX.map((e) => e.key), ...tabs.map((t) => `settingsModal.tab.${t}`)].filter(
      (key) => !lookup("zh-CN", key) || !lookup("en-US", key),
    );
    expect(missing).toEqual([]);
  });

  it("finds an option by either language whatever the UI language", () => {
    const zh = searchSettings("proxy", zhFirst, tabs);
    expect(zh.some((h) => h.key === "httpProxy.section" && h.tab === "general")).toBe(true);
    expect(zh.find((h) => h.key === "httpProxy.section")?.label).toBe(cleanLabel(lookup("zh-CN", "httpProxy.section")!));
    const en = searchSettings(cleanLabel(lookup("zh-CN", "settingsModal.scrollback")!), enFirst, tabs);
    expect(en[0]).toMatchObject({ key: "settingsModal.scrollback", label: cleanLabel(lookup("en-US", "settingsModal.scrollback")!) });
  });

  it("puts matching tabs first and requires every word", () => {
    const hits = searchSettings("x server", enFirst, tabs);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.tab === "xserver" || /x/i.test(h.label))).toBe(true);
    expect(searchSettings("mouse", enFirst, tabs)[0]).toMatchObject({ tab: "mouse", isTab: true });
    expect(searchSettings("zzzz-nothing", enFirst, tabs)).toEqual([]);
    expect(searchSettings("   ", enFirst, tabs)).toEqual([]);
  });

  it("cleans labels for display and matching", () => {
    expect(cleanLabel("Opacity {{x}}")).toBe("Opacity");
    expect(cleanLabel("日志目录：")).toBe("日志目录");
    expect(cleanLabel("More…")).toBe("More");
  });
});
