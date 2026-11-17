export type ProtocolType =
  | "ssh"
  | "powershell"
  | "cmd"
  | "wsl"
  | "custom"
  | "tcp"
  | "serial"
  | "telnet";

export type AuthType = "password" | "privatekey" | "none";

/** Session data type (serial / TCP): text runs through the terminal, binary is a hex dump. */
export type DataType = "text" | "binary";

/** Protocols with a data type choice (Rust `SessionConfig::binary_data`). */
export function hasDataType(protocol: ProtocolType): boolean {
  return protocol === "serial" || protocol === "tcp";
}

export interface JumpHostConfig {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  authType: AuthType;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
}

export interface SessionConfig {
  id: string;
  label: string;
  group: string;
  protocol: ProtocolType;
  host: string;
  port: number;
  username: string;
  authType: AuthType;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  jumpHost?: JumpHostConfig | null;
  term: string;
  keepAliveSecs: number;
  startupCommand?: string;
  workingDir?: string;
  shellCommand?: string;
  serial?: SerialConfig | null;
  /** Start a session log as soon as it connects. */
  autoLog?: boolean;
  proxy?: ProxyConfig | null;
  tunnels?: TunnelConfig[];
  x11?: X11Config | null;
  /** Remote charset ("" = UTF-8). */
  charset?: string;
  /** Serial / TCP: "binary" shows received bytes as a hex dump and sends bytes as is (WindTerm session.dataType). */
  dataType?: DataType;
  /** Highlight scheme ("" = auto). */
  system?: HighlightSystem | "";
  /** Accept any SSH host key without asking. */
  skipHostKeyCheck?: boolean;
  /** Per-session terminal key / bell behaviour. */
  termOptions?: TerminalOptions;
  /** Default tab color for this session. */
  tabColor?: string | null;
}

/** A keyword / pattern painted in every terminal (Settings > Highlight). */
export interface HighlightRule {
  id: string;
  pattern: string;
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  /** background: colored box with contrasting text; text: colored text only. */
  mode: "background" | "text";
  color: string;
  /** Text color for background mode ("" / null = automatic contrast). */
  textColor?: string | null;
  enabled: boolean;
}

export type HighlightSystem = "linux" | "powershell" | "cmd" | "macos" | "routeros" | "none";

export interface ProxyConfig {
  kind: "none" | "socks5" | "socks4" | "http";
  host: string;
  port: number;
  username?: string | null;
  password?: string | null;
}

export interface TunnelConfig {
  name: string;
  kind: "local" | "remote" | "dynamic";
  listenHost: string;
  listenPort: number;
  targetHost: string;
  targetPort: number;
  enabled: boolean;
}

export interface X11Config {
  enabled: boolean;
  display: string;
}

export interface TerminalOptions {
  /** Backspace sends DEL (^?) or BS (^H). */
  backspaceKey: "del" | "ctrl-h";
  /** Delete sends the VT sequence ESC[3~ or DEL. */
  deleteKey: "vt" | "del";
  /** Enter sends CR, CR LF or LF. */
  enterKey: "cr" | "crlf" | "lf";
  bell: "none" | "sound" | "visual";
  /** Treat Alt as Meta (ESC prefix). Superseded by metaKey when that is set. */
  altIsMeta: boolean;
  /**
   * Which key acts as Meta (sends ESC + key), like WindTerm's terminal.metaModifierKey:
   * both Alt keys, only the left / right one (keeps AltGr for typing), the Windows key, or none.
   */
  metaKey?: MetaKeyMapping;
}

export type MetaKeyMapping = "alt" | "leftAlt" | "rightAlt" | "win" | "none";

export const DEFAULT_TERMINAL_OPTIONS: TerminalOptions = {
  backspaceKey: "del",
  deleteKey: "vt",
  enterKey: "cr",
  bell: "visual",
  altIsMeta: true,
};

/** Effective Meta key of a session (older sessions only have altIsMeta). */
export function metaKeyOf(o: TerminalOptions): MetaKeyMapping {
  return o.metaKey ?? (o.altIsMeta === false ? "none" : "alt");
}

export interface SerialConfig {
  baudRate: number;
  dataBits: number;
  parity: "none" | "odd" | "even";
  stopBits: number;
  flowControl: "none" | "software" | "hardware";
}

export interface QuickCommand {
  id: string;
  label: string;
  group: string;
  /** Text sent to the terminal; line breaks are sent as Enter (CR). */
  command: string;
  /** Press Enter after the text. */
  appendNewline: boolean;
  /** "shape-color" (WindTerm quick.icon without "session::"), e.g. "tag-coral". */
  icon?: string;
  /** Key combo that runs it, e.g. "Alt+1" (same notation as AppSettings.keymap). */
  shortcut?: string;
  /** "text" (default) sends `command`; "action" runs the app action `action`. */
  kind?: "text" | "action";
  action?: string;
}

/** How the quick bar lays out its commands (Quick Commands dialog options). */
export interface QuickBarSettings {
  /** Group order, including groups without commands yet. */
  groups?: string[];
  /** Show every group's commands at once (off: one group at a time). */
  multiGroups?: boolean;
  /** With several groups shown, label each one. */
  groupTitles?: boolean;
  /** Sort commands by label instead of their own order. */
  sortAlpha?: boolean;
}

export interface ThemeDefinition {
  id: string;
  name: string;
  isLight: boolean;
  guiBg: string;
  guiPanel: string;
  guiFg: string;
  accent: string;
  termBg: string;
  termFg: string;
  cursorLocal: string;
  cursorRemote: string;
  ansi: [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
}

export interface AppSettings {
  language: "zh-CN" | "en-US" | string;
  themeId: string;
  fontFamily: string;
  fontSize: number;
  scrollback: number;
  cursorBlink: boolean;
  cursorStyle: "block" | "underline" | "bar";
  confirmBeforeClose: boolean;
  lockPasscode?: string | null;
  syntaxHighlight: boolean;
  closeToTray: boolean;
  logDir?: string | null;
  logFilePattern: string;
  logTimestamp: boolean;
  /** Copy selected text to the clipboard automatically. */
  copyOnSelect?: boolean;
  /** Right-click in a terminal: open the menu, or paste. */
  rightClickAction?: "menu" | "paste";
  /** Extra characters that end a word on double-click selection. */
  wordSeparators?: string;
  alwaysOnTop?: boolean;
  /** Window opacity 0.2 - 1. */
  windowOpacity?: number;
  /** actionId -> key combo, e.g. "Ctrl+Shift+F"; "" disables the shortcut. */
  keymap?: Record<string, string>;
  /** Toolbar buttons the user hid. */
  toolbarHidden?: string[];
  /** Show the status bar at the bottom of the window (default off). */
  showStatusBar?: boolean;
  /** Quick bar layout and group order (kept in settings.extra on the Rust side). */
  quickBar?: QuickBarSettings;
  /** Toolbar defaults applied (see DEFAULT_TOOLBAR_HIDDEN); missing on older settings. */
  toolbarLayout?: number;
  /** Folder for files received over ZModem ("" = Downloads). */
  zmodemDownloadDir?: string;
  /** Show the line timestamp margin in new terminals. */
  showTimestamps?: boolean;
  /** Timestamps with milliseconds. */
  timestampMs?: boolean;
  /** Line numbers in the timestamp margin (default on). */
  gutterLineNumbers?: boolean;
  /** Background bands on the cursor's line and on the line last clicked (default on). */
  highlightCurrentLine?: boolean;
  highlightRules?: HighlightRule[];
  /** Lines scrolled per mouse wheel notch (WindTerm default 3). */
  wheelScrollLines?: number;
  /** Mark background tabs that print output (default on). */
  tabActivity?: boolean;
  /** Show the host the shell is on (OSC 7 / title / prompt) after the tab name (default on). */
  tabHostname?: boolean;
  /** Show the command running in the pane (make, colcon build ...) on its tab (default on). */
  tabCommand?: boolean;
  /** Load shell integration (OSC 133 / 633 / 7) into SSH and WSL bash / zsh / fish and local PowerShell (default on; read by the backend from settings.extra). */
  shellIntegration?: boolean;
  /** Keep every pane's whole output in the backend and scroll back through all of it (default on; read by the backend from settings.extra). */
  fullHistory?: boolean;
  /** Compressed history kept in memory per pane, in MB (default 32); older parts go to encrypted temp files. */
  fullHistoryMemoryMb?: number;
  /** Temp-file space per pane, in MB (default 2048; 0 = memory only, oldest lines dropped). */
  fullHistoryDiskMb?: number;
  /** The old 50000-line scrollback default was lowered once (full history holds the rest). */
  scrollbackMigrated?: boolean;
  /** Guess Claude Code / Codex state from the screen when their hooks are not installed (default on). */
  agentScreenDetect?: boolean;
  /** Windows notification when an agent finishes, needs approval or fails (default on). */
  agentNotify?: boolean;
  /** Check GitHub for a newer release at startup (default on). */
  checkUpdates?: boolean;
  /** A release the user chose to skip: no startup prompt for it (a newer one prompts again). */
  skippedUpdateVersion?: string;

  // ---- WindTerm parity (see utils/settingsDefaults.ts for the defaults) ----

  /** Ask before closing a tab with a live connection (terminal.askBeforeCloseTab). */
  askBeforeCloseTab?: boolean;
  /** Ask before quitting / closing the main window with sessions open (terminal.askBeforeCloseWindow). */
  askBeforeCloseWindow?: boolean;
  /** Confirm pasting multi-line text (terminal.screen.pasteDialog). */
  pasteConfirm?: boolean;
  /** ... also in full-screen programs like vim (terminal.altScreen.pasteDialog). */
  pasteConfirmAltScreen?: boolean;

  /** Command history (terminal.commandHistory.*). */
  history?: HistorySettings;
  /** Auto completion popup (terminal.autoComplete.*). */
  autoComplete?: AutoCompleteSettings;
  /** Fold markers beside each command's output. */
  foldMargin?: boolean;

  /** Open sessions at startup (terminal.startupSessions). */
  startupSessions?: "none" | "last" | "selected";
  startupSessionIds?: string[];
  /** Lock the window after this many idle minutes; 0 = never (application.lockScreenTimeout). */
  lockScreenTimeout?: number;

  /** Mouse behaviour in terminals (terminal.rightClickAction, terminal.mouseTracking.*). */
  mouse?: MouseSettings;
  /** Tab bar mouse actions (tabbar.doubleClickAction / middleClickAction). */
  tabDoubleClick?: TabMouseAction;
  tabMiddleClick?: TabMouseAction;
  /** Switch to a tab when the mouse rests on it (default on). */
  tabHoverSwitch?: boolean;

  /** Display details (text.alternatingLineColors / whiteSpaceVisibility / wrapSymbolVisible). */
  alternateRowColors?: boolean;
  showWhitespace?: "none" | "all" | "leading" | "trailing";
  showWrapMarks?: boolean;

  /** OSC 52 from remote programs (session.allowRemoteWriteClipboard / ReadClipboard). */
  remoteClipboardWrite?: ClipboardPermission;
  remoteClipboardRead?: ClipboardPermission;

  /** Session log: split size in MB (0 = never), line template, plain text or raw output. */
  logMaxSizeMb?: number;
  logLinePattern?: string;
  logType?: "text" | "raw";

  /** X/Y/ZModem upload commands and packet sizes (xmodem.uploadCommand ...). */
  modem?: ModemSettings;

  /** SSH file browser (SFTP / SCP). */
  sftp?: SftpSettings;

  /** Duplicate / split an SSH tab over its existing connection (no new login). */
  reuseSshConnection?: boolean;

  /** Built-in X server (xserver.*). */
  xserver?: XServerSettings;

  /** Phone remote through a self-hosted relay (remote.*). */
  remote?: RemoteSettings;

  /** Config sync to S3 / WebDAV / a folder. Stays on this computer (never synced itself). */
  sync?: SyncSettings;

  /** Session sidebar order: saved order, name, most recently used, most used. */
  sessionSort?: "default" | "name" | "recent" | "frequent";
}

/** What export / import / sync carry. Mirrors Rust `sync::CATEGORIES`. */
export type SyncCategory = "sessions" | "quickCommands" | "themes" | "settings" | "senders" | "history";

export type SyncProvider = "none" | "s3" | "webdav" | "gist" | "folder";

/** Mirrors Rust `sync::SyncConfig` (plus the frontend-only auto sync options). */
export interface SyncSettings {
  provider: SyncProvider;
  s3: {
    /** Empty: AWS. R2 / MinIO / OSS / COS ... give their endpoint. */
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    prefix: string;
    pathStyle: boolean;
  };
  webdav: { url: string; username: string; password: string };
  folder: { path: string };
  /** GitHub Gist: token with the gist scope; empty gistId = find / create by file name. */
  gist: { token: string; gistId: string; apiUrl: string };
  fileName: string;
  /** Encrypts the synced file (AES-256-GCM); empty = plain JSON. */
  password: string;
  categories: SyncCategory[];
  /** Sync at startup and every intervalMin minutes (0 = startup only). */
  autoSync: boolean;
  intervalMin: number;
}

/** Mirrors Rust `sync::BundleInfo`. */
export interface ConfigBundleInfo {
  encrypted: boolean;
  exportedAt: string;
  device: string;
  /** Unknown (null) while the file is encrypted. */
  categories: SyncCategory[] | null;
}

export type SyncResult = "uploaded" | "downloaded" | "merged" | "upToDate" | "conflict";

/** Mirrors Rust `sync::SyncOutcome`. */
export interface SyncOutcome {
  result: SyncResult;
  applied: SyncCategory[];
  remoteDevice: string;
  remoteTime: string;
  at: number;
}

/** Mirrors Rust `sync::SyncState`. */
export interface SyncStateInfo {
  target: string;
  lastSync: number;
  lastResult: string;
}

/** Mirrors Rust `remote::RemoteConfig`. */
export interface RemoteSettings {
  enabled: boolean;
  /** Base address of the relay, e.g. https://relay.example.com */
  relayUrl: string;
  /** Must match the relay's HOST_TOKEN when it sets one. */
  hostToken: string;
  /** Phones may only watch. */
  readOnly: boolean;
}

export interface HistorySettings {
  enabled: boolean;
  /** Keep commands this many days. */
  days: number;
  /** At most this many commands. */
  size: number;
  /** Completion and the history panel use the current session's commands only. */
  perSession: boolean;
}

export interface AutoCompleteSettings {
  enabled: boolean;
  /** Characters typed before suggestions appear. */
  threshold: number;
  visibleRows: number;
  /** Select the best match right away (Enter / Tab accepts it). */
  preselect: boolean;
  history: boolean;
  quickCommands: boolean;
  commandNames: boolean;
  commandOptions: boolean;
}

export type ClipboardPermission = "deny" | "ask" | "allow";
export type TabMouseAction = "close" | "rename" | "duplicate" | "reconnect" | "none";

export interface MouseSettings {
  rightClick: "menu" | "paste" | "copyPaste" | "none";
  middleClick: "paste" | "pasteSelection" | "menu" | "none";
  doubleClick: "word" | "wordCopy" | "line" | "none";
  /** Ctrl + wheel changes the font size. */
  ctrlWheelZoom: boolean;
  /**
   * Mouse events sent to programs that track the mouse (vim, tmux, htop ...).
   * Off: the event stays local (selection, menu, scrolling) even then.
   */
  tracking: {
    click: boolean;
    doubleClick: boolean;
    middleClick: boolean;
    rightClick: boolean;
    move: boolean;
    wheel: boolean;
  };
}

/** SSH file browser and its transfer queue (settings.sftp; the backend reads `concurrency`). */
export interface SftpSettings {
  /** Transfers running at the same time (1 - 16). */
  concurrency: number;
  /** What to do when the target already exists. */
  conflict: "ask" | "overwrite" | "skip" | "rename" | "newer";
  /** Keep modification / access times. */
  preserveTimes: boolean;
  /** auto: SFTP, SCP when the server has no SFTP subsystem. */
  protocol: "auto" | "sftp" | "scp";
  /** Follow the terminal's directory (OSC 7, needs shell integration). */
  followCwd: boolean;
  showHidden: boolean;
  /** Program for "Edit locally" ("" = the program Windows uses for the file type). */
  editor: string;
  /** Last local folder downloads went to ("" = Downloads). */
  downloadDir: string;
}

export interface ModemSettings {
  zmodemUploadCommand: string;
  /** `%f` is replaced by the file name. */
  xmodemUploadCommand: string;
  ymodemUploadCommand: string;
  xmodemPacket: 128 | 1024;
  ymodemPacket: 128 | 1024;
}

export interface XServerSettings {
  enabled: boolean;
  autoStart: boolean;
  path: string;
  display: number;
  windowMode: "multiwindow" | "rootless" | "fullscreen" | "windowed";
  clipboard: boolean;
  primarySelection: boolean;
  keyhook: boolean;
  trayIcon: boolean;
  xkbLayout: string;
  xkbModel: string;
  disableAccessControl: boolean;
  extraArgs: string;
}

/** One entry of the command history. */
export interface HistoryEntry {
  command: string;
  /** Last time it ran (ms). */
  time: number;
  count: number;
  /** Session label it last ran in. */
  session?: string;
  /** Session it belongs to (historyKeyOf); absent in entries from older versions. */
  key?: string;
}

/** A saved text in the Sender panel. */
export interface SenderItem {
  id: string;
  name: string;
  text: string;
  /** Send each line separately, waiting lineDelay ms in between. */
  lineDelay: number;
  /** Repeat the whole text; 0 = until stopped. */
  repeat: number;
  /** Pause between repeats, ms. */
  interval: number;
  /** Line ending sent after each line. */
  eol: "cr" | "lf" | "crlf" | "none";
  target: "active" | "visible" | "all" | "selected";
  /** "hex": each line is hex bytes ("48 65 6C"), sent as raw bytes (default "text"). */
  mode?: "text" | "hex";
}

export interface AppStateSnapshot {
  sessions: SessionConfig[];
  quickCommands: QuickCommand[];
  customThemes: ThemeDefinition[];
  settings: AppSettings;
}

export interface DiscoveryCandidate {
  sourceType: "windterm_sessions" | "openssh_config" | "windterm_theme" | string;
  label: string;
  path: string;
  itemCount: number;
}

export interface ImportResult {
  sessions: SessionConfig[];
  themes: ThemeDefinition[];
  quickCommands: QuickCommand[];
  summary: string;
}

export type ConnectionStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

export interface TerminalStatePayload {
  instanceId: string;
  status: ConnectionStatus;
  message?: string | null;
}

/** MCP agent control of a pane (mcp.rs ControlView). */
export type AiControlMode = "active" | "paused";

export interface AiControl {
  instanceId: string;
  mode: AiControlMode;
  title: string;
  /** What the agent is doing right now (a command line), shown in the pane banner. */
  activity: string | null;
}

/** An agent asking to operate a pane (MCP request_control; mcp.rs ControlRequest). */
export interface AiControlRequest {
  requestId: string;
  instanceId: string;
  /** "Claude Code", "Codex" ... */
  client: string;
  /** What the agent wants to do, in its own words. */
  reason: string;
  /** The pane is paused: the agent asks to continue. */
  resume: boolean;
  /** Session name of the pane. */
  title: string;
}

/** An agent asking to open a session in a new tab (MCP open_session; mcp.rs OpenRequest). */
export interface AiOpenRequest {
  requestId: string;
  client: string;
  reason: string;
  /** A saved session ... */
  sessionId: string | null;
  /** ... or a quick connect line. */
  target: string | null;
  label: string;
  summary: string;
}

/** The main window's answer (mcp.rs OpenResult). */
export interface AiOpenResult {
  accept: boolean;
  pane?: string;
  needsLogin?: boolean;
  error?: string;
  title?: string;
}

/** Agent CLIs the pane menu can copy a setup command for. */
export type McpClient = "claude" | "codex" | "gemini";

/** Pane screen for the MCP `read_screen` tool (mcp.rs ScreenSnapshot). */
export interface McpScreenSnapshot {
  text: string;
  cols: number;
  rows: number;
  cursorX: number;
  cursorY: number;
  alternate: boolean;
}

export type SplitDirection = "horizontal" | "vertical";

export interface TerminalLeafNode {
  kind: "leaf";
  paneId: string;
  session: SessionConfig;
  status: ConnectionStatus;
  statusMessage?: string;
  rows: number;
  cols: number;
  reconnectCount: number;
  /** Custom tab title set by the user (rename). */
  title?: string;
  /** Tab color (CSS color) set from the tab menu. */
  color?: string | null;
  /** The connection already exists (tab moved from another window): do not connect. */
  attached?: boolean;
  /** Serialized screen + scrollback to restore when attaching. */
  restoreContent?: string;
  /** Locked: the tab cannot be closed and the connection cannot be dropped. */
  locked?: boolean;
  /** Open this SSH tab on the live connection of that pane (first connect only). */
  reuseFrom?: string;
  /** When the connection last came up (status bar uptime). Frontend only. */
  connectedAt?: number;
}

/** A split area with its own tab bar; every tab is one terminal. */
export interface PaneGroup {
  kind: "group";
  id: string;
  tabs: TerminalLeafNode[];
  activeTabId: string;
}

export interface GroupSplitNode {
  kind: "split";
  id: string;
  direction: SplitDirection;
  ratio: number;
  first: LayoutNode;
  second: LayoutNode;
}

export type LayoutNode = PaneGroup | GroupSplitNode;

export interface WorkspaceState {
  root: LayoutNode | null;
  activeGroupId: string | null;
}

/** WindTerm-style sync channels: input typed in a pane goes to every pane in its channel. */
export type SyncChannel = "A" | "B" | "C" | "D";

/**
 * off: no broadcast; visible: the active tab of every split group; all: every
 * terminal; channels: panes that joined the same channel (A-D) via the pane menu.
 */
export type SyncInputScope = "off" | "visible" | "all" | "channels";

/** Result of the update check (Rust `update::UpdateInfo`). */
export interface UpdateInfo {
  current: string;
  latest: string;
  available: boolean;
  url: string;
  notes: string;
  publishedAt?: string | null;
}
