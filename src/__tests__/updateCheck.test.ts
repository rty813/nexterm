import { describe, expect, it } from "vitest";
import { releaseNotesPreview, shouldPromptUpdate, updateCheckEnabled } from "../utils/updateCheck";
import type { UpdateInfo } from "../types/domain";

const info = (latest: string, available = true): UpdateInfo => ({
  current: "0.1.2",
  latest,
  available,
  url: "https://github.com/rty813/nexterm/releases/tag/v" + latest,
  notes: "",
});

describe("update check", () => {
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

  it("trims release notes", () => {
    const notes = "## What's Changed\r\n\r\n\r\n* **MCP** file transfer\r\n* Clear resets history\r\n\r\n";
    expect(releaseNotesPreview(notes)).toBe("What's Changed\n\n* MCP file transfer\n* Clear resets history");
    const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const out = releaseNotesPreview(long, 3).split("\n");
    expect(out).toEqual(["line 0", "line 1", "line 2", "…"]);
    expect(releaseNotesPreview("")).toBe("");
  });
});
