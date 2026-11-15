import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { backend } from "../services/backend";
import type { TerminalLeafNode } from "../types/domain";
import { tabTitle } from "../utils/layout";
import {
  AGENT_STATE_SCRIPT,
  WINDOWS_AGENT_STATE_SCRIPT,
  REMOTE_READ,
  hasOurHooks,
  hookStatus,
  mergeClaudeSettings,
  mergeCodexHooks,
  mergeGeminiSettings,
  parseRemoteRead,
  remoteWrite,
  type HookStatus,
} from "../utils/agentHooks";

/**
 * Claude Code / Codex / Gemini CLI status hooks: read the install status and install or
 * remove them, on this computer (target null) or on an SSH session's host.
 */
export function useAgentHooks(setToast: (message: string) => void) {
  const { t } = useTranslation();
  // Hook install status per SSH host (user@host:port), filled on demand.
  const hookStatusCache = useRef(new Map<string, HookStatus>());
  const hostKey = (leaf: TerminalLeafNode) => leaf.session.protocol === "wsl"
    ? `wsl:${leaf.paneId}`
    : `${leaf.session.username}@${leaf.session.host}:${leaf.session.port}`;
  const exec = (leaf: TerminalLeafNode, command: string) =>
    leaf.session.protocol === "wsl" ? backend.wslAgentExec(leaf.paneId, command) : backend.sshExec(leaf.paneId, command);

  /** Install status on this computer (null) or on an SSH session's host; null when it cannot be read. */
  const agentHookStatus = async (target: TerminalLeafNode | null, fresh = false): Promise<HookStatus | null> => {
    try {
      if (!target) {
        const f = await backend.agentHooksReadLocal();
        return hookStatus({
          ...f,
          windows: true,
          claudeSettings: f.claudeSettings ?? null,
          codexHooks: f.codexHooks ?? null,
          geminiSettings: f.geminiSettings ?? null,
          script: f.script ?? null,
        });
      }
      const key = hostKey(target);
      const cached = hookStatusCache.current.get(key);
      if (cached && !fresh) return cached;
      const status = hookStatus(parseRemoteRead(await exec(target, REMOTE_READ)));
      hookStatusCache.current.set(key, status);
      return status;
    } catch {
      return null;
    }
  };

  /** Install or remove the agent hooks, on this computer or on an SSH session's host. */
  const agentHooks = async (target: TerminalLeafNode | null, install: boolean) => {
    const apps: string[] = [];
    const plan = (f: {
      claudeDir: boolean;
      codexDir: boolean;
      geminiDir: boolean;
      claudeSettings: string | null;
      codexHooks: string | null;
      geminiSettings: string | null;
    }, windows = false) => {
      if (install && !f.claudeDir && !f.codexDir && !f.geminiDir) throw new Error(t("agent.noAgentDirs"));
      const want = (dir: boolean, text: string | null) => (install ? dir : hasOurHooks(text));
      const claude = want(f.claudeDir, f.claudeSettings) ? mergeClaudeSettings(f.claudeSettings, install, windows) : null;
      const codex = want(f.codexDir, f.codexHooks) ? mergeCodexHooks(f.codexHooks, install, windows) : null;
      const gemini = want(f.geminiDir, f.geminiSettings) ? mergeGeminiSettings(f.geminiSettings, install, windows) : null;
      if (claude !== null) apps.push("Claude Code");
      if (codex !== null) apps.push("Codex");
      if (gemini !== null) apps.push("Gemini CLI");
      return { claude, codex, gemini };
    };
    try {
      if (target) {
        const f = parseRemoteRead(await exec(target, REMOTE_READ));
        if (!f.hasBase64) throw new Error(t("agent.noBase64"));
        const { claude, codex, gemini } = plan(f);
        const out = await exec(target, remoteWrite(install ? AGENT_STATE_SCRIPT : null, claude, codex, gemini));
        if (!out.includes("WTN-OK")) throw new Error(out.trim() || "exec failed");
      } else {
        const f = await backend.agentHooksReadLocal();
        const { claude, codex, gemini } = plan({
          ...f,
          claudeSettings: f.claudeSettings ?? null,
          codexHooks: f.codexHooks ?? null,
          geminiSettings: f.geminiSettings ?? null,
        }, true);
        await backend.agentHooksWriteLocal({ script: install ? WINDOWS_AGENT_STATE_SCRIPT : null, claudeSettings: claude, codexHooks: codex, geminiSettings: gemini });
      }
      if (target) await agentHookStatus(target, true);
      const where = target ? tabTitle(target) : t("agent.thisComputer");
      setToast(
        install
          ? t("agent.installed", { where, apps: apps.join(" / ") }) +
              (apps.includes("Codex") ? t("agent.codexTrust") : "")
          : t("agent.uninstalled", { where })
      );
    } catch (e) {
      setToast(t("agent.failed", { error: e instanceof Error ? e.message : String(e) }));
    }
  };

  return { agentHookStatus, agentHooks };
}
