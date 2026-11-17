import { Channel, invoke } from "@tauri-apps/api/core";
import { emit, emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { utf8Base64 } from "../utils/zmodemDrop";
import type { RemoteEntry } from "../utils/sftpPaths";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import type {
  AiControl,
  AiControlRequest,
  AiOpenRequest,
  AiOpenResult,
  AiControlMode,
  AppSettings,
  AppStateSnapshot,
  DiscoveryCandidate,
  ImportResult,
  McpClient,
  McpScreenSnapshot,
  QuickCommand,
  SessionConfig,
  TunnelConfig,
  TerminalStatePayload,
  ConfigBundleInfo,
  SyncCategory,
  SyncOutcome,
  SyncSettings,
  SyncStateInfo,
} from "../types/domain";
import type { HistoryInfo, HistoryPage } from "../utils/historyView";

/** One step of a full-history search (history/mod.rs SearchResult). */
/** A search or highlight rule for the full history (history/search.rs QuerySpec). */
export interface HistoryQuery {
  pattern: string;
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
}

export interface HistoryMatch {
  line: number;
  /** Line number as the margin shows it (starts over after each clear). */
  no: number;
  /** UTF-16 offsets in the line's text. */
  start: number;
  end: number;
  /** The line around the match, starting at UTF-16 offset ctxOffset of the line. */
  ctx: string;
  ctxOffset: number;
}

/** Full-history search results (history/mod.rs SearchResult). */
export interface HistorySearchResult {
  matches: HistoryMatch[];
  /** Where to continue; null: reached the end in that direction. */
  next: number | null;
}

/** Scrollbar marks and counts per query (history/mod.rs Marks). */
export interface HistoryMarks {
  first: number;
  total: number;
  counts: number[];
  /** Buckets of [first, total) with matches, per query. */
  buckets: number[][];
  /** Per query: why it does not compile, or null. */
  errors: (string | null)[];
}

export interface HostKeyPromptPayload {
  requestId: string;
  instanceId: string;
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
  changed: boolean;
  knownHosts: string;
}

export type { RemoteEntry };

export interface SftpListing {
  path: string;
  entries: RemoteEntry[];
  /** "scp": the server has no SFTP; listed with shell commands, transfers use SCP. */
  mode: "sftp" | "scp";
}

/** Mirrors transfer.rs ConflictInfo. */
export interface TransferConflict {
  path: string;
  isDir: boolean;
  srcSize: number;
  srcMtime?: number | null;
  dstSize: number;
  dstMtime?: number | null;
}

/** Mirrors transfer.rs TransferInfo. */
export interface TransferInfo {
  id: string;
  instanceId: string;
  label: string;
  direction: "upload" | "download";
  protocol: "" | "sftp" | "scp" | "zmodem" | "xmodem" | "ymodem";
  name: string;
  localPath?: string | null;
  remotePath: string;
  isDir: boolean;
  state: "queued" | "running" | "paused" | "conflict" | "done" | "error" | "cancelled";
  total: number;
  transferred: number;
  filesTotal: number;
  filesDone: number;
  skipped: number;
  current?: string | null;
  speed: number;
  error?: string | null;
  conflict?: TransferConflict | null;
  createdAt: number;
  finishedAt?: number | null;
}

export interface TransferRequest {
  instanceId: string;
  direction: "upload" | "download";
  /** Upload: the source. Download: the full local target (folder + name). */
  localPath: string;
  /** Upload: the full remote target. Download: the source. */
  remotePath: string;
  isDir?: boolean;
  options: {
    conflict: string;
    preserveTimes: boolean;
    protocol: string;
    /** Staging folder of dropped files, deleted when the job is over. */
    cleanup?: string | null;
  };
}

/** Mirrors sftp.rs EditInfo. */
export interface SftpEditInfo {
  id: string;
  instanceId: string;
  remotePath: string;
  localPath: string;
  state: "watching" | "uploading" | "error" | "stopped";
  uploads: number;
  lastUpload?: number | null;
  error?: string | null;
}

export interface TunnelStatus {
  id: string;
  config: TunnelConfig;
  boundPort: number;
  active: number;
  total: number;
}

export interface XServerStatus {
  running: boolean;
  display: number | null;
  pid: number | null;
  executable: string | null;
  enabled: boolean;
  message: string | null;
}

export interface RemotePhone {
  id: number;
  name: string;
  watching: string | null;
}

export interface RemoteStatus {
  state: "off" | "connecting" | "online" | "error";
  message: string | null;
  phones: RemotePhone[];
}

export interface RemotePairing {
  url: string;
  qrSvg: string;
}

/** A tab as phones see it (mirrors Rust `remote::RemoteTab`). */
export interface RemoteTab {
  id: string;
  title: string;
  status: string;
  cols: number;
  rows: number;
  active: boolean;
  /** Hostname the shell reported (empty when the title already shows it). */
  host: string;
  /** Command running in the pane right now. */
  command: string;
  /** AI agent state, e.g. "Claude Code: working". */
  agent: string;
  /** Session protocol: phones offer the file browser on SSH tabs. */
  protocol: string;
  /** Why the connection ended or failed. */
  message: string;
  /** Set while the pane's login form waits for a username / password. */
  auth: RemoteAuth | null;
  /** SSH with password auth: phones offer another password after a failure. */
  passwordAuth: boolean;
}

/** What a pane's login form asks for (mirrors Rust `remote::RemoteAuth`). */
export interface RemoteAuth {
  user: boolean;
  password: boolean;
  /** Prefill of the username field. */
  username: string;
}

/** Credentials a phone typed into a pane's login form; none: reconnect as is. */
export interface RemoteLoginPayload {
  paneId: string;
  username: string | null;
  password: string | null;
  remember: boolean;
}

export interface RemoteSizePayload {
  paneId: string;
  /** null: the phone gave the size back. */
  cols: number | null;
  rows: number | null;
}

export interface ModemStartedPayload {
  instanceId: string;
  direction: "receive" | "send";
  protocol: "XMODEM" | "YMODEM";
}

export interface ZmodemRequestPayload {
  instanceId: string;
  direction: "receive" | "send";
}

export interface ZmodemProgressPayload {
  instanceId: string;
  state: "running" | "done" | "error" | "cancelled";
  fileName?: string;
  fileIndex?: number;
  fileCount?: number;
  transferred?: number;
  total?: number;
  message?: string;
  files?: string[];
  dir?: string;
}

/** Label of the window this page runs in ("main", "term-...", "ctx-menu"). */
export function currentWindowLabel(): string {
  if (!isTauriRuntime()) return "main";
  try {
    return getCurrentWindow().label;
  } catch {
    return "main";
  }
}

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

const textEncoder = new TextEncoder();

export function encodeBytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const sub = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...sub);
  }
  return btoa(binary);
}

export function encodeTextToBase64(text: string): string {
  return encodeBytesToBase64(textEncoder.encode(text));
}

export function decodeBase64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/**
 * Browser preview only: a tiny line-editing "shell" so typing, history and completion can
 * be tried without the desktop backend. Echoes input, handles Backspace / Ctrl+C / Enter.
 */
const previewLines = new Map<string, string>();
function previewEcho(paneId: string, data: string): void {
  let line = previewLines.get(paneId) ?? "";
  let out = "";
  for (const ch of data) {
    if (ch === "\r" || ch === "\n") {
      out += "\r\n";
      const cmd = line.trim();
      if (cmd === "clear") out += "\x1b[H\x1b[2J";
      else if (cmd) for (let i = 1; i <= 6; i++) out += `${cmd}: output line ${i}\r\n`;
      out += "$ ";
      line = "";
    } else if (ch === "\x7f" || ch === "\b") {
      if (line) {
        line = line.slice(0, -1);
        out += "\b \b";
      }
    } else if (ch === "\x03") {
      out += "^C\r\n$ ";
      line = "";
    } else if (ch >= " ") {
      line += ch;
      out += ch;
    }
  }
  previewLines.set(paneId, line);
  if (out) {
    void import("./terminalBus").then(({ terminalBus }) => terminalBus.publish(paneId, new TextEncoder().encode(out)));
  }
}

export interface OutputSubscription {
  ack(bytes: number): void;
  dispose(): void;
}

const fallbackState: AppStateSnapshot = {
  sessions: [
    {
      id: "demo-ps",
      label: "Windows PowerShell",
      group: "本地终端",
      protocol: "powershell",
      host: "",
      port: 0,
      username: "",
      authType: "none",
      term: "xterm-256color",
      keepAliveSecs: 0,
    },
    {
      id: "demo-cmd",
      label: "命令提示符 (CMD)",
      group: "本地终端",
      protocol: "cmd",
      host: "",
      port: 0,
      username: "",
      authType: "none",
      term: "xterm-256color",
      keepAliveSecs: 0,
    },
  ],
  quickCommands: [],
  customThemes: [],
  settings: {
    language: "zh-CN",
    syntaxHighlight: true,
    closeToTray: true,
    logDir: null,
    logFilePattern: "%n_%Y-%m-%d_%H-%M-%S.log",
    logTimestamp: true,
    themeId: "dige-black",
    fontFamily: "'Cascadia Mono', Consolas, 'Roboto Mono', 'Microsoft YaHei UI', monospace",
    fontSize: 14,
    scrollback: 50000,
    cursorBlink: false,
    cursorStyle: "block",
    confirmBeforeClose: false,
    lockPasscode: null,
  },
};

/** JSON files in the app data directory (whitelisted in lib.rs DATA_FILES). */
export type DataFileName =
  | "command_history"
  | "senders"
  | "last_sessions"
  | "session_usage"
  | "last_workspace"
  | "ui_state"
  | "quick_connect_history";

/**
 * The current window's backdrop color, for new windows: WebView2 paints white until the
 * page has loaded otherwise. Read through a canvas, which resolves color-mix() for us.
 */
function backdropColor(): [number, number, number] | undefined {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    ctx.fillStyle = getComputedStyle(document.body).backgroundColor;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return [r, g, b];
  } catch {
    return undefined;
  }
}

export const backend = {
  async loadInitialState(): Promise<AppStateSnapshot> {
    if (!isTauriRuntime()) {
      return fallbackState;
    }
    return invoke<AppStateSnapshot>("load_initial_state");
  },

  async saveSessions(sessions: SessionConfig[]): Promise<void> {
    if (!isTauriRuntime()) return;
    await invoke("save_sessions", { sessions });
  },

  async saveQuickCommands(commands: QuickCommand[]): Promise<void> {
    if (!isTauriRuntime()) return;
    await invoke("save_quick_commands", { commands });
  },

  async saveSettings(settings: AppSettings): Promise<void> {
    if (!isTauriRuntime()) return;
    await invoke("save_settings", { settings });
  },

  /** `reuseFrom`: open the SSH shell on that pane's live connection (no new login). */
  async connectTerminal(
    instanceId: string,
    session: SessionConfig,
    cols: number,
    rows: number,
    reuseFrom?: string | null
  ): Promise<string | null> {
    if (!isTauriRuntime()) return null;
    return invoke<string | null>("connect_terminal", {
      instanceId,
      session,
      cols: Math.max(10, Math.floor(cols)),
      rows: Math.max(2, Math.floor(rows)),
      reuseFrom: reuseFrom ?? null,
    });
  },

  async writeTerminal(instanceId: string, textOrBytes: string | Uint8Array): Promise<void> {
    if (!isTauriRuntime()) {
      previewEcho(instanceId, typeof textOrBytes === "string" ? textOrBytes : new TextDecoder().decode(textOrBytes));
      return;
    }
    const dataB64 =
      typeof textOrBytes === "string"
        ? encodeTextToBase64(textOrBytes)
        : encodeBytesToBase64(textOrBytes);
    try {
      await invoke("write_terminal", { instanceId, dataB64 });
    } catch (e) {
      // The AI agent holds the pane; the pane shows why the keystroke went nowhere.
      if (e !== "ai-locked") throw e;
    }
  },

  async broadcastTerminal(
    instanceIds: string[],
    textOrBytes: string | Uint8Array
  ): Promise<void> {
    if (!isTauriRuntime()) {
      const text = typeof textOrBytes === "string" ? textOrBytes : new TextDecoder().decode(textOrBytes);
      instanceIds.forEach((id) => previewEcho(id, text));
      return;
    }
    if (instanceIds.length === 0) return;
    const dataB64 =
      typeof textOrBytes === "string"
        ? encodeTextToBase64(textOrBytes)
        : encodeBytesToBase64(textOrBytes);
    await invoke("broadcast_terminal", { instanceIds, dataB64 });
  },

  async resizeTerminal(instanceId: string, cols: number, rows: number): Promise<void> {
    if (!isTauriRuntime()) return;
    await invoke("resize_terminal", {
      instanceId,
      cols: Math.max(10, Math.floor(cols)),
      rows: Math.max(2, Math.floor(rows)),
    });
  },

  async disconnectTerminal(instanceId: string): Promise<void> {
    if (!isTauriRuntime()) return;
    await invoke("disconnect_terminal", { instanceId });
  },

  // ---- Full scrollback history (src-tauri/src/history/) ----

  /** null: no history for this pane (turned off, or never connected). */
  async historyInfo(instanceId: string): Promise<HistoryInfo | null> {
    if (!isTauriRuntime()) return null;
    return invoke<HistoryInfo | null>("history_info", { instanceId });
  },

  async historyLines(instanceId: string, from: number, count: number): Promise<HistoryPage | null> {
    if (!isTauriRuntime()) return null;
    return invoke<HistoryPage | null>("history_lines", { instanceId, from, count });
  },

  /** Matches from history line `from` on (or back), across the whole history. */
  async historySearch(instanceId: string, spec: HistoryQuery, from: number, backward: boolean, limit: number): Promise<HistorySearchResult> {
    if (!isTauriRuntime()) return { matches: [], next: null };
    return invoke<HistorySearchResult>("history_search", { instanceId, spec, from, backward, limit });
  },

  /** Where each query matches in the whole history (`buckets` slots) and how often; null: no history. */
  async historyMarks(instanceId: string, specs: HistoryQuery[], buckets: number): Promise<HistoryMarks | null> {
    if (!isTauriRuntime()) return null;
    return invoke<HistoryMarks | null>("history_marks", { instanceId, specs, buckets: Math.max(1, Math.round(buckets)) });
  },

  /** Matches before (line, UTF-16 offset start): the position shown as "3/120". */
  async historyRank(instanceId: string, spec: HistoryQuery, line: number, start: number): Promise<number> {
    return invoke<number>("history_rank", { instanceId, spec, line, start });
  },

  /** Write the whole history to a file; returns the number of lines written. */
  async historyExport(instanceId: string, path: string, ansi: boolean): Promise<number> {
    return invoke<number>("history_export", { instanceId, path, ansi });
  },

  /** History line where xterm.js's buffer starts (`sig`: its first lines); null if not found. */
  async historyLocate(instanceId: string, sig: string[], hint: number, window: number): Promise<number | null> {
    if (!isTauriRuntime()) return null;
    return invoke<number | null>("history_locate", { instanceId, sig, hint, window });
  },

  async historyClear(instanceId: string): Promise<void> {
    if (!isTauriRuntime()) return;
    await invoke("history_clear", { instanceId });
  },

  /** The pane closed for good: drop its history. */
  async historyDrop(instanceId: string): Promise<void> {
    if (!isTauriRuntime()) return;
    await invoke("history_drop", { instanceId });
  },

  /** Text written into xterm.js by the front end itself, so the history stays in step. */
  async historyFeed(instanceId: string, data: string): Promise<void> {
    if (!isTauriRuntime()) return;
    await invoke("history_feed", { instanceId, data });
  },

  async scanImportCandidates(): Promise<DiscoveryCandidate[]> {
    if (!isTauriRuntime()) return [];
    return invoke<DiscoveryCandidate[]>("scan_import_candidates");
  },

  async executeImport(sourceType: string, path: string): Promise<ImportResult> {
    if (!isTauriRuntime()) {
      return { sessions: [], themes: [], quickCommands: [], summary: "Browser preview mode" };
    }
    return invoke<ImportResult>("execute_import", { sourceType, path });
  },

  /** The local WindTerm quick commands (quickbar.config), without saving them; null when none. */
  async readWindTermQuickCommands(): Promise<QuickCommand[] | null> {
    if (!isTauriRuntime()) return null;
    return invoke<QuickCommand[] | null>("read_windterm_quick_commands");
  },

  async listSerialPorts(): Promise<string[]> {
    if (!isTauriRuntime()) return [];
    try {
      return await invoke<string[]>("list_serial_ports");
    } catch {
      return [];
    }
  },

  async pickFile(title: string, extensions?: string[]): Promise<string | null> {
    if (!isTauriRuntime()) return null;
    const selected = await open({
      title,
      multiple: false,
      directory: false,
      filters: extensions?.length
        ? [{ name: title, extensions }]
        : undefined,
    });
    return typeof selected === "string" ? selected : null;
  },

  async setWindowFullscreen(fullscreen: boolean): Promise<void> {
    if (!isTauriRuntime()) return;
    try {
      await getCurrentWindow().setFullscreen(fullscreen);
    } catch {
      // Ignore if window state transition is busy
    }
  },

  async respondHostKey(requestId: string, decision: "reject" | "acceptOnce" | "acceptAndSave"): Promise<void> {
    if (!isTauriRuntime()) return;
    await invoke("respond_host_key", { requestId, decision });
  },

  async tunnelList(instanceId: string): Promise<TunnelStatus[]> {
    if (!isTauriRuntime()) return [];
    return invoke<TunnelStatus[]>("tunnel_list", { instanceId });
  },

  async tunnelStart(instanceId: string, tunnel: TunnelConfig): Promise<TunnelStatus[]> {
    if (!isTauriRuntime()) throw new Error("Browser preview mode");
    return invoke<TunnelStatus[]>("tunnel_start", { instanceId, tunnel });
  },

  async tunnelStop(instanceId: string, id: string): Promise<TunnelStatus[]> {
    if (!isTauriRuntime()) return [];
    return invoke<TunnelStatus[]>("tunnel_stop", { instanceId, id });
  },

  async sshExec(instanceId: string, command: string): Promise<string> {
    if (!isTauriRuntime()) throw new Error("Browser preview mode");
    return invoke<string>("ssh_exec", { instanceId, command });
  },

  /** Execute agent hook setup in the WSL session's default distribution. */
  async wslAgentExec(instanceId: string, command: string): Promise<string> {
    if (!isTauriRuntime()) throw new Error("Browser preview mode");
    return invoke<string>("wsl_agent_exec", { instanceId, command });
  },

  /** Integration observed on this connection; null if the connection is unavailable. */
  async shellIntegrationStatus(instanceId: string): Promise<{ detected: boolean; loading: boolean } | null> {
    if (!isTauriRuntime()) return null;
    return invoke("shell_integration_status", { instanceId });
  },

  /** Install for the shell's current user, load now (echo hidden) and wait for the result. */
  async injectShellIntegration(instanceId: string): Promise<"loaded" | "failed" | "unsupported" | "noAnswer"> {
    if (!isTauriRuntime()) throw new Error("Browser preview mode");
    return invoke("inject_shell_integration", { instanceId });
  },

  async zmodemStart(instanceId: string, files: string[], dir?: string | null): Promise<void> {
    if (!isTauriRuntime()) return;
    await invoke("zmodem_start", { instanceId, files, dir: dir ?? null });
  },

  /**
   * Copy a file dropped on a terminal to a temporary folder (batch `token`), in chunks, and
   * return its path for zmodemStart. The webview has the file's contents but not its path.
   */
  async zmodemStageFile(token: string, file: File, onProgress?: (written: number) => void): Promise<string> {
    if (!isTauriRuntime()) return file.name;
    const CHUNK = 4 * 1024 * 1024;
    const name = utf8Base64(file.name);
    let path = "";
    let offset = 0;
    do {
      const bytes = new Uint8Array(await file.slice(offset, offset + CHUNK).arrayBuffer());
      path = await invoke<string>("zmodem_stage_chunk", bytes, {
        headers: { "x-token": token, "x-name": name, "x-append": offset > 0 ? "1" : "0" },
      });
      offset += bytes.length;
      onProgress?.(offset);
    } while (offset < file.size);
    return path;
  },

  /** Delete a batch of staged drop files, or every leftover one (null). */
  async zmodemUnstage(token: string | null): Promise<void> {
    if (!isTauriRuntime()) return;
    await invoke("zmodem_unstage", { token }).catch(() => undefined);
  },

  // ------------------------------------------------------------ SFTP file browser / transfer queue

  async sftpHome(instanceId: string): Promise<string> {
    if (!isTauriRuntime()) throw new Error("Browser preview mode");
    return invoke<string>("sftp_home", { instanceId });
  },

  async sftpList(instanceId: string, path: string): Promise<SftpListing> {
    if (!isTauriRuntime()) throw new Error("Browser preview mode");
    return invoke<SftpListing>("sftp_list", { instanceId, path });
  },

  async sftpStat(instanceId: string, path: string): Promise<RemoteEntry> {
    if (!isTauriRuntime()) throw new Error("Browser preview mode");
    return invoke<RemoteEntry>("sftp_stat", { instanceId, path });
  },

  async sftpMkdir(instanceId: string, path: string): Promise<void> {
    if (!isTauriRuntime()) throw new Error("Browser preview mode");
    await invoke("sftp_mkdir", { instanceId, path });
  },

  async sftpTouch(instanceId: string, path: string): Promise<void> {
    if (!isTauriRuntime()) throw new Error("Browser preview mode");
    await invoke("sftp_touch", { instanceId, path });
  },

  async sftpRename(instanceId: string, from: string, to: string): Promise<void> {
    if (!isTauriRuntime()) throw new Error("Browser preview mode");
    await invoke("sftp_rename", { instanceId, from, to });
  },

  async sftpRemove(instanceId: string, paths: string[]): Promise<void> {
    if (!isTauriRuntime()) throw new Error("Browser preview mode");
    await invoke("sftp_remove", { instanceId, paths });
  },

  async sftpChmod(instanceId: string, paths: string[], mode: number): Promise<void> {
    if (!isTauriRuntime()) throw new Error("Browser preview mode");
    await invoke("sftp_chmod", { instanceId, paths, mode });
  },

  async sftpSymlink(instanceId: string, link: string, target: string): Promise<void> {
    if (!isTauriRuntime()) throw new Error("Browser preview mode");
    await invoke("sftp_symlink", { instanceId, link, target });
  },

  /** Raw bytes of a remote file; rejects with "TOO_LARGE:<size>" above `limit`. */
  async sftpRead(instanceId: string, path: string, limit: number): Promise<ArrayBuffer> {
    if (!isTauriRuntime()) throw new Error("Browser preview mode");
    return invoke<ArrayBuffer>("sftp_read", { instanceId, path, limit });
  },

  /**
   * Copy one file (or empty folder: `file` null) dropped on the file browser into the
   * staging folder of `token`, at `rel` below it. Returns that staging folder.
   */
  async sftpStage(token: string, rel: string, file: File | null, onProgress?: (written: number) => void): Promise<string> {
    if (!isTauriRuntime()) return "";
    const CHUNK = 4 * 1024 * 1024;
    const headers = { "x-token": token, "x-rel": utf8Base64(rel) };
    if (!file) return invoke<string>("sftp_stage_chunk", new Uint8Array(), { headers: { ...headers, "x-dir": "1" } });
    let base = "";
    let offset = 0;
    do {
      const bytes = new Uint8Array(await file.slice(offset, offset + CHUNK).arrayBuffer());
      base = await invoke<string>("sftp_stage_chunk", bytes, { headers: { ...headers, "x-append": offset > 0 ? "1" : "0" } });
      offset += bytes.length;
      onProgress?.(bytes.length);
    } while (offset < file.size);
    return base;
  },

  async sftpEditStart(instanceId: string, path: string, program?: string): Promise<SftpEditInfo> {
    if (!isTauriRuntime()) throw new Error("Browser preview mode");
    return invoke<SftpEditInfo>("sftp_edit_start", { instanceId, path, program: program || null });
  },

  async sftpEditStop(id: string): Promise<void> {
    if (!isTauriRuntime()) return;
    await invoke("sftp_edit_stop", { id });
  },

  async sftpEditRetry(id: string): Promise<void> {
    if (!isTauriRuntime()) return;
    await invoke("sftp_edit_retry", { id });
  },

  async sftpEditList(): Promise<SftpEditInfo[]> {
    if (!isTauriRuntime()) return [];
    return invoke<SftpEditInfo[]>("sftp_edit_list");
  },

  async onSftpEdit(handler: (e: SftpEditInfo) => void): Promise<UnlistenFn> {
    if (!isTauriRuntime()) return () => {};
    return listen<SftpEditInfo>("sftp-edit", (e) => handler(e.payload));
  },

  async transferEnqueue(requests: TransferRequest[]): Promise<TransferInfo[]> {
    if (!isTauriRuntime()) return [];
    return invoke<TransferInfo[]>("transfer_enqueue", { requests });
  },

  async transferList(): Promise<TransferInfo[]> {
    if (!isTauriRuntime()) return [];
    return invoke<TransferInfo[]>("transfer_list");
  },

  async transferAction(action: "pause" | "resume" | "cancel" | "retry", id: string): Promise<void> {
    if (!isTauriRuntime()) return;
    await invoke(`transfer_${action}`, { id });
  },

  async transferAnswer(id: string, action: "overwrite" | "skip" | "rename" | "cancel", applyAll: boolean): Promise<void> {
    if (!isTauriRuntime()) return;
    await invoke("transfer_answer", { id, answer: { action, applyAll } });
  },

  /** Clear finished transfers (`ids`, or every finished one). */
  async transferRemove(ids?: string[]): Promise<void> {
    if (!isTauriRuntime()) return;
    await invoke("transfer_remove", { ids: ids ?? null });
  },

  async onTransferUpdate(handler: (t: TransferInfo) => void): Promise<UnlistenFn> {
    if (!isTauriRuntime()) return () => {};
    return listen<TransferInfo>("transfer-update", (e) => handler(e.payload));
  },

  async onTransferRemoved(handler: (ids: string[]) => void): Promise<UnlistenFn> {
    if (!isTauriRuntime()) return () => {};
    return listen<string[]>("transfer-removed", (e) => handler(e.payload));
  },

  /** Show a local file (selected) or folder in Explorer. */
  async revealPath(path: string): Promise<void> {
    if (!isTauriRuntime()) return;
    await invoke("reveal_path", { path });
  },

  async openLocalPath(path: string): Promise<void> {
    if (!isTauriRuntime()) return;
    await invoke("open_local_path", { path });
  },

  async pickDirectories(title: string, defaultPath?: string): Promise<string[]> {
    if (!isTauriRuntime()) return [];
    const selected = await open({ title, multiple: true, directory: true, defaultPath: defaultPath || undefined });
    if (!selected) return [];
    return Array.isArray(selected) ? selected : [selected];
  },

  async zmodemCancel(instanceId: string): Promise<void> {
    if (!isTauriRuntime()) return;
    await invoke("zmodem_cancel", { instanceId });
  },

  async listCharsets(): Promise<string[]> {
    if (!isTauriRuntime()) return ["UTF-8", "GBK", "GB18030", "Big5", "Shift_JIS", "EUC-KR", "ISO-8859-1"];
    return invoke<string[]>("list_charsets");
  },

  async setWindowOpacity(opacity: number): Promise<void> {
    if (!isTauriRuntime()) return;
    await invoke("set_window_opacity", { opacity });
  },

  async setAlwaysOnTop(on: boolean): Promise<void> {
    if (!isTauriRuntime()) return;
    await getCurrentWindow().setAlwaysOnTop(on).catch(() => undefined);
  },

  async pickFiles(title: string): Promise<string[]> {
    if (!isTauriRuntime()) return [];
    const selected = await open({ title, multiple: true, directory: false });
    if (!selected) return [];
    return Array.isArray(selected) ? selected : [selected];
  },

  async pickDirectory(title: string, defaultPath?: string): Promise<string | null> {
    if (!isTauriRuntime()) return null;
    const selected = await open({ title, multiple: false, directory: true, defaultPath: defaultPath || undefined });
    return typeof selected === "string" ? selected : null;
  },

  async onHostKeyPrompt(handler: (p: HostKeyPromptPayload) => void): Promise<UnlistenFn> {
    if (!isTauriRuntime()) return () => {};
    return listen<HostKeyPromptPayload>("host-key-prompt", (e) => handler(e.payload));
  },

  /** A phone answered a host key question (payload: its request id). */
  async onHostKeyResolved(handler: (requestId: string) => void): Promise<UnlistenFn> {
    if (!isTauriRuntime()) return () => {};
    return listen<string>("host-key-resolved", (e) => handler(e.payload));
  },

  async onZmodemRequest(handler: (p: ZmodemRequestPayload) => void): Promise<UnlistenFn> {
    if (!isTauriRuntime()) return () => {};
    return listen<ZmodemRequestPayload>("zmodem-request", (e) => handler(e.payload));
  },

  async onZmodemProgress(handler: (p: ZmodemProgressPayload) => void): Promise<UnlistenFn> {
    if (!isTauriRuntime()) return () => {};
    return listen<ZmodemProgressPayload>("zmodem-progress", (e) => handler(e.payload));
  },

  // ---------------- multiple windows ----------------

  /**
   * Open a new terminal window; with a token it adopts a tab parked by stashPaneTransfer.
   * `at` (physical screen px) puts the window's title bar under that point.
   */
  async openTerminalWindow(transferToken?: string, title = "Nexterm", at?: { x: number; y: number }): Promise<string> {
    const label = `term-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const hash = transferToken ? `#window&transfer=${transferToken}` : "#window";
    if (!isTauriRuntime()) {
      window.open(`${location.pathname}${hash}`, "_blank", "width=1200,height=760");
      return label;
    }
    const scale = at ? await getCurrentWindow().scaleFactor() : 1;
    new WebviewWindow(label, {
      url: `index.html${hash}`,
      title,
      width: 1000,
      height: 640,
      minWidth: 480,
      minHeight: 300,
      // HTML5 drag and drop (tabs between groups and windows) needs this off on Windows.
      dragDropEnabled: false,
      // Our own title bar (components/TitleBar.tsx).
      decorations: false,
      ...(at ? { x: Math.max(0, at.x / scale - 160), y: Math.max(0, at.y / scale - 16) } : {}),
      // The theme's backdrop instead of WebView2's white while the page loads.
      backgroundColor: backdropColor(),
    });
    return label;
  },

  async stashPaneTransfer(token: string, payload: unknown): Promise<void> {
    if (!isTauriRuntime()) {
      localStorage.setItem(`wtn-transfer-${token}`, JSON.stringify(payload));
      return;
    }
    await invoke("stash_pane_transfer", { token, payload });
  },

  async takePaneTransfer<T>(token: string): Promise<T | null> {
    if (!isTauriRuntime()) {
      const raw = localStorage.getItem(`wtn-transfer-${token}`);
      localStorage.removeItem(`wtn-transfer-${token}`);
      return raw ? (JSON.parse(raw) as T) : null;
    }
    return invoke<T | null>("take_pane_transfer", { token });
  },

  /** Other open terminal windows (label + title), for "move tab to window". */
  async listTerminalWindows(): Promise<{ label: string; title: string }[]> {
    if (!isTauriRuntime()) return [];
    const self = currentWindowLabel();
    const all = await WebviewWindow.getAll();
    const out: { label: string; title: string }[] = [];
    for (const w of all) {
      if (w.label === self || !(w.label === "main" || w.label.startsWith("term-"))) continue;
      out.push({ label: w.label, title: await w.title().catch(() => w.label) });
    }
    return out;
  },

  /** Windows toast; `tag` comes back through onNotificationClicked when it is clicked. */
  async showNotification(title: string, body: string, tag: string): Promise<void> {
    if (!isTauriRuntime()) {
      if ("Notification" in window && Notification.permission === "granted") new Notification(title, { body, tag });
      return;
    }
    await invoke("show_notification", { title, body, tag }).catch(() => undefined);
  },

  async onNotificationClicked(handler: (tag: string) => void): Promise<UnlistenFn> {
    if (!isTauriRuntime()) return () => {};
    return listen<{ tag: string }>("notification-clicked", (e) => handler(e.payload.tag));
  },

  /** Panes handed to the MCP agent (all windows). */
  async mcpControls(): Promise<AiControl[]> {
    if (!isTauriRuntime()) return [];
    return invoke<AiControl[]>("mcp_controls");
  },

  /** Hand a pane to the agent ("active"), pause it ("paused"), or take it back (null). */
  async mcpSetControl(instanceId: string, mode: AiControlMode | null, title = ""): Promise<void> {
    if (!isTauriRuntime()) return;
    await invoke("mcp_set_control", { instanceId, mode, title });
  },

  /** The command that adds Nexterm to Claude Code / Codex / Gemini CLI as an MCP server. */
  async mcpClientCommand(client: McpClient): Promise<string> {
    if (!isTauriRuntime()) {
      return client === "codex"
        ? "codex mcp add nexterm nexterm.exe mcp"
        : client === "gemini"
          ? "gemini mcp add --scope user nexterm nexterm.exe mcp"
          : "claude mcp add --scope user nexterm nexterm.exe mcp";
    }
    return invoke<string>("mcp_client_command", { client });
  },

  async onMcpControl(handler: (p: { instanceId: string; control: AiControl | null }) => void): Promise<UnlistenFn> {
    if (!isTauriRuntime()) return () => {};
    return listen<{ instanceId: string; control: AiControl | null }>("mcp-control", (e) => handler(e.payload));
  },

  /** The MCP `read_screen` tool asks the window showing the pane for its screen. */
  async onMcpReadScreen(handler: (p: { requestId: string; instanceId: string; scrollback: number }) => void): Promise<UnlistenFn> {
    if (!isTauriRuntime()) return () => {};
    return listen<{ requestId: string; instanceId: string; scrollback: number }>("mcp-read-screen", (e) => handler(e.payload));
  },

  /** request_control dialogs waiting for the user (all windows). */
  async mcpPendingRequests(): Promise<AiControlRequest[]> {
    if (!isTauriRuntime()) return [];
    return invoke<AiControlRequest[]>("mcp_pending_requests");
  },

  async mcpRespondRequest(requestId: string, accept: boolean, title: string): Promise<void> {
    if (!isTauriRuntime()) return;
    await invoke("mcp_respond_request", { requestId, accept, title });
  },

  /** An agent asks to operate a pane (MCP request_control). */
  async onMcpControlRequest(handler: (r: AiControlRequest) => void): Promise<UnlistenFn> {
    if (!isTauriRuntime()) return () => {};
    return listen<AiControlRequest>("mcp-control-request", (e) => handler(e.payload));
  },

  /** A request was answered (in any window), cancelled, or settled by a hand-over. */
  async onMcpControlRequestDone(handler: (requestId: string) => void): Promise<UnlistenFn> {
    if (!isTauriRuntime()) return () => {};
    return listen<{ requestId: string }>("mcp-control-request-done", (e) => handler(e.payload.requestId));
  },

  /** An agent asks to open a session in a new tab (MCP open_session). */
  async onMcpOpenRequest(handler: (r: AiOpenRequest) => void): Promise<UnlistenFn> {
    if (!isTauriRuntime()) return () => {};
    return listen<AiOpenRequest>("mcp-open-request", (e) => handler(e.payload));
  },

  /** An open_session request was answered or timed out. */
  async onMcpOpenRequestDone(handler: (requestId: string) => void): Promise<UnlistenFn> {
    if (!isTauriRuntime()) return () => {};
    return listen<{ requestId: string }>("mcp-open-request-done", (e) => handler(e.payload.requestId));
  },

  async mcpOpenRespond(requestId: string, result: AiOpenResult): Promise<void> {
    if (!isTauriRuntime()) return;
    await invoke("mcp_open_respond", { requestId, result });
  },

  /** The agent closes a pane it opened (MCP close_pane). */
  async onMcpClosePane(handler: (instanceId: string) => void): Promise<UnlistenFn> {
    if (!isTauriRuntime()) return () => {};
    return listen<{ instanceId: string }>("mcp-close-pane", (e) => handler(e.payload.instanceId));
  },

  /** The MCP `run_command` tool typed a command into a pane (for the command history). */
  async onMcpCommand(handler: (p: { instanceId: string; command: string }) => void): Promise<UnlistenFn> {
    if (!isTauriRuntime()) return () => {};
    return listen<{ instanceId: string; command: string }>("mcp-command", (e) => handler(e.payload));
  },

  async mcpScreenReply(requestId: string, snapshot: McpScreenSnapshot): Promise<void> {
    if (!isTauriRuntime()) return;
    await invoke("mcp_screen_reply", { requestId, snapshot });
  },

  /** Agent state reported by hooks of a local shell (through the app's local endpoint). */
  async onAgentStateEvent(handler: (p: { paneId: string; state: string; kind: string; app: string }) => void): Promise<UnlistenFn> {
    if (!isTauriRuntime()) return () => {};
    return listen<{ paneId: string; state: string; kind: string; app: string }>("agent-state", (e) => handler(e.payload));
  },

  async agentHooksReadLocal(): Promise<{
    claudeDir: boolean;
    codexDir: boolean;
    geminiDir: boolean;
    claudeSettings: string | null;
    codexHooks: string | null;
    geminiSettings: string | null;
    scriptInstalled: boolean;
    script: string | null;
  }> {
    if (!isTauriRuntime()) throw new Error("desktop only");
    return invoke("agent_hooks_read_local");
  },

  async agentHooksWriteLocal(files: {
    script: string | null;
    claudeSettings: string | null;
    codexHooks: string | null;
    geminiSettings: string | null;
  }): Promise<void> {
    if (!isTauriRuntime()) throw new Error("desktop only");
    await invoke("agent_hooks_write_local", { files });
  },

  /** Mouse cursor on screen, physical px. */
  async cursorPosition(): Promise<{ x: number; y: number } | null> {
    if (!isTauriRuntime()) return null;
    const p = await cursorPosition();
    return { x: p.x, y: p.y };
  },

  async mousePrimaryDown(): Promise<boolean> {
    if (!isTauriRuntime()) return false;
    return invoke<boolean>("mouse_primary_down");
  },

  /** Client areas (physical px) of the visible terminal windows, main first. */
  async terminalWindowBounds(exclude: string[] = []): Promise<{ label: string; x: number; y: number; w: number; h: number }[]> {
    if (!isTauriRuntime()) return [];
    const all = await WebviewWindow.getAll();
    const out: { label: string; x: number; y: number; w: number; h: number }[] = [];
    for (const w of all) {
      if (exclude.includes(w.label) || !(w.label === "main" || w.label.startsWith("term-"))) continue;
      try {
        if (!(await w.isVisible()) || (await w.isMinimized())) continue;
        const [pos, size] = await Promise.all([w.innerPosition(), w.innerSize()]);
        out.push({ label: w.label, x: pos.x, y: pos.y, w: size.width, h: size.height });
      } catch {
        // window closing
      }
    }
    return out.sort((a, b) => (a.label === "main" ? -1 : b.label === "main" ? 1 : 0));
  },

  /** Bring the main window up. False when it no longer exists. */
  async showMainWindow(): Promise<boolean> {
    if (!isTauriRuntime()) return false;
    const main = await WebviewWindow.getByLabel("main");
    if (!main) return false;
    await main.unminimize().catch(() => undefined);
    await main.show().catch(() => undefined);
    await main.setFocus().catch(() => undefined);
    return true;
  },

  async broadcast(event: string, payload: unknown): Promise<void> {
    if (!isTauriRuntime()) return;
    await emit(event, payload);
  },

  async onBroadcast<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
    if (!isTauriRuntime()) return () => {};
    return listen<T>(event, (e) => handler(e.payload));
  },

  async emitToWindow(label: string, event: string, payload: unknown): Promise<void> {
    if (!isTauriRuntime()) return;
    await emitTo(label, event, payload);
  },

  async onWindowEvent<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
    if (!isTauriRuntime()) return () => {};
    return getCurrentWindow().listen<T>(event, (e) => handler(e.payload));
  },

  async emitSettingsChanged(): Promise<void> {
    if (isTauriRuntime()) await emit("settings-changed");
  },

  async onSettingsChanged(handler: () => void): Promise<UnlistenFn> {
    if (!isTauriRuntime()) return () => {};
    return listen("settings-changed", () => handler());
  },

  async readClipboard(): Promise<string> {
    if (!isTauriRuntime()) return navigator.clipboard.readText().catch(() => "");
    return readText().catch(() => "");
  },

  async writeClipboard(text: string): Promise<void> {
    if (!text) return;
    if (!isTauriRuntime()) return navigator.clipboard.writeText(text).catch(() => undefined);
    await writeText(text).catch(() => undefined);
  },

  /** host / username / protocol fill %h %u %P of the log file name pattern. */
  async startSessionLog(
    instanceId: string,
    label: string,
    vars?: { host?: string; username?: string; protocol?: string }
  ): Promise<string> {
    if (!isTauriRuntime()) throw new Error("Browser preview mode");
    return invoke<string>("start_session_log", {
      instanceId,
      label,
      host: vars?.host ?? null,
      username: vars?.username ?? null,
      protocol: vars?.protocol ?? null,
    });
  },

  /** Pause / resume a running log; resolves to the new paused state. */
  async pauseSessionLog(instanceId: string, paused: boolean): Promise<boolean> {
    if (!isTauriRuntime()) return paused;
    return invoke<boolean>("pause_session_log", { instanceId, paused });
  },

  /** XMODEM / YMODEM transfer. target: file (XMODEM receive) or folder (YMODEM receive). */
  async modemStart(opts: {
    instanceId: string;
    protocol: "xmodem" | "ymodem";
    send: boolean;
    files?: string[];
    target?: string | null;
    command?: string | null;
    packetSize?: number;
  }): Promise<void> {
    if (!isTauriRuntime()) throw new Error("Browser preview mode");
    await invoke("modem_start", {
      instanceId: opts.instanceId,
      protocol: opts.protocol,
      send: opts.send,
      files: opts.files ?? [],
      target: opts.target ?? null,
      command: opts.command ?? null,
      packetSize: opts.packetSize ?? null,
    });
  },

  async onModemStarted(handler: (p: ModemStartedPayload) => void): Promise<UnlistenFn> {
    if (!isTauriRuntime()) return () => {};
    return listen<ModemStartedPayload>("modem-started", (e) => handler(e.payload));
  },

  /** JSON data kept next to settings.json: command_history, senders, last_sessions. */
  async loadDataFile<T>(name: DataFileName): Promise<T | null> {
    if (!isTauriRuntime()) {
      const raw = localStorage.getItem(`wtn-data-${name}`);
      return raw ? (JSON.parse(raw) as T) : null;
    }
    return invoke<T | null>("load_data_file", { name }).catch(() => null);
  },

  async saveDataFile(name: DataFileName, value: unknown): Promise<void> {
    if (!isTauriRuntime()) {
      localStorage.setItem(`wtn-data-${name}`, JSON.stringify(value));
      return;
    }
    await invoke("save_data_file", { name, value }).catch(() => undefined);
  },

  /** Write the selected categories to a file (encrypted when a password is given). */
  async configExport(path: string, categories: SyncCategory[], password: string): Promise<void> {
    await invoke("config_export", { path, categories, password });
  },

  async configInspect(path: string): Promise<ConfigBundleInfo> {
    return invoke<ConfigBundleInfo>("config_inspect", { path });
  },

  /** Returns the categories that were written. Every window gets `config-applied`. */
  async configImport(path: string, password: string, categories: SyncCategory[], mode: "merge" | "replace"): Promise<SyncCategory[]> {
    return invoke<SyncCategory[]>("config_import", { path, password, categories, mode });
  },

  /** Reach the sync target; what is stored there (null: nothing yet). */
  async syncTest(config: SyncSettings): Promise<ConfigBundleInfo | null> {
    return invoke<ConfigBundleInfo | null>("sync_test", { config });
  },

  async syncRun(config: SyncSettings, action: "auto" | "push" | "pull" | "merge"): Promise<SyncOutcome> {
    return invoke<SyncOutcome>("sync_run", { config, action });
  },

  async syncState(): Promise<SyncStateInfo | null> {
    if (!isTauriRuntime()) return null;
    return invoke<SyncStateInfo>("sync_state").catch(() => null);
  },

  /** Imported / downloaded config was written to disk (the categories it touched). */
  async onConfigApplied(handler: (categories: SyncCategory[]) => void): Promise<UnlistenFn> {
    if (!isTauriRuntime()) return () => undefined;
    return listen<SyncCategory[]>("config-applied", (e) => handler(e.payload));
  },

  async writeTextFile(path: string, content: string): Promise<void> {
    if (!isTauriRuntime()) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([content], { type: "text/plain" }));
      a.download = path.split(/[\\/]/).pop() || "output.txt";
      a.click();
      return;
    }
    await invoke("write_text_file", { path, content });
  },

  /** Save-as dialog; null when cancelled. */
  async pickSavePath(title: string, defaultPath: string, filters?: { name: string; extensions: string[] }[]): Promise<string | null> {
    if (!isTauriRuntime()) return defaultPath;
    const picked = await save({ title, defaultPath, filters });
    return typeof picked === "string" ? picked : null;
  },

  /** A saved session was opened (use count / last used, for sidebar sorting). */
  async recordSessionUse(id: string): Promise<void> {
    if (!isTauriRuntime()) {
      const raw = localStorage.getItem("wtn-data-session_usage");
      const usage = raw ? JSON.parse(raw) : {};
      usage[id] = { count: (usage[id]?.count ?? 0) + 1, lastUsed: Date.now() };
      localStorage.setItem("wtn-data-session_usage", JSON.stringify(usage));
      window.dispatchEvent(new CustomEvent("wtn-session-usage", { detail: usage }));
      return;
    }
    await invoke("record_session_use", { id }).catch(() => undefined);
  },

  async onSessionUsage(handler: (usage: Record<string, { count: number; lastUsed: number }>) => void): Promise<UnlistenFn> {
    if (!isTauriRuntime()) {
      const fn = (e: Event) => handler((e as CustomEvent).detail);
      window.addEventListener("wtn-session-usage", fn);
      return () => window.removeEventListener("wtn-session-usage", fn);
    }
    return listen<Record<string, { count: number; lastUsed: number }>>("session-usage", (e) => handler(e.payload));
  },

  /** Open a web / mail link in the system browser. */
  async openExternal(url: string): Promise<void> {
    if (!isTauriRuntime()) {
      window.open(url, "_blank", "noopener");
      return;
    }
    await invoke("open_external", { url });
  },

  /** Command names for completion, from WindTerm's terminal/commands (empty when absent). */
  async commandCatalog(scheme: string): Promise<{ name: string; description: string }[]> {
    if (!isTauriRuntime()) return [];
    return invoke<{ name: string; description: string }[]>("command_catalog", { scheme }).catch(() => []);
  },

  async commandOptions(scheme: string, name: string): Promise<{ flags: string[]; label: string; description: string }[]> {
    if (!isTauriRuntime()) return [];
    return invoke<{ flags: string[]; label: string; description: string }[]>("command_options", { scheme, name }).catch(() => []);
  },

  async remoteStatus(): Promise<RemoteStatus | null> {
    if (!isTauriRuntime()) return null;
    return invoke<RemoteStatus>("remote_status").catch(() => null);
  },

  async remotePairing(reset = false): Promise<RemotePairing | null> {
    if (!isTauriRuntime()) return null;
    return invoke<RemotePairing>(reset ? "remote_reset_pairing" : "remote_pairing").catch(() => null);
  },

  async remoteKick(phone: number): Promise<void> {
    if (isTauriRuntime()) await invoke("remote_kick", { phone }).catch(() => undefined);
  },

  async remoteReportTabs(tabs: RemoteTab[]): Promise<void> {
    if (isTauriRuntime()) await invoke("remote_report_tabs", { tabs }).catch(() => undefined);
  },

  async remoteWatchState(): Promise<{ watched: string[]; sizes: { paneId: string; cols: number; rows: number }[] }> {
    const none = { watched: [], sizes: [] };
    if (!isTauriRuntime()) return none;
    return invoke<typeof none>("remote_watch_state").catch(() => none);
  },

  async remoteRelease(paneId: string): Promise<void> {
    if (isTauriRuntime()) await invoke("remote_release", { paneId }).catch(() => undefined);
  },

  /** Records of a watched pane: [kind u8][len u32 LE][payload] (see remote.rs). */
  async remoteFeed(paneId: string, body: Uint8Array): Promise<void> {
    if (!isTauriRuntime()) return;
    await invoke("remote_feed", body, { headers: { "x-pane": paneId } }).catch(() => undefined);
  },

  async onRemoteState(handler: (s: RemoteStatus) => void): Promise<UnlistenFn> {
    if (!isTauriRuntime()) return () => {};
    return listen<RemoteStatus>("remote-state", (e) => handler(e.payload));
  },

  async onRemoteWatch(handler: (panes: string[]) => void): Promise<UnlistenFn> {
    if (!isTauriRuntime()) return () => {};
    return listen<string[]>("remote-watch", (e) => handler(e.payload));
  },

  async onRemoteSnapshot(handler: (paneId: string) => void): Promise<UnlistenFn> {
    if (!isTauriRuntime()) return () => {};
    return listen<string>("remote-snapshot", (e) => handler(e.payload));
  },

  /** A phone asked to open a saved session (payload: its id). */
  async onRemoteOpenSession(handler: (sessionId: string) => void): Promise<UnlistenFn> {
    if (!isTauriRuntime()) return () => {};
    return listen<string>("remote-open-session", (e) => handler(e.payload));
  },

  /** A phone asked to close a tab (payload: its pane id); it asked for confirmation itself. */
  async onRemoteClosePane(handler: (paneId: string) => void): Promise<UnlistenFn> {
    if (!isTauriRuntime()) return () => {};
    return listen<string>("remote-close-pane", (e) => handler(e.payload));
  },

  async onRemoteSize(handler: (p: RemoteSizePayload) => void): Promise<UnlistenFn> {
    if (!isTauriRuntime()) return () => {};
    return listen<RemoteSizePayload>("remote-size", (e) => handler(e.payload));
  },

  async onRemoteLogin(handler: (p: RemoteLoginPayload) => void): Promise<UnlistenFn> {
    if (!isTauriRuntime()) return () => {};
    return listen<RemoteLoginPayload>("remote-login", (e) => handler(e.payload));
  },

  async onRemotePhoneJoined(handler: (name: string) => void): Promise<UnlistenFn> {
    if (!isTauriRuntime()) return () => {};
    return listen<string>("remote-phone-joined", (e) => handler(e.payload));
  },

  async xserverStatus(): Promise<XServerStatus | null> {
    if (!isTauriRuntime()) return null;
    return invoke<XServerStatus>("xserver_status").catch(() => null);
  },

  async xserverStart(): Promise<XServerStatus> {
    if (!isTauriRuntime()) throw new Error("Browser preview mode");
    return invoke<XServerStatus>("xserver_start");
  },

  async xserverStop(): Promise<XServerStatus | null> {
    if (!isTauriRuntime()) return null;
    return invoke<XServerStatus>("xserver_stop");
  },

  async onXServerState(handler: (s: XServerStatus) => void): Promise<UnlistenFn> {
    if (!isTauriRuntime()) return () => {};
    return listen<XServerStatus>("xserver-state", (e) => handler(e.payload));
  },

  /** The backend asks before quitting with `count` sessions open (tray quit / closing the main window). */
  async onConfirmQuit(handler: (count: number) => void): Promise<UnlistenFn> {
    if (!isTauriRuntime()) return () => {};
    return getCurrentWindow().listen<number>("confirm-quit", (e) => handler(e.payload));
  },

  async stopSessionLog(instanceId: string): Promise<void> {
    if (!isTauriRuntime()) return;
    await invoke("stop_session_log", { instanceId });
  },

  async revealLog(path?: string | null): Promise<void> {
    if (!isTauriRuntime()) return;
    await invoke("reveal_log", { path: path ?? null });
  },

  /** Open (or focus) the standalone session manager window. */
  /** Cross-window notification: sessions.json was saved. */
  async emitSessionsChanged(): Promise<void> {
    if (isTauriRuntime()) await emit("sessions-changed");
  },

  async onSessionsChanged(handler: () => void): Promise<UnlistenFn> {
    if (!isTauriRuntime()) return () => {};
    return listen("sessions-changed", () => handler());
  },

  async reportLockedSessions(count: number): Promise<void> {
    if (!isTauriRuntime()) return;
    await invoke("report_locked_sessions", { count }).catch(() => undefined);
  },

  /** confirmed: the user already agreed to end the open sessions. */
  async quitApp(confirmed = false): Promise<void> {
    if (!isTauriRuntime()) return;
    await invoke("quit_app", { confirmed });
  },

  /**
   * Receive a pane's output as raw bytes over a binary channel. Call `ack(n)` once the
   * terminal has parsed n bytes: the backend sends at most ~512 KB ahead of that, and
   * stops reading the connection when it is far behind (flow control).
   */
  subscribeOutput(instanceId: string, handler: (bytes: Uint8Array) => void): OutputSubscription {
    if (!isTauriRuntime()) return { ack: () => {}, dispose: () => {} };
    const channel = new Channel<ArrayBuffer>((buf) => handler(new Uint8Array(buf)));
    const token = invoke<number>("subscribe_output", { instanceId, onOutput: channel });
    let unacked = 0;
    let timer = 0;
    let disposed = false;
    const send = () => {
      window.clearTimeout(timer);
      timer = 0;
      if (unacked === 0 || disposed) return;
      const bytes = unacked;
      unacked = 0;
      void invoke("ack_output", { instanceId, bytes }).catch(() => undefined);
    };
    return {
      // Acks are batched: big ones right away so the backend keeps streaming,
      // small interactive ones a moment later to save an IPC call per keystroke echo.
      ack: (bytes) => {
        unacked += bytes;
        if (unacked >= 64 * 1024) send();
        else if (!timer) timer = window.setTimeout(send, 16);
      },
      dispose: () => {
        send();
        disposed = true;
        channel.onmessage = () => {};
        void token.then((t) => invoke("unsubscribe_output", { instanceId, token: t })).catch(() => undefined);
      },
    };
  },

  async onTerminalState(
    handler: (payload: TerminalStatePayload) => void
  ): Promise<UnlistenFn> {
    if (!isTauriRuntime()) return () => {};
    return listen<TerminalStatePayload>("terminal-state", (event) => {
      handler(event.payload);
    });
  },
};
