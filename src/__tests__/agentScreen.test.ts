import { describe, expect, it } from "vitest";
import { detectFromScreen, needsQuietConfirm, SCREEN_DONE_QUIET_MS } from "../utils/agentStatus";

// Claude Code 2.x screens as reported (working line while generating, then the done line).
const footer = ["─".repeat(40), "❯ ", "─".repeat(40), "  ⏵⏵ auto mode on (shift+tab to cycle)"];

describe("Claude Code 2.x screen", () => {
  it("working -> done", () => {
    const idle = detectFromScreen(["❯ hi", "", ...footer], undefined);
    expect(idle?.state).toBe("idle");
    const working = detectFromScreen(["❯ hi", "", "✻ Brewing… (3s · ↓ 12 tokens · esc to interrupt)", "", ...footer], idle);
    expect(working?.state).toBe("working");
    const done = detectFromScreen(
      ["❯ hi", "", "● Hi! What can I help you with in /home/user?", "", "✻ Brewed for 8s · done 3:08 PM", "", ...footer],
      working
    );
    expect(done?.state).toBe("done");
  });
});

// Codex 0.16x (screenshot from a user): the Working line, a tip under it, the composer.
const codexFooter = ["", "› Ask Codex to do anything", "", "  GPT-6.1-Sol high · /opt/candy-test · 添加关联记忆测试项", "  ← for agents · ? for shortcuts"];

describe("Codex screen", () => {
  it("is working while the Working line shows, even with a tip under it", () => {
    const lines = ["• Working (3m 01s • esc to interrupt)", "  └ Tip: Use /permissions to control when Codex asks for confirmation.", "", ...codexFooter];
    const s = detectFromScreen(lines, undefined);
    expect(s?.state).toBe("working");
    expect(s?.app).toBe("codex");
  });

  it("waits for quiet output before calling a hidden Working line done", () => {
    const working = detectFromScreen(["• Working (12s • esc to interrupt)", ...codexFooter], undefined)!;
    // Streaming a reply: Codex hides the Working line, the footer stays.
    const streaming = detectFromScreen(["• Here is the plan for the memory test", ...codexFooter], working);
    expect(streaming?.state).toBe("done");
    expect(needsQuietConfirm(streaming, working)).toBe(true);
    // Already done / still working / idle -> idle need no confirmation.
    expect(needsQuietConfirm(streaming, streaming)).toBe(false);
    expect(needsQuietConfirm(working, working)).toBe(false);
    expect(SCREEN_DONE_QUIET_MS).toBeGreaterThanOrEqual(2000);
  });
});
