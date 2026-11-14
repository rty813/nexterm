import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Bell, BellRing, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, CircleCheck, CircleX, Columns2, LoaderCircle, Lock, Plus, Rows2, X } from "lucide-react";
import { backend } from "../services/backend";
import { agentDisplayName, type AgentStatus } from "../utils/agentStatus";
import { tabTitle } from "../utils/layout";
import { titleShowsHost } from "../utils/hostname";
import { formatDuration } from "../utils/commandWatch";
import { canInjectShellIntegration, type RunningCommand } from "../utils/runningCommand";
import type { PaneGroup, SplitDirection, SyncChannel, TabMouseAction, TerminalLeafNode } from "../types/domain";
import { ProtocolBadge } from "./ProtocolBadge";
import { compactMenu, useContextMenu, type MenuItem } from "./ContextMenu";
import { TAB_COLORS, type TabMark } from "./TerminalPane";

/** Drag payload type for moving a tab between split groups. */
export const TAB_MIME = "application/x-nexterm-pane";

export interface GroupTabBarProps {
  group: PaneGroup;
  isActiveGroup: boolean;
  syncChannels: Record<string, SyncChannel>;
  logPaths: Record<string, string>;
  tabMarks: Record<string, TabMark>;
  agentStates: Record<string, AgentStatus>;
  /** Host per pane, shown after the tab name; undefined = feature off. */
  hostnames?: Record<string, string>;
  /** Command running per pane, shown on the tab; undefined = feature off. */
  runningCommands?: Record<string, RunningCommand>;
  commandWatches: Record<string, { armedAt: number }>;
  onToggleCommandWatch: (paneId: string) => void;
  onActivateGroup: () => void;
  onSelectTab: (paneId: string) => void;
  onCloseTab: (paneId: string) => void;
  onRenameTab: (paneId: string, title: string) => void;
  onDuplicateTab: (paneId: string) => void;
  onReconnectTab: (paneId: string) => void;
  /** Install shell integration for the tab's current user and load it now. */
  onInjectShellIntegration: (paneId: string) => void;
  onCloseOtherTabs: (paneId: string) => void;
  onCloseTabsToRight: (paneId: string) => void;
  /** Split this group: a new connection of the active tab's session opens beside it. */
  onSplitGroup: (direction: SplitDirection) => void;
  /** Move an existing tab (same connection) into a new group beside this one. */
  onMoveToNewGroup: (paneId: string, direction: SplitDirection) => void;
  onDropTab: (paneId: string, index: number) => void;
  onSetTabColor: (paneId: string, color: string | null) => void;
  onToggleLock: (paneId: string) => void;
  onMoveToNewWindow: (paneId: string) => void;
  moveToWindowTargets: () => Promise<{ label: string; title: string }[]>;
  onMoveToWindow: (paneId: string, windowLabel: string) => void;
  /** A tab dragged out of this window was dropped outside every window. */
  onDragOutside: (paneId: string, screenX: number, screenY: number) => void;
  keymap: Record<string, string>;
  /** WindTerm tabbar.doubleClickAction / middleClickAction. */
  tabMouse: { doubleClick: TabMouseAction; middleClick: TabMouseAction };
  /** Activate a tab when the mouse rests on it. */
  hoverSwitch: boolean;
  /** "+": a new tab with the default shell in this group. */
  onNewTab: () => void;
  /** The menu beside "+": other shells, recent sessions, new session. */
  newTabMenu: () => MenuItem[];
}

/** How long the mouse must rest on a tab before it switches (avoids flicking through tabs in passing). */
const HOVER_SWITCH_MS = 600;

export const GroupTabBar: React.FC<GroupTabBarProps> = ({
  group,
  isActiveGroup,
  syncChannels,
  logPaths,
  tabMarks,
  agentStates,
  hostnames,
  runningCommands,
  commandWatches,
  onToggleCommandWatch,
  onActivateGroup,
  onSelectTab,
  onCloseTab,
  onRenameTab,
  onDuplicateTab,
  onReconnectTab,
  onInjectShellIntegration,
  onCloseOtherTabs,
  onCloseTabsToRight,
  onSplitGroup,
  onMoveToNewGroup,
  onDropTab,
  onSetTabColor,
  onToggleLock,
  onMoveToNewWindow,
  moveToWindowTargets,
  onMoveToWindow,
  onDragOutside,
  keymap,
  tabMouse,
  hoverSwitch,
  onNewTab,
  newTabMenu,
}) => {
  const { t } = useTranslation();
  const openMenu = useContextMenu();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const hoverTimer = useRef<number | null>(null);

  const cancelHover = () => {
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  };
  useEffect(() => cancelHover, []);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ left: false, right: false });

  const updateOverflow = () => {
    const el = scrollRef.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setOverflow((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  };

  // Track overflow on resize; the wheel listener is native because React's onWheel is passive.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    const ro = new ResizeObserver(updateOverflow);
    ro.observe(el);
    return () => {
      el.removeEventListener("wheel", onWheel);
      ro.disconnect();
    };
  }, []);

  // Keep the active tab visible when it changes or tabs are added/removed.
  useEffect(() => {
    const el = scrollRef.current;
    const tab = el?.querySelector<HTMLElement>(`[data-pane-id="${CSS.escape(group.activeTabId)}"]`);
    if (el && tab) {
      const start = tab.getBoundingClientRect().left - el.getBoundingClientRect().left + el.scrollLeft;
      const end = start + tab.offsetWidth;
      if (start < el.scrollLeft) el.scrollLeft = start;
      else if (end > el.scrollLeft + el.clientWidth) el.scrollLeft = end - el.clientWidth;
    }
    updateOverflow();
  }, [group.activeTabId, group.tabs.length]);

  const scrollTabs = (dir: -1 | 1) => {
    const el = scrollRef.current;
    if (el) el.scrollBy({ left: dir * Math.max(120, el.clientWidth * 0.8), behavior: "smooth" });
  };

  const startHover = (e: React.MouseEvent, paneId: string) => {
    cancelHover();
    // No switching while a mouse button is held (drag, selection) or a tab is being renamed.
    if (!hoverSwitch || e.buttons !== 0 || editingId || paneId === group.activeTabId) return;
    hoverTimer.current = window.setTimeout(() => {
      hoverTimer.current = null;
      onSelectTab(paneId);
    }, HOVER_SWITCH_MS);
  };

  const runTabAction = (action: TabMouseAction, leaf: TerminalLeafNode) => {
    if (action === "close" && !leaf.locked) onCloseTab(leaf.paneId);
    else if (action === "rename") startRename(leaf);
    else if (action === "duplicate") onDuplicateTab(leaf.paneId);
    else if (action === "reconnect") onReconnectTab(leaf.paneId);
  };

  const startRename = (leaf: TerminalLeafNode) => {
    setEditingId(leaf.paneId);
    setDraftTitle(tabTitle(leaf));
  };

  const commitRename = (paneId: string) => {
    onRenameTab(paneId, draftTitle.trim());
    setEditingId(null);
  };

  const acceptsDrag = (e: React.DragEvent) => e.dataTransfer.types.includes(TAB_MIME);

  const handleDrop = (e: React.DragEvent, index: number) => {
    if (!acceptsDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const paneId = e.dataTransfer.getData(TAB_MIME);
    setDropIndex(null);
    if (paneId) onDropTab(paneId, index);
  };

  const tabMenu = async (e: React.MouseEvent, leaf: TerminalLeafNode, idx: number) => {
    e.preventDefault();
    const point = { clientX: e.clientX, clientY: e.clientY };
    onSelectTab(leaf.paneId);
    const single = group.tabs.length < 2;
    const [windows, shellStatus] = await Promise.all([
      moveToWindowTargets(),
      backend.shellIntegrationStatus(leaf.paneId).catch(() => null),
    ]);
    const colorItems: MenuItem[] = [
      { label: t("menu.noColor"), checked: !leaf.color, onClick: () => onSetTabColor(leaf.paneId, null) },
      ...TAB_COLORS.map((c) => ({ label: c, swatch: c, checked: leaf.color === c, onClick: () => onSetTabColor(leaf.paneId, c) })),
    ];
    openMenu(
      point,
      compactMenu([
        { label: t("menu.renameTab"), onClick: () => startRename(leaf) },
        { label: t("menu.tabColor"), children: colorItems },
        {
          label: leaf.locked ? t("menu.unlockSession") : t("menu.lockSession"),
          shortcut: keymap["tab.lock"],
          onClick: () => onToggleLock(leaf.paneId),
        },
        {
          label: commandWatches[leaf.paneId] ? t("cmdNotify.cancel") : t("cmdNotify.arm"),
          shortcut: keymap["terminal.notifyWhenDone"],
          checked: Boolean(commandWatches[leaf.paneId]),
          onClick: () => onToggleCommandWatch(leaf.paneId),
        },
        { label: t("menu.duplicateTab"), shortcut: keymap["tab.duplicate"], onClick: () => onDuplicateTab(leaf.paneId) },
        { label: t("pane.reconnect"), shortcut: keymap["tab.reconnect"], onClick: () => onReconnectTab(leaf.paneId) },
        {
          label: t(shellStatus?.loading ? "si.menuLoading" : shellStatus?.detected ? "si.menuDetected" : shellStatus ? "si.menuNotDetected" : "si.menu"),
          disabled: Boolean(shellStatus?.loading) || !canInjectShellIntegration(leaf.session.protocol, leaf.status),
          onClick: () => onInjectShellIntegration(leaf.paneId),
        },
        {
          label: t("menu.moveToWindow"),
          children: [
            { label: t("menu.moveToNewWindow"), shortcut: keymap["tab.moveToNewWindow"], onClick: () => onMoveToNewWindow(leaf.paneId) },
            ...(windows.length ? [{ type: "separator" as const }] : []),
            ...windows.map((w) => ({ label: w.title || w.label, onClick: () => onMoveToWindow(leaf.paneId, w.label) })),
          ],
        },
        { type: "separator" },
        { label: t("pane.splitRight"), onClick: () => onSplitGroup("horizontal") },
        { label: t("pane.splitDown"), onClick: () => onSplitGroup("vertical") },
        {
          label: t("menu.moveRight"),
          disabled: single,
          onClick: () => onMoveToNewGroup(leaf.paneId, "horizontal"),
        },
        {
          label: t("menu.moveDown"),
          disabled: single,
          onClick: () => onMoveToNewGroup(leaf.paneId, "vertical"),
        },
        { type: "separator" },
        { label: t("tabbar.closeTab"), shortcut: keymap["tab.close"], disabled: leaf.locked, onClick: () => onCloseTab(leaf.paneId) },
        { label: t("menu.closeOthers"), disabled: single, onClick: () => onCloseOtherTabs(leaf.paneId) },
        {
          label: t("menu.closeRight"),
          disabled: idx >= group.tabs.length - 1,
          onClick: () => onCloseTabsToRight(leaf.paneId),
        },
      ])
    );
  };

  return (
    <div
      className={`tabbar group-tabbar ${isActiveGroup ? "group-active" : ""}`}
      onMouseDown={onActivateGroup}
      onDragOver={(e) => {
        if (!acceptsDrag(e)) return;
        e.preventDefault();
        setDropIndex(group.tabs.length);
      }}
      onDragLeave={() => setDropIndex(null)}
      onDrop={(e) => handleDrop(e, group.tabs.length)}
    >
      {(overflow.left || overflow.right) && (
        <button
          type="button"
          className="tab-scroll-btn"
          title={t("tabbar.scrollLeft")}
          disabled={!overflow.left}
          onClick={() => scrollTabs(-1)}
        >
          <ChevronLeft size={14} />
        </button>
      )}
      <div className="tabbar-scroll" ref={scrollRef} onScroll={updateOverflow}>
        {group.tabs.map((leaf, idx) => {
          const isActive = leaf.paneId === group.activeTabId;
          const title = tabTitle(leaf);
          const channel = syncChannels[leaf.paneId];
          const mark = tabMarks[leaf.paneId];
          const agent = agentStates[leaf.paneId];
          const reported = hostnames?.[leaf.paneId];
          const host = reported && !titleShowsHost(title, reported) ? reported : "";
          const running = runningCommands?.[leaf.paneId];
          const runTip = running
            ? ` · ${t("tabbar.running")}: ${running.command} (${t("tabbar.runningFor", { d: formatDuration(Date.now() - running.startedAt) })})`
            : "";
          const agentTip = agent ? `${agentName(agent.app)}: ${t(`agent.state.${agent.state}`)}${agent.kind ? ` (${t(`agent.kind.${agent.kind}`, agent.kind)})` : ""}` : "";
          return (
            <div
              key={leaf.paneId}
              data-pane-id={leaf.paneId}
              className={`tab-item ${isActive ? "active" : ""} ${running ? "tab-running" : ""} ${dropIndex === idx ? "drop-before" : ""} ${leaf.color ? "tab-colored" : ""} ${
                mark?.activity ? "tab-activity" : ""
              } ${mark?.bell ? "tab-bell" : ""} ${agent ? `tab-agent-${agent.state}` : ""} ${
                leaf.status === "disconnected" || leaf.status === "error" ? "tab-down" : ""
              }`}
              style={leaf.color ? ({ "--tab-color": leaf.color } as React.CSSProperties) : undefined}
              draggable={editingId !== leaf.paneId}
              onDragStart={(e) => {
                cancelHover();
                e.dataTransfer.setData(TAB_MIME, leaf.paneId);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => {
                if (!acceptsDrag(e)) return;
                e.preventDefault();
                e.stopPropagation();
                const r = e.currentTarget.getBoundingClientRect();
                setDropIndex(e.clientX < r.left + r.width / 2 ? idx : idx + 1);
              }}
              onDrop={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                handleDrop(e, e.clientX < r.left + r.width / 2 ? idx : idx + 1);
              }}
              onDragEnd={(e) => {
                setDropIndex(null);
                // Dropped outside the window (and no window took it): another window under
                // the cursor adopts it, else it opens in a new window there.
                const outside =
                  e.dataTransfer.dropEffect === "none" &&
                  (e.clientX < 0 || e.clientY < 0 || e.clientX > window.innerWidth || e.clientY > window.innerHeight);
                if (outside) onDragOutside(leaf.paneId, e.screenX, e.screenY);
              }}
              onClick={() => {
                cancelHover();
                onSelectTab(leaf.paneId);
              }}
              onMouseEnter={(e) => startHover(e, leaf.paneId)}
              onMouseLeave={cancelHover}
              onDoubleClick={(e) => {
                if ((e.target as HTMLElement).closest("input, button")) return;
                runTabAction(tabMouse.doubleClick, leaf);
              }}
              onContextMenu={(e) => void tabMenu(e, leaf, idx)}
              onMouseDown={(e) => {
                // No autoscroll cursor on middle click.
                if (e.button === 1) e.preventDefault();
              }}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  runTabAction(tabMouse.middleClick, leaf);
                }
              }}
              title={`${title}${reported ? ` · ${t("tabbar.host")}: ${reported}` : ""}${runTip}${agentTip ? ` · ${agentTip}` : ""}${mark?.activity ? ` · ${t("tabbar.hasActivity")}` : ""} (${t("tabbar.renameHint")})`}
            >
              {agent ? <AgentIcon status={agent} /> : <ProtocolBadge protocol={leaf.session.protocol} size={12} />}
              {commandWatches[leaf.paneId] && (
                <button
                  type="button"
                  className="tab-watch-btn"
                  title={t("cmdNotify.watchingTip")}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleCommandWatch(leaf.paneId);
                  }}
                >
                  <BellRing size={11} />
                </button>
              )}
              {mark?.bell && <Bell size={11} className="tab-bell-icon" />}
              {mark?.activity && !mark.bell && <span className="tab-activity-dot" />}

              {editingId === leaf.paneId ? (
                <input
                  type="text"
                  className="tab-rename-input"
                  autoFocus
                  value={draftTitle}
                  onClick={(e) => e.stopPropagation()}
                  onMouseDown={(e) => e.stopPropagation()}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  onBlur={() => commitRename(leaf.paneId)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename(leaf.paneId);
                    if (e.key === "Escape") setEditingId(null);
                  }}
                />
              ) : (
                <span className="tab-title-text">
                  {title}
                  {host && <span className="tab-host"> · {host}</span>}
                </span>
              )}
              {running && editingId !== leaf.paneId && <span className="tab-cmd">{running.command}</span>}

              {logPaths[leaf.paneId] && <span className="tab-rec-dot" title={logPaths[leaf.paneId]} />}
              {channel && <span className={`tab-sync-chip sync-ch-${channel}`}>{channel}</span>}

              {leaf.locked ? (
                <button
                  type="button"
                  className="tab-lock-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleLock(leaf.paneId);
                  }}
                  title={t("menu.unlockSession")}
                >
                  <Lock size={11} />
                </button>
              ) : (
                <button
                  type="button"
                  className="tab-close-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(leaf.paneId);
                  }}
                  title={t("tabbar.closeTab")}
                >
                  <X size={12} />
                </button>
              )}
            </div>
          );
        })}
        {dropIndex === group.tabs.length && <div className="tab-drop-tail" />}
      </div>
      {(overflow.left || overflow.right) && (
        <button
          type="button"
          className="tab-scroll-btn"
          title={t("tabbar.scrollRight")}
          disabled={!overflow.right}
          onClick={() => scrollTabs(1)}
        >
          <ChevronRight size={14} />
        </button>
      )}

      <div className="tab-new">
        <button type="button" className="tab-new-btn" title={`${t("tabbar.newTab")}${keymap["tab.newShell"] ? ` (${keymap["tab.newShell"]})` : ""}`} onClick={onNewTab}>
          <Plus size={14} />
        </button>
        <button
          type="button"
          className="tab-new-more"
          title={t("tabbar.newTabMenu")}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            openMenu({ clientX: r.left, clientY: r.bottom + 4 }, newTabMenu());
          }}
        >
          <ChevronDown size={12} />
        </button>
      </div>
      <div className="tabbar-spacer" />

      <div className="tabbar-actions">
        <button
          type="button"
          className="icon-btn"
          title={t("pane.splitRight")}
          onClick={() => onSplitGroup("horizontal")}
        >
          <Columns2 size={14} />
        </button>
        <button
          type="button"
          className="icon-btn"
          title={t("pane.splitDown")}
          onClick={() => onSplitGroup("vertical")}
        >
          <Rows2 size={14} />
        </button>
      </div>
    </div>
  );
};

const agentName = agentDisplayName;

/** Agent state icon shown in place of the protocol icon. */
const AgentIcon: React.FC<{ status: AgentStatus }> = ({ status }) => {
  const letter = status.app === "claude" ? "C" : status.app === "codex" ? "X" : "A";
  const icon =
    status.state === "working" ? (
      <LoaderCircle size={12} className="spin" />
    ) : status.state === "blocked" ? (
      <CircleAlert size={12} />
    ) : status.state === "done" ? (
      <CircleCheck size={12} />
    ) : status.state === "error" ? (
      <CircleX size={12} />
    ) : (
      <span className="agent-idle-letter">{letter}</span>
    );
  return <span className={`agent-icon agent-${status.state} agent-app-${status.app}`}>{icon}</span>;
};
