import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, ExternalLink, Layers, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { backend } from "../services/backend";
import { confirmAsk } from "../utils/confirm";
import {
  TMUX_LIST_COMMAND,
  TYPED_DETACH,
  TYPED_SYNC,
  execKill,
  execRename,
  newTabAttach,
  newTabNew,
  nextSessionName,
  parseTmuxListing,
  typedNew,
  typedSwitch,
  validSessionName,
  type TmuxListing,
} from "../utils/tmux";

export interface TmuxTarget {
  paneId: string;
  title: string;
  protocol: "ssh" | "wsl";
}

/** How often the open panel re-reads the session list. */
const POLL_MS = 4000;

/**
 * Docked list of the tmux sessions on an SSH host or in WSL: switch the pane to one (without
 * nesting when it is already inside tmux), open one in a new tab, create, rename and kill.
 */
export const TmuxPanel: React.FC<{
  /** Connected SSH / WSL panes. */
  targets: TmuxTarget[];
  activePaneId: string | null;
  /** Pane the panel was opened for (pane menu); wins over the active pane. */
  preferredPaneId: string | null;
  /** Type a line into the pane (Enter added) and focus it. */
  onType: (paneId: string, line: string) => void;
  onOpenInNewTab: (paneId: string, startupCommand: string) => void;
  onClose: () => void;
}> = ({ targets, activePaneId, preferredPaneId, onType, onOpenInNewTab, onClose }) => {
  const { t } = useTranslation();
  const has = useCallback((id: string | null): id is string => Boolean(id && targets.some((x) => x.paneId === id)), [targets]);

  // Follows the active pane; keeps the last SSH / WSL pane while a local shell is active.
  const [paneId, setPaneId] = useState<string | null>(null);
  useEffect(() => {
    if (has(preferredPaneId)) setPaneId(preferredPaneId);
  }, [preferredPaneId, has]);
  useEffect(() => {
    setPaneId((cur) => (has(activePaneId) ? activePaneId : has(cur) ? cur : targets[0]?.paneId ?? null));
  }, [activePaneId, targets, has]);
  const target = targets.find((x) => x.paneId === paneId) ?? null;

  const [listing, setListing] = useState<TmuxListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<{ from: string; to: string } | null>(null);

  const exec = useCallback(
    (cmd: string) => {
      if (!target) return Promise.reject(new Error("no pane"));
      return target.protocol === "wsl" ? backend.wslAgentExec(target.paneId, cmd) : backend.sshExec(target.paneId, cmd);
    },
    [target]
  );

  // Answers for an earlier pane are dropped once the panel moved on.
  const seq = useRef(0);
  const refresh = useCallback(async () => {
    if (!target) return;
    const mine = ++seq.current;
    setLoading(true);
    try {
      const out = await exec(TMUX_LIST_COMMAND);
      if (mine !== seq.current) return;
      setListing(parseTmuxListing(out));
      setError(null);
    } catch (e) {
      if (mine === seq.current) setError(String(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [target, exec]);

  useEffect(() => {
    setListing(null);
    setError(null);
    setRenaming(null);
    if (!target) return;
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.paneId]);

  /** Typed commands land asynchronously; look again shortly after. */
  const refreshSoon = () => {
    window.setTimeout(() => void refresh(), 600);
    window.setTimeout(() => void refresh(), 1800);
  };

  const sessions = useMemo(() => listing?.sessions ?? [], [listing]);
  const names = sessions.map((s) => s.name);
  const typedName = newName.trim();
  const nameProblem = typedName && !validSessionName(typedName) ? t("tmux.badName") : names.includes(typedName) ? t("tmux.exists") : null;
  const renameProblem =
    renaming && renaming.to.trim() && renaming.to.trim() !== renaming.from
      ? !validSessionName(renaming.to.trim())
        ? t("tmux.badName")
        : names.includes(renaming.to.trim())
        ? t("tmux.exists")
        : null
      : null;

  const type = (line: string) => {
    if (!target) return;
    onType(target.paneId, line);
    refreshSoon();
  };
  const create = (inNewTab: boolean) => {
    if (!target || nameProblem) return;
    const name = typedName || nextSessionName(names);
    if (inNewTab) onOpenInNewTab(target.paneId, newTabNew(name));
    else type(typedNew(name));
    setNewName("");
    refreshSoon();
  };
  // Enter and the blur that follows must not rename twice.
  const renamingRef = useRef(renaming);
  renamingRef.current = renaming;
  const commitRename = async () => {
    const r = renamingRef.current;
    if (!r) return;
    renamingRef.current = null;
    const to = r.to.trim();
    if (!to || to === r.from || renameProblem) {
      setRenaming(null);
      return;
    }
    try {
      await exec(execRename(r.from, to));
    } catch (e) {
      setError(String(e));
    }
    setRenaming(null);
    void refresh();
  };
  const kill = async (name: string) => {
    if (!(await confirmAsk(t("tmux.killConfirm", { name })))) return;
    try {
      await exec(execKill(name));
    } catch (e) {
      setError(String(e));
    }
    void refresh();
  };
  const toggle = (name: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const installed = listing?.installed !== false;

  return (
    <aside className="side-panel tmux-panel">
      <div className="side-panel-header">
        <Layers size={14} /> {t("tmux.title")}
        <span className="tmux-header-actions">
          <button type="button" className="icon-btn-xs" title={t("tmux.refresh")} disabled={!target || loading} onClick={() => void refresh()}>
            <RefreshCw size={12} className={loading ? "spin" : undefined} />
          </button>
          <button type="button" className="icon-btn-xs" title={t("forward.close")} onClick={onClose}>
            <X size={13} />
          </button>
        </span>
      </div>
      <div className="side-panel-body">
        {!target ? (
          <div className="side-panel-empty">{t("tmux.noTarget")}</div>
        ) : (
          <>
            <label className="tmux-target">
              <span>{t("tmux.target")}</span>
              <select className="text-input input-sm" value={target.paneId} onChange={(e) => setPaneId(e.target.value)}>
                {targets.map((x) => (
                  <option key={x.paneId} value={x.paneId}>
                    {x.title} ({x.protocol.toUpperCase()})
                  </option>
                ))}
              </select>
            </label>

            {error && <p className="adv-hint tmux-error">{t("tmux.error", { error })}</p>}
            {!installed && <div className="side-panel-empty">{t("tmux.notInstalled")}</div>}

            {installed && (
              <>
                <form
                  className="tmux-new"
                  onSubmit={(e) => {
                    e.preventDefault();
                    create(false);
                  }}
                >
                  <input
                    className="text-input input-sm mono"
                    placeholder={t("tmux.namePlaceholder")}
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                  />
                  <button type="submit" className="btn-ghost btn-sm" disabled={Boolean(nameProblem)} title={t("tmux.create")}>
                    <Plus size={12} /> {t("tmux.create")}
                  </button>
                  <button type="button" className="icon-btn-xs" disabled={Boolean(nameProblem)} title={t("tmux.createNewTab")} onClick={() => create(true)}>
                    <ExternalLink size={12} />
                  </button>
                </form>
                {nameProblem && <p className="adv-hint tmux-error">{nameProblem}</p>}

                {listing === null ? (
                  <div className="side-panel-empty">{t("tmux.loading")}</div>
                ) : sessions.length === 0 ? (
                  <div className="side-panel-empty">{t("tmux.empty")}</div>
                ) : (
                  <div className="tmux-list">
                    {sessions.map((s) => {
                      const open = expanded.has(s.name);
                      const editing = renaming?.from === s.name;
                      return (
                        <div key={s.name} className="tmux-session">
                          <div
                            className={`tmux-row ${s.attached ? "attached" : ""}`}
                            title={t("tmux.switchHere")}
                            onClick={() => !editing && type(typedSwitch(s.name))}
                          >
                            <button
                              type="button"
                              className="icon-btn-xs"
                              onClick={(e) => {
                                e.stopPropagation();
                                toggle(s.name);
                              }}
                            >
                              {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                            </button>
                            {editing ? (
                              <input
                                className="text-input input-sm mono tmux-rename"
                                value={renaming.to}
                                autoFocus
                                onClick={(e) => e.stopPropagation()}
                                onChange={(e) => setRenaming({ from: s.name, to: e.target.value })}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") void commitRename();
                                  if (e.key === "Escape") setRenaming(null);
                                }}
                                onBlur={() => void commitRename()}
                              />
                            ) : (
                              <span className="tmux-name mono">{s.name}</span>
                            )}
                            <span className="tmux-meta">
                              {t("tmux.windows", { count: s.windows })}
                              {s.attached > 0 && <span className="tmux-badge">{t("tmux.attached", { count: s.attached })}</span>}
                            </span>
                            <span className="tmux-actions" onClick={(e) => e.stopPropagation()}>
                              <button type="button" className="icon-btn-xs" title={t("tmux.attachNewTab")} onClick={() => onOpenInNewTab(target.paneId, newTabAttach(s.name))}>
                                <ExternalLink size={11} />
                              </button>
                              <button type="button" className="icon-btn-xs" title={t("tmux.rename")} onClick={() => setRenaming({ from: s.name, to: s.name })}>
                                <Pencil size={11} />
                              </button>
                              <button type="button" className="icon-btn-xs danger-hover" title={t("tmux.kill")} onClick={() => void kill(s.name)}>
                                <Trash2 size={11} />
                              </button>
                            </span>
                          </div>
                          {editing && renameProblem && <p className="adv-hint tmux-error">{renameProblem}</p>}
                          {open &&
                            s.windowList.map((w) => (
                              <div
                                key={w.index}
                                className={`tmux-window ${w.active ? "active" : ""}`}
                                title={t("tmux.switchWindow", { index: w.index })}
                                onClick={() => type(typedSwitch(s.name, w.index))}
                              >
                                <span className="mono">{w.index}</span>
                                <span className="tmux-window-name">{w.name}</span>
                              </div>
                            ))}
                        </div>
                      );
                    })}
                  </div>
                )}

                <div className="sender-actions">
                  <button type="button" className="btn-ghost btn-sm" title={t("tmux.detachTip")} onClick={() => type(TYPED_DETACH)}>
                    {t("tmux.detach")}
                  </button>
                  <button type="button" className="btn-ghost btn-sm" title={t("tmux.syncTip")} onClick={() => type(TYPED_SYNC)}>
                    {t("tmux.sync")}
                  </button>
                </div>
              </>
            )}
            <p className="adv-hint">{t("tmux.hint")}</p>
          </>
        )}
      </div>
    </aside>
  );
};
