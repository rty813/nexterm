import { describe, expect, it } from "vitest";
import { formatUpdateSize, parseNoteInline, updatePercent, parseReleaseNotes, shouldPromptUpdate, updateCheckEnabled } from "../utils/updateCheck";
import type { UpdateInfo } from "../types/domain";

const info = (latest: string, available = true): UpdateInfo => ({
  current: "0.1.2",
  latest,
  available,
  url: "https://github.com/rty813/nexterm/releases/tag/v" + latest,
  notes: "",
  canInstall: true,
});

describe("update check", () => {
  it("formats download progress", () => {
    const mb = 1024 * 1024;
    expect(updatePercent({ received: 5, total: 0 })).toBeNull();
    expect(updatePercent({ received: 3 * mb, total: 12 * mb })).toBe(25);
    expect(updatePercent({ received: 13 * mb, total: 12 * mb })).toBe(100);
    expect(formatUpdateSize({ received: 0, total: 0 })).toBe("0.0 MB");
    expect(formatUpdateSize({ received: 5.5 * mb, total: 0 })).toBe("5.5 MB");
    expect(formatUpdateSize({ received: 3 * mb, total: 12 * mb })).toBe("3.0 / 12.0 MB");
  });

  it("is on by default", () => {
    expect(updateCheckEnabled({})).toBe(true);
    expect(updateCheckEnabled({ checkUpdates: true })).toBe(true);
    expect(updateCheckEnabled({ checkUpdates: false })).toBe(false);
  });

  it("prompts for a newer release unless it was skipped", () => {
    expect(shouldPromptUpdate(info("0.1.3"), {})).toBe(true);
    expect(shouldPromptUpdate(info("0.1.3", false), {})).toBe(false);
    expect(shouldPromptUpdate(info("0.1.3"), { skippedUpdateVersion: "0.1.3" })).toBe(false);
    expect(shouldPromptUpdate(info("0.1.4"), { skippedUpdateVersion: "0.1.3" })).toBe(true);
  });

  it("parses release notes into blocks", () => {
    const notes =
      "## What's Changed\r\n\r\n\r\n* **MCP** file transfer\r\n* Clear resets history by @a in [#3](https://x/3)\r\n\r\n" +
      "[![pic](https://x/a.jpg)](https://x/a.jpg)\n\nSome text\ncontinued\n\n**Full Changelog**: https://x/compare";
    expect(parseReleaseNotes(notes)).toEqual([
      { kind: "h2", lines: ["What's Changed"] },
      { kind: "li", lines: ["**MCP** file transfer"] },
      { kind: "li", lines: ["Clear resets history by @a in #3"] },
      { kind: "p", lines: ["Some text", "continued"] },
    ]);
    expect(parseReleaseNotes("")).toEqual([]);
  });

  it("keeps the UI language of bilingual notes", () => {
    const notes =
      "## 新功能 / What's new\n\n### MCP\n\n- **数据解释器**：单击字节。\n**Data interpreter**: click a byte.\n" +
      "- 仅中文\n- English only<br>still English\n";
    expect(parseReleaseNotes(notes, "zh-CN")).toEqual([
      { kind: "h2", lines: ["新功能"] },
      { kind: "h3", lines: ["MCP"] },
      { kind: "li", lines: ["**数据解释器**：单击字节。"] },
      { kind: "li", lines: ["仅中文"] },
      { kind: "li", lines: ["English only", "still English"] },
    ]);
    expect(parseReleaseNotes(notes, "en-US").map((b) => b.lines)).toEqual([
      ["What's new"],
      ["MCP"],
      ["**Data interpreter**: click a byte."],
      ["仅中文"],
      ["English only", "still English"],
    ]);
  });

  it("splits bold and code spans", () => {
    expect(parseNoteInline("New `list_files` and **MCP** tools")).toEqual([
      { text: "New " },
      { text: "list_files", code: true },
      { text: " and " },
      { text: "MCP", bold: true },
      { text: " tools" },
    ]);
    expect(parseNoteInline("plain")).toEqual([{ text: "plain" }]);
  });
});
