import type { TFunction } from "i18next";
import type { MenuItem } from "../components/ContextMenu";
import { backend } from "../services/backend";
import type { TerminalLeafNode } from "../types/domain";

export interface TmuxMenuDeps {
  t: TFunction;
  /** Type a command into the pane (Enter included). */
  send: (cmd: string) => void;
  /** Open the session again in a new tab that runs `startupCommand`. */
  openInNewTab: (startupCommand: string) => void;
}

/** The pane menu's tmux submenu: sessions on the SSH host and what to do with them. */
export async function buildTmuxMenu(leaf: TerminalLeafNode, deps: TmuxMenuDeps): Promise<MenuItem[]> {
  const { t, send, openInNewTab } = deps;
  let sessionsOut = "";
  let error: string | null = null;
  try {
    sessionsOut = await backend.sshExec(
      leaf.paneId,
      "tmux list-sessions -F '#{session_name}\t#{session_windows}\t#{?session_attached,1,0}' 2>&1 || true"
    );
  } catch (e) {
    error = String(e);
  }
  const missing = /command not found|not found|No such file/i.test(sessionsOut);
  const noServer = /no server running|error connecting|no sessions/i.test(sessionsOut);
  const list = missing || noServer || error
    ? []
    : sessionsOut
        .split("\n")
        .map((l) => l.split("\t"))
        .filter((p) => p.length >= 3 && p[0]);
  const quote = (n: string) => `'${n.replace(/'/g, "'\\''")}'`;
  const items: MenuItem[] = [
    {
      label: t("tmux.header", { count: list.length }),
      disabled: true,
    },
  ];
  if (error) items.push({ label: t("tmux.error", { error }), disabled: true });
  if (missing) items.push({ label: t("tmux.notInstalled"), disabled: true });
  for (const [name, windows, attached] of list) {
    items.push({
      label: `${name}  ·  ${t("tmux.windows", { count: Number(windows) || 0 })}${attached === "1" ? `  ·  ${t("tmux.attached")}` : ""}`,
      children: [
        { label: t("tmux.attachHere"), onClick: () => send(`tmux attach -t ${quote(name)}`) },
        {
          label: t("tmux.attachNewTab"),
          onClick: () => openInNewTab(`tmux attach -t ${quote(name)}`),
        },
        {
          label: t("tmux.rename"),
          onClick: () => {
            const next = window.prompt(t("tmux.renamePrompt"), name);
            if (next && next !== name) void backend.sshExec(leaf.paneId, `tmux rename-session -t ${quote(name)} ${quote(next)}`);
          },
        },
        { type: "separator" },
        {
          label: t("tmux.kill"),
          danger: true,
          onClick: () => {
            if (window.confirm(t("tmux.killConfirm", { name }))) void backend.sshExec(leaf.paneId, `tmux kill-session -t ${quote(name)}`);
          },
        },
      ],
    });
  }
  items.push(
    { type: "separator" },
    {
      label: t("tmux.newSession"),
      disabled: missing,
      onClick: () => {
        const name = window.prompt(t("tmux.newPrompt"), "");
        if (name === null) return;
        send(name.trim() ? `tmux new -s ${quote(name.trim())}` : "tmux new");
      },
    },
    { label: t("tmux.detach"), disabled: missing, onClick: () => send("tmux detach") },
    {
      label: t("tmux.sync"),
      disabled: missing,
      onClick: () => send("tmux set-window-option synchronize-panes"),
    }
  );
  return items;
}
