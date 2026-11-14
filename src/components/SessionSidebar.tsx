import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowDownUp,
  ChevronDown,
  ChevronRight,
  Columns2,
  Copy,
  Download,
  Edit2,
  Folder,
  History,
  LayoutList,
  Play,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { buildSessionTree, type SessionSortMode, type SessionTreeNode, type SessionUsage } from "../utils/sessionTree";
import type { SessionConfig } from "../types/domain";
import { ProtocolBadge } from "./ProtocolBadge";
import { sessionTargetSummary } from "../utils/sessionSummary";
import { useContextMenu } from "./ContextMenu";

/** Tabs of a saved session open in this window: how many, and the best status among them. */
export interface SessionOpenState {
  count: number;
  status: "connected" | "connecting" | "error" | "disconnected";
}

interface SessionSidebarProps {
  sessions: SessionConfig[];
  selectedSessionId: string | null;
  onSelectSession: (id: string) => void;
  /** Open a new connection of the session. */
  onOpenSession: (session: SessionConfig) => void;
  /** Bring up the session's open tab. */
  onFocusSession: (session: SessionConfig) => void;
  openState: Record<string, SessionOpenState>;
  /** Saved sessions, most recently opened first. */
  recentIds: string[];
  quickHistory: string[];
  onQuickConnect: (raw: string) => void;
  recentOpen: boolean;
  onToggleRecent: () => void;
  onOpenInSplit: (session: SessionConfig) => void;
  onCreateSession: () => void;
  onEditSession: (session: SessionConfig) => void;
  onDuplicateSession: (session: SessionConfig) => void;
  onDeleteSession: (session: SessionConfig) => void;
  onOpenImport: () => void;
  onOpenManager: () => void;
  sortMode: SessionSortMode;
  usage: SessionUsage;
  onChangeSort: (mode: SessionSortMode) => void;
}

const SORT_MODES: SessionSortMode[] = ["default", "name", "recent", "frequent"];

export const SessionSidebar: React.FC<SessionSidebarProps> = ({
  sessions,
  selectedSessionId,
  onSelectSession,
  onOpenSession,
  onFocusSession,
  openState,
  recentIds,
  quickHistory,
  onQuickConnect,
  recentOpen,
  onToggleRecent,
  onOpenInSplit,
  onCreateSession,
  onEditSession,
  onDuplicateSession,
  onDeleteSession,
  onOpenImport,
  onOpenManager,
  sortMode,
  usage,
  onChangeSort,
}) => {
  const { t } = useTranslation();
  const openMenu = useContextMenu();
  const [filter, setFilter] = useState("");
  const [collapsedPaths, setCollapsedPaths] = useState<Record<string, boolean>>({});

  const tree = useMemo(
    () => buildSessionTree(sessions, filter, sortMode, usage),
    [sessions, filter, sortMode, usage]
  );

  const recent = useMemo(
    () =>
      recentIds
        .slice(0, 5)
        .map((id) => sessions.find((s) => s.id === id))
        .filter((s): s is SessionConfig => Boolean(s)),
    [recentIds, sessions]
  );

  const toggleFolder = (fullPath: string) => {
    setCollapsedPaths((prev) => ({
      ...prev,
      [fullPath]: !prev[fullPath],
    }));
  };

  const renderNode = (node: SessionTreeNode, depth: number): React.ReactNode => {
    if (node.kind === "folder") {
      const isCollapsed = Boolean(collapsedPaths[node.fullPath]) && !filter.trim();
      return (
        <div key={`folder-${node.fullPath}`} className="tree-folder-block">
          <div
            className="tree-folder-row"
            style={{ paddingLeft: `${8 + depth * 14}px` }}
            onClick={() => toggleFolder(node.fullPath)}
          >
            {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
            <Folder size={13} className="folder-icon" />
            <span className="folder-name">{node.name}</span>
            <span className="folder-badge">{node.sessionCount}</span>
          </div>
          {!isCollapsed && (
            <div className="tree-folder-children">
              {node.children.map((child) => renderNode(child, depth + 1))}
            </div>
          )}
        </div>
      );
    }

    return renderSession(node.session, depth, node.session.id);
  };

  /** Double-click / Enter / Play: switch to the open tab if there is one; Ctrl opens another. */
  const activate = (s: SessionConfig, forceNew: boolean) => {
    if (!forceNew && openState[s.id]) onFocusSession(s);
    else onOpenSession(s);
  };

  const renderSession = (s: SessionConfig, depth: number, key: string): React.ReactNode => {
    const isSelected = s.id === selectedSessionId;
    const open = openState[s.id];
    const subtext = sessionTargetSummary(s);
    const used = usage[s.id];
    const usedText = used
      ? t("sidebar.usedInfo", { count: used.count, time: new Date(used.lastUsed).toLocaleString() })
      : t("sidebar.neverUsed");

    return (
      <div
        key={key}
        className={`tree-session-row ${isSelected ? "selected" : ""} ${open ? "is-open" : ""}`}
        style={{ paddingLeft: `${14 + depth * 14}px` }}
        tabIndex={0}
        onClick={() => onSelectSession(s.id)}
        onDoubleClick={(e) => activate(s, e.ctrlKey || e.metaKey)}
        onKeyDown={(e) => {
          if (e.key === "Enter") activate(s, e.ctrlKey || e.metaKey);
        }}
        onContextMenu={(e) => {
          onSelectSession(s.id);
          openMenu(e, [
            ...(open ? [{ label: t("sidebar.switchToTab"), onClick: () => onFocusSession(s) }] : []),
            { label: open ? t("sidebar.connectAnother") : t("sidebar.connectTab"), onClick: () => onOpenSession(s) },
            { label: t("sidebar.openSplit"), onClick: () => onOpenInSplit(s) },
            { type: "separator" },
            { label: t("sidebar.edit"), onClick: () => onEditSession(s) },
            { label: t("sidebar.duplicate"), onClick: () => onDuplicateSession(s) },
            { label: t("sidebar.delete"), danger: true, onClick: () => onDeleteSession(s) },
            { type: "separator" },
            { label: t("sidebar.manager"), onClick: onOpenManager },
          ]);
        }}
        title={`${open ? t("sidebar.openHint", { count: open.count }) : t("sidebar.doubleClickHint")} (${subtext})\n${usedText}`}
      >
        <span className="session-icon">
          <ProtocolBadge protocol={s.protocol} size={13} />
          {open && <span className={`session-open-dot status-${open.status}`} />}
        </span>
        <div className="session-row-text">
          <span className="session-row-label">{s.label}</span>
          <span className="session-row-sub">{subtext}</span>
        </div>
        <div className="session-row-actions" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="icon-btn-xs"
            title={open ? t("sidebar.switchToTabHint") : t("sidebar.connectTab")}
            onClick={(e) => activate(s, e.ctrlKey || e.metaKey)}
          >
            <Play size={11} />
          </button>
          <button
            type="button"
            className="icon-btn-xs"
            title={t("sidebar.openSplit")}
            onClick={() => onOpenInSplit(s)}
          >
            <Columns2 size={11} />
          </button>
          <button
            type="button"
            className="icon-btn-xs"
            title={t("sidebar.edit")}
            onClick={() => onEditSession(s)}
          >
            <Edit2 size={11} />
          </button>
          <button
            type="button"
            className="icon-btn-xs"
            title={t("sidebar.duplicate")}
            onClick={() => onDuplicateSession(s)}
          >
            <Copy size={11} />
          </button>
          <button
            type="button"
            className="icon-btn-xs danger-hover"
            title={t("sidebar.delete")}
            onClick={() => onDeleteSession(s)}
          >
            <Trash2 size={11} />
          </button>
        </div>
      </div>
    );
  };

  return (
    <aside className="session-sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">
          {t("sidebar.title")} ({sessions.length})
        </span>
        <button
          type="button"
          className={`icon-btn-xs ${sortMode !== "default" ? "active" : ""}`}
          title={`${t("sidebar.sortBy")}：${t(`sidebar.sort.${sortMode}`)}`}
          onClick={(e) =>
            openMenu(
              e,
              SORT_MODES.map((m) => ({ label: t(`sidebar.sort.${m}`), checked: sortMode === m, onClick: () => onChangeSort(m) }))
            )
          }
        >
          <ArrowDownUp size={13} />
        </button>
        <button
          type="button"
          className="icon-btn-xs"
          onClick={onOpenManager}
          title={t("sidebar.manager")}
        >
          <LayoutList size={13} />
        </button>
        <button
          type="button"
          className="btn-primary btn-xs"
          onClick={onCreateSession}
          title={t("toolbar.newSession")}
        >
          <Plus size={12} /> {t("sidebar.newBtn")}
        </button>
      </div>

      <div className="sidebar-search">
        <Search size={13} className="muted-icon" />
        <input
          type="text"
          placeholder={t("sidebar.searchPlaceholder")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      <div className="sidebar-tree">
        {!filter.trim() && (recent.length > 0 || quickHistory.length > 0) && (
          <div className="tree-folder-block sidebar-recent">
            <div className="tree-folder-row" style={{ paddingLeft: "8px" }} onClick={onToggleRecent}>
              {recentOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              <History size={13} className="recent-icon" />
              <span className="folder-name">{t("sidebar.recent")}</span>
            </div>
            {recentOpen && (
              <div className="tree-folder-children">
                {recent.map((s) => renderSession(s, 1, `recent-${s.id}`))}
                {quickHistory.slice(0, 3).map((raw) => (
                  <div
                    key={`qh-${raw}`}
                    className="tree-session-row quick-history-row"
                    style={{ paddingLeft: "28px" }}
                    tabIndex={0}
                    title={t("sidebar.quickHistoryHint")}
                    onDoubleClick={() => onQuickConnect(raw)}
                    onKeyDown={(e) => e.key === "Enter" && onQuickConnect(raw)}
                  >
                    <span className="session-icon">
                      <History size={13} className="muted-icon" />
                    </span>
                    <div className="session-row-text">
                      <span className="session-row-label mono">{raw}</span>
                      <span className="session-row-sub">{t("sidebar.quickConnected")}</span>
                    </div>
                    <div className="session-row-actions" onClick={(e) => e.stopPropagation()}>
                      <button type="button" className="icon-btn-xs" title={t("sidebar.connectTab")} onClick={() => onQuickConnect(raw)}>
                        <Play size={11} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {tree.length === 0 ? (
          <div className="sidebar-empty">{t("sidebar.empty")}</div>
        ) : (
          tree.map((node) => renderNode(node, 0))
        )}
      </div>

      <div className="sidebar-footer">
        <button
          type="button"
          className="btn-secondary btn-block"
          onClick={onOpenImport}
        >
          <Download size={13} /> {t("sidebar.importBtn")}
        </button>
      </div>
    </aside>
  );
};
