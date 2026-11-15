import { describe, expect, it } from "vitest";
import { agentDisplayName, detectFromScreen, parseOsc7501 } from "../utils/agentStatus";
import { AGENT_STATE_SCRIPT, WINDOWS_AGENT_STATE_SCRIPT, anyInstalled, fromBase64, hasOurHooks, hookStatus, mergeClaudeSettings, mergeCodexHooks, mergeGeminiSettings, parseRemoteRead, posixHookCommand, remoteWrite, toBase64 } from "../utils/agentHooks";

describe("OSC 7501", () => {
  it("parses Herdr's format", () => {
    expect(parseOsc7501(":state=blocked:kind=permission:app=claude-code")).toEqual({ state: "blocked", kind: "permission", app: "claude" });
    expect(parseOsc7501(":state=clear:app=codex")).toEqual({ state: "clear", app: "codex" });
    expect(parseOsc7501(":state=bogus")).toBeNull();
    expect(parseOsc7501(":state=working:app=gemini-cli")).toEqual({ state: "working", kind: undefined, app: "gemini" });
    expect(agentDisplayName("gemini")).toBe("Gemini CLI");
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

  it("follows Gemini CLI", () => {
    const prompt = [" >   Type your message or @path/to/file", "~/proj   no sandbox   gemini-2.5-pro", "? for shortcuts"];
    const idle = detectFromScreen(prompt, undefined);
    expect(idle).toMatchObject({ state: "idle", app: "gemini" });
    const working = detectFromScreen(["⠏ Reading the file (esc to cancel, 4s)", ...prompt], idle);
    expect(working).toMatchObject({ state: "working", app: "gemini" });
    // The confirmation hides the input box: the app is remembered.
    for (const ask of ["Apply this change?", "Do you want to proceed?", 'Allow execution of MCP tool "x" from server "y"?']) {
      expect(detectFromScreen(["Action Required", ask, "● 1. Allow once", "Waiting for user confirmation..."], working)).toMatchObject({ state: "blocked", app: "gemini" });
    }
    expect(detectFromScreen(prompt, working)?.state).toBe("done");
    // The hint line Gemini shows with UI details off.
    expect(detectFromScreen(["press tab twice for more"], undefined)?.state).toBe("idle");
    // Another agent's screen that only talks about Gemini is not Gemini.
    expect(detectFromScreen(["✻ Comparing with gemini… (esc to interrupt)"], undefined)?.app).toBe("claude");
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

  it("writes Gemini CLI's events, with its millisecond timeout", () => {
    const original = JSON.stringify({
      mcpServers: { x: { command: "y" } },
      hooks: { enabled: true, disabled: ["some-hook"], AfterAgent: [{ hooks: [{ name: "mine", type: "command", command: "say done" }] }] },
    });
    const installed = mergeGeminiSettings(original, true);
    const doc = JSON.parse(installed);
    expect(doc.mcpServers).toEqual({ x: { command: "y" } });
    // Settings Gemini keeps beside the events are not matcher groups: untouched.
    expect(doc.hooks.enabled).toBe(true);
    expect(doc.hooks.disabled).toEqual(["some-hook"]);
    expect(Object.keys(doc.hooks).filter((k) => Array.isArray(doc.hooks[k]) && k !== "disabled")).toEqual(
      ["AfterAgent", "SessionStart", "BeforeAgent", "BeforeTool", "AfterTool", "Notification", "SessionEnd"]
    );
    expect(doc.hooks.AfterAgent).toHaveLength(2);
    expect(doc.hooks.BeforeTool[0]).toEqual({
      matcher: "*",
      hooks: [{ name: "nexterm-agent-state", type: "command", command: 'sh "$HOME/.nexterm/agent-state.sh" gemini BeforeTool', timeout: 5000 }],
    });
    expect(doc.hooks.BeforeAgent[0].matcher).toBeUndefined();
    expect(mergeGeminiSettings(installed, true)).toBe(installed);
    expect(JSON.parse(mergeGeminiSettings(installed, false))).toEqual(JSON.parse(original));
    // Claude Code and Codex keep seconds.
    expect(JSON.parse(mergeClaudeSettings("{}", true)).hooks.Stop[0].hooks[0].timeout).toBe(5);
    expect(JSON.parse(mergeGeminiSettings("{}", true, true)).hooks.AfterAgent[0].hooks[0].command).toContain(".nexterm/agent-state.ps1') gemini AfterAgent");
    expect(() => mergeGeminiSettings('{"hooks": []}', true)).toThrow();
  });

  it("maps Gemini CLI's events in both scripts", () => {
    for (const script of [AGENT_STATE_SCRIPT, WINDOWS_AGENT_STATE_SCRIPT]) {
      for (const word of ["BeforeAgent", "BeforeTool", "AfterTool", "AfterAgent", "ToolPermission", "ask_user"]) expect(script).toContain(word);
    }
  });

  it("round-trips remote reads", () => {
    const text = '{"中文": 1}';
    expect(fromBase64(toBase64(text))).toBe(text);
    const out = `@@WTN@@\n${toBase64(text)}\n@@WTN@@\n\n@@WTN@@\n\n@@WTN@@\n${toBase64("{}")}\n@@WTN@@\nclaude-dir\ngemini-dir\nhas-base64\n`;
    expect(parseRemoteRead(out)).toEqual({
      claudeSettings: text, codexHooks: null, script: null, geminiSettings: "{}",
      claudeDir: true, codexDir: false, geminiDir: true, hasBase64: true,
    });
    // Output of a host that still runs an older reader: no Gemini part, nothing misread.
    expect(parseRemoteRead(`@@WTN@@\n\n@@WTN@@\n\n@@WTN@@\n\n@@WTN@@\nclaude-dir\nhas-base64\n`).geminiSettings).toBeNull();
  });

  it("writes Gemini CLI's settings on a remote host", () => {
    const cmd = remoteWrite("script", null, null, "{}");
    expect(cmd).toContain('"${GEMINI_CLI_HOME:-$HOME}/.gemini"/settings.json');
    expect(cmd).not.toContain(".claude");
    expect(remoteWrite("script", "{}", null)).not.toContain(".gemini");
    const py = fromBase64(posixHookCommand(true).match(/b64decode\('([^']+)'\)/)![1]);
    expect(py).toContain("'.gemini'/'settings.json','gemini'");
    expect(py).toContain("5000 if app=='gemini' else 5");
  });
});

describe("hook install status", () => {
  it("reports installed / missing / absent / outdated", () => {
    const claude = mergeClaudeSettings("{}", true);
    const base = { claudeDir: true, codexDir: false, claudeSettings: claude, codexHooks: null };
    expect(hookStatus({ ...base, script: AGENT_STATE_SCRIPT })).toEqual({ claude: "installed", codex: "absent", gemini: "absent", outdated: false });
    expect(hookStatus({ ...base, script: "old" })).toEqual({ claude: "installed", codex: "absent", gemini: "absent", outdated: true });
    expect(hookStatus({ ...base, script: null }).claude).toBe("missing");
    expect(hookStatus({ ...base, codexDir: true, claudeSettings: "{}", script: null })).toEqual({ claude: "missing", codex: "missing", gemini: "absent", outdated: false });
    const onlyGemini = hookStatus({ claudeDir: false, codexDir: false, geminiDir: true, claudeSettings: null, codexHooks: null, geminiSettings: mergeGeminiSettings("{}", true), script: AGENT_STATE_SCRIPT });
    expect(onlyGemini).toEqual({ claude: "absent", codex: "absent", gemini: "installed", outdated: false });
    expect(anyInstalled(onlyGemini)).toBe(true);
    expect(hookStatus({ ...base, geminiDir: true, geminiSettings: '{"hooks":{"disabled":["x"]}}', script: null }).gemini).toBe("missing");
  });
});


describe("Windows hook migration", () => {
  it("preserves other commands in a mixed group and replaces old hooks", () => {
    const input = JSON.stringify({ hooks: { Stop: [{ hooks: [
      { type: "command", command: "custom" },
      { type: "command", command: 'sh "$HOME/.nexterm/agent-state.sh" claude Stop' },
    ] }] } });
    const updated = mergeClaudeSettings(input, true, true);
    const groups = JSON.parse(updated).hooks.Stop;
    expect(groups[0].hooks).toEqual([{ type: "command", command: "custom" }]);
    expect(groups[1].hooks[0].command).toContain(".nexterm/agent-state.ps1");
    expect(hasOurHooks(updated)).toBe(true);
    expect(JSON.parse(mergeClaudeSettings(updated, false, true)).hooks.Stop[0].hooks[0].command).toBe("custom");
    expect(hookStatus({ claudeDir: true, codexDir: false, claudeSettings: updated, codexHooks: null, script: WINDOWS_AGENT_STATE_SCRIPT, windows: true }).outdated).toBe(false);
  });
});
