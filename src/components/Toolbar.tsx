import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Activity,
  ArrowRightLeft,
  ArrowRight,
  History,
  Layers,
  HardDrive,
  Send,
  Columns2,
  Command,
  Ellipsis,
  Maximize2,
  Minimize2,
  PanelLeft,
  Pause,
  Play,
  PlugZap,
  Plus,
  Radio,
  RotateCw,
  Rows2,
  Settings,
  MonitorSmartphone,
  Zap,
} from "lucide-react";
import type { SplitDirection, SyncInputScope } from "../types/domain";
import { backend, type RemoteStatus } from "../services/backend";
import { TOOLBAR_ITEMS, type ToolbarItem } from "../utils/actions";
import { useContextMenu, type MenuItem } from "./ContextMenu";

export interface SyncMember {
  paneId: string;
  label: string;
  /** Pane badge text ("SYNC", "SYNC A"). */
  badge: string;
  paused: boolean;
}

interface ToolbarProps {
  sidebarOpen: boolean;
  quickBarOpen: boolean;
  focusMode: boolean;
  syncScope: SyncInputScope;
  syncPaused: boolean;
  onToggleSyncPause: () => void;
  /** Panes in the broadcast right now; each can be paused on its own. */
  syncMembers: SyncMember[];
  onToggleSyncPausePane: (paneId: string) => void;
  hasActivePane: boolean;
  hidden: string[];
  /** actionId -> shortcut, shown in tooltips. */
  keymap: Record<string, string>;
  onToggleSidebar: () => void;
  onToggleQuickBar: () => void;
  onToggleFocusMode: () => void;
  onChangeSyncScope: (scope: SyncInputScope) => void;
  onNewSessionModal: () => void;
  onQuickConnect: (raw: string, inSplit: boolean) => void;
  onSplitActive: (dir: SplitDirection) => void;
  onReconnectActive: () => void;
  onDisconnectActive: () => void;
  onOpenSettings: () => void;
  portForwardOpen: boolean;
  onTogglePortForward: () => void;
  monitorOpen: boolean;
  onToggleMonitor: () => void;
  senderOpen: boolean;
  onToggleSender: () => void;
  historyOpen: boolean;
  onToggleHistory: () => void;
  tmuxOpen: boolean;
  onToggleTmux: () => void;
  filesOpen: boolean;
  onToggleFiles: () => void;
  remoteEnabled: boolean;
  /** A relay address is saved; without one the button opens the remote settings. */
  remoteConfigured: boolean;
  onToggleRemote: () => void;
  onOpenRemoteSettings: () => void;
  /** Right-click on the toolbar: customize. */
  onCustomize: () => void;
  /** "Check for Updates" in the More menu. */
  onCheckUpdate: () => void;
  channelCount: number;
  onOpenPalette: () => void;
  /** Recent quick connect addresses, offered while typing. */
  quickHistory: string[];
}

export const Toolbar: React.FC<ToolbarProps> = ({
  sidebarOpen,
  quickBarOpen,
  focusMode,
  syncScope,
  syncPaused,
  onToggleSyncPause,
  syncMembers,
  onToggleSyncPausePane,
  hasActivePane,
  hidden,
  keymap,
  onToggleSidebar,
  onToggleQuickBar,
  onToggleFocusMode,
  onChangeSyncScope,
  onNewSessionModal,
  onQuickConnect,
  onSplitActive,
  onReconnectActive,
  onDisconnectActive,
  onOpenSettings,
  portForwardOpen,
  onTogglePortForward,
  monitorOpen,
  onToggleMonitor,
  senderOpen,
  onToggleSender,
  historyOpen,
  onToggleHistory,
  tmuxOpen,
  onToggleTmux,
  filesOpen,
  onToggleFiles,
  remoteEnabled,
  remoteConfigured,
  onToggleRemote,
  onOpenRemoteSettings,
  onCustomize,
  onCheckUpdate,
  channelCount,
  onOpenPalette,
  quickHistory,
}) => {
  const { t } = useTranslation();
  const openMenu = useContextMenu();
  const [address, setAddress] = useState("");
  const show = (item: ToolbarItem) => !hidden.includes(item);
  const pausedPanes = syncMembers.filter((m) => m.paused).length;
  const tip = (label: string, action: string) => (keymap[action] ? `${label} (${keymap[action]})` : label);
  const [remoteStatus, setRemoteStatus] = useState<RemoteStatus | null>(null);
  const [appVersion, setAppVersion] = useState("");
  useEffect(() => {
    void backend.appVersion().then(setAppVersion);
  }, []);
  useEffect(() => {
    void backend.remoteStatus().then(setRemoteStatus);
    const un = backend.onRemoteState(setRemoteStatus);
    return () => void un.then((f) => f());
  }, []);
  const remoteState = remoteEnabled ? remoteStatus?.state ?? "connecting" : "off";
  const phoneCount = remoteStatus?.phones.length ?? 0;
  const remoteTip = !remoteConfigured
    ? t("remote.toolbarSetup")
    : [
        t(`remote.state.${remoteState}`),
        phoneCount > 0 ? t("remote.toolbarPhones", { count: phoneCount }) : "",
        remoteEnabled ? t("remote.toolbarOn") : t("remote.toolbarOff"),
      ]
        .filter(Boolean)
        .join("\n");

  const showSyncMenu = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const item = (scope: SyncInputScope, label: string, disabled = false) => ({
      label,
      checked: syncScope === scope,
      disabled,
      onClick: () => onChangeSyncScope(scope),
    });
    openMenu({ clientX: r.left, clientY: r.bottom + 4 }, [
      item("off", t("toolbar.syncOff")),
      item("visible", t("toolbar.syncVisible")),
      item("all", t("toolbar.syncAll")),
      item("channels", t("toolbar.syncChannels", { count: channelCount }), channelCount === 0),
      { type: "separator" },
      {
        label: syncPaused ? t("menu.resumeSync") : t("menu.pauseSync"),
        shortcut: keymap["terminal.syncPause"],
        disabled: syncScope === "off",
        onClick: onToggleSyncPause,
      },
      {
        label: t("sync.perPane", { count: syncMembers.length }),
        disabled: syncScope === "off" || syncMembers.length === 0,
        children: syncMembers.map((m) => ({
          label: syncScope === "channels" ? `${m.label}  (${m.badge})` : m.label,
          checked: !m.paused,
          onClick: () => onToggleSyncPausePane(m.paneId),
        })),
      },
    ]);
  };

  // Buttons not on the toolbar are one click away in "More".
  const overflowItem: Partial<Record<ToolbarItem, MenuItem>> = {
    sidebar: { label: t("toolbar.toggleSidebar"), shortcut: keymap["view.toggleSidebar"], checked: sidebarOpen, onClick: onToggleSidebar },
    newSession: { label: t("toolbar.newSession"), onClick: onNewSessionModal },
    palette: { label: t("actions.view.commandPalette"), shortcut: keymap["view.commandPalette"], onClick: onOpenPalette },
    reconnect: { label: t("toolbar.reconnect"), shortcut: keymap["tab.reconnect"], disabled: !hasActivePane, onClick: onReconnectActive },
    disconnect: { label: t("toolbar.disconnect"), disabled: !hasActivePane, onClick: onDisconnectActive },
    splitRight: { label: t("toolbar.splitRight"), shortcut: keymap["split.right"], disabled: !hasActivePane, onClick: () => onSplitActive("horizontal") },
    splitDown: { label: t("toolbar.splitDown"), shortcut: keymap["split.down"], disabled: !hasActivePane, onClick: () => onSplitActive("vertical") },
    quickBar: { label: t("toolbar.toggleQuickBar"), shortcut: keymap["view.toggleQuickBar"], checked: quickBarOpen, onClick: onToggleQuickBar },
    portForward: { label: t("forward.title"), shortcut: keymap["view.portForward"], checked: portForwardOpen, onClick: onTogglePortForward },
    sender: { label: t("sender.title"), shortcut: keymap["view.sender"], checked: senderOpen, onClick: onToggleSender },
    history: { label: t("history.title"), shortcut: keymap["view.history"], checked: historyOpen, onClick: onToggleHistory },
    tmux: { label: t("tmux.title"), shortcut: keymap["terminal.tmux"], checked: tmuxOpen, onClick: onToggleTmux },
    files: { label: t("sftp.title"), shortcut: keymap["view.files"], checked: filesOpen, onClick: onToggleFiles },
    monitor: { label: t("monitor.title"), shortcut: keymap["view.serverMonitor"], checked: monitorOpen, onClick: onToggleMonitor },
    remote: { label: t("remote.enabled"), checked: remoteEnabled, onClick: onToggleRemote },
    settings: { label: t("toolbar.settings"), shortcut: keymap["view.settings"], onClick: onOpenSettings },
    focusMode: { label: t("toolbar.focusMode"), shortcut: keymap["view.focusMode"], checked: focusMode, onClick: onToggleFocusMode },
  };
  const showOverflow = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const items = TOOLBAR_ITEMS.filter((i) => !show(i)).map((i) => overflowItem[i]).filter((x): x is MenuItem => Boolean(x));
    openMenu({ clientX: r.right - 220, clientY: r.bottom + 4 }, [
      ...items,
      ...(items.length ? [{ type: "separator" } as MenuItem] : []),
      { label: t("toolbar.customize"), onClick: onCustomize },
      { type: "separator" },
      { label: t("actions.window.checkUpdate"), shortcut: keymap["window.checkUpdate"], onClick: onCheckUpdate },
      ...(appVersion ? [{ label: t("update.currentVersion", { version: appVersion }), disabled: true } as MenuItem] : []),
    ]);
  };

  const handleQuickSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!address.trim()) return;
    onQuickConnect(address, false);
    setAddress("");
  };

  return (
    <header
      className="top-toolbar"
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest("input, select")) return;
        openMenu(e, [{ label: t("toolbar.customize"), onClick: onCustomize }]);
      }}
    >
      <div className="toolbar-group">
        {show("sidebar") && (
          <button
            type="button"
            className={`icon-btn ${sidebarOpen ? "active" : ""}`}
            onClick={onToggleSidebar}
            title={tip(t("toolbar.toggleSidebar"), "view.toggleSidebar")}
          >
            <PanelLeft size={15} />
          </button>
        )}
        {show("newSession") && (
          <button type="button" className="icon-btn" onClick={onNewSessionModal} title={t("toolbar.newSession")}>
            <Plus size={15} />
          </button>
        )}
        {show("palette") && (
          <button type="button" className="icon-btn" onClick={onOpenPalette} title={tip(t("actions.view.commandPalette"), "view.commandPalette")}>
            <Command size={14} />
          </button>
        )}
        {show("reconnect") && (
          <button
            type="button"
            className="icon-btn"
            disabled={!hasActivePane}
            onClick={onReconnectActive}
            title={tip(t("toolbar.reconnect"), "tab.reconnect")}
          >
            <RotateCw size={14} />
          </button>
        )}
        {show("disconnect") && (
          <button
            type="button"
            className="icon-btn"
            disabled={!hasActivePane}
            onClick={onDisconnectActive}
            title={t("toolbar.disconnect")}
          >
            <PlugZap size={15} />
          </button>
        )}
      </div>

      {show("quickConnect") ? (
        <form className="quick-connect-bar" onSubmit={handleQuickSubmit}>
          <span className="quick-prefix">{t("toolbar.quickPrefix")}</span>
          <input
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.altKey && address.trim()) {
                e.preventDefault();
                onQuickConnect(address, true);
                setAddress("");
              }
            }}
            placeholder={t("toolbar.quickPlaceholder")}
            list="quick-connect-history"
            spellCheck={false}
          />
          <datalist id="quick-connect-history">
            {quickHistory.map((h) => (
              <option key={h} value={h} />
            ))}
          </datalist>
          <button type="submit" className="quick-go-btn" title={t("toolbar.connectBtn")}>
            <ArrowRight size={14} />
          </button>
        </form>
      ) : (
        <div className="toolbar-spacer" />
      )}

      <div className="toolbar-group">
        {show("splitRight") && (
          <button
            type="button"
            className="icon-btn"
            disabled={!hasActivePane}
            onClick={() => onSplitActive("horizontal")}
            title={tip(t("toolbar.splitRight"), "split.right")}
          >
            <Columns2 size={15} />
          </button>
        )}
        {show("splitDown") && (
          <button
            type="button"
            className="icon-btn"
            disabled={!hasActivePane}
            onClick={() => onSplitActive("vertical")}
            title={tip(t("toolbar.splitDown"), "split.down")}
          >
            <Rows2 size={15} />
          </button>
        )}

        {show("sync") && (
          <>
            <button
              type="button"
              className={`pill-btn ${syncScope !== "off" ? (syncPaused ? "pill-paused" : "pill-active") : ""}`}
              onClick={showSyncMenu}
              title={t("toolbar.syncTitle")}
            >
              <Radio size={13} />
              <span>
                {syncScope === "off"
                  ? t("toolbar.syncOff")
                  : syncScope === "visible"
                  ? t("toolbar.syncVisible")
                  : syncScope === "channels"
                  ? t("toolbar.syncChannels", { count: channelCount })
                  : t("toolbar.syncAll")}
                {syncScope !== "off" && syncPaused ? ` · ${t("toolbar.syncPausedSuffix")}` : ""}
                {syncScope !== "off" && !syncPaused && pausedPanes > 0 ? ` · ${t("sync.pausedPanes", { count: pausedPanes })}` : ""}
              </span>
            </button>
            {syncScope !== "off" && (
              <button
                type="button"
                className={`icon-btn ${syncPaused ? "active" : ""}`}
                onClick={onToggleSyncPause}
                title={tip(syncPaused ? t("menu.resumeSync") : t("menu.pauseSync"), "terminal.syncPause")}
              >
                {syncPaused ? <Play size={14} /> : <Pause size={14} />}
              </button>
            )}
          </>
        )}

        {show("quickBar") && (
          <button
            type="button"
            className={`icon-btn ${quickBarOpen ? "active" : ""}`}
            onClick={onToggleQuickBar}
            title={tip(t("toolbar.toggleQuickBar"), "view.toggleQuickBar")}
          >
            <Zap size={15} />
          </button>
        )}

        {show("portForward") && (
          <button
            type="button"
            className={`icon-btn ${portForwardOpen ? "active" : ""}`}
            onClick={onTogglePortForward}
            title={tip(t("forward.title"), "view.portForward")}
          >
            <ArrowRightLeft size={15} />
          </button>
        )}
        {show("sender") && (
          <button
            type="button"
            className={`icon-btn ${senderOpen ? "active" : ""}`}
            onClick={onToggleSender}
            title={tip(t("sender.title"), "view.sender")}
          >
            <Send size={15} />
          </button>
        )}
        {show("history") && (
          <button
            type="button"
            className={`icon-btn ${historyOpen ? "active" : ""}`}
            onClick={onToggleHistory}
            title={tip(t("history.title"), "view.history")}
          >
            <History size={15} />
          </button>
        )}
        {show("tmux") && (
          <button
            type="button"
            className={`icon-btn ${tmuxOpen ? "active" : ""}`}
            onClick={onToggleTmux}
            title={tip(t("tmux.title"), "terminal.tmux")}
          >
            <Layers size={15} />
          </button>
        )}
        {show("files") && (
          <button
            type="button"
            className={`icon-btn ${filesOpen ? "active" : ""}`}
            onClick={onToggleFiles}
            title={tip(t("sftp.title"), "view.files")}
          >
            <HardDrive size={15} />
          </button>
        )}
        {show("monitor") && (
          <button
            type="button"
            className={`icon-btn ${monitorOpen ? "active" : ""}`}
            onClick={onToggleMonitor}
            title={tip(t("monitor.title"), "view.serverMonitor")}
          >
            <Activity size={15} />
          </button>
        )}
        {show("remote") && (
          <button
            type="button"
            className={`icon-btn remote-btn ${remoteEnabled ? "active" : ""}`}
            onClick={onToggleRemote}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onOpenRemoteSettings();
            }}
            title={remoteTip}
          >
            <MonitorSmartphone size={15} />
            {remoteEnabled && <span className={`remote-dot remote-dot-${remoteState}`} />}
          </button>
        )}
        {show("settings") && (
          <button type="button" className="icon-btn" onClick={onOpenSettings} title={tip(t("toolbar.settings"), "view.settings")}>
            <Settings size={15} />
          </button>
        )}

        {show("focusMode") && (
          <button
            type="button"
            className={`icon-btn ${focusMode ? "active" : ""}`}
            onClick={onToggleFocusMode}
            title={tip(t("toolbar.focusMode"), "view.focusMode")}
          >
            {focusMode ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
        )}
        <button type="button" className="icon-btn" onClick={showOverflow} title={t("toolbar.more")}>
          <Ellipsis size={15} />
        </button>
      </div>
    </header>
  );
};
