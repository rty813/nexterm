import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { backend } from "../services/backend";
import type { TerminalLeafNode } from "../types/domain";
import { tabTitle } from "../utils/layout";
import {
  AGENT_STATE_SCRIPT,
  REMOTE_READ,
  hasOurHooks,
  hookStatus,
  mergeClaudeSettings,
  mergeCodexHooks,
  parseRemoteRead,
  remoteWrite,
  type HookStatus,
} from "../utils/agentHooks";

/**
 * Claude Code / Codex status hooks: read the install status and install or
 * remove them, on this computer (target null) or on an SSH session's host.
 */
export function useAgentHooks(setToast: (message: string) => void) {
  const { t } = useTranslation();
  // Hook install status per SSH host (user@host:port), filled on demand.
  const hookStatusCache = useRef(new Map<string, HookStatus>());
  const hostKey = (leaf: TerminalLeafNode) => `${leaf.session.username}@${leaf.session.host}:${leaf.session.port}`;

  /** Install status on this computer (null) or on an SSH session's host; null when it cannot be read. */
  const agentHookStatus = async (target: TerminalLeafNode | null, fresh = false): Promise<HookStatus | null> => {
    try {
      if (!target) {
        const f = await backend.agentHooksReadLocal();
        return hookStatus({
          ...f,
          claudeSettings: f.claudeSettings ?? null,
          codexHooks: f.codexHooks ?? null,
          script: f.script ?? null,
        });
      }
      const key = hostKey(target);
      const cached = hookStatusCache.current.get(key);
      if (cached && !fresh) return cached;
      const status = hookStatus(parseRemoteRead(await backend.sshExec(target.paneId, REMOTE_READ)));
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
      claudeSettings: string | null;
      codexHooks: string | null;
    }) => {
      if (install && !f.claudeDir && !f.codexDir) throw new Error(t("agent.noAgentDirs"));
      const want = (dir: boolean, text: string | null) => (install ? dir : hasOurHooks(text));
      const claude = want(f.claudeDir, f.claudeSettings) ? mergeClaudeSettings(f.claudeSettings, install) : null;
      const codex = want(f.codexDir, f.codexHooks) ? mergeCodexHooks(f.codexHooks, install) : null;
      if (claude !== null) apps.push("Claude Code");
      if (codex !== null) apps.push("Codex");
      return { claude, codex };
    };
    try {
      if (target) {
        const f = parseRemoteRead(await backend.sshExec(target.paneId, REMOTE_READ));
        if (!f.hasBase64) throw new Error(t("agent.noBase64"));
        const { claude, codex } = plan(f);
        const out = await backend.sshExec(target.paneId, remoteWrite(install ? AGENT_STATE_SCRIPT : null, claude, codex));
        if (!out.includes("WTN-OK")) throw new Error(out.trim() || "exec failed");
      } else {
        const f = await backend.agentHooksReadLocal();
        const { claude, codex } = plan({
          ...f,
          claudeSettings: f.claudeSettings ?? null,
          codexHooks: f.codexHooks ?? null,
        });
        await backend.agentHooksWriteLocal({ script: install ? AGENT_STATE_SCRIPT : null, claudeSettings: claude, codexHooks: codex });
      }
      if (target) void agentHookStatus(target, true);
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
