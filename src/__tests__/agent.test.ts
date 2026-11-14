import { describe, expect, it } from "vitest";
import { detectFromScreen, parseOsc7501 } from "../utils/agentStatus";
import { AGENT_STATE_SCRIPT, fromBase64, hasOurHooks, hookStatus, mergeClaudeSettings, mergeCodexHooks, parseRemoteRead, toBase64 } from "../utils/agentHooks";

describe("OSC 7501", () => {
  it("parses Herdr's format", () => {
    expect(parseOsc7501(":state=blocked:kind=permission:app=claude-code")).toEqual({ state: "blocked", kind: "permission", app: "claude" });
    expect(parseOsc7501(":state=clear:app=codex")).toEqual({ state: "clear", app: "codex" });
    expect(parseOsc7501(":state=bogus")).toBeNull();
  });
});

describe("screen detection", () => {
  it("follows working -> done, blocked, and agent exit", () => {
    const working = detectFromScreen(["✻ Thinking… (esc to interrupt)", "? for shortcuts"], undefined);
    expect(working?.state).toBe("working");
    expect(working?.app).toBe("claude");
    const done = detectFromScreen(["> ", "? for shortcuts"], working);
    expect(done?.state).toBe("done");
    expect(detectFromScreen(["Do you want to proceed?", "❯ 1. Yes"], done)?.state).toBe("blocked");
    expect(detectFromScreen(["user@host:~$ "], done)).toBeUndefined();
    expect(detectFromScreen(["> ", "? for shortcuts"], undefined)?.state).toBe("idle");
  });
});

describe("hook config merge", () => {
  it("adds our hooks, keeps others, and removes cleanly", () => {
    const original = JSON.stringify({ model: "x", hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } });
    const installed = mergeClaudeSettings(original, true);
    const doc = JSON.parse(installed);
    expect(doc.model).toBe("x");
    expect(doc.hooks.Stop).toHaveLength(2);
    expect(doc.hooks.PreToolUse[0].matcher).toBe("*");
    expect(hasOurHooks(installed)).toBe(true);
    // installing twice does not duplicate
    expect(JSON.parse(mergeClaudeSettings(installed, true)).hooks.Stop).toHaveLength(2);
    const removed = JSON.parse(mergeClaudeSettings(installed, false));
    expect(removed.hooks).toEqual({ Stop: [{ hooks: [{ type: "command", command: "say done" }] }] });
    expect(Object.keys(JSON.parse(mergeCodexHooks(null, true)).hooks)).toEqual(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]);
    expect(() => mergeClaudeSettings("{ bad", true)).toThrow();
  });

  it("round-trips remote reads", () => {
    const text = '{"中文": 1}';
    expect(fromBase64(toBase64(text))).toBe(text);
    const out = `@@WTN@@\n${toBase64(text)}\n@@WTN@@\n\n@@WTN@@\n\n@@WTN@@\nclaude-dir\nhas-base64\n`;
    expect(parseRemoteRead(out)).toEqual({ claudeSettings: text, codexHooks: null, script: null, claudeDir: true, codexDir: false, hasBase64: true });
  });
});

describe("hook install status", () => {
  it("reports installed / missing / absent / outdated", () => {
    const claude = mergeClaudeSettings("{}", true);
    const base = { claudeDir: true, codexDir: false, claudeSettings: claude, codexHooks: null };
    expect(hookStatus({ ...base, script: AGENT_STATE_SCRIPT })).toEqual({ claude: "installed", codex: "absent", outdated: false });
    expect(hookStatus({ ...base, script: "old" })).toEqual({ claude: "installed", codex: "absent", outdated: true });
    expect(hookStatus({ ...base, script: null }).claude).toBe("missing");
    expect(hookStatus({ ...base, codexDir: true, claudeSettings: "{}", script: null })).toEqual({ claude: "missing", codex: "missing", outdated: false });
  });
});
