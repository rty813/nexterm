import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Terminal, type IMarker } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { SerializeAddon } from "@xterm/addon-serialize";
import { remoteMirror } from "../services/remoteMirror";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import {
  ChevronsDownUp,
  ChevronsUpDown,
  Columns2,
  KeyRound,
  RotateCw,
  Rows2,
  Search,
  Upload,
  X,
  Smartphone,
  Bot,
  Pause,
  Play,
  Square,
  LogOut,
} from "lucide-react";

import { buildXtermTheme } from "../constants/themes";
import { backend, isTauriRuntime, type RemoteAuth, type RemoteLoginPayload } from "../services/backend";
import { terminalBus } from "../services/terminalBus";
import { registerMcpScreen } from "../services/mcpScreen";
import {
  DEFAULT_TERMINAL_OPTIONS,
  type AiControl,
  type AiControlMode,
  type McpClient,
  type AppSettings,
  type SplitDirection,
  type SyncChannel,
  type SyncInputScope,
  type TerminalLeafNode,
  type TerminalOptions,
  type ThemeDefinition,
} from "../types/domain";
import { compactMenu, useContextMenu } from "./ContextMenu";
import { ProtocolBadge } from "./ProtocolBadge";
import { OutputHighlighter, resolveScheme } from "../utils/outputHighlighter";
import { TimestampGutter } from "../utils/timestampGutter";
import { installWideCursorFix } from "../utils/wideCursorFix";
import { installCompositionBounds } from "../utils/compositionBounds";
import { compileUserRules } from "../utils/outputHighlighter";
import { HIGHLIGHT_PRESETS, readRow } from "../utils/textMatch";
import { installRulerMarks } from "../utils/rulerMarks";
import { codexDetachedFromTerminal, detectFromScreen, needsQuietConfirm, parseOsc7501, SCREEN_DONE_QUIET_MS, type AgentStatus } from "../utils/agentStatus";
import { looksLikePrompt, osc133Exit, type CommandDone } from "../utils/commandWatch";
import { hostFromOsc7, hostFromPrompt, hostFromTitle } from "../utils/hostname";
import { cwdFromOsc7 } from "../utils/sftpPaths";
import { paneCwd } from "../utils/paneCwd";
import { canInjectShellIntegration, CommandTracker, type RunningCommand } from "../utils/runningCommand";
import { anyInstalled, posixHookCommand, type HookStatus } from "../utils/agentHooks";
import { TerminalSearch, type SearchOptionsState } from "./TerminalSearch";
import type { MenuItem } from "./ContextMenu";
import { installTerminalFeatures, type SuggestionState, type TerminalFeatures } from "../utils/terminalFeatures";
import { modemOf, mouseOf } from "../utils/settingsDefaults";
import { zmodemDrop } from "../utils/zmodemDrop";
import { historyKeyOf } from "../utils/commandHistory";
import { AutoCompletePopup } from "./AutoCompletePopup";
import type { QuickCommand } from "../types/domain";

/** Serializers of mounted terminals, used to carry scrollback when a tab moves to another window. */
const serializers = new Map<string, () => string>();
export function serializePane(paneId: string): string {
  return serializers.get(paneId)?.() ?? "";
}

export const TAB_COLORS = [
  "#e5484d", "#f76b15", "#ffc53d", "#46a758", "#12a594", "#0090ff", "#8e4ec6", "#d6409f", "#8d8d8d",
];

/** Apply per-session key options to what xterm.js produced before it goes to the host. */
function translateInput(data: string, o: TerminalOptions): string {
  let out = data;
  if (o.backspaceKey === "ctrl-h") out = out.replace(/\x7f/g, "\b");
  if (o.deleteKey === "del") out = out.replace(/\x1b\[3~/g, "\x7f");
  if (o.enterKey !== "cr" && out.includes("\r")) out = out.replace(/\r/g, o.enterKey === "crlf" ? "\r\n" : "\n");
  return out;
}
import { sessionTargetSummary } from "../utils/sessionSummary";

/** Workspace-level state and actions every pane needs (menus, logging, sync input). */
export interface PaneExtras {
  syncChannels: Record<string, SyncChannel>;
  syncPaused: boolean;
  /** Panes paused one by one (they neither send nor receive synced input). */
  syncPausedPanes: Record<string, boolean>;
  /** How typing is broadcast (the sync bar shows channel or whole-workspace sync). */
  syncScope: SyncInputScope;
  /** Sync bar "关闭": a channel removes every pane from it; without one, sync input turns off. */
  onCloseSync: (channel?: SyncChannel) => void;
  logPaths: Record<string, string>;
  onSetSyncChannel: (paneId: string, channel: SyncChannel | null) => void;
  onToggleSyncPause: () => void;
  onToggleSyncPausePane: (paneId: string) => void;
  onToggleLog: (leaf: TerminalLeafNode) => void;
  onLogStarted: (paneId: string, path: string) => void;
  onRevealLog: (paneId: string) => void;
  /** Duplicate shortcut. reuse: true = new channel on the live SSH connection, false = new connection, omitted = per settings. */
  onDuplicateInNewTab: (leaf: TerminalLeafNode, reuse?: boolean) => void;
  onDisconnect: (paneId: string) => void;
  /** Zoom (maximize) the pane's group inside the window. */
  onToggleZoom: (paneId: string) => void;
  isZoomed: boolean;
  /** Effective shortcuts, for menu hints. */
  keymap: Record<string, string>;
  /** Open the tmux sessions panel on this pane (SSH / WSL). */
  onTmux: (leaf: TerminalLeafNode) => void;
  /** True for key events bound to an app action; xterm then ignores them. */
  isAppShortcut: (ev: KeyboardEvent) => boolean;
  /** Add a permanent text highlight (from the selection or the search bar). */
  onAddHighlight: (pattern: string, options: SearchOptionsState, color: string) => void;
  /** Literal highlight of `text`: set its color, or remove it with null. */
  onSetHighlight: (text: string, color: string | null) => void;
  onClearHighlights: () => void;
  /** Open Settings on the Highlight tab. */
  onManageHighlights: () => void;
  /** Lock / unlock the session: a locked session cannot be closed or disconnected. */
  onToggleLock: (paneId: string) => void;
  /** Short message at the bottom of the window. */
  onToast: (message: string) => void;
  /** Register the pane's xterm for app-level shortcuts (copy / find / ...). */
  registerTerminal: (paneId: string, api: PaneApi | null) => void;
  /** Background-tab marks: new output, bell. */
  tabMarks: Record<string, TabMark>;
  onTabMark: (paneId: string, mark: keyof TabMark) => void;
  /** AI agent status per pane (Claude Code, Codex ...). */
  agentStates: Record<string, AgentStatus>;
  /** Panes handed to the MCP agent: it types, the user's keyboard is locked out. */
  aiControls: Record<string, AiControl>;
  /** Hand the pane to the agent ("active"), pause ("paused"), or take it back (null). */
  onAiControl: (leaf: TerminalLeafNode, mode: AiControlMode | null) => void;
  /** Copy the command that adds Nexterm to Claude Code as an MCP server. */
  onCopyMcpCommand: (client: McpClient) => void;
  onAgentState: (paneId: string, status: AgentStatus | null) => void;
  /** Host the shell reported (OSC 7, title, prompt), shown after the tab name. */
  hostnames: Record<string, string>;
  onHostname: (paneId: string, host: string) => void;
  /** Command running in the pane (make, colcon build ...), shown on the tab. */
  runningCommands: Record<string, RunningCommand>;
  onRunningCommand: (paneId: string, cmd: RunningCommand | null) => void;
  /** The pane's login form opened / closed (phones show it too). */
  onAuthPrompt: (paneId: string, auth: RemoteAuth | null) => void;
  /** Install shell integration for the pane's current user and load it now. */
  onInjectShellIntegration: (paneId: string) => void;
  /** Install (or remove) the agent status hooks on this SSH session's host. */
  onAgentHooks: (leaf: TerminalLeafNode, install: boolean) => void;
  /** Hook install status on the session's host (cached; fresh re-reads it). */
  agentHookStatus: (leaf: TerminalLeafNode, fresh?: boolean) => Promise<HookStatus | null>;
  /** Panes waiting to notify when their current (or next) command finishes. */
  commandWatches: Record<string, { armedAt: number }>;
  onToggleCommandWatch: (paneId: string) => void;
  onCommandDone: (paneId: string, info: CommandDone) => void;
  /** Paste into a pane, through the multi-line paste confirmation. */
  onPasteRequest: (paneId: string, text: string, altScreen: boolean, paste: (text: string) => void) => void;
  /** Ask whether the remote program may read / write the clipboard (OSC 52). */
  onClipboardRequest: (paneId: string, kind: "read" | "write", preview: string) => Promise<"no" | "once" | "always">;
  /** Logs paused with "Pause logging". */
  pausedLogs: Record<string, boolean>;
  onPauseLog: (paneId: string, paused: boolean) => void;
  /** X / Y / ZModem transfers started from the pane menu. */
  onModemTransfer: (leaf: TerminalLeafNode, protocol: "xmodem" | "ymodem" | "zmodem", send: boolean) => void;
  /** Open the SFTP file browser on this SSH pane (at its current directory when known). */
  onOpenFileBrowser: (paneId: string) => void;
  /** Quick commands, for auto completion. */
  quickCommands: QuickCommand[];
}

export interface TabMark {
  activity?: boolean;
  bell?: boolean;
}

/** Imperative handle used by the global shortcut dispatcher. */
export interface PaneApi {
  copy: () => void;
  paste: () => void;
  selectAll: () => void;
  clear: () => void;
  find: () => void;
  focus: () => void;
  toggleTimestamps: () => void;
  /** Hard reset (RIS): clears modes, charset, scroll region and the screen. */
  reset: () => void;
  /** Erase the scrollback only, keep the screen. */
  clearScrollback: () => void;
  /** Save the whole buffer as text. */
  saveToFile: () => void;
  /** Paste text (with the multi-line confirmation). */
  pasteText: (text: string) => void;
  foldAll: () => void;
  unfoldAll: () => void;
  /** Send as if typed (Sender, sync input). */
  sendText: (text: string) => void;
}

export interface ReconnectCredentials {
  username?: string;
  password?: string;
  remember?: boolean;
}

interface TerminalPaneProps {
  leaf: TerminalLeafNode;
  isActive: boolean;
  /** The pane's tab is the shown one of its group. */
  visible: boolean;
  showSplitChrome: boolean;
  theme: ThemeDefinition;
  settings: AppSettings;
  extras: PaneExtras;
  /** Set while input typed here is broadcast to other panes, e.g. "同步 A". */
  syncBadge: string | null;
  onActivate: (paneId: string) => void;
  onUserInput: (paneId: string, data: string) => void;
  onDimensionsChange: (paneId: string, cols: number, rows: number) => void;
  onSplit: (paneId: string, direction: SplitDirection) => void;
  onClosePane: (paneId: string) => void;
  onReconnectPane: (paneId: string, creds?: ReconnectCredentials) => void;
}

const CR_LF = String.fromCharCode(13) + String.fromCharCode(10);
const ESC = String.fromCharCode(27);

const TerminalPaneImpl: React.FC<TerminalPaneProps> = ({
  leaf,
  isActive,
  visible,
  showSplitChrome,
  theme,
  settings,
  extras: extrasProp,
  syncBadge,
  onActivate,
  onUserInput,
  onDimensionsChange,
  onSplit,
  onClosePane,
  onReconnectPane,
}) => {
  const { t } = useTranslation();
  const openMenu = useContextMenu();
  const extrasRef = useRef(extrasProp);
  extrasRef.current = extrasProp;
  // The pane skips re-renders that do not concern it (see paneSliceEqual), so handlers
  // built during an older render must still see the app's latest callbacks and state.
  const extras = useMemo(
    () => new Proxy({} as PaneExtras, { get: (_t, key) => extrasRef.current[key as keyof PaneExtras] }),
    []
  );
  // Background-tab activity: output while hidden, not right after hiding, a resize or input.
  // One-shot command-finished notification (utils/commandWatch.ts).
  const watchRef = useRef<{ phase: "waiting" | "running"; startedAt: number; command: string | null } | null>(null);
  const armedAt = extras.commandWatches[leaf.paneId]?.armedAt ?? null;
  useEffect(() => {
    const term = xtermRef.current;
    if (!armedAt || !term) {
      watchRef.current = null;
      return;
    }
    if (watchRef.current) return;
    // At a prompt: wait for the next command. Otherwise a command is running now.
    const idle = term.buffer.active.type === "normal" && looksLikePrompt(textBeforeCursor(term));
    watchRef.current = { phase: idle ? "waiting" : "running", startedAt: armedAt, command: null };
  }, [armedAt]);
  const visibleRef = useRef(visible);
  const quietUntil = useRef(0);
  useEffect(() => {
    visibleRef.current = visible;
    quietUntil.current = Date.now() + 1500;
  }, [visible]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const trackerRef = useRef<CommandTracker | null>(null);
  // A dropped / reconnected connection runs nothing.
  useEffect(() => {
    if (leaf.status !== "connected") trackerRef.current?.reset();
  }, [leaf.status]);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const onUserInputRef = useRef(onUserInput);
  onUserInputRef.current = onUserInput;
  const onDimensionsChangeRef = useRef(onDimensionsChange);
  const pushSizeRef = useRef<() => void>(() => undefined);
  onDimensionsChangeRef.current = onDimensionsChange;
  /** A phone took over this pane's size: rows / columns stop following the container. */
  const [phoneSize, setPhoneSize] = useState<{ cols: number; rows: number } | null>(null);
  const phoneSizeRef = useRef(phoneSize);
  phoneSizeRef.current = phoneSize;
  /** Fit to the container, or to the phone's size while it holds it. */
  const fitRef = useRef<() => void>(() => undefined);
  /** Last "colsxrows" sent to the connection. */
  const sentSizeRef = useRef("");

  const isSsh = leaf.session.protocol === "ssh";
  const needsUsername = isSsh && !leaf.session.username.trim();
  const usesPassword = isSsh && leaf.session.authType === "password";
  const needsInitialPassword =
    needsUsername || (usesPassword && !leaf.session.password);

  const [awaitingPassword, setAwaitingPassword] =
    useState<boolean>(needsInitialPassword);
  const [passwordInput, setPasswordInput] = useState<string>("");
  const [usernameInput, setUsernameInput] = useState<string>(leaf.session.username);
  const highlighterRef = useRef<OutputHighlighter | null>(null);
  const rulerMarksRef = useRef<ReturnType<typeof installRulerMarks> | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const timestampsRef = useRef<TimestampGutter | null>(null);
  const [showTimestamps, setShowTimestamps] = useState<boolean>(Boolean(settings.showTimestamps));
  const [rememberPwd, setRememberPwd] = useState<boolean>(true);
  const [searchOpen, setSearchOpen] = useState<boolean>(false);
  const [searchSeed, setSearchSeed] = useState<string>("");

  const isRemote =
    leaf.session.protocol === "ssh" || leaf.session.protocol === "tcp" || leaf.session.protocol === "telnet";
  const termOptions: TerminalOptions = { ...DEFAULT_TERMINAL_OPTIONS, ...(leaf.session.termOptions ?? {}) };
  const termOptionsRef = useRef(termOptions);
  termOptionsRef.current = termOptions;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [bellFlash, setBellFlash] = useState(false);
  const aiControl = extras.aiControls[leaf.paneId];
  const scheme = resolveScheme(leaf.session.system || undefined, leaf.session.protocol);
  const schemeRef = useRef(scheme);
  schemeRef.current = scheme;
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const featuresRef = useRef<TerminalFeatures | null>(null);
  const foldGutterRef = useRef<HTMLDivElement | null>(null);
  const [suggestions, setSuggestions] = useState<SuggestionState | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: settings.cursorBlink,
      cursorStyle: settings.cursorStyle,
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      scrollback: settings.scrollback,
      theme: buildXtermTheme(theme, isRemote),
      convertEol: false,
      // Overview ruler drawn over the (widened) scrollbar: search hits, highlights, selection.
      overviewRulerWidth: 14,
      macOptionIsMeta: termOptions.altIsMeta,
      altClickMovesCursor: true,
      rightClickSelectsWord: false,
      wordSeparator: settings.wordSeparators || " ()[]{}'\",;:<>|",
    });

    const fitAddon = new FitAddon();
    // Ctrl+click opens a link in the system browser (window.open does nothing in the app);
    // a plain click stays a click (selection, the program's own mouse handling).
    const openLink = (event: MouseEvent, uri: string) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      void backend.openExternal(uri).catch((err) => extrasRef.current.onToast(String(err)));
    };
    const webLinksAddon = new WebLinksAddon(openLink, {
      hover: (event) => (event.target as HTMLElement | null)?.setAttribute("title", t("pane.linkHint")),
      leave: (event) => (event.target as HTMLElement | null)?.removeAttribute("title"),
    });
    // OSC 8 hyperlinks (ls --hyperlink, gcc, systemd ...) open the same way.
    term.options.linkHandler = {
      activate: openLink,
      allowNonHttpProtocols: false,
    };
    const unicode11Addon = new Unicode11Addon();
    const serializeAddon = new SerializeAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.loadAddon(unicode11Addon);
    term.loadAddon(serializeAddon);
    const wideFix = installWideCursorFix(term);

    // Mouse wheel: a fixed number of lines per notch, like WindTerm. xterm.js would
    // convert the 100px Windows notch into ~6-7 rows. Apps that track the mouse
    // (vim, htop, tmux with mouse on) and the alternate screen keep xterm's handling.
    let wheelRemainder = 0;
    term.attachCustomWheelEventHandler((ev) => {
      const handled = featuresRef.current?.onWheel(ev);
      if (handled !== undefined) return handled;
      if (ev.ctrlKey || ev.deltaY === 0) return true;
      if (term.modes.mouseTrackingMode !== "none" || term.buffer.active.type !== "normal") return true;
      const perNotch = Math.max(1, settingsRef.current.wheelScrollLines ?? 3);
      // deltaMode 1 = lines (some mice), 0 = pixels (100 per notch on Windows; touchpads send less).
      const notches = ev.deltaMode === 1 ? ev.deltaY / 3 : ev.deltaY / 100;
      wheelRemainder += notches * perNotch * (ev.shiftKey ? term.rows / perNotch : 1);
      const lines = Math.trunc(wheelRemainder);
      if (lines !== 0) {
        wheelRemainder -= lines;
        term.scrollLines(lines);
      }
      ev.preventDefault();
      return false;
    });
    const rulerMarks = installRulerMarks(term, { accent: theme.accent, termBg: theme.termBg });
    rulerMarksRef.current = rulerMarks;
    serializers.set(leaf.paneId, () => serializeAddon.serialize({ scrollback: 5000 }));
    const unregisterScreen = registerMcpScreen(leaf.paneId, term, (command) => featuresRef.current?.recordCommand(command));
    const fit = () => {
      const held = phoneSizeRef.current;
      if (!held) fitAddon.fit();
      else if (term.cols !== held.cols || term.rows !== held.rows) term.resize(held.cols, held.rows);
    };
    fitRef.current = fit;
    term.unicode.activeVersion = "11";

    term.open(el);
    const compositionBounds = installCompositionBounds(term);
    // GPU renderer: several times faster than the DOM renderer on large output.
    // Falls back to the DOM renderer when WebGL2 is unavailable or the context is lost.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // DOM renderer
    }
    xtermRef.current = term;
    highlighterRef.current = new OutputHighlighter(term, theme, settings.syntaxHighlight !== false, scheme);
    if (gutterRef.current) {
      timestampsRef.current = new TimestampGutter(term, gutterRef.current, Boolean(settings.timestampMs));
    }
    if (leaf.restoreContent) term.write(leaf.restoreContent);

    // Tell the app and the remote about a new size only when rows / columns changed, and
    // only once a drag settles: every SIGWINCH makes full-screen programs redraw.
    let sizeTimer = 0;
    const pushSize = () => {
      const size = `${term.cols}x${term.rows}`;
      window.clearTimeout(sizeTimer);
      if (size === sentSizeRef.current) return;
      sizeTimer = window.setTimeout(() => {
        sentSizeRef.current = `${term.cols}x${term.rows}`;
        onDimensionsChangeRef.current(leaf.paneId, term.cols, term.rows);
        void backend.resizeTerminal(leaf.paneId, term.cols, term.rows);
      }, 80);
    };
    pushSizeRef.current = pushSize;

    /** Paste through the confirmation, then into the shell (bracketed paste kept). */
    const requestPaste = (text: string) =>
      extrasRef.current.onPasteRequest(leaf.paneId, text, term.buffer.active.type === "alternate", (ok) => {
        term.paste(ok);
        term.focus();
      });
    if (foldGutterRef.current) {
      featuresRef.current = installTerminalFeatures(term, el, serializeAddon, foldGutterRef.current, {
        paneId: leaf.paneId,
        settings: () => settingsRef.current,
        termOptions: () => termOptionsRef.current,
        scheme: () => schemeRef.current,
        sessionLabel: () => leaf.session.label,
        sessionKey: () => historyKeyOf(leaf.session),
        quickCommands: () => extrasRef.current.quickCommands,
        colors: () => ({ fg: themeRef.current.termFg, bg: themeRef.current.termBg }),
        sendInput: (data) => onUserInputRef.current(leaf.paneId, translateInput(data, termOptionsRef.current)),
        sendRaw: (data) => void backend.writeTerminal(leaf.paneId, data),
        requestPaste,
        openMenu: (ev) => containerRef.current?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: ev.clientX, clientY: ev.clientY })),
        refit: () => {
          try {
            fit();
            pushSize();
          } catch {
            // transient layout pass
          }
        },
        confirmClipboard: (kind, preview) => extrasRef.current.onClipboardRequest(leaf.paneId, kind, preview),
        onSuggestions: setSuggestions,
        fold: {
          exportStamps: () => timestampsRef.current?.exportStamps() ?? [],
          importStamps: (list, cursorLine) => timestampsRef.current?.importStamps(list, cursorLine),
          placeholder: (rows, command) => `\x1b[2m\x1b[7m ${t("fold.placeholder", { count: rows })} \x1b[27m ${command.slice(0, 60)}\x1b[22m`,
          tooltip: { fold: t("fold.foldTip"), unfold: t("fold.unfoldTip"), wrapped: t("fold.wrappedTip") },
        },
      });
    }

    const finishCommand = (exitCode: number | null) => {
      const w = watchRef.current;
      if (!w) return;
      watchRef.current = null;
      extrasRef.current.onCommandDone(leaf.paneId, { command: w.command, exitCode, durationMs: Date.now() - w.startedAt });
    };
    // Shell integration: OSC 133;C = command started, 133;D;<exit> = finished.
    // The command running now, for the tab (see utils/runningCommand.ts).
    const tracker = new CommandTracker((cmd) => extrasRef.current.onRunningCommand(leaf.paneId, cmd));
    trackerRef.current = tracker;
    let enterMarker: IMarker | undefined;
    let enterTimer = 0;
    /** The whole (wrapped) input line Enter was pressed on, once the shell redrew it. */
    const readEnterLine = () => {
      window.clearTimeout(enterTimer);
      const marker = enterMarker;
      enterMarker = undefined;
      if (!marker) return;
      const y0 = marker.line;
      marker.dispose();
      if (y0 < 0) return;
      const buf = term.buffer.active;
      let start = y0;
      while (start > 0 && buf.getLine(start)?.isWrapped) start--;
      let text = buf.getLine(start)?.translateToString(true) ?? "";
      for (let y = start + 1; buf.getLine(y)?.isWrapped; y++) text += buf.getLine(y)!.translateToString(true);
      tracker.onEnter(text);
    };
    const osc633Disp = term.parser.registerOscHandler(633, (data) => {
      if (data.startsWith("C")) readEnterLine();
      tracker.onShellMark(data, 633);
      return false;
    });
    const osc133Disp = term.parser.registerOscHandler(133, (data) => {
      // C comes in the same chunk as the newline: take the command line before it starts.
      if (data.startsWith("C")) readEnterLine();
      tracker.onShellMark(data);
      const w = watchRef.current;
      if (!w) return false;
      if (data.startsWith("C") && w.phase === "waiting") watchRef.current = { ...w, phase: "running", startedAt: Date.now() };
      else if (data.startsWith("D") && w.phase === "running") finishCommand(osc133Exit(data));
      return false;
    });
    let cmdTimer = 0;
    const checkCommandDone = () => {
      if (watchRef.current?.phase !== "running" || term.buffer.active.type !== "normal") return;
      if (looksLikePrompt(textBeforeCursor(term))) finishCommand(null);
    };

    // Agent hooks report their state as OSC 7501 (Herdr's format).
    let hookSeen = false;
    const oscDisp = term.parser.registerOscHandler(7501, (data) => {
      const p = parseOsc7501(data);
      if (!p) return true;
      hookSeen = true;
      extrasRef.current.onAgentState(
        leaf.paneId,
        p.state === "clear" ? null : { state: p.state, kind: p.kind, app: p.app, source: "hook", since: Date.now() }
      );
      return true;
    });
    // Throttled, not debounced: a spinner redraws all the time while the agent works, so a
    // debounce would only ever look at the screen after it stopped.
    let scanTimer = 0;
    let lastScan = 0;
    const queueScan = () => {
      if (scanTimer) return;
      scanTimer = window.setTimeout(() => {
        scanTimer = 0;
        lastScan = Date.now();
        scanScreen();
      }, Math.max(0, 400 - (Date.now() - lastScan)));
    };
    // "Done" from the screen waits for quiet output (see SCREEN_DONE_QUIET_MS); output cancels it.
    let doneTimer = 0;
    const scanScreen = (quietConfirmed = false) => {
      window.clearTimeout(doneTimer);
      doneTimer = 0;
      const buf = term.buffer.active;
      const lines: string[] = [];
      for (let y = Math.max(0, term.rows - 24); y < term.rows; y++) {
        lines.push(buf.getLine(buf.baseY + y)?.translateToString(true) ?? "");
      }
      const prev = extrasRef.current.agentStates[leaf.paneId];
      if (prev?.app === "codex" && codexDetachedFromTerminal(lines, textBeforeCursor(term), buf.type === "normal")) {
        hookSeen = false;
        extrasRef.current.onAgentState(leaf.paneId, null);
        return;
      }
      if (hookSeen || settingsRef.current.agentScreenDetect === false || prev?.source === "hook") return;
      const next = detectFromScreen(lines, prev);
      if (!quietConfirmed && needsQuietConfirm(next, prev)) {
        doneTimer = window.setTimeout(() => scanScreen(true), SCREEN_DONE_QUIET_MS);
        return;
      }
      if (next !== prev) extrasRef.current.onAgentState(leaf.paneId, next ?? null);
    };
    // Current host: OSC 7, the window title, or the prompt once output settles.
    const reportHost = (host: string | null) => host && extrasRef.current.onHostname(leaf.paneId, host);
    const osc7Disp = term.parser.registerOscHandler(7, (data) => {
      reportHost(hostFromOsc7(data));
      const cwd = cwdFromOsc7(data);
      if (cwd) paneCwd.set(leaf.paneId, cwd);
      return false;
    });
    const titleDisp = term.onTitleChange((title) => reportHost(hostFromTitle(title)));
    let hostTimer = 0;
    const scanPromptHost = () => {
      const alt = term.buffer.active.type !== "normal";
      const before = alt ? "" : textBeforeCursor(term);
      if (!alt) reportHost(hostFromPrompt(before));
      tracker.onQuiet(before, alt);
    };
    const parsedDisp = term.onWriteParsed(() => {
      if (!visibleRef.current && Date.now() > quietUntil.current && settingsRef.current.tabActivity !== false) {
        if (!extrasRef.current.tabMarks[leaf.paneId]?.activity) extrasRef.current.onTabMark(leaf.paneId, "activity");
      }
      window.clearTimeout(doneTimer);
      queueScan();
      window.clearTimeout(hostTimer);
      hostTimer = window.setTimeout(scanPromptHost, 300);
      // The shell moved past the Enter line: it is final (autosuggestions cleared).
      if (enterMarker && term.buffer.active.baseY + term.buffer.active.cursorY !== enterMarker.line) readEnterLine();
      // Watched command: done once output is quiet and a prompt is back.
      if (watchRef.current?.phase === "running") {
        window.clearTimeout(cmdTimer);
        cmdTimer = window.setTimeout(checkCommandDone, 1200);
      }
    });
    const resizeDisp = term.onResize(({ cols, rows }) => {
      quietUntil.current = Date.now() + 1500;
      remoteMirror.resized(leaf.paneId, cols, rows);
    });

    const bellDisp = term.onBell(() => {
      if (!visibleRef.current || !document.hasFocus()) extrasRef.current.onTabMark(leaf.paneId, "bell");
      const mode = termOptionsRef.current.bell;
      if (mode === "visual") {
        setBellFlash(true);
        window.setTimeout(() => setBellFlash(false), 180);
      } else if (mode === "sound") {
        playBeep();
      }
    });
    const selDisp = term.onSelectionChange(() => {
      if (settingsRef.current.copyOnSelect && term.hasSelection()) {
        void backend.writeClipboard(term.getSelection());
      }
    });
    extras.registerTerminal(leaf.paneId, {
      copy: () => term.hasSelection() && void backend.writeClipboard(term.getSelection()),
      paste: () => void backend.readClipboard().then((text) => text && requestPaste(text)),
      selectAll: () => term.selectAll(),
      clear: () => {
        term.clear();
        remoteMirror.refresh(leaf.paneId);
      },
      find: () => {
        setSearchSeed(term.hasSelection() && !term.getSelection().includes("\n") ? term.getSelection() : "");
        setSearchOpen(true);
      },
      focus: () => term.focus(),
      toggleTimestamps: () => setShowTimestamps((v) => !v),
      reset: () => {
        term.reset();
        remoteMirror.refresh(leaf.paneId);
        featuresRef.current?.tracker.reset();
        // Let the shell redraw its prompt.
        if (leaf.status === "connected") onUserInputRef.current(leaf.paneId, "\x0c");
      },
      clearScrollback: () => {
        term.clear();
        remoteMirror.refresh(leaf.paneId);
      },
      saveToFile: () => void saveBufferRef.current(),
      pasteText: requestPaste,
      foldAll: () => featuresRef.current?.folder.foldAll(),
      unfoldAll: () => featuresRef.current?.folder.unfoldAll(),
      sendText: (text) => onUserInputRef.current(leaf.paneId, text),
    });
    fitAddonRef.current = fitAddon;

    // App shortcuts (see utils/actions.ts) are handled by the window; keep them out of the shell.
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type === "keydown" && extrasRef.current.isAppShortcut(ev)) return false;
      // The AI agent holds the pane: say so instead of typing (the backend drops it anyway).
      if (extrasRef.current.aiControls[leaf.paneId]?.mode === "active") {
        const modifierOnly = ["Control", "Shift", "Alt", "Meta"].includes(ev.key);
        const copy = (ev.ctrlKey || ev.metaKey) && ["c", "C", "Insert"].includes(ev.key) && term.hasSelection();
        if (copy) return true;
        if (ev.type === "keydown" && !modifierOnly && Date.now() - aiHintAt > 3000) {
          aiHintAt = Date.now();
          extrasRef.current.onToast(t("ai.keyboardLocked"));
        }
        return false;
      }
      return featuresRef.current?.onKey(ev) ?? true;
    });

    let aiHintAt = 0;
    const inputDisp = term.onData((data) => {
      quietUntil.current = Math.max(quietUntil.current, Date.now() + 800);
      const w = watchRef.current;
      if (w?.phase === "waiting" && data.includes("\r")) {
        watchRef.current = { phase: "running", startedAt: Date.now(), command: commandFromLine(textBeforeCursor(term)) };
      }
      if (data.includes("\r") && !enterMarker && tracker.acceptsEnter(term.buffer.active.type !== "normal")) {
        enterMarker = term.registerMarker(0);
        if (enterMarker) enterTimer = window.setTimeout(readEnterLine, 500);
      }
      onUserInputRef.current(leaf.paneId, translateInput(data, termOptionsRef.current));
    });

    // Preview mode echo (no backend) still goes through the bus.
    const unsubStream = terminalBus.subscribe(leaf.paneId, (bytes) => {
      term.write(bytes);
    });
    // Ack once xterm has parsed a chunk, so the backend never runs far ahead of the screen.
    const output = backend.subscribeOutput(leaf.paneId, (bytes) => {
      remoteMirror.received(leaf.paneId, bytes);
      term.write(bytes, () => {
        output.ack(bytes.length);
        remoteMirror.parsed(leaf.paneId);
      });
    });
    const unmirror = remoteMirror.register(leaf.paneId, {
      serialize: () => serializeAddon.serialize({ scrollback: 1000 }),
      size: () => ({ cols: term.cols, rows: term.rows }),
      // A phone took / gave back the size. Applied right here, not after a render or the
      // debounce timer: both stall while this window is minimized, which is when phones are used.
      login: (p) => remoteLoginRef.current(p),
      setSizeOverride: (size) => {
        phoneSizeRef.current = size;
        setPhoneSize(size);
        try {
          fit();
        } catch {
          // transient layout pass
        }
        const now = `${term.cols}x${term.rows}`;
        if (now === sentSizeRef.current) return;
        window.clearTimeout(sizeTimer);
        sentSizeRef.current = now;
        onDimensionsChangeRef.current(leaf.paneId, term.cols, term.rows);
        void backend.resizeTerminal(leaf.paneId, term.cols, term.rows);
      },
    });

    let rafId = 0;
    const syncFit = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        if (!el.offsetWidth || !el.offsetHeight) return;
        try {
          fit();
          pushSize();
        } catch {
          // Ignore transient layout pass
        }
      });
    };

    const ro = new ResizeObserver(() => {
      syncFit();
    });
    ro.observe(el);
    syncFit();

    if (!isTauriRuntime()) {
      term.write(
        `${ESC}[38;2;102;217;239mNexterm${ESC}[0m (${leaf.session.label})${CR_LF}${t("pane.previewHint")}${CR_LF}${CR_LF}$ `
      );
    }

    return () => {
      cancelAnimationFrame(rafId);
      window.clearTimeout(sizeTimer);
      ro.disconnect();
      unregisterScreen();
      unsubStream();
      output.dispose();
      unmirror();
      inputDisp.dispose();
      bellDisp.dispose();
      oscDisp.dispose();
      osc133Disp.dispose();
      window.clearTimeout(cmdTimer);
      parsedDisp.dispose();
      resizeDisp.dispose();
      window.clearTimeout(scanTimer);
      window.clearTimeout(doneTimer);
      osc7Disp.dispose();
      titleDisp.dispose();
      window.clearTimeout(hostTimer);
      osc633Disp.dispose();
      window.clearTimeout(enterTimer);
      enterMarker?.dispose();
      tracker.dispose();
      if (trackerRef.current === tracker) trackerRef.current = null;
      compositionBounds.dispose();
      wideFix.dispose();
      rulerMarks.dispose();
      rulerMarksRef.current = null;
      selDisp.dispose();
      serializers.delete(leaf.paneId);
      extras.registerTerminal(leaf.paneId, null);
      highlighterRef.current?.dispose();
      highlighterRef.current = null;
      timestampsRef.current?.dispose();
      timestampsRef.current = null;
      featuresRef.current?.dispose();
      featuresRef.current = null;
      term.dispose();
      xtermRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaf.paneId]);

  useEffect(() => {
    timestampsRef.current?.setVisible(showTimestamps);
  }, [showTimestamps]);


  useEffect(() => {
    timestampsRef.current?.setWithMs(Boolean(settings.timestampMs));
  }, [settings.timestampMs]);

  const userRules = useMemo(() => compileUserRules(settings.highlightRules), [settings.highlightRules]);
  useEffect(() => {
    highlighterRef.current?.setUserRules(userRules);
  }, [userRules]);

  const attachedRef = useRef(Boolean(leaf.attached));
  useEffect(() => {
    if (awaitingPassword) {
      return;
    }
    const term = xtermRef.current;
    if (attachedRef.current && leaf.reconnectCount === 0) {
      // Tab moved here from another window: the connection is already running.
      attachedRef.current = false;
      if (term) void backend.resizeTerminal(leaf.paneId, term.cols, term.rows);
      return;
    }
    // Fit synchronously before connecting so the PTY is created with the real
    // viewport size instead of xterm's 80x24 default (the rAF fit runs later).
    const el = containerRef.current;
    if (term && el && el.offsetWidth && el.offsetHeight) {
      try {
        fitRef.current();
      } catch {
        // ignore transient layout pass
      }
    }
    const cols = term?.cols ?? 100;
    const rows = term?.rows ?? 30;
    if (leaf.reconnectCount > 0 && term) {
      const msg = t("pane.reconnectingBanner", { label: leaf.session.label });
      term.write(`${CR_LF}${ESC}[90m${msg}${ESC}[0m${CR_LF}`);
    }
    // Duplicated SSH tab: open a channel on the source pane's connection (first connect only).
    const reuse = leaf.reconnectCount === 0 ? leaf.reuseFrom ?? null : null;
    void backend
      .connectTerminal(leaf.paneId, leaf.session, cols, rows, reuse)
      .then((logPath) => {
        if (logPath) extras.onLogStarted(leaf.paneId, logPath);
        // Resizes sent while the backend was still spawning the session were
        // dropped (no registered entry yet); re-sync the current size now.
        const current = xtermRef.current;
        if (current && (current.cols !== cols || current.rows !== rows)) {
          void backend.resizeTerminal(leaf.paneId, current.cols, current.rows);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaf.paneId, leaf.reconnectCount, awaitingPassword]);

  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    term.options.theme = buildXtermTheme(theme, isRemote);
    term.options.fontFamily = settings.fontFamily;
    term.options.fontSize = settings.fontSize;
    term.options.cursorBlink = settings.cursorBlink;
    term.options.cursorStyle = settings.cursorStyle;
    term.options.scrollback = settings.scrollback;
    highlighterRef.current?.setTheme(theme);
    rulerMarksRef.current?.setColors({ accent: theme.accent, termBg: theme.termBg });
    highlighterRef.current?.setEnabled(settings.syntaxHighlight !== false);
    highlighterRef.current?.setScheme(scheme);
    term.options.macOptionIsMeta = termOptions.altIsMeta;
    term.options.wordSeparator = settings.wordSeparators || " ()[]{}'\",;:<>|";
    featuresRef.current?.update(settings.fontSize);
    try {
      fitRef.current();
      // A new font size changes rows / columns without resizing the container.
      pushSizeRef.current();
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, settings, isRemote, scheme, termOptions.altIsMeta]);

  useEffect(() => {
    if (isActive && !awaitingPassword && !searchOpen) {
      xtermRef.current?.focus();
    }
  }, [isActive, awaitingPassword, searchOpen]);

  const handlePasswordSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (needsUsername && !usernameInput.trim()) return;
    setAwaitingPassword(false);
    onReconnectPane(leaf.paneId, {
      username: usernameInput.trim() || undefined,
      password: usesPassword ? passwordInput : undefined,
      remember: rememberPwd,
    });
  };

  // Phones see the login form as part of the tab and can answer it (remote.rs `login`).
  useEffect(() => {
    const auth = awaitingPassword ? { user: needsUsername, password: usesPassword, username: leaf.session.username } : null;
    extrasRef.current.onAuthPrompt(leaf.paneId, auth);
  }, [awaitingPassword, needsUsername, usesPassword, leaf.session.username, leaf.paneId]);
  useEffect(() => () => extrasRef.current.onAuthPrompt(leaf.paneId, null), [leaf.paneId]);

  /** A phone answered the login form, or asked to reconnect a failed pane. */
  const remoteLogin = (p: RemoteLoginPayload) => {
    if (awaitingPassword) {
      const username = p.username?.trim() || usernameInput.trim();
      if (needsUsername && !username) return;
      setAwaitingPassword(false);
      setPasswordInput("");
      onReconnectPane(leaf.paneId, {
        username: username || undefined,
        password: usesPassword ? p.password ?? "" : undefined,
        remember: p.remember,
      });
    } else if (leaf.status === "disconnected" || leaf.status === "error") {
      const creds = usesPassword && p.password !== null ? { password: p.password, remember: p.remember } : undefined;
      onReconnectPane(leaf.paneId, creds);
    }
  };
  const remoteLoginRef = useRef(remoteLogin);
  remoteLoginRef.current = remoteLogin;


  const saveBuffer = async () => {
    const text = featuresRef.current?.plainText() ?? "";
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const name = `${leaf.session.label.replace(/[\\/:*?"<>|]/g, "_")}_${stamp}.txt`;
    const path = await backend.pickSavePath(t("maint.saveTitle"), name, [{ name: "Text", extensions: ["txt", "log"] }]);
    if (!path) return;
    try {
      await backend.writeTextFile(path, text);
      extras.onToast(t("maint.saved", { path }));
    } catch (err) {
      extras.onToast(String(err));
    }
  };

  const saveBufferRef = useRef(saveBuffer);
  saveBufferRef.current = saveBuffer;

  const targetSummary = sessionTargetSummary(leaf.session);
  const logPath = extras.logPaths[leaf.paneId];
  const channel = extras.syncChannels[leaf.paneId];
  const pausedOnItsOwn = Boolean(extras.syncPausedPanes[leaf.paneId]);
  const syncPausedHere = Boolean(syncBadge) && (extras.syncPaused || pausedOnItsOwn);
  const inChannel = extras.syncScope === "channels" && Boolean(channel);

  const showPaneMenu = async (e: React.MouseEvent) => {
    const term = xtermRef.current;
    if (!term) return;
    e.preventDefault();
    e.stopPropagation();
    onActivate(leaf.paneId);
    const features = featuresRef.current;
    // A program tracking right clicks gets them (Shift+right click still opens the menu).
    if (features?.appOwnsRightClick(e)) return;
    const right = mouseOf(settings).rightClick;
    // Synthetic events (middle click "menu") always show the menu.
    const fromMouse = e.nativeEvent.isTrusted && e.button === 2;
    if (fromMouse && !e.shiftKey && right !== "menu") {
      if (right === "none") return;
      const sel = term.hasSelection() ? term.getSelection() : "";
      if (right === "copyPaste" && sel) {
        void backend.writeClipboard(sel);
        term.clearSelection();
      } else {
        void backend.readClipboard().then(
          (text) => text && extras.onPasteRequest(leaf.paneId, text, term.buffer.active.type === "alternate", (ok) => term.paste(ok))
        );
      }
      return;
    }
    const clickRow = features?.rowAt(e.clientY) ?? null;
    const folder = features?.folder;
    const isFolded = clickRow !== null && Boolean(folder?.isFoldedAt(clickRow));
    const canFold = clickRow !== null && Boolean(folder?.canFoldAt(clickRow));
    const api = {
      reset: () => {
        term.reset();
        remoteMirror.refresh(leaf.paneId);
        features?.tracker.reset();
        if (leaf.status === "connected") onUserInputRef.current(leaf.paneId, "\x0c");
      },
    };
    const modemOk = leaf.status === "connected" && leaf.session.protocol !== "powershell" && leaf.session.protocol !== "cmd" && leaf.session.protocol !== "wsl" && leaf.session.protocol !== "custom";
    const k = extras.keymap;
    const shellStatus = await backend.shellIntegrationStatus(leaf.paneId).catch(() => null);
    const tmux = (leaf.session.protocol === "ssh" || leaf.session.protocol === "wsl") && leaf.status === "connected";
    // Hook status of this host (cached after the first look; waits briefly for it).
    const hooks = leaf.status === "connected" && (leaf.session.protocol === "ssh" || leaf.session.protocol === "wsl")
      ? await Promise.race([extras.agentHookStatus(leaf), new Promise<null>((r) => window.setTimeout(() => r(null), 1500))])
      : null;
    const hooksOn = anyInstalled(hooks);
    const hookLine = (app: string, st: HookStatus["claude"] | undefined) =>
      `${app}：${st ? t(`agent.hookState.${st}`) : t("agent.hookState.unknown")}`;
    const hasSelection = term.hasSelection();
    // Highlight target: the selection (one line), else the word under the mouse.
    const sel = hasSelection ? term.getSelection().trim() : "";
    const hlText = sel && !sel.includes("\n") ? sel : wordAt(term, e.clientX, e.clientY, settings.wordSeparators);
    const hlCurrent =
      (settings.highlightRules ?? []).find((r) => r.enabled && !r.regex && r.pattern === hlText)?.color ?? null;
    const connected = leaf.status === "connected" || leaf.status === "connecting";
    openMenu(
      e,
      compactMenu([
        {
          label: t("menu.copy"),
          shortcut: k["terminal.copy"],
          disabled: !hasSelection,
          onClick: () => void backend.writeClipboard(term.getSelection()),
        },
        {
          label: t("menu.paste"),
          shortcut: k["terminal.paste"],
          onClick: () =>
            void backend.readClipboard().then((text) => {
              if (text) extras.onPasteRequest(leaf.paneId, text, term.buffer.active.type === "alternate", (ok) => term.paste(ok));
              term.focus();
            }),
        },
        {
          label: t("menu.copyAndPaste"),
          disabled: !hasSelection,
          onClick: () => {
            const sel = term.getSelection();
            void backend.writeClipboard(sel);
            extras.onPasteRequest(leaf.paneId, sel, term.buffer.active.type === "alternate", (ok) => term.paste(ok));
          },
        },
        { label: t("menu.selectAll"), onClick: () => term.selectAll() },
        { type: "separator" },
        {
          type: "colors",
          colors: HIGHLIGHT_PRESETS.map((c) => ({ color: c, label: t("menu.highlightWith", { color: t(`highlight.color.${c}`), text: hlText }) })),
          current: hlCurrent,
          disabled: !hlText,
          onPick: (c) => extras.onSetHighlight(hlText, c),
          onClear: () => extras.onSetHighlight(hlText, null),
          clearLabel: t("menu.unhighlight", { text: hlText }),
        },
        { label: t("menu.manageHighlights"), onClick: () => extras.onManageHighlights() },
        {
          label: t("menu.clearHighlights"),
          disabled: !(settings.highlightRules ?? []).some((r) => r.enabled),
          onClick: () => extras.onClearHighlights(),
        },
        { type: "separator" },
        { type: "separator" },
        {
          label: t("menu.find"),
          shortcut: k["terminal.find"],
          onClick: () => {
            setSearchSeed(hasSelection && !term.getSelection().includes("\n") ? term.getSelection() : "");
            setSearchOpen(true);
          },
        },
        {
          label: t("fold.menu"),
          children: [
            {
              label: isFolded ? t("fold.unfoldHere") : t("fold.foldHere"),
              disabled: !(isFolded || canFold),
              onClick: () => (isFolded ? folder?.unfoldAt(clickRow!) : folder?.foldAt(clickRow!)),
            },
            { label: t("fold.foldAll"), shortcut: k["terminal.foldAll"], disabled: !folder?.hasFoldable(), onClick: () => folder?.foldAll() },
            { label: t("fold.unfoldAll"), shortcut: k["terminal.unfoldAll"], disabled: !folder?.hasFolds(), onClick: () => folder?.unfoldAll() },
          ],
        },
        {
          label: t("maint.menu"),
          children: [
            { label: t("menu.clearScreen"), shortcut: k["terminal.clear"], onClick: () => term.clear() },
            {
              label: t("maint.clearScreenOnly"),
              onClick: () => term.write("\x1b[H\x1b[2J"),
            },
            { label: t("maint.reset"), shortcut: k["terminal.reset"], onClick: () => api.reset() },
            { type: "separator" },
            { label: t("maint.saveToFile"), shortcut: k["terminal.saveToFile"], onClick: () => void saveBuffer() },
            {
              label: t("maint.copyAll"),
              onClick: () => {
                const text = features?.plainText() ?? "";
                void backend.writeClipboard(text);
                extras.onToast(t("maint.copied", { count: text.split("\n").length - 1 }));
              },
            },
          ],
        },
        {
          label: t("menu.timestamps"),
          checked: showTimestamps,
          shortcut: k["terminal.toggleTimestamp"],
          onClick: () => setShowTimestamps((v) => !v),
        },
        { type: "separator" },
        { label: extras.isZoomed ? t("menu.unzoom") : t("menu.zoom"), shortcut: k["split.zoom"], onClick: () => extras.onToggleZoom(leaf.paneId) },
        {
          label: armedAt ? t("cmdNotify.cancel") : t("cmdNotify.arm"),
          shortcut: k["terminal.notifyWhenDone"],
          checked: Boolean(armedAt),
          onClick: () => extras.onToggleCommandWatch(leaf.paneId),
        },
        {
          label: t("ai.menu"),
          children: [
            aiControl
              ? { label: t("ai.stop"), onClick: () => extras.onAiControl(leaf, null) }
              : { label: t("ai.handOver"), disabled: leaf.status !== "connected", onClick: () => extras.onAiControl(leaf, "active") },
            aiControl?.mode === "active" && { label: t("ai.pause"), onClick: () => extras.onAiControl(leaf, "paused") },
            aiControl?.mode === "paused" && { label: t("ai.resume"), onClick: () => extras.onAiControl(leaf, "active") },
            { type: "separator" as const },
            { label: t("ai.copyMcpCommand"), onClick: () => extras.onCopyMcpCommand("claude") },
            { label: t("ai.copyCodexCommand"), onClick: () => extras.onCopyMcpCommand("codex") },
            { label: t("ai.copyGeminiCommand"), onClick: () => extras.onCopyMcpCommand("gemini") },
          ].filter(Boolean) as MenuItem[],
        },
        (leaf.session.protocol === "ssh" || leaf.session.protocol === "wsl") && {
          label: hooks ? `${t("agent.menu")}（${hooksOn ? (hooks.outdated ? t("agent.menuOutdated") : t("agent.menuInstalled")) : t("agent.menuNotInstalled")}）` : t("agent.menu"),
          disabled: leaf.status !== "connected",
          children: [
            { label: hookLine("Claude Code", hooks?.claude), disabled: true, checked: hooks?.claude === "installed" },
            { label: hookLine("Codex", hooks?.codex), disabled: true, checked: hooks?.codex === "installed" },
            { label: hookLine("Gemini CLI", hooks?.gemini), disabled: true, checked: hooks?.gemini === "installed" },
            ...(hooks?.outdated ? [{ label: t("agent.outdatedHint"), disabled: true }] : []),
            { type: "separator" as const },
            { label: hooksOn ? t("agent.reinstallRemote") : t("agent.installRemote"), onClick: () => extras.onAgentHooks(leaf, true) },
            { label: t("agent.uninstallRemote"), disabled: Boolean(hooks) && !hooksOn, onClick: () => extras.onAgentHooks(leaf, false) },
            {
              label: t("agent.recheck"),
              onClick: () =>
                void extras.agentHookStatus(leaf, true).then((st) =>
                  extras.onToast(
                    st
                      ? `${hookLine("Claude Code", st.claude)}  ·  ${hookLine("Codex", st.codex)}  ·  ${hookLine("Gemini CLI", st.gemini)}${st.outdated ? `  ·  ${t("agent.outdatedHint")}` : ""}`
                      : t("agent.checkFailed")
                  )
                ),
            },
          ],
        },
        ["serial", "telnet", "tcp", "custom"].includes(leaf.session.protocol) && {
          label: t("agent.menu"),
          children: [
            {
              label: t("agent.copyPosixInstall"),
              onClick: () => void backend.writeClipboard(posixHookCommand(true)).then(() => extras.onToast(t("agent.posixCopied"))),
            },
            {
              label: t("agent.copyPosixRemove"),
              onClick: () => void backend.writeClipboard(posixHookCommand(false)).then(() => extras.onToast(t("agent.posixCopied"))),
            },
          ],
        },
        {
          label: t(shellStatus?.loading ? "si.menuLoading" : shellStatus?.detected ? "si.menuDetected" : shellStatus ? "si.menuNotDetected" : "si.menu"),
          disabled:
            Boolean(shellStatus?.loading) || !canInjectShellIntegration(leaf.session.protocol, leaf.status) || xtermRef.current?.buffer.active.type === "alternate",
          onClick: () => extras.onInjectShellIntegration(leaf.paneId),
        },
        tmux && { label: t("menu.tmux"), shortcut: k["terminal.tmux"], onClick: () => extras.onTmux(leaf) },
        { type: "separator" },
        {
          label: logPath ? t("menu.stopLog") : t("menu.startLog"),
          disabled: !logPath && !connected,
          onClick: () => extras.onToggleLog(leaf),
        },
        Boolean(logPath) && {
          label: extras.pausedLogs[leaf.paneId] ? t("menu.resumeLog") : t("menu.pauseLog"),
          onClick: () => extras.onPauseLog(leaf.paneId, !extras.pausedLogs[leaf.paneId]),
        },
        { label: t("menu.openLogFolder"), onClick: () => extras.onRevealLog(leaf.paneId) },
        leaf.session.protocol === "ssh" && {
          label: t("sftp.openHere"),
          disabled: !connected,
          onClick: () => extras.onOpenFileBrowser(leaf.paneId),
        },
        {
          label: t("modem.menu"),
          disabled: !modemOk,
          children: [
            { label: t("modem.sendZ"), onClick: () => extras.onModemTransfer(leaf, "zmodem", true) },
            { type: "separator" },
            { label: t("modem.sendX"), onClick: () => extras.onModemTransfer(leaf, "xmodem", true) },
            { label: t("modem.receiveX"), onClick: () => extras.onModemTransfer(leaf, "xmodem", false) },
            { type: "separator" },
            { label: t("modem.sendY"), onClick: () => extras.onModemTransfer(leaf, "ymodem", true) },
            { label: t("modem.receiveY"), onClick: () => extras.onModemTransfer(leaf, "ymodem", false) },
          ],
        },
        { type: "separator" },
        {
          // One row: clicking the channel it is in leaves it.
          type: "choices",
          label: t("menu.syncChannelRow"),
          options: (["A", "B", "C", "D"] as SyncChannel[]).map((ch) => ({
            value: ch,
            label: ch,
            checked: channel === ch,
            title: channel === ch ? t("menu.leaveChannel") : t("menu.joinChannel", { channel: ch }),
          })),
          onPick: (ch) => extras.onSetSyncChannel(leaf.paneId, channel === ch ? null : (ch as SyncChannel)),
        },
        {
          label: pausedOnItsOwn ? t("sync.resumePane") : t("sync.pausePane"),
          shortcut: k["terminal.syncPausePane"],
          disabled: !syncBadge,
          checked: Boolean(syncBadge) && pausedOnItsOwn,
          onClick: () => extras.onToggleSyncPausePane(leaf.paneId),
        },
        {
          label: extras.syncPaused ? t("sync.resumeAll") : t("sync.pauseAll"),
          shortcut: k["terminal.syncPause"],
          disabled: !syncBadge && !extras.syncPaused,
          onClick: () => extras.onToggleSyncPause(),
        },
        { type: "separator" },
        {
          label: leaf.locked ? t("menu.unlockSession") : t("menu.lockSession"),
          shortcut: k["tab.lock"],
          onClick: () => extras.onToggleLock(leaf.paneId),
        },
        { label: t("pane.reconnect"), shortcut: k["tab.reconnect"], onClick: () => onReconnectPane(leaf.paneId) },
        {
          label: t("menu.disconnect"),
          disabled: !connected || leaf.locked,
          onClick: () => extras.onDisconnect(leaf.paneId),
        },
        {
          label: t("pane.closePane"),
          danger: true,
          disabled: leaf.locked,
          onClick: () => onClosePane(leaf.paneId),
        },
      ]) as MenuItem[]
    );
  };


  // Files dragged from Explorer: upload with ZModem (type `rz`, then send them).
  const [fileOver, setFileOver] = useState(false);
  const dragDepth = useRef(0);
  const isFileDrag = (e: React.DragEvent) => e.dataTransfer.types.includes("Files");
  const fileDrop = {
    onDragEnter: (e: React.DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      dragDepth.current += 1;
      setFileOver(true);
    },
    onDragOver: (e: React.DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!isFileDrag(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setFileOver(false);
    },
    onDrop: (e: React.DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      dragDepth.current = 0;
      setFileOver(false);
      onActivate(leaf.paneId);
      // Folders cannot be sent with ZModem.
      const entries = Array.from(e.dataTransfer.items).map((it) => it.webkitGetAsEntry?.());
      const files = Array.from(e.dataTransfer.files).filter((_, i) => !entries[i]?.isDirectory);
      if (files.length === 0) {
        extras.onToast(t("zmodem.dropNoFiles"));
        return;
      }
      const term = xtermRef.current;
      if (leaf.status !== "connected") {
        extras.onToast(t("zmodem.dropNotConnected"));
        return;
      }
      if (term?.buffer.active.type === "alternate") {
        extras.onToast(t("zmodem.dropBusy"));
        return;
      }
      zmodemDrop.queue(leaf.paneId, files, () => extras.onToast(t("zmodem.dropNoRz")));
      // Straight to this terminal: never broadcast to synced panes.
      void backend.writeTerminal(leaf.paneId, `${modemOf(settingsRef.current).zmodemUploadCommand}\r`);
      term?.focus();
    },
  };

  return (
    <div
      className={`terminal-pane ${isActive ? "pane-active" : ""} ${
        showSplitChrome ? "pane-split-mode" : ""
      } ${syncBadge && !syncPausedHere ? "pane-synced" : ""} ${bellFlash ? "pane-bell" : ""} ${aiControl?.mode === "active" ? "pane-ai-held" : ""}`}
      onMouseDown={() => onActivate(leaf.paneId)}
      {...fileDrop}
    >
      {fileOver && (
        <div className="pane-drop-overlay">
          <div className="pane-drop-card">
            <Upload size={22} />
            <strong>{t("zmodem.dropTitle")}</strong>
            <span>{t("zmodem.dropHint", { cmd: modemOf(settings).zmodemUploadCommand })}</span>
          </div>
        </div>
      )}
      {aiControl && (
        <div className={`pane-ai-banner ${aiControl.mode === "paused" ? "ai-paused" : ""}`} onMouseDown={(e) => e.stopPropagation()}>
          <Bot size={13} />
          <span className="pane-ai-state">{aiControl.mode === "active" ? t("ai.active") : t("ai.paused")}</span>
          {aiControl.activity && <code className="pane-ai-activity" title={aiControl.activity}>{aiControl.activity}</code>}
          <span className="pane-ai-spacer" />
          {aiControl.mode === "active" ? (
            <button type="button" title={t("ai.pauseTip")} onClick={() => extras.onAiControl(leaf, "paused")}>
              <Pause size={12} /> {t("ai.pause")}
            </button>
          ) : (
            <button type="button" title={t("ai.resumeTip")} onClick={() => extras.onAiControl(leaf, "active")}>
              <Play size={12} /> {t("ai.resume")}
            </button>
          )}
          <button type="button" className="pane-ai-stop" title={t("ai.stopTip")} onClick={() => extras.onAiControl(leaf, null)}>
            <Square size={11} /> {t("ai.stop")}
          </button>
        </div>
      )}
      {syncBadge && (
        // WindTerm-style bar on top of a pane whose typing is broadcast.
        <div className={`pane-sync-bar ${syncPausedHere ? "sync-bar-paused" : ""}`} onMouseDown={(e) => e.stopPropagation()}>
          {inChannel && <span className={`pane-sync-dot sync-ch-${channel}`} />}
          <span className="pane-sync-state">
            {inChannel ? t("sync.barChannel", { channel }) : t(extras.syncScope === "all" ? "sync.barAll" : "sync.barVisible")}
            {syncPausedHere && ` · ${extras.syncPaused ? t("sync.barPausedAll") : t("sync.barPaused")}`}
          </span>
          <span className="pane-ai-spacer" />
          {extras.syncPaused ? (
            <button type="button" onClick={() => extras.onToggleSyncPause()}>
              <Play size={12} /> {t("sync.resumeAll")}
            </button>
          ) : (
            <button type="button" title={pausedOnItsOwn ? t("sync.resumePane") : t("sync.pausePane")} onClick={() => extras.onToggleSyncPausePane(leaf.paneId)}>
              {pausedOnItsOwn ? <Play size={12} /> : <Pause size={12} />} {pausedOnItsOwn ? t("sync.barResume") : t("sync.barPause")}
            </button>
          )}
          {inChannel && (
            <button type="button" onClick={() => extras.onSetSyncChannel(leaf.paneId, null)}>
              <LogOut size={12} /> {t("sync.barLeave")}
            </button>
          )}
          <button
            type="button"
            className="pane-sync-close"
            title={inChannel ? t("sync.closeChannelTip", { channel }) : t("sync.stopTip")}
            onClick={() => extras.onCloseSync(inChannel ? channel : undefined)}
          >
            <X size={12} /> {inChannel ? t("sync.closeChannel") : t("sync.stop")}
          </button>
        </div>
      )}
      {(logPath || phoneSize) && (
        <div className="pane-badges">
          {phoneSize && (
            <button
              type="button"
              className="pane-badge badge-phone"
              title={t("remote.paneHeldTip")}
              onClick={(e) => {
                e.stopPropagation();
                remoteMirror.release(leaf.paneId);
              }}
            >
              <Smartphone size={11} /> {t("remote.paneHeld", { cols: phoneSize.cols, rows: phoneSize.rows })}
            </button>
          )}
          {logPath && (
            <button
              type="button"
              className="pane-badge badge-rec"
              title={logPath}
              onClick={(e) => {
                e.stopPropagation();
                extras.onRevealLog(leaf.paneId);
              }}
            >
              {extras.pausedLogs[leaf.paneId] ? `❚❚ ${t("pane.recordingPaused")}` : `● ${t("pane.recording")}`}
            </button>
          )}
        </div>
      )}
      {showSplitChrome && (
        <div className="pane-mini-header">
          <div className="pane-mini-title">
            <ProtocolBadge protocol={leaf.session.protocol} size={12} />
            <span className="pane-mini-label">{leaf.session.label}</span>
            <span className="pane-mini-target">{targetSummary}</span>
          </div>
          <div className="pane-mini-actions">
            <button
              type="button"
              className="icon-btn-xs"
              title={t("pane.find")}
              onClick={(e) => {
                e.stopPropagation();
                setSearchOpen((v) => !v);
              }}
            >
              <Search size={12} />
            </button>
            <button
              type="button"
              className="icon-btn-xs"
              title={t("pane.splitRight")}
              onClick={(e) => {
                e.stopPropagation();
                onSplit(leaf.paneId, "horizontal");
              }}
            >
              <Columns2 size={12} />
            </button>
            <button
              type="button"
              className="icon-btn-xs"
              title={t("pane.splitDown")}
              onClick={(e) => {
                e.stopPropagation();
                onSplit(leaf.paneId, "vertical");
              }}
            >
              <Rows2 size={12} />
            </button>
            <button
              type="button"
              className="icon-btn-xs"
              title={t("pane.reconnect")}
              onClick={(e) => {
                e.stopPropagation();
                onReconnectPane(leaf.paneId);
              }}
            >
              <RotateCw size={12} />
            </button>
            <button
              type="button"
              className="icon-btn-xs danger-hover"
              title={t("pane.closePane")}
              onClick={(e) => {
                e.stopPropagation();
                onClosePane(leaf.paneId);
              }}
            >
              <X size={12} />
            </button>
          </div>
        </div>
      )}

      {searchOpen && xtermRef.current && (
        <TerminalSearch
          term={xtermRef.current}
          accent={theme.accent}
          initialQuery={searchSeed}
          onClose={() => {
            setSearchOpen(false);
            xtermRef.current?.focus();
          }}
          onHighlight={extras.onAddHighlight}
        />
      )}

      {awaitingPassword && (
        <div
          className="pane-auth-overlay"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <form className="pane-auth-card" onSubmit={handlePasswordSubmit}>
            <div className="pane-auth-header">
              <KeyRound size={16} />
              <span>
                {t("pane.sshAuthTitle")} — {targetSummary}
              </span>
            </div>
            {needsUsername && (
              <input
                type="text"
                autoFocus
                className="text-input"
                placeholder={t("pane.sshUserPlaceholder")}
                value={usernameInput}
                onChange={(e) => setUsernameInput(e.target.value)}
                required
              />
            )}
            {usesPassword && (
              <input
                type="password"
                autoFocus={!needsUsername}
                className="text-input"
                placeholder={t("pane.sshPwdPlaceholder")}
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
              />
            )}
            <div className="pane-auth-footer">
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={rememberPwd}
                  onChange={(e) => setRememberPwd(e.target.checked)}
                />
                <span>{usesPassword ? t("pane.rememberPwd") : t("pane.rememberUser")}</span>
              </label>
              <button type="submit" className="btn-primary btn-sm">
                {t("pane.connectNow")}
              </button>
            </div>
          </form>
        </div>
      )}

      {!awaitingPassword &&
        (leaf.status === "disconnected" || leaf.status === "error") && (
          <div className="pane-disconnect-banner">
            <span>
              {leaf.status === "error"
                ? t("pane.connFailed")
                : t("pane.sessionEnded")}
              {leaf.statusMessage ? `: ${leaf.statusMessage}` : ""}
            </span>
            <div className="banner-actions">
              {leaf.session.protocol === "ssh" &&
                leaf.session.authType === "password" && (
                  <button
                    type="button"
                    className="btn-ghost btn-xs"
                    onClick={() => setAwaitingPassword(true)}
                  >
                    {t("pane.changePwd")}
                  </button>
                )}
              <button
                type="button"
                className="btn-primary btn-xs"
                onClick={() => onReconnectPane(leaf.paneId)}
              >
                <RotateCw size={12} /> {t("pane.reconnect")}
              </button>
            </div>
          </div>
        )}

      <div className="xterm-row">
        <div ref={gutterRef} className="ts-gutter" style={{ display: "none" }} />
        <div className="fold-gutter-wrap">
          <div ref={foldGutterRef} className="fold-gutter" style={{ display: "none" }} />
          {settings.foldMargin !== false && (
            <div className="fold-tools" onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}>
              <button
                type="button"
                title={`${t("fold.foldAll")}${extras.keymap["terminal.foldAll"] ? ` (${extras.keymap["terminal.foldAll"]})` : ""}`}
                onClick={() => featuresRef.current?.folder.foldAll()}
              >
                <ChevronsDownUp size={12} />
              </button>
              <button
                type="button"
                title={`${t("fold.unfoldAll")}${extras.keymap["terminal.unfoldAll"] ? ` (${extras.keymap["terminal.unfoldAll"]})` : ""}`}
                onClick={() => featuresRef.current?.folder.unfoldAll()}
              >
                <ChevronsUpDown size={12} />
              </button>
            </div>
          )}
        </div>
        <div className="xterm-mount-wrap">
          <div
            ref={containerRef}
            className="xterm-mount"
            onContextMenu={(e) => void showPaneMenu(e)}
          />
          {suggestions && isActive && (
            <AutoCompletePopup state={suggestions} onPick={(i) => featuresRef.current?.acceptSuggestion(i)} />
          )}
        </div>
      </div>
    </div>
  );
};

let audioCtx: AudioContext | null = null;
function playBeep(): void {
  try {
    audioCtx ??= new AudioContext();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.08;
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.12);
  } catch {
    // no audio device
  }
}

/** The word under a mouse position, using the terminal's word separators. */
function wordAt(term: Terminal, clientX: number, clientY: number, separators?: string): string {
  const screen = term.element?.querySelector(".xterm-screen") as HTMLElement | null;
  if (!screen) return "";
  const r = screen.getBoundingClientRect();
  const col = Math.floor(((clientX - r.left) / r.width) * term.cols);
  const row = Math.floor(((clientY - r.top) / r.height) * term.rows);
  if (col < 0 || row < 0 || col >= term.cols || row >= term.rows) return "";
  const line = term.buffer.active.getLine(term.buffer.active.viewportY + row);
  if (!line) return "";
  const { text, cols } = readRow(line);
  let i = cols.findIndex((c) => c >= col);
  if (i < 0 || cols[i] !== col) {
    if (i < 0) return "";
    if (cols[i] > col && i > 0 && cols[i - 1] <= col) i -= 1;
  }
  const sep = new Set((separators || " ()[]{}'\",;:<>|") + " \t");
  if (sep.has(text[i])) return "";
  let a = i;
  let b = i + 1;
  while (a > 0 && !sep.has(text[a - 1])) a--;
  while (b < text.length && !sep.has(text[b])) b++;
  return text.slice(a, b).trim();
}

/** The cursor row up to the cursor (the prompt plus what was typed). */
function textBeforeCursor(term: Terminal): string {
  const buf = term.buffer.active;
  return buf.getLine(buf.baseY + buf.cursorY)?.translateToString(false, 0, buf.cursorX) ?? "";
}

/** "user@host:~$ make -j8" -> "make -j8". */
function commandFromLine(line: string): string | null {
  const m = /^.*?[$#%>❯➜»λ]\s+(.+)$/.exec(line.trim()) ;
  const cmd = (m ? m[1] : line).trim();
  return cmd ? cmd.slice(0, 120) : null;
}

/** Re-render a pane only when something it shows or uses changed (App re-renders often). */
function paneSliceEqual(a: TerminalPaneProps, b: TerminalPaneProps): boolean {
  for (const key of Object.keys(a) as (keyof TerminalPaneProps)[]) {
    if (key !== "extras" && a[key] !== b[key]) return false;
  }
  const id = a.leaf.paneId;
  const x = a.extras;
  const y = b.extras;
  return (
    x.commandWatches[id] === y.commandWatches[id] &&
    x.logPaths[id] === y.logPaths[id] &&
    x.pausedLogs[id] === y.pausedLogs[id] &&
    x.syncChannels[id] === y.syncChannels[id] &&
    x.syncPaused === y.syncPaused &&
    x.syncPausedPanes[id] === y.syncPausedPanes[id] &&
    x.syncScope === y.syncScope &&
    x.aiControls[id] === y.aiControls[id] &&
    x.isZoomed === y.isZoomed &&
    x.keymap === y.keymap
  );
}

export const TerminalPane = React.memo(TerminalPaneImpl, paneSliceEqual);
