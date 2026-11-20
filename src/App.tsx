import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, Folder, Minimize2 } from "lucide-react";
import { applyThemeCssVars, BUILTIN_THEMES } from "./constants/themes";
import { applyTerminalBackground } from "./services/terminalBackground";
import { backend, currentWindowLabel, isTauriRuntime, type RemoteAuth, type RemoteTab } from "./services/backend";
import { actionForCombo, comboFromEvent, resolveKeymap } from "./utils/actions";
import { terminalBus } from "./services/terminalBus";
import { parseQuickConnectInput } from "./utils/quickConnect";
import {
  activeLeafOf,
  allGroups,
  allLeaves,
  findGroup,
  findGroupOfPane,
  findLeaf,
  mapGroups,
  moveTab,
  placeLeaves,
  removeTab,
  splitGroup,
  updateLeaf,
  updateSplitRatio,
  equalizeSplits,
  neighborGroup,
  resizeGroup,
  swapGroups,
  tabTitle,
  type DropZone,
  type Side,
} from "./utils/layout";
import { canReuseSsh, duplicateReusesSsh } from "./utils/duplicate";
import { dropZoneAt, type DropHint } from "./utils/dropZones";
import type {
  AppSettings,
  ImportResult,
  ProtocolType,
  QuickCommand,
  SessionConfig,
  SplitDirection,
  PaneGroup,
  SyncChannel,
  SyncInputScope,
  TerminalLeafNode,
  ThemeDefinition,
  TunnelConfig,
  WorkspaceState,
} from "./types/domain";

import { Toolbar } from "./components/Toolbar";
import { SessionSidebar, type SessionOpenState } from "./components/SessionSidebar";
import { SplitWorkspace, TABBAR_H, type GroupActions } from "./components/SplitWorkspace";
import { QuickBar } from "./components/QuickBar";
import { QuickCommandManager, type QuickManagerTarget } from "./components/QuickCommandManager";
import { quickPayload } from "./utils/quickCommands";
import { syncTargets } from "./utils/syncInput";
import { SessionModal } from "./components/SessionModal";
import { PaneSessionModal } from "./components/PaneSessionModal";
import { applyPaneSessionEdits, hasSavedPassword, savePaneProfile } from "./utils/paneSession";
import { SessionManager } from "./components/SessionManager";
import { ImportModal } from "./components/ImportModal";
import { SettingsModal, type SettingsTab } from "./components/SettingsModal";
import { LockOverlay } from "./components/LockOverlay";
import { serializePane, type PaneApi, type PaneExtras, type ReconnectCredentials, type TabMark } from "./components/TerminalPane";
import { TitleBar, titleDragStartedRecently } from "./components/TitleBar";
import { agentDisplayName, normalizeApp, type AgentState, type AgentStatus } from "./utils/agentStatus";
import { titleShowsHost } from "./utils/hostname";
import { formatDuration, type CommandDone } from "./utils/commandWatch";
import type { RunningCommand } from "./utils/runningCommand";
import { useAgentHooks } from "./hooks/useAgentHooks";
import { compactMenu, ContextMenuProvider, type MenuItem } from "./components/ContextMenu";
import { HostKeyDialog, ZmodemDialog } from "./components/TransferDialogs";
import { ConfirmDialog, PasteDialog, type ConfirmAnswer, type ConfirmRequest } from "./components/ConfirmDialog";
import { StorageLocationPrompt } from "./components/StorageLocation";
import type { HighlightRule, StorageLocationInfo } from "./types/domain";
import { ShareDialog } from "./components/ShareDialog";
import { shareStore, useShareStore } from "./services/shares";
import { SenderPanel } from "./components/SenderPanel";
import { HistoryPanel } from "./components/HistoryPanel";
import { TmuxPanel, type TmuxTarget } from "./components/TmuxPanel";
import { commandHistory, historyKeyOf } from "./utils/commandHistory";
import { autoSyncInterval, syncErrorKey, syncReady } from "./utils/configSync";
import { historyOf, modemOf, remoteOf, sftpOf, syncOf } from "./utils/settingsDefaults";
import { hostKeyOf } from "./utils/sftpBookmarks";
import type { AiControl, AiControlMode, AiControlRequest, AiOpenRequest, McpClient, SenderItem, UpdateInfo, UpdateProgress } from "./types/domain";
import { AiRequestDialog } from "./components/AiRequestDialog";
import { PortForwardPanel, type ForwardTarget } from "./components/PortForwardPanel";
import { ServerMonitorPanel } from "./components/ServerMonitor";
import { SftpPanel, type SftpTarget } from "./components/SftpPanel";
import { FilePreview, type PreviewRequest } from "./components/FilePreview";
import { paneCwd } from "./utils/paneCwd";
import { downloadDir as downloadDirPath } from "@tauri-apps/api/path";
import { HighlightDialog, newHighlightRule } from "./components/HighlightEditor";
import { sessionTargetSummary } from "./utils/sessionSummary";
import { usePersistentUiState } from "./hooks/usePersistentUiState";
import { CommandPalette, type PaletteTab } from "./components/CommandPalette";
import { ProtocolBadge } from "./components/ProtocolBadge";
import { buildSessionTree, type SessionTreeNode } from "./utils/sessionTree";
import { ACTIONS, DEFAULT_TOOLBAR_HIDDEN, TOOLBAR_LAYOUT_VERSION } from "./utils/actions";
import { restoreWorkspace, snapshotWorkspace, type WorkspaceSnapshot } from "./utils/workspaceSnapshot";
import { UPDATE_CHECK_DELAY_MS, shouldPromptUpdate, updateCheckEnabled } from "./utils/updateCheck";
import { UpdateProgressCard } from "./components/UpdateProgressCard";
import { ReleaseNotes } from "./components/ReleaseNotes";
import { PluginActivity, PluginBadges, PluginHost, PluginToolbar, PluginViews, usePluginPlatform } from "./components/StatusPlugins";
import { plugins } from "./plugins/platform";
import { pluginStores } from "./plugins/storeService";
import { PluginUpdateNotice } from "./components/PluginStore";

function sameDropHint(a: DropHint | null, b: DropHint | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.zone.groupId === b.zone.groupId &&
    a.zone.side === b.zone.side &&
    a.rect.left === b.rect.left &&
    a.rect.top === b.rect.top &&
    a.rect.width === b.rect.width &&
    a.rect.height === b.rect.height
  );
}

function uid(prefix = "id"): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? `${prefix}-${crypto.randomUUID()}`
    : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const DEFAULT_SETTINGS: AppSettings = {
  themeId: "dige-black",
  fontFamily: "'Cascadia Mono', Consolas, 'Roboto Mono', 'Microsoft YaHei UI', monospace",
  fontSize: 14,
  scrollback: 10000,
  cursorBlink: false,
  cursorStyle: "block",
  confirmBeforeClose: false,
  lockPasscode: null,
  language: "zh-CN",
  syntaxHighlight: true,
  closeToTray: true,
  logDir: null,
  logFilePattern: "%n_%Y-%m-%d_%H-%M-%S.log",
  logTimestamp: true,
  copyOnSelect: false,
  rightClickAction: "menu",
  alwaysOnTop: false,
  windowOpacity: 1,
  keymap: {},
  toolbarHidden: [...DEFAULT_TOOLBAR_HIDDEN],
  toolbarLayout: TOOLBAR_LAYOUT_VERSION,
  wheelScrollLines: 3,
};

export const App: React.FC = () => {
  const { t, i18n } = useTranslation();
  const [sessions, setSessions] = useState<SessionConfig[]>([]);
  const [quickCommands, setQuickCommands] = useState<QuickCommand[]>([]);
  const quickCommandsRef = useRef(quickCommands);
  quickCommandsRef.current = quickCommands;
  /** The Quick Commands dialog, and what it opens on. */
  const [quickManager, setQuickManager] = useState<QuickManagerTarget | null>(null);
  const [customThemes, setCustomThemes] = useState<ThemeDefinition[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [initialSnapshot, setInitialSnapshot] = useState<{ sessions: SessionConfig[]; settings: AppSettings } | null>(null);
  // Saved state could not be read: carry on with the defaults (and the default theme).
  const [loadFailed, setLoadFailed] = useState(false);

  const [ws, setWs] = useState<WorkspaceState>({ root: null, activeGroupId: null });
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  const { ui, setSidebarOpen, setSidebarWidth, setQuickBarOpen, setSidebarRecentOpen } = usePersistentUiState(
    currentWindowLabel() === "main"
  );
  const { sidebarOpen, sidebarWidth } = ui;
  // With no quick commands the bar stays out of the way, unless asked for (to add one).
  const [quickBarAsked, setQuickBarAsked] = useState(false);
  const quickBarOpen = ui.quickBarOpen && (quickCommands.length > 0 || quickBarAsked);
  const toggleQuickBar = () => {
    const shown = quickBarOpen;
    setQuickBarOpen(!shown);
    setQuickBarAsked(!shown);
  };
  const [focusMode, setFocusMode] = useState(false);
  const [syncScope, setSyncScope] = useState<SyncInputScope>("off");
  const [locked, setLocked] = useState(false);
  /** Pause broadcasting without forgetting the sync scope / channels. */
  const [syncPaused, setSyncPaused] = useState(false);
  /** Panes paused one by one: they stay out of the broadcast while the others keep syncing. */
  const [syncPausedPanes, setSyncPausedPanes] = useState<Record<string, boolean>>({});
  /** paneId -> joined sync channel. */
  const [syncChannels, setSyncChannels] = useState<Record<string, SyncChannel>>({});
  /** paneId -> session log file currently being written. */
  const [logPaths, setLogPaths] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<string | null>(null);
  /** Update download in progress. */
  const [updateProgress, setUpdateProgress] = useState<{ version: string; progress: UpdateProgress } | null>(null);
  const [portForwardOpen, setPortForwardOpen] = useState(false);
  const [monitorOpen, setMonitorOpen] = useState(false);
  /** Pane the forwarding panel was opened for (pane menu); falls back to the active pane. */
  const [forwardPaneId, setForwardPaneId] = useState<string | null>(null);

  const [sessionModalState, setSessionModalState] = useState<{
    open: boolean;
    editing: SessionConfig | null;
    /** `editing` only prefills a new session. */
    isNew?: boolean;
  }>({ open: false, editing: null });
  const [settingsPaneId, setSettingsPaneId] = useState<string | null>(null);
  const settingsPane = settingsPaneId ? findLeaf(ws.root, settingsPaneId) : undefined;
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);

  // Refs for latest sync input routing without recreating terminal event handlers
  const wsRef = useRef(ws);
  wsRef.current = ws;
  const syncScopeRef = useRef(syncScope);
  syncScopeRef.current = syncScope;
  const syncPausedRef = useRef(syncPaused);
  syncPausedRef.current = syncPaused;
  const syncPausedPanesRef = useRef(syncPausedPanes);
  syncPausedPanesRef.current = syncPausedPanes;
  const syncChannelsRef = useRef(syncChannels);
  syncChannelsRef.current = syncChannels;

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // One modal question at a time (close / quit / clipboard confirmations).
  const [confirmQueue, setConfirmQueue] = useState<{ req: ConfirmRequest; resolve: (a: ConfirmAnswer) => void }[]>([]);
  const ask = useCallback(
    (req: ConfirmRequest) => new Promise<ConfirmAnswer>((resolve) => setConfirmQueue((q) => [...q, { req, resolve }])),
    []
  );
  const [pasteRequest, setPasteRequest] = useState<{ text: string; paste: (text: string) => void } | null>(null);
  const [senderOpen, setSenderOpen] = useState(false);
  const [senderPaneId, setSenderPaneId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  /** SFTP file browser, the pane it was opened on, and the open file previews. */
  const [filesOpen, setFilesOpen] = useState(false);
  const [filesPaneId, setFilesPaneId] = useState<string | null>(null);
  /** tmux sessions panel, and the pane it was opened on from the pane menu. */
  const [tmuxOpen, setTmuxOpen] = useState(false);
  const [tmuxPaneId, setTmuxPaneId] = useState<string | null>(null);
  const [previews, setPreviews] = useState<PreviewRequest[]>([]);
  const [senders, setSenders] = useState<SenderItem[]>([]);
  /** paneId -> log paused. */
  const [pausedLogs, setPausedLogs] = useState<Record<string, boolean>>({});

  const allThemes = useMemo(
    () => [...BUILTIN_THEMES, ...customThemes],
    [customThemes]
  );

  const activeTheme = useMemo(
    () =>
      allThemes.find((t) => t.id === settings.themeId) ?? BUILTIN_THEMES[0],
    [allThemes, settings.themeId]
  );

  // The theme waits for the saved settings: until then the page keeps the cached theme
  // (applyCachedThemeVars) instead of flashing the default one. The main window's backdrop
  // follows the theme and is kept for the next start, painted before the page loads.
  const themeReady = initialSnapshot !== null || loadFailed;
  useLayoutEffect(() => {
    if (!themeReady) return;
    applyThemeCssVars(activeTheme);
    if (currentWindowLabel() === "main") void backend.setWindowBackground();
  }, [activeTheme, themeReady]);

  // Keep i18n language in sync with persisted settings (default zh-CN)
  useEffect(() => {
    const lng = settings.language || "zh-CN";
    if (i18n.language !== lng) void i18n.changeLanguage(lng);
    document.documentElement.lang = lng;
  }, [settings.language, i18n]);

  // Load persisted state & attach global Tauri output/state listeners
  useEffect(() => {
    let mounted = true;
    void backend.loadInitialState().then((snap) => {
      if (!mounted) return;
      setSessions(snap.sessions);
      setQuickCommands(snap.quickCommands);
      setCustomThemes(snap.customThemes);
      // The slimmer toolbar, once, for users who never customized theirs.
      const st = snap.settings;
      if ((st.toolbarLayout ?? 0) < TOOLBAR_LAYOUT_VERSION && currentWindowLabel() === "main") {
        const migrated = {
          ...st,
          toolbarLayout: TOOLBAR_LAYOUT_VERSION,
          toolbarHidden: st.toolbarHidden?.length ? st.toolbarHidden : [...DEFAULT_TOOLBAR_HIDDEN],
        };
        snap = { ...snap, settings: migrated };
        void backend.saveSettings(migrated);
      }
      // Full history keeps everything in the backend: xterm.js's own scrollback can be
      // smaller. Once, and only from the old default (a value the user picked stays).
      if (!snap.settings.scrollbackMigrated && currentWindowLabel() === "main") {
        const cur = snap.settings;
        const migrated = {
          ...cur,
          scrollbackMigrated: true,
          scrollback: cur.scrollback === 50000 && cur.fullHistory !== false ? 10000 : cur.scrollback,
        };
        snap = { ...snap, settings: migrated };
        void backend.saveSettings(migrated);
      }
      setSettings(snap.settings);
      commandHistory.configure(historyOf(snap.settings));
      void commandHistory.load();
      setInitialSnapshot(snap);
    }).catch((err) => {
      console.error("load initial state", err);
      if (mounted) setLoadFailed(true);
    });
    void backend.loadDataFile<SenderItem[]>("senders").then((list) => {
      if (mounted && Array.isArray(list)) setSenders(list);
    });

    const unlistenStatePromise = backend.onTerminalState((payload) => {
      setWs((prev) => {
        const root = updateLeaf(prev.root, payload.instanceId, (leaf) => ({
          ...leaf,
          status: payload.status,
          statusMessage: payload.message ?? undefined,
          connectedAt:
            payload.status === "connected" ? (leaf.status === "connected" ? leaf.connectedAt : Date.now()) : undefined,
        }));
        return root === prev.root ? prev : { ...prev, root };
      });
    });

    return () => {
      mounted = false;
      void unlistenStatePromise.then((fn) => fn());
    };
  }, []);

  // ---------------------------------------------------------------- idle lock, history, quit

  // Lock the window after N idle minutes (WindTerm application.lockScreenTimeout).
  const lockMinutes = settings.lockScreenTimeout ?? 0;
  useEffect(() => {
    if (!lockMinutes || lockMinutes <= 0) return;
    let last = Date.now();
    const bump = () => (last = Date.now());
    const events = ["mousemove", "mousedown", "keydown", "wheel", "touchstart"] as const;
    events.forEach((ev) => window.addEventListener(ev, bump, { passive: true, capture: true }));
    const timer = window.setInterval(() => {
      if (Date.now() - last >= lockMinutes * 60_000) setLocked(true);
    }, 5000);
    return () => {
      window.clearInterval(timer);
      events.forEach((ev) => window.removeEventListener(ev, bump, { capture: true }));
    };
  }, [lockMinutes]);

  useEffect(() => {
    commandHistory.configure(historyOf(settings));
  }, [settings.history]);

  // Backend asks before quitting with open sessions (tray "Quit", closing the main window).
  useEffect(() => {
    const un = backend.onConfirmQuit(async (count) => {
      const a = await ask({
        title: t("confirm.quitTitle"),
        message: t("confirm.quitMsg", { count }),
        okLabel: t("confirm.quit"),
        danger: true,
        checkboxLabel: t("confirm.dontAsk"),
      });
      if (!a.ok) return;
      if (a.checked) saveSettings({ ...settingsRef.current, askBeforeCloseWindow: false });
      commandHistory.flush();
      await backend.quitApp(true);
    });
    return () => void un.then((f) => f());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------- startup sessions
  // WindTerm terminal.startupSessions: reopen the last sessions, or a chosen list.
  const startupDone = useRef(false);
  // Opening a saved session counts as a use (sidebar: recent / most used order).
  const restoringRef = useRef(false);
  useEffect(() => {
    if (!initialSnapshot || startupDone.current || currentWindowLabel() !== "main") return;
    startupDone.current = true;
    const { sessions: saved, settings: st } = initialSnapshot;
    const mode = st.startupSessions ?? "none";
    // Restoring sessions at startup is not "using" them (sidebar sorting).
    const restore = (list: (SessionConfig | undefined)[]) => {
      restoringRef.current = true;
      try {
        list.forEach((x) => x && openSessionInNewTab(x));
      } finally {
        restoringRef.current = false;
      }
    };
    if (mode === "selected") {
      restore((st.startupSessionIds ?? []).map((id) => saved.find((x) => x.id === id)));
    } else if (mode === "last") {
      // The whole layout (splits, tab order, titles ...); older versions only saved the list.
      void backend.loadDataFile<WorkspaceSnapshot>("last_workspace").then((snap) => {
        const back = restoreWorkspace(snap, { sessions: saved, makeLeaf, newId: uid, adoptPluginSession: (id, origin) => plugins.adoptSession(id, origin) });
        if (back.root) {
          setWs((prev) => (prev.root ? prev : back));
          return;
        }
        void backend.loadDataFile<{ id: string; label?: string }[]>("last_sessions").then((list) => {
          restore((list ?? []).map((e) => saved.find((x) => x.id === e.id)));
        });
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSnapshot]);

  // Save the layout shortly after it changes (status-only changes write nothing).
  const lastSavedLayout = useRef("");
  useEffect(() => {
    if (!startupDone.current || currentWindowLabel() !== "main") return;
    const timer = window.setTimeout(() => {
      const ids = sessions.map((x) => x.id);
      const snap = snapshotWorkspace(wsRef.current, ids, (id) => plugins.sessionOrigin(id));
      const text = JSON.stringify(snap);
      if (text === lastSavedLayout.current) return;
      lastSavedLayout.current = text;
      void backend.saveDataFile("last_workspace", snap);
      const known = new Set(ids);
      const list = allLeaves(wsRef.current.root)
        .filter((l) => known.has(l.session.id))
        .map((l) => ({ id: l.session.id, label: l.session.label }));
      void backend.saveDataFile("last_sessions", list);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [ws, sessions]);

  // Explicit Focus Mode toggle (zero background watchdog timer bugs!)
  const toggleFocusMode = useCallback(() => {
    setFocusMode((prev) => {
      const next = !prev;
      void backend.setWindowFullscreen(next);
      return next;
    });
  }, []);

  const sessionsRef = useRef<SessionConfig[]>([]);
  sessionsRef.current = sessions;
  const [sessionUsage, setSessionUsage] = useState<Record<string, { count: number; lastUsed: number }>>({});
  /** Saved sessions, most recently opened first. */
  const recentSessionIds = useMemo(
    () =>
      Object.entries(sessionUsage)
        .filter(([id]) => sessions.some((s) => s.id === id))
        .sort((a, b) => b[1].lastUsed - a[1].lastUsed)
        .map(([id]) => id),
    [sessionUsage, sessions]
  );
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** Addresses typed into quick connect, newest first. */
  const [quickHistory, setQuickHistory] = useState<string[]>([]);
  useEffect(() => {
    void backend.loadDataFile<string[]>("quick_connect_history").then((list) => Array.isArray(list) && setQuickHistory(list));
  }, []);
  const rememberQuickConnect = (raw: string) => {
    const entry = raw.trim();
    if (!entry) return;
    setQuickHistory((prev) => {
      const next = [entry, ...prev.filter((x) => x !== entry)].slice(0, 20);
      void backend.saveDataFile("quick_connect_history", next);
      return next;
    });
  };
  const forgetQuickConnect = (raw: string) => {
    setQuickHistory((prev) => {
      const next = prev.filter((x) => x !== raw);
      void backend.saveDataFile("quick_connect_history", next);
      return next;
    });
  };
  const saveQuickConnect = (raw: string) => {
    const parsed = parseQuickConnectInput(raw);
    if (!parsed) return;
    setSessionModalState({ open: true, editing: { ...parsed, group: t("sessionModal.defaultGroup") }, isNew: true });
  };
  useEffect(() => {
    void backend.loadDataFile<Record<string, { count: number; lastUsed: number }>>("session_usage").then((u) => u && setSessionUsage(u));
    const un = backend.onSessionUsage(setSessionUsage);
    return () => void un.then((f) => f());
  }, []);
  const noteSessionUse = (session: SessionConfig) => {
    if (restoringRef.current || !sessionsRef.current.some((x) => x.id === session.id)) return;
    void backend.recordSessionUse(session.id);
  };

  const makeLeafFromSession = (session: SessionConfig): TerminalLeafNode => {
    noteSessionUse(session);
    return makeLeaf(session);
  };
  const makeLeaf = (session: SessionConfig): TerminalLeafNode => ({
    kind: "leaf",
    paneId: uid("pane"),
    session: { ...session },
    status: "connecting",
    rows: 28,
    cols: 100,
    reconnectCount: 0,
    color: session.tabColor ?? null,
  });

  const makeGroup = (leaf: TerminalLeafNode): PaneGroup => ({
    kind: "group",
    id: uid("group"),
    tabs: [leaf],
    activeTabId: leaf.paneId,
  });

  /** Open a session as a new tab in a group (default: the active group). */
  /** `reuseFrom`: an SSH pane whose connection the new tab opens a channel on. */
  /** Returns the new tab's pane id. */
  const openSessionInNewTab = useCallback((session: SessionConfig, groupId?: string, reuseFrom?: string): string => {
    const leaf = { ...makeLeafFromSession(session), ...(reuseFrom ? { reuseFrom } : {}) };
    setWs((prev) => {
      if (!prev.root) {
        const group = makeGroup(leaf);
        return { root: group, activeGroupId: group.id };
      }
      const groups = allGroups(prev.root);
      const target =
        groups.find((g) => g.id === groupId) ??
        groups.find((g) => g.id === prev.activeGroupId) ??
        groups[0];
      return {
        root: mapGroups(prev.root, (g) =>
          g.id === target.id ? { ...g, tabs: [...g.tabs, leaf], activeTabId: leaf.paneId } : g
        ),
        activeGroupId: target.id,
      };
    });
    return leaf.paneId;
  }, []);

  /** Open a session in a new split group beside the active group. */
  const openSessionInSplit = useCallback(
    (session: SessionConfig, direction: SplitDirection = "horizontal", besideGroupId?: string) => {
      const leaf = makeLeafFromSession(session);
      const group = makeGroup(leaf);
      setWs((prev) => {
        if (!prev.root) return { root: group, activeGroupId: group.id };
        const groups = allGroups(prev.root);
        const target =
          groups.find((g) => g.id === besideGroupId) ??
          groups.find((g) => g.id === prev.activeGroupId) ??
          groups[0];
        return {
          root: splitGroup(prev.root, target.id, direction, group, uid("split")),
          activeGroupId: group.id,
        };
      });
    },
    []
  );

  const openQuickShell = useCallback(
    (proto: ProtocolType, groupId?: string) => {
      const labels: Record<ProtocolType, string> = {
        powershell: "PowerShell",
        cmd: "CMD",
        wsl: "WSL",
        ssh: "SSH",
        custom: "Shell",
        tcp: "TCP",
        serial: "Serial",
        telnet: "Telnet",
      };
      openSessionInNewTab(
        {
          id: uid("quick"),
          label: labels[proto],
          group: t("app.localShellsGroup"),
          protocol: proto,
          host: "",
          port: 0,
          username: "",
          authType: "none",
          term: "xterm-256color",
          keepAliveSecs: 0,
        },
        groupId
      );
    },
    [openSessionInNewTab, t]
  );

  const activatePane = useCallback((paneId: string) => {
    setWs((prev) => {
      const group = findGroupOfPane(prev.root, paneId);
      if (!group) return prev;
      if (group.activeTabId === paneId && prev.activeGroupId === group.id) return prev;
      return {
        root: mapGroups(prev.root, (g) => (g.id === group.id ? { ...g, activeTabId: paneId } : g)),
        activeGroupId: group.id,
      };
    });
  }, []);

  /** Close tabs (terminals). Emptied groups disappear from the layout. */
  const closePanes = useCallback((requested: string[]) => {
    const locked = requested.filter((id) => findLeaf(wsRef.current.root, id)?.locked);
    const paneIds = requested.filter((id) => !locked.includes(id));
    if (locked.length > 0) setToast(t("app.lockedSkip", { count: locked.length }));
    for (const paneId of paneIds) {
      void backend.disconnectTerminal(paneId);
      void backend.historyDrop(paneId);
      terminalBus.clearPane(paneId);
      paneCwd.forget(paneId);
    }
    setPreviews((list) => list.filter((x) => !paneIds.includes(x.instanceId)));
    setWs((prev) => {
      let root = prev.root;
      for (const paneId of paneIds) root = removeTab(root, paneId);
      const groups = allGroups(root);
      const activeGroupId = groups.some((g) => g.id === prev.activeGroupId)
        ? prev.activeGroupId
        : groups[groups.length - 1]?.id ?? null;
      return { root, activeGroupId };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleLock = useCallback((paneId: string) => {
    const leaf = findLeaf(wsRef.current.root, paneId);
    if (!leaf) return;
    setWs((prev) => ({ ...prev, root: updateLeaf(prev.root, paneId, (l) => ({ ...l, locked: !l.locked })) }));
    setToast(leaf.locked ? t("app.unlocked", { name: tabTitle(leaf) }) : t("app.locked", { name: tabTitle(leaf) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The backend refuses to quit / close a window while it holds locked sessions.
  const lockedCount = allLeaves(ws.root).filter((l) => l.locked).length;
  useEffect(() => {
    void backend.reportLockedSessions(lockedCount);
  }, [lockedCount]);
  useEffect(() => {
    const un = backend.onWindowEvent<number>("quit-blocked", (count) => setToast(t("app.quitBlocked", { count })));
    return () => void un.then((f) => f());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (currentWindowLabel() !== "main") return;
    const un = backend.onRemotePhoneJoined((name) => setToast(t("remote.phoneJoined", { name: name || t("remote.phone") })));
    return () => void un.then((f) => f());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A share viewer asks to join or for control: the window that shows the pane says so.
  useEffect(() => {
    const un = backend.onSharePrompt((p) => {
      const leaf = findLeaf(wsRef.current.root, p.paneId);
      if (!leaf) return;
      const name = p.name || t("share.guest");
      setToast(t(p.kind === "join" ? "share.toastJoin" : "share.toastControl", { title: tabTitle(leaf), name }));
    });
    return () => void un.then((f) => f());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const relayConfigured = Boolean(remoteOf(settings).relayUrl.trim());
  useEffect(() => shareStore.setRelayConfigured(relayConfigured), [relayConfigured]);
  const { dialogPane: shareDialogPane } = useShareStore();
  const shareDialogLeaf = shareDialogPane ? findLeaf(ws.root, shareDialogPane) : null;
  // "Manage text highlights" of one pane (its rules live on the leaf, not in the settings).
  const [highlightPane, setHighlightPane] = useState<string | null>(null);
  const highlightLeaf = highlightPane ? findLeaf(ws.root, highlightPane) : null;
  const updateHighlights = (paneId: string, fn: (rules: HighlightRule[]) => HighlightRule[]) =>
    setWs((prev) => ({ ...prev, root: updateLeaf(prev.root, paneId, (l) => ({ ...l, highlightRules: fn(l.highlightRules ?? []) })) }));
  // The pane closed or moved to another window while its dialog was open.
  useEffect(() => {
    if (shareDialogPane && !shareDialogLeaf) shareStore.closeDialog();
  }, [shareDialogPane, shareDialogLeaf]);

  // A phone opens a saved session here (it may have saved it a moment ago: read the file).
  useEffect(() => {
    if (currentWindowLabel() !== "main") return;
    const un = backend.onRemoteOpenSession((id) => {
      void backend.loadInitialState().then((snap) => {
        const session = snap.sessions.find((s) => s.id === id);
        if (session) openSessionInNewTab(session);
      });
    });
    return () => void un.then((f) => f());
  }, [openSessionInNewTab]);

  /** Close tabs, asking first when live connections would end (WindTerm terminal.askBeforeCloseTab). */
  const closePanesAsk = useCallback(
    async (paneIds: string[]) => {
      const live = paneIds
        .map((id) => findLeaf(wsRef.current.root, id))
        .filter((l): l is TerminalLeafNode => Boolean(l && !l.locked && (l.status === "connected" || l.status === "connecting")));
      if (live.length && settingsRef.current.askBeforeCloseTab !== false) {
        const a = await ask({
          title: t("confirm.closeTabTitle"),
          message:
            live.length === 1 ? t("confirm.closeTabOne", { name: tabTitle(live[0]) }) : t("confirm.closeTabMany", { count: live.length }),
          okLabel: t("confirm.close"),
          danger: true,
          checkboxLabel: t("confirm.dontAsk"),
        });
        if (!a.ok) return;
        if (a.checked) saveSettings({ ...settingsRef.current, askBeforeCloseTab: false });
      }
      closePanes(paneIds);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [closePanes, ask]
  );

  const handleClosePane = useCallback((paneId: string) => void closePanesAsk([paneId]), [closePanesAsk]);

  const handleDimensionsChange = useCallback((paneId: string, cols: number, rows: number) => {
    setWs((prev) => {
      const root = updateLeaf(prev.root, paneId, (l) => (l.cols === cols && l.rows === rows ? l : { ...l, cols, rows }));
      return root === prev.root ? prev : { ...prev, root };
    });
  }, []);

  /** Split: keep the current terminal and open a new connection of its session beside it. */
  const handleSplitPane = useCallback(
    (paneId: string, direction: SplitDirection) => {
      const ws = wsRef.current;
      const leaf = findLeaf(ws.root, paneId);
      const group = findGroupOfPane(ws.root, paneId);
      if (leaf && group) openSessionInSplit(leaf.session, direction, group.id);
    },
    [openSessionInSplit]
  );

  /** Move an existing tab into a new group beside its own (no reconnect). */
  const moveTabToNewGroup = useCallback((paneId: string, direction: SplitDirection) => {
    setWs((prev) => {
      const source = findGroupOfPane(prev.root, paneId);
      const leaf = findLeaf(prev.root, paneId);
      if (!source || !leaf || source.tabs.length < 2) return prev;
      const group: PaneGroup = { kind: "group", id: uid("group"), tabs: [leaf], activeTabId: paneId };
      const without = removeTab(prev.root, paneId)!;
      return { root: splitGroup(without, source.id, direction, group, uid("split")), activeGroupId: group.id };
    });
  }, []);

  const handleReconnectPane = useCallback((paneId: string, creds?: ReconnectCredentials) => {
    const current = findLeaf(wsRef.current.root, paneId)?.session;
    if (!current) return;
    const credentials = {
      ...(creds?.username !== undefined ? { username: creds.username } : {}),
      ...(creds?.password !== undefined ? { password: creds.password } : {}),
    };

    setWs((prev) => ({
      ...prev,
      root: updateLeaf(prev.root, paneId, (leaf) => {
        return {
          ...leaf,
          session: { ...leaf.session, ...credentials },
          status: "connecting",
          statusMessage: undefined,
          reconnectCount: leaf.reconnectCount + 1,
        };
      }),
    }));

    if (creds?.remember && sessionsRef.current.some((session) => session.id === current.id)) {
      persistSessions(sessionsRef.current.map((session) => session.id === current.id ? { ...session, ...credentials } : session));
    }
  }, []);

  // Route keyboard or QuickBar input respecting Sync Input broadcast settings
  const dispatchTerminalInput = useCallback((sourcePaneId: string, data: string) => {
    const root = wsRef.current.root;
    const scope = syncScopeRef.current;
    const targets = syncTargets({
      scope,
      pausedAll: syncPausedRef.current,
      pausedPanes: syncPausedPanesRef.current,
      channels: syncChannelsRef.current,
      allPanes: scope === "off" ? [] : allLeaves(root).map((l) => l.paneId),
      visiblePanes: scope === "visible" ? allGroups(root).map((g) => activeLeafOf(g)!.paneId) : [],
      sourcePaneId,
    });
    if (targets.length <= 1) void backend.writeTerminal(sourcePaneId, data);
    else void backend.broadcastTerminal(targets, data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeGroup = useMemo(
    () =>
      (ws.activeGroupId ? findGroup(ws.root, ws.activeGroupId) : undefined) ??
      allGroups(ws.root)[0],
    [ws]
  );

  const activeLeaf = useMemo(() => activeLeafOf(activeGroup) ?? null, [activeGroup]);

  const persistSessions = (next: SessionConfig[]) => {
    setSessions(next);
    void backend.saveSessions(next).then(() => backend.emitSessionsChanged());
  };

  // Connected SSH tabs in this window, for the port forwarding panel.
  const forwardTargets: ForwardTarget[] = allLeaves(ws.root)
    .filter((l) => l.session.protocol === "ssh" && l.status === "connected")
    .map((l) => ({
      paneId: l.paneId,
      title: tabTitle(l),
      summary: sessionTargetSummary(l.session),
      sessionId: l.session.id,
      saved: sessions.find((s) => s.id === l.session.id)?.tunnels ?? [],
    }));

  // SSH tabs in this window, for the file browser (offline ones stay listed while selected).
  const sftpTargets: SftpTarget[] = useMemo(
    () =>
      allLeaves(ws.root)
        .filter((l) => l.session.protocol === "ssh")
        .map((l) => ({ paneId: l.paneId, title: tabTitle(l), connected: l.status === "connected", hostKey: hostKeyOf(l.session) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ws.root]
  );
  const tmuxTargets: TmuxTarget[] = useMemo(
    () =>
      allLeaves(ws.root).flatMap((l) =>
        (l.session.protocol === "ssh" || l.session.protocol === "wsl") && l.status === "connected"
          ? [{ paneId: l.paneId, title: tabTitle(l), protocol: l.session.protocol }]
          : []
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ws.root]
  );
  const openFileBrowser = useCallback((paneId: string | null) => {
    setFilesPaneId(paneId);
    setFilesOpen(true);
  }, []);
  const editLocalPreview = (req: PreviewRequest) =>
    void backend.sftpEditStart(req.instanceId, req.path, sftpOf(settingsRef.current).editor).catch((e) => setToast(String(e)));
  const downloadPreview = async (req: PreviewRequest) => {
    const s = sftpOf(settingsRef.current);
    const dir = s.downloadDir || (await downloadDirPath().catch(() => ""));
    if (!dir) return;
    await backend.transferEnqueue([
      {
        instanceId: req.instanceId,
        direction: "download",
        localPath: `${dir.replace(/[\\/]+$/, "")}\\${req.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")}`,
        remotePath: req.path,
        options: { conflict: s.conflict, preserveTimes: s.preserveTimes, protocol: s.protocol },
      },
    ]);
    setToast(t("sftp.queued", { name: req.name }));
  };

  const saveTunnelRule = (sessionId: string, rule: TunnelConfig) => {
    const target = sessions.find((s) => s.id === sessionId);
    if (!target) {
      setToast(t("forward.notSaved"));
      return;
    }
    persistSessions(sessions.map((s) => (s.id === sessionId ? { ...s, tunnels: [...(s.tunnels ?? []), rule] } : s)));
    setToast(t("forward.savedToast", { name: target.label }));
  };

  // Sessions saved by another window (a tab window's sidebar or dialogs).
  useEffect(() => {
    const unSessions = backend.onSessionsChanged(() => {
      void backend.loadInitialState().then((snap) => setSessions(snap.sessions));
    });
    return () => void unSessions.then((fn) => fn());
  }, []);

  // ---------------------------------------------------------------- windows

  const keymap = useMemo(() => resolveKeymap(settings.keymap), [settings.keymap]);
  const keymapRef = useRef(keymap);
  keymapRef.current = keymap;
  const paneApis = useRef(new Map<string, PaneApi>());
  const [zoomedGroupId, setZoomedGroupId] = useState<string | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const isMainWindow = currentWindowLabel() === "main";
  const pluginVersion = usePluginPlatform().snapshot();
  useEffect(() => {
    if (!isMainWindow) return;
    plugins.onSession = session => {
      delete plugins.active.tab;
      plugins.emit();
      return openSessionInNewTab(session);
    };
    return () => {plugins.onSession = undefined;};
  }, [isMainWindow, openSessionInNewTab]);
  useEffect(() => {plugins.locked = locked;}, [locked]);

  // Where to store the configuration: asked on a first run or with "ask at every startup".
  const [storagePrompt, setStoragePrompt] = useState<StorageLocationInfo | null>(null);
  useEffect(() => {
    if (isMainWindow) void backend.storageLocationPrompt().then(setStoragePrompt);
  }, [isMainWindow]);

  // Window options: always on top + opacity.
  useEffect(() => {
    void backend.setAlwaysOnTop(Boolean(settings.alwaysOnTop));
  }, [settings.alwaysOnTop]);
  useEffect(() => {
    void backend.setWindowOpacity(settings.windowOpacity ?? 1);
  }, [settings.windowOpacity]);
  // Terminal background image (Settings > Theme).
  useEffect(() => {
    if (themeReady) applyTerminalBackground(settings.background);
  }, [settings.background, themeReady]);

  // Other windows saving settings (shortcuts, toolbar ...) apply here too.
  useEffect(() => {
    const un = backend.onSettingsChanged(() => {
      void backend.loadInitialState().then((snap) => setSettings(snap.settings));
    });
    return () => void un.then((f) => f());
  }, []);

  // An import or sync rewrote data files: reload what this window keeps in memory.
  useEffect(() => {
    const un = backend.onConfigApplied((categories) => {
      void backend.loadInitialState().then((snap) => {
        if (categories.includes("quickCommands")) setQuickCommands(snap.quickCommands);
        if (categories.includes("themes")) setCustomThemes(snap.customThemes);
        if (categories.includes("settings")) commandHistory.configure(historyOf(snap.settings));
      });
      if (categories.includes("senders")) {
        void backend.loadDataFile<SenderItem[]>("senders").then((list) => setSenders(Array.isArray(list) ? list : []));
      }
      if (categories.includes("plugins")) {
        void plugins.reload();
        void pluginStores.reload();
      }
      if (categories.includes("history")) {
        void commandHistory.reload();
        void backend.loadDataFile<string[]>("quick_connect_history").then((list) => setQuickHistory(Array.isArray(list) ? list : []));
      }
    });
    return () => void un.then((f) => f());
  }, []);

  // Automatic config sync (main window only): at startup, then every intervalMin minutes.
  const syncSettings = syncOf(settings);
  const syncKey = JSON.stringify(syncSettings);
  const syncLoaded = initialSnapshot !== null;
  useEffect(() => {
    if (!isMainWindow || !syncLoaded) return;
    const cfg = syncOf(settings);
    if (!cfg.autoSync || !syncReady(cfg)) return;
    let lastNote = "";
    const tick = () => {
      void backend
        .syncRun(cfg, "auto")
        .then((out) => {
          const note = out.result === "downloaded" || out.result === "conflict" ? `cfgSync.auto.${out.result}` : "";
          if (note && note !== lastNote) setToast(t(note));
          lastNote = note;
        })
        .catch((e) => {
          const key = syncErrorKey(e);
          // "busy": a sync from the settings dialog is running.
          if (String(e) === "busy") return;
          const note = t("cfgSync.auto.failed", { error: key ? t(key) : String(e) });
          if (note !== lastNote) setToast(note);
          lastNote = note;
        });
    };
    tick();
    const every = autoSyncInterval(cfg);
    const timer = every ? window.setInterval(tick, every) : 0;
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMainWindow, syncLoaded, syncKey]);

  const saveSettings = useCallback((next: AppSettings) => {
    setSettings(next);
    void backend.saveSettings(next).then(() => backend.emitSettingsChanged());
  }, []);

  // A zoomed group that disappeared (closed) un-zooms the layout.
  useEffect(() => {
    if (zoomedGroupId && !findGroup(ws.root, zoomedGroupId)) setZoomedGroupId(null);
  }, [ws.root, zoomedGroupId]);

  /** Snapshot a tab so another window can adopt it with its live connection. */
  const packPane = (paneId: string) => {
    const leaf = findLeaf(wsRef.current.root, paneId);
    if (!leaf) return null;
    return {
      leaf: { ...leaf, attached: true, restoreContent: serializePane(paneId) },
      logPath: logPaths[paneId] ?? null,
      syncChannel: syncChannels[paneId] ?? null,
    };
  };
  type PanePack = NonNullable<ReturnType<typeof packPane>>;

  /** Drop a tab from this window without closing its connection. */
  const detachPane = (paneId: string) => {
    terminalBus.clearPane(paneId);
    paneApis.current.delete(paneId);
    setWs((prev) => {
      const root = removeTab(prev.root, paneId);
      const groups = allGroups(root);
      const activeGroupId = groups.some((g) => g.id === prev.activeGroupId)
        ? prev.activeGroupId
        : groups[groups.length - 1]?.id ?? null;
      return { root, activeGroupId };
    });
  };

  // ------------------------------------------------ drag and drop between groups / windows

  useEffect(() => {
    const clear = () => setDropHint(null);
    document.addEventListener("dragend", clear);
    document.addEventListener("drop", clear);
    return () => {
      document.removeEventListener("dragend", clear);
      document.removeEventListener("drop", clear);
    };
  }, []);

  const [dropHint, setDropHint] = useState<DropHint | null>(null);
  /** Dragover fires on every mouse move: re-render only when the target zone moves. */
  const updateDropHint = (next: DropHint | null) =>
    setDropHint((prev) => (sameDropHint(prev, next) ? prev : next));
  const hintAt = (clientX: number, clientY: number, mode: "tab" | "window") =>
    dropZoneAt(
      document.querySelector<HTMLElement>("[data-drop-stage]"),
      wsRef.current.root,
      zoomedGroupId,
      clientX,
      clientY,
      mode,
      focusMode ? 0 : TABBAR_H
    );
  /** Same, for a point in physical screen px (from another window). */
  const hintAtScreen = async (x: number, y: number, mode: "tab" | "window") => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    const [pos, scale] = await Promise.all([win.innerPosition(), win.scaleFactor()]);
    return hintAt((x - pos.x) / scale, (y - pos.y) / scale, mode);
  };

  /** Adopt tabs from another window at a drop zone (default: the active group). */
  const adoptPanes = (packs: PanePack[], zone: DropZone | null) => {
    const leaves = packs.map((p) => p.leaf as TerminalLeafNode);
    if (!leaves.length) return;
    setWs((prev) => placeLeaves(prev.root, leaves, zone, prev.activeGroupId, { group: uid("group"), split: uid("split") }));
    for (const p of packs) {
      if (p.logPath) setLogPaths((m) => ({ ...m, [p.leaf.paneId]: p.logPath! }));
      if (p.syncChannel) setSyncChannels((m) => ({ ...m, [p.leaf.paneId]: p.syncChannel as SyncChannel }));
    }
  };

  /** Move one of this window's tabs to a drop zone of this window. */
  const moveTabToZone = (paneId: string, zone: DropZone) =>
    setWs((prev) => {
      const source = findGroupOfPane(prev.root, paneId);
      const leaf = findLeaf(prev.root, paneId);
      if (!source || !leaf) return prev;
      if (zone.groupId === source.id && (zone.side === "center" || source.tabs.length < 2)) return prev;
      const without = removeTab(prev.root, paneId);
      return placeLeaves(without, [leaf], zone, prev.activeGroupId, { group: uid("group"), split: uid("split") });
    });

  /** A tab dropped on the terminals of this window, from this or another window. */
  const handleTabDrop = (paneId: string, x: number, y: number) => {
    const hint = hintAt(x, y, "tab");
    setDropHint(null);
    if (!hint || !paneId) return;
    if (findLeaf(wsRef.current.root, paneId)) moveTabToZone(paneId, hint.zone);
    // Another window's tab: its owner sends it over.
    else void backend.broadcast("claim-pane", { paneId, to: currentWindowLabel(), zone: hint.zone });
  };

  /** A sidebar session dropped on the terminals: open it in that group, or split beside it. */
  const handleSessionDrop = (sessionId: string, x: number, y: number) => {
    const hint = hintAt(x, y, "tab");
    setDropHint(null);
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) return;
    const leaf = makeLeafFromSession(session);
    setWs((prev) =>
      placeLeaves(prev.root, [leaf], hint?.zone ?? null, prev.activeGroupId, { group: uid("group"), split: uid("split") })
    );
  };

  const moveTabToNewWindow = async (paneId: string, at?: { x: number; y: number }) => {
    const pack = packPane(paneId);
    if (!pack) return;
    const token = uid("xfer");
    await backend.stashPaneTransfer(token, pack);
    await backend.openTerminalWindow(token, tabTitle(pack.leaf), at);
    detachPane(paneId);
  };

  const moveTabToWindow = async (paneId: string, label: string, extra?: { zone?: DropZone | null; at?: { x: number; y: number } }) => {
    const pack = packPane(paneId);
    if (!pack) return;
    await backend.emitToWindow(label, "adopt-pane", { ...pack, ...extra });
    detachPane(paneId);
  };

  /** A tab dropped outside this window that no window took: the window under the cursor, else a new one. */
  const handleDragOutside = async (paneId: string) => {
    const at = await backend.cursorPosition();
    if (!at) return void moveTabToNewWindow(paneId);
    const target = (await backend.terminalWindowBounds([currentWindowLabel()])).find(
      (b) => at.x >= b.x && at.x < b.x + b.w && at.y >= b.y && at.y < b.y + b.h
    );
    if (target) await moveTabToWindow(paneId, target.label, { at });
    else await moveTabToNewWindow(paneId, at);
  };

  /** Hand every tab of this (secondary) window to another window, then close this one. */
  const closingRef = useRef(false);
  const handOverAll = async (label: string, zone: DropZone | null) => {
    const packs = allLeaves(wsRef.current.root)
      .map((l) => packPane(l.paneId))
      .filter((p): p is PanePack => Boolean(p));
    closingRef.current = true;
    await backend.emitToWindow(label, "adopt-panes", { packs, zone });
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().destroy();
  };

  // Window events go through a ref so the listeners (registered once) see fresh state.
  const winOps = useRef({ adoptPanes, packPane, detachPane, hintAtScreen, handOverAll });
  winOps.current = { adoptPanes, packPane, detachPane, hintAtScreen, handOverAll };

  useEffect(() => {
    const self = currentWindowLabel();
    type AdoptOne = PanePack & { zone?: DropZone | null; at?: { x: number; y: number } };
    const zoneOf = async (p: { zone?: DropZone | null; at?: { x: number; y: number } }) =>
      p.zone ?? (p.at ? (await winOps.current.hintAtScreen(p.at.x, p.at.y, "tab"))?.zone ?? null : null);
    const subs = [
      backend.onWindowEvent<AdoptOne>("adopt-pane", async (p) => winOps.current.adoptPanes([p], await zoneOf(p))),
      backend.onWindowEvent<{ packs: PanePack[]; zone?: DropZone | null }>("adopt-panes", (p) =>
        winOps.current.adoptPanes(p.packs, p.zone ?? null)
      ),
      // Another window got one of our tabs dropped on it.
      backend.onBroadcast<{ paneId: string; to: string; zone: DropZone }>("claim-pane", (p) => {
        if (p.to === self) return;
        const pack = winOps.current.packPane(p.paneId);
        if (!pack) return;
        void backend.emitToWindow(p.to, "adopt-pane", { ...pack, zone: p.zone });
        winOps.current.detachPane(p.paneId);
      }),
    ];
    // A secondary window dragged by its title bar over this one: preview, then dock.
    let hintSeq = 0;
    subs.push(
      backend.onWindowEvent<{ x: number; y: number } | null>("dock-hint", async (p) => {
        const seq = ++hintSeq;
        const hint = p ? await winOps.current.hintAtScreen(p.x, p.y, "window") : null;
        if (seq === hintSeq) updateDropHint(hint);
      }),
      backend.onWindowEvent<{ from: string; x: number; y: number }>("dock-drop", async (p) => {
        ++hintSeq;
        const hint = await winOps.current.hintAtScreen(p.x, p.y, "window");
        setDropHint(null);
        void backend.emitToWindow(p.from, "dock-result", { from: self, zone: hint?.zone ?? null });
      }),
      backend.onWindowEvent<{ from: string; zone: DropZone | null }>("dock-result", (p) => {
        if (p.zone) void winOps.current.handOverAll(p.from, p.zone);
      })
    );
    const m = window.location.hash.match(/transfer=([\w-]+)/);
    if (m) {
      void backend.takePaneTransfer<PanePack>(m[1]).then((pack) => pack && winOps.current.adoptPanes([pack], null));
    }
    return () => subs.forEach((s) => void s.then((f) => f()));
  }, []);

  // Secondary window dragged by its title bar: watch the cursor until the button is
  // released; over another window's tab bar or edge band it docks there.
  useEffect(() => {
    if (isMainWindow || !isTauriRuntime()) return;
    const self = currentWindowLabel();
    let timer = 0;
    let busy = false;
    let starting = false;
    let target: string | null = null;
    let bounds: { label: string; x: number; y: number; w: number; h: number }[] = [];
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        const [down, at] = await Promise.all([backend.mousePrimaryDown(), backend.cursorPosition()]);
        if (!at) return;
        const hit = bounds.find((b) => at.x >= b.x && at.x < b.x + b.w && at.y >= b.y && at.y < b.y + b.h)?.label ?? null;
        if (hit !== target && target) void backend.emitToWindow(target, "dock-hint", null);
        if (down) {
          target = hit;
          if (hit) void backend.emitToWindow(hit, "dock-hint", at);
          return;
        }
        window.clearInterval(timer);
        timer = 0;
        if (hit) void backend.emitToWindow(hit, "dock-drop", { from: self, ...at });
        target = null;
      } finally {
        busy = false;
      }
    };
    let un: (() => void) | undefined;
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
      getCurrentWindow()
        .onMoved(async () => {
          if (timer || starting || closingRef.current) return;
          starting = true;
          try {
            // Only a drag by the title bar docks (not a resize from the top / left border
            // or a programmatic move).
            const [down, at] = await Promise.all([backend.mousePrimaryDown(), backend.cursorPosition()]);
            if (!down || !at || !titleDragStartedRecently()) return;
            bounds = await backend.terminalWindowBounds([self]);
            if (!timer) timer = window.setInterval(() => void tick(), 50);
          } finally {
            starting = false;
          }
        })
        .then((f) => (un = f))
    );
    return () => {
      window.clearInterval(timer);
      un?.();
    };
  }, [isMainWindow]);

  // Closing a secondary window hands its tabs back to the main window (only the main
  // window hides to the tray). Without a main window they are closed.
  useEffect(() => {
    if (isMainWindow || !isTauriRuntime()) return;
    let un: (() => void) | undefined;
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
      getCurrentWindow()
        .onCloseRequested(async (event) => {
          const leaves = allLeaves(wsRef.current.root);
          if (closingRef.current || leaves.length === 0) return;
          event.preventDefault();
          if (await backend.showMainWindow()) {
            await winOps.current.handOverAll("main", null);
            return;
          }
          const locked = leaves.filter((l) => l.locked).length;
          if (locked > 0) {
            setToast(t("app.quitBlocked", { count: locked }));
            return;
          }
          for (const l of leaves) {
            void backend.disconnectTerminal(l.paneId);
            void backend.historyDrop(l.paneId);
          }
          closingRef.current = true;
          await getCurrentWindow().destroy();
        })
        .then((f) => (un = f))
    );
    return () => un?.();
  }, [isMainWindow]);

  // Close a secondary window once its last tab is gone (moved or closed).
  const hadTabs = useRef(false);
  useEffect(() => {
    if (ws.root) hadTabs.current = true;
    else if (hadTabs.current && !isMainWindow && isTauriRuntime() && !closingRef.current) {
      closingRef.current = true;
      void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().destroy());
    }
  }, [ws.root, isMainWindow]);

  /** Main-window features asked for from a secondary window open in the main window. */
  const inMainWindow = (action: string) => {
    void backend.showMainWindow();
    void backend.emitToWindow("main", "run-action", action);
  };
  useEffect(() => {
    if (!isMainWindow) return;
    const un = backend.onWindowEvent<string>("run-action", (id) => runActionRef.current(id));
    return () => void un.then((f) => f());
  }, [isMainWindow]);

  // ---------------------------------------------------------------- split ops

  const focusNeighbor = (side: Side) => {
    const ws0 = wsRef.current;
    const from = ws0.activeGroupId ?? allGroups(ws0.root)[0]?.id;
    if (!from) return;
    const to = neighborGroup(ws0.root, from, side);
    const leaf = to && activeLeafOf(findGroup(ws0.root, to));
    if (leaf) {
      activatePane(leaf.paneId);
      paneApis.current.get(leaf.paneId)?.focus();
    }
  };

  const growActive = (side: Side) =>
    setWs((prev) => (prev.activeGroupId ? { ...prev, root: resizeGroup(prev.root, prev.activeGroupId, side) } : prev));

  const swapWithNext = () =>
    setWs((prev) => {
      const groups = allGroups(prev.root);
      const i = groups.findIndex((g) => g.id === prev.activeGroupId);
      if (groups.length < 2 || i < 0) return prev;
      const j = (i + 1) % groups.length;
      return { root: swapGroups(prev.root, groups[i].id, groups[j].id), activeGroupId: groups[j].id };
    });

  const toggleZoom = (paneId?: string) => {
    const group = paneId ? findGroupOfPane(wsRef.current.root, paneId) : activeGroup;
    if (!group) return;
    setZoomedGroupId((z) => (z === group.id ? null : group.id));
  };

  const cycleTab = (dir: 1 | -1) => {
    const group = activeGroup;
    if (!group || group.tabs.length < 2) return;
    const i = group.tabs.findIndex((l) => l.paneId === group.activeTabId);
    const next = group.tabs[(i + dir + group.tabs.length) % group.tabs.length];
    activatePane(next.paneId);
    paneApis.current.get(next.paneId)?.focus();
  };

  const setTabColor = (paneId: string, color: string | null) =>
    setWs((prev) => ({ ...prev, root: updateLeaf(prev.root, paneId, (l) => ({ ...l, color })) }));

  // ---------------------------------------------------------------- tmux

  const openTmuxPanel = (paneId: string | null) => {
    setTmuxPaneId(paneId);
    setTmuxOpen(true);
  };
  /** A tmux line goes to that pane only (not to panes it is synced with). */
  const typeTmux = (paneId: string, line: string) => {
    void backend.writeTerminal(paneId, `${line}\r`);
    paneApis.current.get(paneId)?.focus();
  };
  const openTmuxInNewTab = (paneId: string, startupCommand: string) => {
    const leaf = allLeaves(wsRef.current.root).find((l) => l.paneId === paneId);
    if (!leaf) return;
    const group = findGroupOfPane(wsRef.current.root, paneId);
    openSessionInNewTab({ ...leaf.session, startupCommand }, group?.id);
  };

  // ---------------------------------------------------------------- shortcuts

  /** Download the offered update with progress, then restart into it once the user agrees. */
  const updatingRef = useRef(false);
  const installUpdate = async (info: UpdateInfo) => {
    if (updatingRef.current) return;
    updatingRef.current = true;
    const version = info.latest;
    setUpdateProgress({ version, progress: { received: 0, total: 0 } });
    const unlisten = await backend
      .onUpdateProgress((progress) => setUpdateProgress({ version, progress }))
      .catch(() => undefined);
    let error: string | null = null;
    try {
      await backend.downloadUpdate();
    } catch (e) {
      error = String(e);
    } finally {
      unlisten?.();
      setUpdateProgress(null);
      updatingRef.current = false;
    }
    if (error === "cancelled") return;
    if (error !== null) {
      const retry = await ask({
        title: t("update.downloadFailedTitle"),
        message: t("update.downloadFailed"),
        detail: error,
        okLabel: t("update.openPage"),
        cancelLabel: t("update.later"),
      });
      if (retry.ok) void backend.openExternal(info.url).catch((e) => setToast(String(e)));
      return;
    }
    const answer = await ask({
      title: t("update.readyTitle", { version: info.latest }),
      message: t("update.readyMessage"),
      icon: <Download size={16} />,
      okLabel: t("update.restartNow"),
      cancelLabel: t("update.later"),
    });
    if (!answer.ok) {
      setToast(t("update.readyLater"));
      return;
    }
    await backend.applyUpdate().catch((e) => setToast(t("update.installFailed", { error: String(e) })));
  };
  const installUpdateRef = useRef(installUpdate);
  installUpdateRef.current = installUpdate;

  /** Offer a newer release: install it (or open its download page), or (startup check only) skip this version. */
  const promptUpdate = async (info: UpdateInfo, offerSkip: boolean) => {
    const answer = await ask({
      title: t("update.title", { version: info.latest }),
      message: info.canInstall
        ? `${t("update.message", { current: info.current, latest: info.latest })} ${t("update.installHint")}`
        : t("update.message", { current: info.current, latest: info.latest }),
      icon: <Download size={16} />,
      wide: Boolean(info.notes.trim()),
      body: info.notes.trim() ? (
        <>
          <div className="release-notes-label">{t("update.notes")}</div>
          <ReleaseNotes notes={info.notes} lang={i18n.language} />
        </>
      ) : undefined,
      okLabel: info.canInstall ? t("update.install") : t("update.download"),
      cancelLabel: t("update.later"),
      checkboxLabel: offerSkip ? t("update.skip") : undefined,
    });
    if (answer.ok && info.canInstall) void installUpdate(info);
    else if (answer.ok) void backend.openExternal(info.url).catch((e) => setToast(String(e)));
    else if (answer.checked) saveSettings({ ...settingsRef.current, skippedUpdateVersion: info.latest });
  };
  const promptUpdateRef = useRef(promptUpdate);
  promptUpdateRef.current = promptUpdate;
  /** "Check for Updates" from the More menu / palette: always answers, even when up to date or offline. */
  const checkingUpdateRef = useRef(false);
  const checkUpdateNow = () => {
    if (checkingUpdateRef.current) return;
    if (!isTauriRuntime()) {
      setToast(t("update.failed", { error: "not in Tauri" }));
      return;
    }
    checkingUpdateRef.current = true;
    setToast(t("update.checking"));
    void backend
      .checkUpdate()
      .then((info) => {
        if (!info.available) {
          setToast(t("update.upToDate", { version: info.current }));
          return;
        }
        setToast(null);
        return promptUpdateRef.current(info, false);
      })
      .catch((e) => setToast(t("update.failed", { error: String(e) })))
      .finally(() => {
        checkingUpdateRef.current = false;
      });
  };

  const runAction = (id: string): boolean => {
    const leaf = activeLeafRef.current;
    const api = leaf ? paneApis.current.get(leaf.paneId) : undefined;
    switch (id) {
      case "view.commandPalette":
        setPaletteOpen((v) => !v);
        return true;
      case "view.toggleSidebar":
        if (!isMainWindow) return false;
        setSidebarOpen((v) => !v);
        return true;
      case "view.toggleQuickBar":
        toggleQuickBar();
        return true;
      case "view.quickCommands":
        setQuickManager({});
        return true;
      case "view.focusMode":
        toggleFocusMode();
        return true;
      case "view.sessionManager":
        openSessionManager();
        return true;
      case "view.portForward":
        setPortForwardOpen((v) => !v);
        return true;
      case "view.serverMonitor":
        setMonitorOpen((v) => !v);
        return true;
      case "view.settings":
        if (!isMainWindow) {
          inMainWindow(id);
          return true;
        }
        setSettingsTab("general");
        setSettingsModalOpen(true);
        return true;
      case "terminal.copy":
        api?.copy();
        return Boolean(api);
      case "terminal.paste":
        api?.paste();
        return Boolean(api);
      case "terminal.find":
        api?.find();
        return Boolean(api);
      case "terminal.selectAll":
        api?.selectAll();
        return Boolean(api);
      case "terminal.clear":
        api?.clear();
        return Boolean(api);
      case "terminal.syncPause":
        toggleSyncPause();
        return true;
      case "terminal.syncPausePane":
        if (leaf && syncBadgesRef.current[leaf.paneId]) toggleSyncPausePane(leaf.paneId);
        return Boolean(leaf);
      case "terminal.toggleLog":
        if (leaf) paneExtrasRef.current.onToggleLog(leaf);
        return Boolean(leaf);
      case "terminal.tmux":
        setTmuxPaneId(null);
        setTmuxOpen((v) => !v);
        return true;
      case "tab.newShell":
        openQuickShell("powershell");
        return true;
      case "tab.close":
        if (leaf) handleClosePane(leaf.paneId);
        return Boolean(leaf);
      case "tab.next":
        cycleTab(1);
        return true;
      case "tab.prev":
        cycleTab(-1);
        return true;
      case "tab.duplicate":
        if (leaf) paneExtrasRef.current.onDuplicateInNewTab(leaf);
        return Boolean(leaf);
      case "tab.reconnect":
        if (leaf) handleReconnectPane(leaf.paneId);
        return Boolean(leaf);
      case "tab.moveToNewWindow":
        if (leaf) void moveTabToNewWindow(leaf.paneId);
        return Boolean(leaf);
      case "split.right":
      case "split.down":
        if (leaf) handleSplitPane(leaf.paneId, id === "split.right" ? "horizontal" : "vertical");
        return Boolean(leaf);
      case "split.zoom":
        toggleZoom();
        return true;
      case "split.focusLeft":
        focusNeighbor("left");
        return true;
      case "split.focusRight":
        focusNeighbor("right");
        return true;
      case "split.focusUp":
        focusNeighbor("up");
        return true;
      case "split.focusDown":
        focusNeighbor("down");
        return true;
      case "split.growLeft":
        growActive("left");
        return true;
      case "split.growRight":
        growActive("right");
        return true;
      case "split.growUp":
        growActive("up");
        return true;
      case "split.growDown":
        growActive("down");
        return true;
      case "split.swapNext":
        swapWithNext();
        return true;
      case "split.equalize":
        setWs((prev) => ({ ...prev, root: equalizeSplits(prev.root) }));
        return true;
      case "window.alwaysOnTop":
        saveSettings({ ...settingsRef.current, alwaysOnTop: !settingsRef.current.alwaysOnTop });
        return true;
      case "tab.lock":
        if (leaf) toggleLock(leaf.paneId);
        return Boolean(leaf);
      case "terminal.notifyWhenDone":
        if (leaf) toggleCommandWatch(leaf.paneId);
        return Boolean(leaf);
      case "terminal.toggleTimestamp":
        api?.toggleTimestamps();
        return Boolean(api);
      case "terminal.reset":
        api?.reset();
        return Boolean(api);
      case "terminal.saveToFile":
        api?.saveToFile();
        return Boolean(api);
      case "terminal.foldAll":
        api?.foldAll();
        return Boolean(api);
      case "terminal.unfoldAll":
        api?.unfoldAll();
        return Boolean(api);
      case "terminal.pauseLog":
        if (leaf && logPaths[leaf.paneId]) paneExtrasRef.current.onPauseLog(leaf.paneId, !pausedLogs[leaf.paneId]);
        return Boolean(leaf);
      case "view.sender":
        setSenderPaneId(null);
        setSenderOpen((v) => !v);
        return true;
      case "view.history":
        setHistoryOpen((v) => !v);
        return true;
      case "view.files":
        setFilesPaneId(null);
        setFilesOpen((v) => !v);
        return true;
      case "window.lock":
        setLocked(true);
        return true;
      case "window.checkUpdate":
        if (!isMainWindow) inMainWindow(id);
        else checkUpdateNow();
        return true;
      default: {
        // Quick commands listed in the command palette.
        const quick = id.startsWith("quick:") ? quickCommandsRef.current.find((q) => `quick:${q.id}` === id) : undefined;
        if (quick) runQuickCommandRef.current(quick);
        return Boolean(quick);
      }
    }
  };
  const runActionRef = useRef(runAction);
  runActionRef.current = runAction;
  const activeLeafRef = useRef<TerminalLeafNode | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // Update check (main window only): once per start, a few seconds in. Offline stays silent.
  useEffect(() => {
    if (!isMainWindow || !syncLoaded || !isTauriRuntime()) return;
    if (!updateCheckEnabled(settingsRef.current)) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void backend
        .checkUpdate()
        .then((info) => {
          if (cancelled || !shouldPromptUpdate(info, settingsRef.current)) return;
          return promptUpdateRef.current(info, true);
        })
        .catch(() => undefined);
    }, UPDATE_CHECK_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMainWindow, syncLoaded]);

  // Plugin updates (main window only): ask every configured store once per start, after a startup
  // sync had its chance to bring in plugins and stores. Failures show on the store page, not here.
  useEffect(() => {
    if (!isMainWindow || !syncLoaded || !isTauriRuntime()) return;
    const timer = window.setTimeout(() => void pluginStores.checkForUpdates().catch(() => undefined), UPDATE_CHECK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [isMainWindow, syncLoaded]);

  const isAppShortcut = useCallback((ev: KeyboardEvent) => {
    const combo = comboFromEvent(ev);
    return Boolean(
      combo && (actionForCombo(keymapRef.current, combo) || quickCommandsRef.current.some((q) => q.shortcut === combo) || plugins.commands().some(command => command.shortcut === combo))
    );
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inXterm = Boolean(target?.closest?.(".xterm"));
      const inField = !inXterm && Boolean(target?.closest?.("input, textarea, select, [contenteditable]"));
      if (inField || locked) return;
      // Alt+1..9: tab N of the active group.
      if (e.altKey && !e.ctrlKey && !e.shiftKey && /^Digit[1-9]$/.test(e.code)) {
        const ws0 = wsRef.current;
        const group = (ws0.activeGroupId && findGroup(ws0.root, ws0.activeGroupId)) || allGroups(ws0.root)[0];
        const tab = group?.tabs[Number(e.code.slice(5)) - 1];
        if (tab) {
          e.preventDefault();
          activatePane(tab.paneId);
          paneApis.current.get(tab.paneId)?.focus();
        }
        return;
      }
      const combo = comboFromEvent(e);
      const action = combo && actionForCombo(keymapRef.current, combo);
      if (action && runActionRef.current(action)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // A quick command's own shortcut (app shortcuts win; the dialog refuses those combos).
      const quick = combo ? quickCommandsRef.current.find((q) => q.shortcut === combo) : undefined;
      if (quick) {
        e.preventDefault();
        e.stopPropagation();
        runQuickCommandRef.current(quick);
        return;
      }
      const pluginCommand = plugins.commands().find(command => command.shortcut === combo);
      if (pluginCommand) {e.preventDefault(); e.stopPropagation(); plugins.run(pluginCommand.pluginId, pluginCommand.id);}
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked]);

  // Forget sync / log state of panes that no longer exist.
  useEffect(() => {
    const alive = new Set(allLeaves(ws.root).map((l) => l.paneId));
    setSyncChannels((prev) => {
      const keys = Object.keys(prev).filter((id) => alive.has(id));
      if (keys.length === Object.keys(prev).length) return prev;
      return Object.fromEntries(keys.map((k) => [k, prev[k]]));
    });
    setSyncPausedPanes((prev) => {
      const keys = Object.keys(prev).filter((id) => alive.has(id));
      if (keys.length === Object.keys(prev).length) return prev;
      return Object.fromEntries(keys.map((k) => [k, prev[k]]));
    });
    setLogPaths((prev) => {
      const keys = Object.keys(prev).filter((id) => alive.has(id));
      if (keys.length === Object.keys(prev).length) return prev;
      return Object.fromEntries(keys.map((k) => [k, prev[k]]));
    });
  }, [ws.root]);

  const toggleSyncPause = useCallback(() => {
    if (syncScopeRef.current === "off") return;
    setSyncPaused((v) => !v);
  }, []);

  /** Pause / resume sync input of a single pane. */
  const toggleSyncPausePane = useCallback((paneId: string) => {
    if (syncScopeRef.current === "off") return;
    setSyncPausedPanes((prev) => {
      if (prev[paneId]) {
        const { [paneId]: _gone, ...rest } = prev;
        return rest;
      }
      return { ...prev, [paneId]: true };
    });
  }, []);

  const changeSyncScope = useCallback((scope: SyncInputScope) => {
    setSyncScope(scope);
    setSyncPaused(false);
    if (scope === "off") setSyncPausedPanes({});
  }, []);

  // Badge per pane whose typing is broadcast (shown even while paused, marked as paused).
  const syncBadges = useMemo(() => {
    const out: Record<string, string> = {};
    if (syncScope === "off") return out;
    if (syncScope === "channels") {
      for (const [paneId, ch] of Object.entries(syncChannels)) {
        out[paneId] = t("pane.syncChannel", { channel: ch });
      }
      return out;
    }
    const leaves =
      syncScope === "all"
        ? allLeaves(ws.root)
        : allGroups(ws.root).map((g) => activeLeafOf(g)!);
    if (leaves.length > 1) leaves.forEach((l) => (out[l.paneId] = t("pane.syncing")));
    return out;
  }, [syncScope, syncChannels, ws.root, t]);
  const syncBadgesRef = useRef(syncBadges);
  syncBadgesRef.current = syncBadges;

  /** Panes in the broadcast right now, offered in the toolbar sync menu to pause one by one. */
  const syncMembers = useMemo(
    () =>
      allLeaves(ws.root)
        .filter((l) => syncBadges[l.paneId])
        .map((l) => ({ paneId: l.paneId, label: tabTitle(l), badge: syncBadges[l.paneId], paused: Boolean(syncPausedPanes[l.paneId]) })),
    [ws.root, syncBadges, syncPausedPanes]
  );

  // ------------------------------------------------ background tab marks + AI agent status

  const [tabMarks, setTabMarks] = useState<Record<string, TabMark>>({});
  const [agentStates, setAgentStates] = useState<Record<string, AgentStatus>>({});
  const [winFocused, setWinFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const on = () => setWinFocused(true);
    const off = () => setWinFocused(false);
    window.addEventListener("focus", on);
    window.addEventListener("blur", off);
    return () => {
      window.removeEventListener("focus", on);
      window.removeEventListener("blur", off);
    };
  }, []);

  /** Open tabs per saved session, for the sidebar. */
  const sessionOpenState = useMemo(() => {
    const rank = { connected: 3, connecting: 2, error: 1, disconnected: 0 } as const;
    const out: Record<string, SessionOpenState> = {};
    for (const l of allLeaves(ws.root)) {
      const status = (l.status in rank ? l.status : "disconnected") as SessionOpenState["status"];
      const key = plugins.sessionKey(l.session.id);
      const cur = out[key];
      if (!cur) out[key] = { count: 1, status };
      else out[key] = { count: cur.count + 1, status: rank[status] > rank[cur.status] ? status : cur.status };
    }
    return out;
  }, [ws.root, pluginVersion]);

  useEffect(() => {plugins.pruneSessionOrigins(new Set(allLeaves(ws.root).map(leaf => leaf.session.id)));}, [ws.root]);

  const focusPluginSession = (key: string) => {
    const leaves = allLeaves(wsRef.current.root).filter(leaf => plugins.sessionKey(leaf.session.id) === key);
    const target = leaves.find(leaf => visibleRef.current.has(leaf.paneId)) ?? leaves[0];
    if (!target) return false;
    delete plugins.active.tab; plugins.emit();
    activatePane(target.paneId);
    requestAnimationFrame(() => paneApis.current.get(target.paneId)?.focus());
    return true;
  };

  /** Bring up a tab of the session: one already on screen, else the first one. */
  const focusSessionTab = (session: SessionConfig) => {
    const leaves = allLeaves(wsRef.current.root).filter((l) => l.session.id === session.id);
    const target = leaves.find((l) => visibleRef.current.has(l.paneId)) ?? leaves[0];
    if (!target) return void openSessionInNewTab(session);
    activatePane(target.paneId);
    requestAnimationFrame(() => paneApis.current.get(target.paneId)?.focus());
  };

  /** Panes shown right now (the active tab of every group). */
  const visiblePaneIds = useMemo(
    () => new Set(allGroups(ws.root).map((g) => g.activeTabId)),
    [ws.root]
  );
  const visibleRef = useRef(visiblePaneIds);
  visibleRef.current = visiblePaneIds;

  const flashTaskbar = () => {
    if (document.hasFocus() || !isTauriRuntime()) return;
    void import("@tauri-apps/api/window").then(({ getCurrentWindow, UserAttentionType }) =>
      getCurrentWindow().requestUserAttention(UserAttentionType.Informational).catch(() => undefined)
    );
  };

  const onTabMark = useCallback((paneId: string, mark: keyof TabMark) => {
    if (mark === "bell") flashTaskbar();
    if (visibleRef.current.has(paneId) && mark === "activity") return;
    setTabMarks((prev) => (prev[paneId]?.[mark] ? prev : { ...prev, [paneId]: { ...prev[paneId], [mark]: true } }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const agentStatesRef = useRef(agentStates);
  agentStatesRef.current = agentStates;
  const lastAlert = useRef<Record<string, { state: string; at: number }>>({});

  /** Agent finished / needs you / failed: flash the taskbar and, unless you are looking at it, notify. */
  const agentAlert = (paneId: string, status: AgentStatus) => {
    const last = lastAlert.current[paneId];
    if (last && last.state === status.state && Date.now() - last.at < 15000) return;
    lastAlert.current[paneId] = { state: status.state, at: Date.now() };
    flashTaskbar();
    if (settingsRef.current.agentNotify === false) return;
    if (document.hasFocus() && visibleRef.current.has(paneId)) return;
    const leaf = findLeaf(wsRef.current.root, paneId);
    const app = agentDisplayName(status.app);
    const kind = status.kind ? t(`agent.kind.${status.kind}`, status.kind) : "";
    void backend.showNotification(
      t(`agent.notify.${status.state}`, { app }),
      [leaf ? tabTitle(leaf) : "", kind].filter(Boolean).join(" · "),
      paneId
    );
  };

  const onAgentState = useCallback((paneId: string, status: AgentStatus | null) => {
    const old = agentStatesRef.current[paneId];
    if (status && (status.state === "blocked" || status.state === "done" || status.state === "error") && old?.state !== status.state) {
      agentAlert(paneId, status);
    }
    setAgentStates((prev) => {
      const old = prev[paneId];
      if (!status) {
        if (!old) return prev;
        const next = { ...prev };
        delete next[paneId];
        return next;
      }
      if (old && old.state === status.state && old.kind === status.kind && old.app === status.app && old.source === status.source) return prev;
      return { ...prev, [paneId]: status };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Panes handed to the MCP agent (all windows share the backend's registry). */
  const [aiControls, setAiControls] = useState<Record<string, AiControl>>({});
  useEffect(() => {
    let alive = true;
    void backend.mcpControls().then((list) => {
      if (alive) setAiControls(Object.fromEntries(list.map((c) => [c.instanceId, c])));
    });
    const un = backend.onMcpControl(({ instanceId, control }) =>
      setAiControls((prev) => {
        if (control) return { ...prev, [instanceId]: control };
        if (!prev[instanceId]) return prev;
        const next = { ...prev };
        delete next[instanceId];
        return next;
      })
    );
    return () => {
      alive = false;
      void un.then((f) => f());
    };
  }, []);
  const onAiControl = useCallback((leaf: TerminalLeafNode, mode: AiControlMode | null) => {
    void backend.mcpSetControl(leaf.paneId, mode, tabTitle(leaf)).catch((e) => setToast(String(e)));
    if (mode === "active" && !aiControlsRef.current[leaf.paneId]) {
      setToast(t("ai.handedOver", { name: tabTitle(leaf) }));
    } else if (mode === null) {
      setToast(t("ai.takenBack", { name: tabTitle(leaf) }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const aiControlsRef = useRef(aiControls);
  aiControlsRef.current = aiControls;

  /**
   * Agents asking to operate a pane (MCP request_control). Every window keeps all of them
   * and shows the ones for its own panes, so a pane moved to another window takes its
   * request along.
   */
  const [aiRequests, setAiRequests] = useState<AiControlRequest[]>([]);
  useEffect(() => {
    let alive = true;
    void backend.mcpPendingRequests().then((list) => {
      if (alive && list.length) setAiRequests((prev) => [...prev, ...list.filter((r) => !prev.some((p) => p.requestId === r.requestId))]);
    });
    const unReq = backend.onMcpControlRequest((req) => {
      setAiRequests((prev) => (prev.some((p) => p.requestId === req.requestId) ? prev : [...prev, req]));
      const leaf = findLeaf(wsRef.current.root, req.instanceId);
      if (!leaf) return;
      // Bring the pane forward so the user sees what the agent asks for.
      activatePane(req.instanceId);
      // A toast when nobody looks at the app comes from the backend (mcp.rs alert_user).
      flashTaskbar();
    });
    const unDone = backend.onMcpControlRequestDone((id) => setAiRequests((prev) => prev.filter((r) => r.requestId !== id)));
    return () => {
      alive = false;
      void unReq.then((f) => f());
      void unDone.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const answerAiRequest = (req: AiControlRequest, accept: boolean) => {
    const leaf = findLeaf(wsRef.current.root, req.instanceId);
    setAiRequests((prev) => prev.filter((r) => r.requestId !== req.requestId));
    void backend.mcpRespondRequest(req.requestId, accept, leaf ? tabTitle(leaf) : req.title).catch((e) => setToast(String(e)));
    if (accept) setToast(t("ai.requestAllowed", { client: req.client, name: leaf ? tabTitle(leaf) : req.title }));
  };
  const myAiRequests = aiRequests.filter((r) => findLeaf(ws.root, r.instanceId));

  /** Agents asking to open a session (MCP open_session): answered in the main window. */
  const [aiOpenRequests, setAiOpenRequests] = useState<AiOpenRequest[]>([]);
  useEffect(() => {
    if (currentWindowLabel() !== "main") return;
    const unReq = backend.onMcpOpenRequest((req) => {
      setAiOpenRequests((prev) => (prev.some((p) => p.requestId === req.requestId) ? prev : [...prev, req]));
      flashTaskbar();
    });
    const unDone = backend.onMcpOpenRequestDone((id) => setAiOpenRequests((prev) => prev.filter((r) => r.requestId !== id)));
    return () => {
      void unReq.then((f) => f());
      void unDone.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const answerAiOpen = (req: AiOpenRequest, accept: boolean) => {
    setAiOpenRequests((prev) => prev.filter((r) => r.requestId !== req.requestId));
    if (!accept) {
      void backend.mcpOpenRespond(req.requestId, { accept: false });
      return;
    }
    const session = req.sessionId
      ? sessionsRef.current.find((s) => s.id === req.sessionId) ?? null
      : req.target
        ? parseQuickConnectInput(req.target)
        : null;
    if (!session) {
      const error = req.sessionId ? t("ai.openMissing", { name: req.label }) : t("ai.openUnparsed", { target: req.target ?? "" });
      setToast(error);
      void backend.mcpOpenRespond(req.requestId, { accept: true, error });
      return;
    }
    const pane = openSessionInNewTab(session);
    // Same rule as the pane's own login prompt: no connection until the user types these.
    const needsLogin =
      session.protocol === "ssh" && (!session.username.trim() || (session.authType === "password" && !hasSavedPassword(session)));
    void backend.mcpOpenRespond(req.requestId, { accept: true, pane, needsLogin, title: session.label });
  };

  // A phone closes a tab (locked ones are skipped; the phone already asked).
  useEffect(() => {
    const un = backend.onRemoteClosePane((id) => {
      if (findLeaf(wsRef.current.root, id)) closePanes([id]);
    });
    return () => void un.then((f) => f());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The agent closes a pane it opened (the backend checked it may).
  useEffect(() => {
    const un = backend.onMcpClosePane((id) => {
      if (findLeaf(wsRef.current.root, id)) closePanes([id]);
    });
    return () => void un.then((f) => f());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const copyMcpCommand = useCallback((client: McpClient) => {
    void backend
      .mcpClientCommand(client)
      .then((cmd) => backend.writeClipboard(cmd))
      .then(() => setToast(t(client === "codex" ? "ai.codexCommandCopied" : client === "gemini" ? "ai.geminiCommandCopied" : "ai.mcpCommandCopied")))
      .catch((e) => setToast(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Host each pane's shell reported last (shown after the tab name). */
  const [hostnames, setHostnames] = useState<Record<string, string>>({});
  const onHostname = useCallback((paneId: string, host: string) => {
    setHostnames((prev) => (prev[paneId] === host ? prev : { ...prev, [paneId]: host }));
  }, []);
  /** Command running in each pane (make, colcon build ...), shown on the tab. */
  const [runningCommands, setRunningCommands] = useState<Record<string, RunningCommand>>({});
  const onRunningCommand = useCallback((paneId: string, cmd: RunningCommand | null) => {
    setRunningCommands((prev) => {
      if (cmd) return { ...prev, [paneId]: cmd };
      if (!prev[paneId]) return prev;
      const next = { ...prev };
      delete next[paneId];
      return next;
    });
  }, []);
  /** Panes whose login form is open, so phones can show and answer it. */
  const [authPrompts, setAuthPrompts] = useState<Record<string, RemoteAuth>>({});
  const onAuthPrompt = useCallback((paneId: string, auth: RemoteAuth | null) => {
    setAuthPrompts((prev) => {
      if (auth) return { ...prev, [paneId]: auth };
      if (!prev[paneId]) return prev;
      const next = { ...prev };
      delete next[paneId];
      return next;
    });
  }, []);

  // Remote access lists every window's tabs; each window reports its own.
  const remoteTabsJson = JSON.stringify(
    allGroups(ws.root).flatMap((g) =>
      g.tabs.map((l) => ({
        id: l.paneId,
        title: tabTitle(l),
        status: l.status,
        cols: l.cols,
        rows: l.rows,
        active: g.id === ws.activeGroupId && g.activeTabId === l.paneId,
        host: ((h, title) => (h && !titleShowsHost(title, h) ? h : ""))(hostnames[l.paneId], tabTitle(l)),
        command: runningCommands[l.paneId]?.command ?? "",
        agent: agentStates[l.paneId]
          ? `${agentDisplayName(agentStates[l.paneId].app)}: ${t(`agent.state.${agentStates[l.paneId].state}`)}`
          : "",
        protocol: l.session.protocol,
        message: l.statusMessage ?? "",
        auth: authPrompts[l.paneId] ?? null,
        passwordAuth: l.session.protocol === "ssh" && l.session.authType === "password",
        locked: Boolean(l.locked),
      }))
    ) satisfies RemoteTab[]
  );
  useEffect(() => {
    const timer = window.setTimeout(() => void backend.remoteReportTabs(JSON.parse(remoteTabsJson)), 150);
    return () => window.clearTimeout(timer);
  }, [remoteTabsJson]);

  /** Pane / tab menu › install shell integration for the current user and load now. */
  const injectShellIntegration = (paneId: string) => {
    setToast(t("si.loading"));
    backend
      .injectShellIntegration(paneId)
      .then((outcome) => setToast(t(`si.${outcome}`)))
      .catch((e) => setToast(String(e)));
  };

  // Seeing a tab clears its marks; a finished agent you have looked at for a moment turns idle.
  useEffect(() => {
    setTabMarks((prev) => {
      const ids = Object.keys(prev).filter((id) => visiblePaneIds.has(id) && (winFocused || prev[id].activity));
      if (!ids.length) return prev;
      const next = { ...prev };
      ids.forEach((id) => delete next[id]);
      return next;
    });
    if (!winFocused) return;
    const seen = Object.entries(agentStates).filter(([id, s]) => s.state === "done" && visiblePaneIds.has(id));
    if (!seen.length) return;
    const timer = window.setTimeout(() => {
      setAgentStates((prev) => {
        const next = { ...prev };
        for (const [id] of seen) if (next[id]?.state === "done") next[id] = { ...next[id], state: "idle", since: Date.now() };
        return next;
      });
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [visiblePaneIds, winFocused, agentStates]);

  // Closed panes drop their marks.
  useEffect(() => {
    const live = new Set(allLeaves(ws.root).map((l) => l.paneId));
    const prune = <T,>(m: Record<string, T>) => {
      const dead = Object.keys(m).filter((id) => !live.has(id));
      if (!dead.length) return m;
      const next = { ...m };
      dead.forEach((id) => delete next[id]);
      return next;
    };
    setTabMarks(prune);
    setAgentStates(prune);
    setHostnames(prune);
    setRunningCommands(prune);
  }, [ws.root]);

  // ------------------------------------------------ one-shot "command finished" notification

  const [commandWatches, setCommandWatches] = useState<Record<string, { armedAt: number }>>({});
  const toggleCommandWatch = useCallback((paneId: string) => {
    setCommandWatches((prev) => {
      const next = { ...prev };
      if (next[paneId]) delete next[paneId];
      else next[paneId] = { armedAt: Date.now() };
      setToast(next[paneId] ? t("cmdNotify.armed") : t("cmdNotify.cancelled"));
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const onCommandDone = useCallback((paneId: string, info: CommandDone) => {
    setCommandWatches((prev) => {
      if (!prev[paneId]) return prev;
      const next = { ...prev };
      delete next[paneId];
      return next;
    });
    const leaf = findLeaf(wsRef.current.root, paneId);
    const failed = info.exitCode !== null && info.exitCode !== 0;
    flashTaskbar();
    if (!visibleRef.current.has(paneId) || !document.hasFocus()) onTabMark(paneId, "bell");
    void backend.showNotification(
      failed ? t("cmdNotify.failed", { code: info.exitCode }) : t("cmdNotify.done"),
      [leaf ? tabTitle(leaf) : "", info.command, t("cmdNotify.took", { d: formatDuration(info.durationMs) })].filter(Boolean).join(" · "),
      paneId
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Closed panes drop their watch.
  useEffect(() => {
    setCommandWatches((prev) => {
      const dead = Object.keys(prev).filter((id) => !findLeaf(ws.root, id));
      if (!dead.length) return prev;
      const next = { ...prev };
      dead.forEach((id) => delete next[id]);
      return next;
    });
  }, [ws.root]);

  // A click on a notification brings up the window and tab it was about.
  useEffect(() => {
    const un = backend.onNotificationClicked(async (tag) => {
      if (!findLeaf(wsRef.current.root, tag)) return;
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      await win.unminimize().catch(() => undefined);
      await win.show().catch(() => undefined);
      await win.setFocus().catch(() => undefined);
      activatePane(tag);
      paneApis.current.get(tag)?.focus();
    });
    return () => void un.then((f) => f());
  }, [activatePane]);

  // Local shells: hooks report through the app's local endpoint.
  useEffect(() => {
    const un = backend.onAgentStateEvent((p) => {
      if (!findLeaf(wsRef.current.root, p.paneId)) return;
      onAgentState(
        p.paneId,
        p.state === "clear" ? null : { state: p.state as AgentState, kind: p.kind || undefined, app: normalizeApp(p.app), source: "hook", since: Date.now() }
      );
    });
    return () => void un.then((f) => f());
  }, [onAgentState]);

  const { agentHookStatus, agentHooks } = useAgentHooks(setToast);

  /** X / Y / ZModem from the pane menu. */
  const modemTransfer = async (leaf: TerminalLeafNode, protocol: "xmodem" | "ymodem" | "zmodem", send: boolean) => {
    const m = modemOf(settingsRef.current);
    try {
      if (protocol === "zmodem") {
        // The remote rz starts the transfer; the ZModem dialog then asks for the files.
        dispatchTerminalInput(leaf.paneId, `${m.zmodemUploadCommand}\r`);
        return;
      }
      if (send) {
        const files =
          protocol === "xmodem"
            ? await backend.pickFile(t("modem.pickFile")).then((f) => (f ? [f] : []))
            : await backend.pickFiles(t("modem.pickFiles"));
        if (!files.length) return;
        const base = files[0].split(/[\\/]/).pop() ?? "";
        const quoted = /^[\w.@%+=:,-]+$/.test(base) ? base : `'${base.replace(/'/g, "'\\''")}'`;
        const command = (protocol === "xmodem" ? m.xmodemUploadCommand : m.ymodemUploadCommand).replace("%f", quoted);
        await backend.modemStart({
          instanceId: leaf.paneId,
          protocol,
          send: true,
          files,
          command,
          packetSize: protocol === "xmodem" ? m.xmodemPacket : m.ymodemPacket,
        });
        return;
      }
      // Receive: the user runs `sx file` / `sb files` on the remote.
      const dir = settingsRef.current.zmodemDownloadDir || null;
      let target: string | null = dir;
      if (protocol === "xmodem") {
        target = await backend.pickSavePath(t("modem.saveAs"), dir ? `${dir}\\received.bin` : "received.bin");
        if (!target) return;
      }
      await backend.modemStart({ instanceId: leaf.paneId, protocol, send: false, target });
      setToast(t(protocol === "xmodem" ? "modem.waitSx" : "modem.waitSb"));
    } catch (e) {
      setToast(String(e));
    }
  };

  const paneExtras: PaneExtras = {
    onPaneSettings: setSettingsPaneId,
    quickCommands,
    onQuickConnect: (target) => {
      const parsed = parseQuickConnectInput(target);
      if (parsed) openSessionInNewTab(parsed);
    },
    pausedLogs,
    onPauseLog: (paneId, paused) => {
      void backend
        .pauseSessionLog(paneId, paused)
        .then((state) => {
          setPausedLogs((prev) => ({ ...prev, [paneId]: state }));
          setToast(state ? t("app.logPaused") : t("app.logResumed"));
        })
        .catch((e) => setToast(String(e)));
    },
    onPasteRequest: (paneId, text, altScreen, paste) => {
      const st = settingsRef.current;
      const multi = /\r|\n/.test(text.replace(/(\r\n|\r|\n)$/, ""));
      const wanted = altScreen ? st.pasteConfirmAltScreen === true : st.pasteConfirm !== false;
      if (multi && wanted) {
        setPasteRequest({ text, paste });
        return;
      }
      void paneId;
      paste(text);
    },
    onClipboardRequest: async (paneId, kind, preview) => {
      const leaf = findLeaf(wsRef.current.root, paneId);
      const a = await ask({
        title: kind === "write" ? t("clip.writeTitle") : t("clip.readTitle"),
        message: t(kind === "write" ? "clip.writeMsg" : "clip.readMsg", { name: leaf ? tabTitle(leaf) : paneId }),
        detail: preview ? (preview.length > 400 ? `${preview.slice(0, 400)}…` : preview) : undefined,
        okLabel: t("clip.allowOnce"),
        extraLabel: t("clip.allowSession"),
        cancelLabel: t("clip.deny"),
      });
      return !a.ok ? "no" : a.extra ? "always" : "once";
    },
    onModemTransfer: (leaf, protocol, send) => void modemTransfer(leaf, protocol, send),
    onOpenFileBrowser: (paneId) => openFileBrowser(paneId),
    commandWatches,
    onToggleCommandWatch: toggleCommandWatch,
    onCommandDone,
    tabMarks,
    onTabMark,
    agentStates,
    onAgentState,
    aiControls,
    onAiControl,
    onCopyMcpCommand: copyMcpCommand,
    hostnames,
    onHostname,
    runningCommands,
    onRunningCommand,
    onAuthPrompt,
    onInjectShellIntegration: (paneId) => injectShellIntegration(paneId),
    onAgentHooks: (leaf, install) => void agentHooks(leaf, install),
    agentHookStatus: (leaf, fresh) => agentHookStatus(leaf, fresh),
    onToast: (message) => setToast(message),
    syncChannels,
    syncPaused,
    syncPausedPanes,
    syncScope,
    onCloseSync: (channel) => {
      if (!channel) {
        changeSyncScope("off");
        return;
      }
      const members = Object.keys(syncChannelsRef.current).filter((id) => syncChannelsRef.current[id] === channel);
      setSyncChannels((prev) => Object.fromEntries(Object.entries(prev).filter(([, ch]) => ch !== channel)));
      setSyncPausedPanes((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => !members.includes(id))));
    },
    logPaths,
    onSetSyncChannel: (paneId, channel) => {
      setSyncChannels((prev) => {
        const { [paneId]: _old, ...rest } = prev;
        return channel ? { ...rest, [paneId]: channel } : rest;
      });
      if (channel) {
        setSyncScope("channels");
        setSyncPaused(false);
      }
    },
    onToggleSyncPause: toggleSyncPause,
    onToggleSyncPausePane: toggleSyncPausePane,
    onToggleLog: (leaf) => {
      if (logPaths[leaf.paneId]) {
        void backend.stopSessionLog(leaf.paneId);
        setLogPaths((prev) => {
          const { [leaf.paneId]: _gone, ...rest } = prev;
          return rest;
        });
        setPausedLogs((prev) => {
          const { [leaf.paneId]: _p, ...rest } = prev;
          return rest;
        });
        setToast(t("app.logStopped"));
        return;
      }
      backend
        .startSessionLog(leaf.paneId, leaf.session.label, {
          host: leaf.session.host,
          username: leaf.session.username,
          protocol: leaf.session.protocol,
        })
        .then((path) => {
          setLogPaths((prev) => ({ ...prev, [leaf.paneId]: path }));
          setToast(t("app.logStarted", { path }));
        })
        .catch((err) => setToast(t("app.logFailed", { error: String(err) })));
    },
    onLogStarted: (paneId, path) => setLogPaths((prev) => ({ ...prev, [paneId]: path })),
    onRevealLog: (paneId) => void backend.revealLog(logPaths[paneId] ?? null),
    onDuplicateInNewTab: (leaf, reuse) => {
      const group = findGroupOfPane(wsRef.current.root, leaf.paneId);
      // Menu items pass reuse explicitly; the shortcut and tab mouse action follow the setting.
      const useSsh = reuse === undefined ? duplicateReusesSsh(settingsRef.current.reuseSshConnection, leaf) : reuse && canReuseSsh(leaf);
      openSessionInNewTab(leaf.session, group?.id, useSsh ? leaf.paneId : undefined);
    },
    onDisconnect: (paneId) => {
      if (findLeaf(wsRef.current.root, paneId)?.locked) {
        setToast(t("app.lockedNoDisconnect"));
        return;
      }
      void backend.disconnectTerminal(paneId);
    },
    onToggleLock: toggleLock,
    onAddHighlight: (paneId, pattern, options, color) => {
      if (!pattern) return;
      updateHighlights(paneId, (rules) => {
        const existing = rules.find(
          (r) => r.pattern === pattern && r.regex === options.regex && r.caseSensitive === options.caseSensitive && r.wholeWord === options.wholeWord
        );
        return existing
          ? rules.map((r) => (r === existing ? { ...r, color, enabled: true } : r))
          : [...rules, newHighlightRule({ pattern, ...options, color })];
      });
      setToast(t("highlight.added", { pattern }));
    },
    onSetHighlight: (paneId, text, color) => {
      if (!text) return;
      const same = (r: HighlightRule) => !r.regex && r.pattern === text;
      updateHighlights(paneId, (rules) =>
        color === null
          ? rules.filter((r) => !same(r))
          : rules.some(same)
          ? rules.map((r) => (same(r) ? { ...r, color, enabled: true } : r))
          : [...rules, newHighlightRule({ pattern: text, caseSensitive: true, color })]
      );
    },
    onClearHighlights: (paneId) => {
      updateHighlights(paneId, () => []);
      setToast(t("highlight.cleared"));
    },
    onManageHighlights: (paneId) => setHighlightPane(paneId),
    onToggleZoom: (paneId) => toggleZoom(paneId),
    isZoomed: zoomedGroupId !== null,
    keymap,
    onTmux: (leaf) => openTmuxPanel(leaf.paneId),
    isAppShortcut,
    registerTerminal: (paneId, api) => {
      if (api) paneApis.current.set(paneId, api);
      else paneApis.current.delete(paneId);
    },
  };
  const paneExtrasRef = useRef(paneExtras);
  paneExtrasRef.current = paneExtras;
  activeLeafRef.current = activeLeaf;

  const groupActions: GroupActions = {
    onActivateGroup: (groupId) =>
      setWs((prev) => (prev.activeGroupId === groupId ? prev : { ...prev, activeGroupId: groupId })),
    onSelectTab: activatePane,
    onCloseTab: handleClosePane,
    onRenameTab: (paneId, title) =>
      setWs((prev) => ({
        ...prev,
        root: updateLeaf(prev.root, paneId, (l) => ({ ...l, title: title || undefined })),
      })),
    onDuplicateTab: (paneId, reuse) => {
      const leaf = findLeaf(ws.root, paneId);
      if (leaf) paneExtras.onDuplicateInNewTab(leaf, reuse);
    },
    onReconnectTab: (paneId) => handleReconnectPane(paneId),
    onInjectShellIntegration: (paneId) => injectShellIntegration(paneId),
    onCloseOtherTabs: (paneId) => {
      const group = findGroupOfPane(ws.root, paneId);
      if (group) void closePanesAsk(group.tabs.filter((l) => l.paneId !== paneId).map((l) => l.paneId));
      activatePane(paneId);
    },
    onCloseTabsToRight: (paneId) => {
      const group = findGroupOfPane(ws.root, paneId);
      if (!group) return;
      const idx = group.tabs.findIndex((l) => l.paneId === paneId);
      void closePanesAsk(group.tabs.slice(idx + 1).map((l) => l.paneId));
    },
    onSplitGroup: (groupId, direction) => {
      const leaf = activeLeafOf(findGroup(ws.root, groupId));
      if (leaf) openSessionInSplit(leaf.session, direction, groupId);
    },
    onMoveToNewGroup: moveTabToNewGroup,
    onSetTabColor: setTabColor,
    onToggleLock: toggleLock,
    onToggleCommandWatch: toggleCommandWatch,
    onMoveToNewWindow: (paneId) => void moveTabToNewWindow(paneId),
    moveToWindowTargets: () => backend.listTerminalWindows(),
    onMoveToWindow: (paneId, label) => void moveTabToWindow(paneId, label),
    onDragOutside: (paneId) => void handleDragOutside(paneId),
    onDropTab: (paneId, groupId, index) =>
      setWs((prev) => {
        const root = moveTab(prev.root, paneId, groupId, index);
        return root === prev.root ? prev : { root, activeGroupId: groupId };
      }),
    onNewTab: (groupId) => openQuickShell("powershell", groupId),
    newTabMenu: (groupId) => {
      const recent = recentSessionIds
        .slice(0, 6)
        .map((id) => sessions.find((s) => s.id === id))
        .filter((s): s is SessionConfig => Boolean(s));
      const shell = (p: ProtocolType, label: string, shortcut?: string): MenuItem => ({
        label,
        shortcut,
        icon: <ProtocolBadge protocol={p} size={13} />,
        onClick: () => openQuickShell(p, groupId),
      });
      return compactMenu([
        shell("powershell", t("palette.newShell.powershell"), keymap["tab.newShell"]),
        shell("cmd", t("palette.newShell.cmd")),
        shell("wsl", t("palette.newShell.wsl")),
        { type: "separator" },
        ...recent.map(
          (s): MenuItem => ({
            label: s.label,
            icon: <ProtocolBadge protocol={s.protocol} size={13} />,
            onClick: () => openSessionInNewTab(s, groupId),
          })
        ),
        { type: "separator" },
        { label: t("tabbar.newSession"), onClick: () => setSessionModalState({ open: true, editing: null }) },
        { label: t("actions.view.commandPalette"), shortcut: keymap["view.commandPalette"], onClick: () => setPaletteOpen(true) },
      ]);
    },
    sessionMenu: (groupId) => {
      // Same folders and order as the session sidebar.
      const toItems = (nodes: SessionTreeNode[]): MenuItem[] =>
        nodes.map((n) =>
          n.kind === "folder"
            ? { label: `${n.name} (${n.sessionCount})`, icon: <Folder size={13} />, children: toItems(n.children) }
            : {
                label: n.session.label,
                icon: <ProtocolBadge protocol={n.session.protocol} size={13} />,
                onClick: () => openSessionInNewTab(n.session, groupId),
              }
        );
      const items = toItems(buildSessionTree(sessions, "", settings.sessionSort ?? "default", sessionUsage));
      return [
        ...(items.length ? items : [{ label: t("tabbar.noSessions"), disabled: true }]),
        { type: "separator" },
        { label: t("tabbar.newSession"), onClick: () => setSessionModalState({ open: true, editing: null }) },
      ];
    },
  };

  const [managerOpen, setManagerOpen] = useState(false);
  const openSessionManager = () => setManagerOpen(true);
  const closePalette = useCallback((ran: boolean) => {
    setPaletteOpen(false);
    // Dismissed: typing goes back to the terminal it came from.
    const leaf = activeLeafRef.current;
    if (!ran && leaf) requestAnimationFrame(() => paneApis.current.get(leaf.paneId)?.focus());
  }, []);

  const handleSaveSessionModal = (
    saved: SessionConfig,
    connectNow: boolean
  ) => {
    const idx = sessions.findIndex((s) => s.id === saved.id);
    const next =
      idx >= 0
        ? sessions.map((s, i) => (i === idx ? saved : s))
        : [...sessions, saved];
    persistSessions(next);
    setSessionModalState({ open: false, editing: null });
    if (connectNow) {
      openSessionInNewTab(saved);
    }
  };

  const handleDuplicateSession = (session: SessionConfig) => {
    const copy: SessionConfig = {
      ...session,
      id: uid("sess"),
      label: `${session.label} (${t("sidebar.copySuffix")})`,
    };
    persistSessions([...sessions, copy]);
  };

  const handleDeleteSession = (session: SessionConfig) => {
    persistSessions(sessions.filter((s) => s.id !== session.id));
  };

  const handleQuickConnect = (raw: string, inSplit: boolean) => {
    const parsed = parseQuickConnectInput(raw);
    if (!parsed) return;
    rememberQuickConnect(raw);
    if (inSplit) {
      openSessionInSplit(parsed, "horizontal");
    } else {
      openSessionInNewTab(parsed);
    }
  };

  const handleImported = (res: ImportResult) => {
    if (res.sessions.length > 0) {
      setSessions((prev) => {
        const merged = [...prev];
        for (const incoming of res.sessions) {
          const idx = merged.findIndex((s) => s.id === incoming.id);
          if (idx >= 0) merged[idx] = incoming;
          else merged.push(incoming);
        }
        return merged;
      });
    }
    if (res.quickCommands?.length > 0) {
      setQuickCommands((prev) => {
        const merged = [...prev];
        for (const incoming of res.quickCommands) {
          const idx = merged.findIndex((q) => q.id === incoming.id);
          if (idx >= 0) merged[idx] = incoming;
          else merged.push(incoming);
        }
        return merged;
      });
    }
    if (res.themes.length > 0) {
      setCustomThemes((prev) => {
        const merged = [...prev];
        for (const incoming of res.themes) {
          const idx = merged.findIndex((t) => t.id === incoming.id);
          if (idx >= 0) merged[idx] = incoming;
          else merged.push(incoming);
        }
        return merged;
      });
      const firstTheme = res.themes[0];
      const nextSettings = { ...settings, themeId: firstTheme.id };
      setSettings(nextSettings);
      void backend.saveSettings(nextSettings);
    }
  };

  /** Run a quick command: send its text to the active terminal, or run its app action. */
  const runQuickCommand = (qc: QuickCommand) => {
    if (qc.kind === "action") {
      if (qc.action) runActionRef.current(qc.action);
      return;
    }
    const leaf = activeLeafRef.current;
    if (!leaf) {
      setToast(t("quickManager.noTerminal"));
      return;
    }
    dispatchTerminalInput(leaf.paneId, quickPayload(qc));
    paneApis.current.get(leaf.paneId)?.focus();
  };
  const runQuickCommandRef = useRef(runQuickCommand);
  runQuickCommandRef.current = runQuickCommand;

  const handleSidebarResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const initialW = sidebarWidth;

    const onMove = (ev: MouseEvent) => {
      const next = Math.min(480, Math.max(190, initialW + (ev.clientX - startX)));
      setSidebarWidth(next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const windowTitle = isMainWindow ? "Nexterm" : `${activeLeaf ? tabTitle(activeLeaf) + " - " : ""}Nexterm`;

  return (
    <ContextMenuProvider>
    <div className={`app-shell ${focusMode ? "focus-mode" : ""}`}>
      {isMainWindow && <PluginHost locked={locked} />}
      <TitleBar
        title={windowTitle}
        status={isMainWindow && !locked && <PluginBadges />}
        pinned={Boolean(settings.alwaysOnTop)}
        onTogglePin={() => saveSettings({ ...settingsRef.current, alwaysOnTop: !settingsRef.current.alwaysOnTop })}
      >
        {!focusMode && isMainWindow ? (
          <>
          <Toolbar
            sidebarOpen={sidebarOpen}
            quickBarOpen={quickBarOpen}
            focusMode={focusMode}
            syncScope={syncScope}
            syncPaused={syncPaused}
            onToggleSyncPause={toggleSyncPause}
            syncMembers={syncMembers}
            onToggleSyncPausePane={toggleSyncPausePane}
            hasActivePane={Boolean(activeLeaf)}
            onToggleSidebar={() => setSidebarOpen((v) => !v)}
            onToggleQuickBar={toggleQuickBar}
            onToggleFocusMode={toggleFocusMode}
            onChangeSyncScope={changeSyncScope}
            onNewSessionModal={() =>
              setSessionModalState({ open: true, editing: null })
            }
            onQuickConnect={handleQuickConnect}
            onSplitActive={(dir) => {
              if (activeLeaf) handleSplitPane(activeLeaf.paneId, dir);
            }}
            onReconnectActive={() => {
              if (activeLeaf) handleReconnectPane(activeLeaf.paneId);
            }}
            onDisconnectActive={() => {
              if (activeLeaf) paneExtras.onDisconnect(activeLeaf.paneId);
            }}
            onOpenSettings={() => {
              setSettingsTab("general");
              setSettingsModalOpen(true);
            }}
            onCheckUpdate={() => runAction("window.checkUpdate")}
            channelCount={Object.keys(syncChannels).length}
            hidden={settings.toolbarHidden ?? DEFAULT_TOOLBAR_HIDDEN}
            onOpenPalette={() => setPaletteOpen(true)}
            quickHistory={quickHistory}
            keymap={keymap}
            portForwardOpen={portForwardOpen}
            onTogglePortForward={() => setPortForwardOpen((v) => !v)}
            monitorOpen={monitorOpen}
            onToggleMonitor={() => setMonitorOpen((v) => !v)}
            senderOpen={senderOpen}
            onToggleSender={() => {
              setSenderPaneId(null);
              setSenderOpen((v) => !v);
            }}
            historyOpen={historyOpen}
            onToggleHistory={() => setHistoryOpen((v) => !v)}
            tmuxOpen={tmuxOpen}
            onToggleTmux={() => {
              setTmuxPaneId(null);
              setTmuxOpen((v) => !v);
            }}
            filesOpen={filesOpen}
            onToggleFiles={() => {
              setFilesPaneId(null);
              setFilesOpen((v) => !v);
            }}
            remoteEnabled={remoteOf(settings).enabled}
            remoteConfigured={Boolean(remoteOf(settings).relayUrl.trim())}
            onToggleRemote={() => {
              const r = remoteOf(settingsRef.current);
              if (!r.relayUrl.trim()) {
                setSettingsTab("remote");
                setSettingsModalOpen(true);
                return;
              }
              saveSettings({ ...settingsRef.current, remote: { ...r, enabled: !r.enabled } });
            }}
            onOpenRemoteSettings={() => {
              setSettingsTab("remote");
              setSettingsModalOpen(true);
            }}
            onCustomize={() => {
              setSettingsTab("toolbar");
              setSettingsModalOpen(true);
            }}
          />
          <PluginToolbar />
          </>
        ) : focusMode ? (
          <div className="titlebar-focus">
            <span className="titlebar-title">{windowTitle}</span>
            <button type="button" className="btn-ghost btn-sm" onClick={toggleFocusMode} title={keymap["view.focusMode"] ? `${t("toolbar.exitFocus")} (${keymap["view.focusMode"]})` : t("toolbar.exitFocus")}>
              <Minimize2 size={12} /> {t("toolbar.exitFocus")}
            </button>
          </div>
        ) : undefined}
      </TitleBar>

      <div className="main-body">
        {!focusMode && isMainWindow && <PluginActivity />}
        {!focusMode && sidebarOpen && isMainWindow && (
          <>
            <div style={{ width: `${sidebarWidth}px`, flexShrink: 0, display: "flex" }}>
              <SessionSidebar
                sessions={sessions}
                sortMode={settings.sessionSort ?? "default"}
                usage={sessionUsage}
                onChangeSort={(mode) => saveSettings({ ...settingsRef.current, sessionSort: mode })}
                selectedSessionId={selectedSessionId}
                onSelectSession={setSelectedSessionId}
                onOpenSession={(s) => openSessionInNewTab(s)}
                onFocusSession={focusSessionTab}
                onFocusPluginSession={focusPluginSession}
                openState={sessionOpenState}
                recentIds={recentSessionIds}
                quickHistory={quickHistory}
                onQuickConnect={(raw) => handleQuickConnect(raw, false)}
                onSaveQuickConnect={saveQuickConnect}
                onForgetQuickConnect={forgetQuickConnect}
                recentOpen={ui.sidebarRecentOpen}
                onToggleRecent={() => setSidebarRecentOpen((v) => !v)}
                onOpenInSplit={(s) => openSessionInSplit(s, "horizontal")}
                onCreateSession={() =>
                  setSessionModalState({ open: true, editing: null })
                }
                onEditSession={(s) =>
                  setSessionModalState({ open: true, editing: s })
                }
                onDuplicateSession={handleDuplicateSession}
                onDeleteSession={handleDeleteSession}
                onOpenImport={() => setImportModalOpen(true)}
                onOpenManager={openSessionManager}
              />
            </div>
            <div
              className="sidebar-resizer"
              onMouseDown={handleSidebarResizeStart}
            />
          </>
        )}

        {!focusMode && isMainWindow && <PluginViews location="sidebar" />}
        <main className="center-column">
          {isMainWindow && <PluginViews location="tab" />}
          <div className="plugin-terminal-workspace" hidden={isMainWindow && Boolean(plugins.active.tab)}>
          <SplitWorkspace
            root={ws.root}
            activeGroupId={activeGroup?.id ?? null}
            zoomedGroupId={zoomedGroupId}
            focusMode={focusMode}
            theme={activeTheme}
            settings={settings}
            extras={paneExtras}
            groupActions={groupActions}
            syncBadges={syncBadges}
            onActivatePane={activatePane}
            onUserInput={dispatchTerminalInput}
            onDimensionsChange={handleDimensionsChange}
            onSplitPane={handleSplitPane}
            onClosePane={handleClosePane}
            onReconnectPane={handleReconnectPane}
            onResizeSplit={(splitId, ratio) =>
              setWs((prev) => ({ ...prev, root: updateSplitRatio(prev.root, splitId, ratio) }))
            }
            onQuickShell={(proto) => openQuickShell(proto)}
            onOpenNewSessionModal={() =>
              setSessionModalState({ open: true, editing: null })
            }
            onOpenImportModal={() => setImportModalOpen(true)}
            dropHint={dropHint}
            onTabDragOver={(p) => updateDropHint(p ? hintAt(p.x, p.y, "tab") : null)}
            onTabDrop={handleTabDrop}
            onSessionDrop={handleSessionDrop}
            hideWelcome={!isMainWindow}
          />
          </div>
          {!focusMode && isMainWindow && <PluginViews location="panel" />}

          {!focusMode && quickBarOpen && (
            <QuickBar
              commands={quickCommands}
              hasActivePane={Boolean(activeLeaf)}
              bar={settings.quickBar ?? {}}
              onExecute={runQuickCommand}
              onManage={(target) => setQuickManager(target ?? {})}
            />
          )}
        </main>

        {monitorOpen && (
          <ServerMonitorPanel
            targets={forwardTargets}
            preferredPaneId={activeLeaf?.session.protocol === "ssh" && activeLeaf.status === "connected" ? activeLeaf.paneId : null}
            onClose={() => setMonitorOpen(false)}
          />
        )}
        {portForwardOpen && (
          <PortForwardPanel
            targets={forwardTargets}
            preferredPaneId={
              forwardPaneId && forwardTargets.some((x) => x.paneId === forwardPaneId)
                ? forwardPaneId
                : activeLeaf?.session.protocol === "ssh"
                ? activeLeaf.paneId
                : null
            }
            onClose={() => {
              setPortForwardOpen(false);
              setForwardPaneId(null);
            }}
            onSaveRule={saveTunnelRule}
          />
        )}
        {senderOpen && (
          <SenderPanel
            items={senders}
            targets={allLeaves(ws.root).map((l) => ({ paneId: l.paneId, title: tabTitle(l), visible: visiblePaneIds.has(l.paneId) }))}
            activePaneId={activeLeaf?.paneId ?? null}
            preferredPaneId={senderPaneId}
            onChange={(next) => {
              setSenders(next);
              void backend.saveDataFile("senders", next);
            }}
            onSend={(ids, text) => {
              if (ids.length === 1) void backend.writeTerminal(ids[0], text);
              else void backend.broadcastTerminal(ids, text);
            }}
            onClose={() => {
              setSenderOpen(false);
              setSenderPaneId(null);
            }}
          />
        )}
        {filesOpen && (
          <SftpPanel
            targets={sftpTargets}
            preferredPaneId={
              filesPaneId && sftpTargets.some((x) => x.paneId === filesPaneId)
                ? filesPaneId
                : activeLeaf?.session.protocol === "ssh"
                ? activeLeaf.paneId
                : null
            }
            settings={sftpOf(settings)}
            onSettings={(patch) => saveSettings({ ...settingsRef.current, sftp: { ...sftpOf(settingsRef.current), ...patch } })}
            ask={ask}
            onToast={setToast}
            onPreview={(req) =>
              setPreviews((list) => [...list.filter((x) => !(x.instanceId === req.instanceId && x.path === req.path)), req])
            }
            onTerminalInput={(paneId, text) => {
              void backend.writeTerminal(paneId, text);
              paneApis.current.get(paneId)?.focus();
            }}
            onClose={() => {
              setFilesOpen(false);
              setFilesPaneId(null);
            }}
          />
        )}
        {tmuxOpen && (
          <TmuxPanel
            targets={tmuxTargets}
            activePaneId={activeLeaf?.paneId ?? null}
            preferredPaneId={tmuxPaneId}
            onType={typeTmux}
            onOpenInNewTab={openTmuxInNewTab}
            onClose={() => {
              setTmuxOpen(false);
              setTmuxPaneId(null);
            }}
          />
        )}
        {historyOpen && (
          <HistoryPanel
            hasActivePane={Boolean(activeLeaf)}
            activeKey={activeLeaf ? historyKeyOf(activeLeaf.session) : null}
            activeLabel={activeLeaf ? tabTitle(activeLeaf) : ""}
            perSessionDefault={historyOf(settings).perSession}
            onInsert={(command, run) => {
              if (!activeLeaf) return;
              dispatchTerminalInput(activeLeaf.paneId, run ? `${command}\r` : command);
              paneApis.current.get(activeLeaf.paneId)?.focus();
            }}
            onClose={() => setHistoryOpen(false)}
          />
        )}
      </div>

      {settingsPane && (
        <PaneSessionModal
          key={settingsPane.paneId}
          leaf={settingsPane}
          isSaved={sessions.some((session) => session.id === settingsPane.session.id)}
          groups={Array.from(new Set(sessions.map((session) => session.group).filter(Boolean))).sort()}
          onClose={() => setSettingsPaneId(null)}
          onApply={async (edits, saveProfile, rememberPassword) => {
            if (saveProfile) {
              const next = savePaneProfile(sessionsRef.current, settingsPane.session, edits, rememberPassword);
              await backend.saveSessions(next);
              setSessions(next);
              void backend.emitSessionsChanged().catch((error) => setToast(String(error)));
            }
            setWs((prev) => ({ ...prev, root: updateLeaf(prev.root, settingsPane.paneId, (leaf) => applyPaneSessionEdits(leaf, edits)) }));
          }}
        />
      )}

      {sessionModalState.open && (
        <SessionModal
          initial={sessionModalState.editing}
          isNew={sessionModalState.isNew}
          groups={Array.from(new Set(sessions.map((x) => x.group).filter(Boolean))).sort()}
          onClose={() => setSessionModalState({ open: false, editing: null })}
          onSave={handleSaveSessionModal}
          onConnect={(session) => {
            setSessionModalState({ open: false, editing: null });
            openSessionInNewTab(session);
          }}
        />
      )}

      {importModalOpen && (
        <ImportModal
          onClose={() => setImportModalOpen(false)}
          onImported={handleImported}
        />
      )}

      {settingsModalOpen && (
        <SettingsModal
          settings={settings}
          themes={allThemes}
          customThemes={customThemes}
          onSaveThemes={async (list) => {
            setCustomThemes(list);
            await backend.saveCustomThemes(list);
          }}
          initialTab={settingsTab}
          sessions={sessions}
          onAgentHooksLocal={(install) => agentHooks(null, install)}
          localHookStatus={() => agentHookStatus(null)}
          onTestNotification={() => void backend.showNotification(t("agent.notify.done", { app: "Claude Code" }), t("agent.testNotifyBody"), "test")}
          onInstallUpdate={(info) => void installUpdateRef.current(info)}
          onClose={() => setSettingsModalOpen(false)}
          onSave={(next) => {
            saveSettings(next);
            setSettingsModalOpen(false);
          }}
          onConfigApplied={(categories) => {
            // The dialog's draft is stale now: close it rather than let Save write it back.
            if (categories.includes("settings")) {
              setSettingsModalOpen(false);
              setToast(t("cfgSync.settingsReloaded"));
            }
          }}
        />
      )}

      {locked && (
        <LockOverlay
          expectedPasscode={settings.lockPasscode}
          onUnlock={() => setLocked(false)}
        />
      )}

      {managerOpen && (
        <SessionManager
          sessions={sessions}
          onChange={persistSessions}
          onConnect={(list) => {
            setManagerOpen(false);
            list.forEach((s) => openSessionInNewTab(s));
          }}
          onClose={() => setManagerOpen(false)}
        />
      )}

      {quickManager && (
        <QuickCommandManager
          commands={quickCommands}
          bar={settings.quickBar ?? {}}
          keymap={keymap}
          target={quickManager}
          onImportWindTerm={() => backend.readWindTermQuickCommands().catch(() => null)}
          onClose={() => setQuickManager(null)}
          onSave={(next, bar) => {
            setQuickCommands(next);
            void backend.saveQuickCommands(next);
            saveSettings({ ...settingsRef.current, quickBar: bar });
            setQuickManager(null);
          }}
        />
      )}

      {paletteOpen && (
        <CommandPalette
          actions={[
            ...plugins.commands().map(command => ({id: `plugin:${command.pluginId}:${command.id}`, label: `${command.pluginName}: ${command.title}`, shortcut: command.shortcut})),
            ...quickCommands.map((q) => ({
              id: `quick:${q.id}`,
              label: `${t("quickbar.badge")}: ${q.label}`,
              shortcut: q.shortcut,
            })),
            ...ACTIONS.filter((a) => a.id !== "view.commandPalette").map((a) => ({
              id: a.id,
              label: t(`actions.${a.id}`),
              shortcut: keymap[a.id] || undefined,
            })),
          ]}
          sessions={sessions}
          recentSessionIds={recentSessionIds}
          tabs={allLeaves(ws.root).map(
            (l): PaletteTab => ({
              paneId: l.paneId,
              title: tabTitle(l),
              protocol: l.session.protocol,
              detail: sessionTargetSummary(l.session),
            })
          )}
          quickHistory={quickHistory}
          onRunAction={(id) => {
            if (id.startsWith("plugin:")) {const [, pluginId, command] = id.split(":"); plugins.run(pluginId, command);}
            else void runActionRef.current(id);
          }}
          onOpenSession={(s) => openSessionInNewTab(s)}
          onFocusTab={(paneId) => {
            activatePane(paneId);
            requestAnimationFrame(() => paneApis.current.get(paneId)?.focus());
          }}
          onOpenShell={(p) => openQuickShell(p)}
          onQuickConnect={(raw) => handleQuickConnect(raw, false)}
          onClose={closePalette}
        />
      )}

      {previews.length > 0 && (
        <FilePreview
          requests={previews}
          onClose={() => setPreviews([])}
          onCloseOne={(path, instanceId) => setPreviews((list) => list.filter((x) => !(x.path === path && x.instanceId === instanceId)))}
          onDownload={(req) => void downloadPreview(req).catch((e) => setToast(String(e)))}
          onEdit={editLocalPreview}
        />
      )}

      {toast && <div className="app-toast">{toast}</div>}
      {updateProgress && (
        <UpdateProgressCard
          version={updateProgress.version}
          progress={updateProgress.progress}
          onCancel={() => void backend.cancelUpdate()}
        />
      )}
      {isMainWindow && !settingsModalOpen && <PluginUpdateNotice onOpen={() => { setSettingsTab("plugins"); setSettingsModalOpen(true); }} />}

      {shareDialogLeaf && <ShareDialog paneId={shareDialogLeaf.paneId} title={tabTitle(shareDialogLeaf)} />}

      {highlightLeaf && (
        <HighlightDialog
          title={tabTitle(highlightLeaf)}
          rules={highlightLeaf.highlightRules ?? []}
          onChange={(fn) => updateHighlights(highlightLeaf.paneId, fn)}
          onClose={() => setHighlightPane(null)}
        />
      )}

      {pasteRequest && (
        <PasteDialog
          text={pasteRequest.text}
          onCancel={() => setPasteRequest(null)}
          onPaste={(text) => {
            pasteRequest.paste(text);
            setPasteRequest(null);
          }}
          onDisable={() => {
            saveSettings({ ...settingsRef.current, pasteConfirm: false });
            pasteRequest.paste(pasteRequest.text);
            setPasteRequest(null);
            setToast(t("paste.disabledToast"));
          }}
        />
      )}
      {confirmQueue[0] && (
        <ConfirmDialog
          key={confirmQueue.length}
          request={confirmQueue[0].req}
          onAnswer={(a) => {
            confirmQueue[0].resolve(a);
            setConfirmQueue((q) => q.slice(1));
          }}
        />
      )}
      {storagePrompt && <StorageLocationPrompt info={storagePrompt} onClose={() => setStoragePrompt(null)} />}

      {myAiRequests.length > 0 &&
        (() => {
          const req = myAiRequests[0];
          const leaf = findLeaf(ws.root, req.instanceId);
          const name = leaf ? tabTitle(leaf) : req.title;
          return (
            <AiRequestDialog
              key={req.requestId}
              requestKey={req.requestId}
              title={req.resume ? t("ai.requestResumeTitle", { client: req.client }) : t("ai.requestTitle", { client: req.client })}
              message={t("ai.requestMessage", { client: req.client, name })}
              reason={req.reason}
              note={t("ai.requestNote")}
              allowLabel={t("ai.requestAllow")}
              more={myAiRequests.length - 1 + aiOpenRequests.length}
              onAnswer={(accept) => answerAiRequest(req, accept)}
            />
          );
        })()}
      {myAiRequests.length === 0 && aiOpenRequests.length > 0 && (
        <AiRequestDialog
          key={aiOpenRequests[0].requestId}
          requestKey={aiOpenRequests[0].requestId}
          title={t("ai.openTitle", { client: aiOpenRequests[0].client })}
          message={
            aiOpenRequests[0].sessionId
              ? t("ai.openSessionMessage", { client: aiOpenRequests[0].client, name: aiOpenRequests[0].label, summary: aiOpenRequests[0].summary })
              : t("ai.openTargetMessage", { client: aiOpenRequests[0].client, target: aiOpenRequests[0].label })
          }
          reason={aiOpenRequests[0].reason}
          note={t("ai.openNote")}
          allowLabel={t("ai.openAllow")}
          more={aiOpenRequests.length - 1}
          onAnswer={(accept) => answerAiOpen(aiOpenRequests[0], accept)}
        />
      )}

      <HostKeyDialog
        labelFor={(id) => (findLeaf(ws.root, id) ? tabTitle(findLeaf(ws.root, id)!) : id)}
        owns={(id) => Boolean(findLeaf(wsRef.current.root, id))}
      />
      <ZmodemDialog
        labelFor={(id) => (findLeaf(ws.root, id) ? tabTitle(findLeaf(ws.root, id)!) : id)}
        owns={(id) => Boolean(findLeaf(wsRef.current.root, id))}
        downloadDir={settings.zmodemDownloadDir ?? ""}
        onDownloadDirChange={(dir) => saveSettings({ ...settings, zmodemDownloadDir: dir })}
      />
      {zoomedGroupId && (
        <button type="button" className="zoom-indicator" onClick={() => setZoomedGroupId(null)}>
          {t("menu.unzoom")} ({keymap["split.zoom"] || "Alt+Z"})
        </button>
      )}
    </div>
    </ContextMenuProvider>
  );
};
