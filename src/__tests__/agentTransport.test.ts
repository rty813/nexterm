// @ts-nocheck -- integration test runs in Node; the frontend does not include Node types.
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { AGENT_STATE_SCRIPT, WINDOWS_AGENT_STATE_SCRIPT, REMOTE_READ, parseRemoteRead, hookStatus, remoteWrite, mergeClaudeSettings, posixHookCommand } from "../utils/agentHooks";

function run(file: string, args: string[], env: NodeJS.ProcessEnv, input = "{}") {
  return new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
    const p = spawn(file, args, { env, windowsHide: true, windowsVerbatimArguments: file === "cmd.exe" });
    let out = "", err = "";
    p.stdout.on("data", (v) => { out += v; });
    p.stderr.on("data", (v) => { err += v; });
    p.on("error", reject);
    p.on("close", (code) => resolve({ code, out, err }));
    p.stdin.end(input);
  });
}

describe.skipIf(process.platform !== "win32")("real hook transports", () => {
  it("runs generated Windows hooks and reports state with stdin", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nexterm-hook-"));
    const requests: string[] = [];
    const server = createServer((req, res) => { requests.push(req.url || ""); res.writeHead(204).end(); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const path = join(dir, "agent-state.ps1");
      await writeFile(path, WINDOWS_AGENT_STATE_SCRIPT);
      const port = (server.address() as { port: number }).port;
      const env = { ...process.env, NEXTERM_AGENT_URL: `http://127.0.0.1:${port}/agent?token=test`, NEXTERM_PANE_ID: "pane 1" };
      const doc = JSON.parse(mergeClaudeSettings("{}", true, true));
      const command = doc.hooks.PreToolUse[0].hooks[0].command.replace("(Join-Path ([Environment]::GetFolderPath('UserProfile')) '.nexterm/agent-state.ps1')", `'${path.replaceAll("'", "''")}'`);
      const result = await run("cmd.exe", ["/d", "/s", "/c", `"${command}"`], env, '{"tool_name":"AskUserQuestion"}');
      expect(result, result.err).toMatchObject({ code: 0 });
      expect(requests, JSON.stringify(result)).toHaveLength(1);
      expect(new URL(requests[0], "http://localhost").searchParams.get("state")).toBe("blocked");
      expect(new URL(requests[0], "http://localhost").searchParams.get("kind")).toBe("question");
    } finally { server.close(); await rm(dir, { recursive: true, force: true }); }
  }, 15000);
  it.skipIf(spawnSync("wsl.exe", ["--exec", "true"], { windowsHide: true, timeout: 5000 }).status !== 0)("installs and removes hooks in an isolated WSL home and uses curl.exe", async () => {
    const requests: string[] = [];
    const server = createServer((req, res) => { requests.push(req.url || ""); res.writeHead(204).end(); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as { port: number }).port;
      const env = { ...process.env, NEXTERM_AGENT_URL: `http://127.0.0.1:${port}/agent?token=test`, NEXTERM_PANE_ID: "test-pane", WSLENV: "NEXTERM_AGENT_URL/u:NEXTERM_PANE_ID/u" };
      const cmd = `set -e\nD=$(mktemp -d)\ntrap 'rm -rf "$D"' EXIT\nexport HOME="$D"\nunset CLAUDE_CONFIG_DIR CODEX_HOME\nmkdir -p "$HOME/.claude"\nprintf '%s' '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"custom"}]}]}}' > "$HOME/.claude/settings.json"\n${posixHookCommand(true)}\nprintf '%s' '{"tool_name":"AskUserQuestion"}' | sh "$HOME/.nexterm/agent-state.sh" claude PreToolUse\n${posixHookCommand(false)}\npython3 -c 'import json,os;d=json.load(open(os.environ["HOME"]+"/.claude/settings.json"));assert d["hooks"]["Stop"][0]["hooks"][0]["command"]=="custom"'\n`;
      const result = await run("wsl.exe", ["--exec", "sh", "-c", cmd], env);
      expect(result, result.err).toMatchObject({ code: 0 });
      expect(requests).toHaveLength(1);
      expect(new URL(requests[0], "http://localhost").searchParams.get("kind")).toBe("question");
    } finally { server.close(); }
  }, 20000);
  it.skipIf(spawnSync("wsl.exe", ["--exec", "true"], { windowsHide: true, timeout: 5000 }).status !== 0)("automatically installs and detects hooks through WSL exec", async () => {
    const env = { ...process.env };
    const call = (cmd: string) => run("wsl.exe", ["--exec", "sh", "-c", cmd], env);
    const temp = await call("mktemp -d /tmp/nexterm-agent-test.XXXXXXXX");
    expect(temp.code).toBe(0);
    const dir = temp.out.trim();
    expect(dir).toMatch(/^\/tmp\/nexterm-agent-test\.[a-zA-Z0-9]+$/);
    const prefix = `export HOME='${dir}'; unset CLAUDE_CONFIG_DIR CODEX_HOME; `;
    try {
      expect((await call(prefix + `mkdir -p "$HOME/.claude"; printf '%s' '{"model":"keep"}' > "$HOME/.claude/settings.json"`)).code).toBe(0);
      const before = await call(prefix + REMOTE_READ);
      expect(before.code).toBe(0);
      const initial = parseRemoteRead(before.out);
      expect(initial.claudeDir).toBe(true);
      const install = await call(prefix + remoteWrite(AGENT_STATE_SCRIPT, mergeClaudeSettings(initial.claudeSettings, true), null));
      expect(install, install.err).toMatchObject({ code: 0 });
      const after = parseRemoteRead((await call(prefix + REMOTE_READ)).out);
      expect(hookStatus(after).claude).toBe("installed");
      expect(JSON.parse(after.claudeSettings).model).toBe("keep");
      const remove = await call(prefix + remoteWrite(null, mergeClaudeSettings(after.claudeSettings, false), null));
      expect(remove, remove.err).toMatchObject({ code: 0 });
      const removed = parseRemoteRead((await call(prefix + REMOTE_READ)).out);
      expect(hookStatus(removed).claude).toBe("missing");
      expect(JSON.parse(removed.claudeSettings).model).toBe("keep");
    } finally { await call(`rm -rf '${dir}'`); }
  }, 20000);

});
