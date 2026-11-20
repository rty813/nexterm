import type {
  AppSettings,
  AutoCompleteSettings,
  HistorySettings,
  ModemSettings,
  MouseSettings,
  RemoteSettings,
  SyncCategory,
  SyncSettings,
  SftpSettings,
  XServerSettings,
} from "../types/domain";
import { cleanBookmarks } from "./sftpBookmarks";

/** Defaults follow WindTerm's global/wind.config and terminal/configs/session.config. */
export const DEFAULT_HISTORY: HistorySettings = { enabled: true, days: 30, size: 10000, perSession: true };

export const DEFAULT_AUTOCOMPLETE: AutoCompleteSettings = {
  enabled: true,
  threshold: 1,
  visibleRows: 7,
  preselect: false,
  history: true,
  quickCommands: true,
  commandNames: true,
  commandOptions: true,
};

export const DEFAULT_MOUSE: MouseSettings = {
  rightClick: "menu",
  middleClick: "paste",
  doubleClick: "word",
  ctrlWheelZoom: true,
  tracking: { click: true, doubleClick: true, middleClick: true, rightClick: false, move: true, wheel: true },
};

export const DEFAULT_MODEM: ModemSettings = {
  zmodemUploadCommand: "rz",
  xmodemUploadCommand: "rx %f",
  ymodemUploadCommand: "rb",
  xmodemPacket: 128,
  ymodemPacket: 1024,
};

export const DEFAULT_XSERVER: XServerSettings = {
  enabled: true,
  autoStart: false,
  path: "",
  display: -1,
  windowMode: "multiwindow",
  clipboard: true,
  primarySelection: true,
  keyhook: false,
  trayIcon: false,
  xkbLayout: "auto",
  xkbModel: "pc105",
  disableAccessControl: false,
  extraArgs: "",
};

export function historyOf(s: AppSettings): HistorySettings {
  return { ...DEFAULT_HISTORY, ...(s.history ?? {}) };
}

export function autoCompleteOf(s: AppSettings): AutoCompleteSettings {
  return { ...DEFAULT_AUTOCOMPLETE, ...(s.autoComplete ?? {}) };
}

export function mouseOf(s: AppSettings): MouseSettings {
  const m = s.mouse;
  // Older settings only had rightClickAction ("paste" copied a selection first).
  const legacyRight = s.rightClickAction === "paste" ? "copyPaste" : "menu";
  return {
    ...DEFAULT_MOUSE,
    rightClick: m?.rightClick ?? legacyRight,
    ...(m ?? {}),
    tracking: { ...DEFAULT_MOUSE.tracking, ...(m?.tracking ?? {}) },
  };
}

export function modemOf(s: AppSettings): ModemSettings {
  return { ...DEFAULT_MODEM, ...(s.modem ?? {}) };
}

export const DEFAULT_SFTP: SftpSettings = {
  concurrency: 3,
  conflict: "ask",
  preserveTimes: true,
  protocol: "auto",
  followCwd: false,
  showHidden: false,
  editor: "",
  downloadDir: "",
  bookmarks: [],
};

export function sftpOf(s: AppSettings): SftpSettings {
  const v = { ...DEFAULT_SFTP, ...(s.sftp ?? {}) };
  return { ...v, concurrency: Math.min(16, Math.max(1, Math.round(v.concurrency) || 3)), bookmarks: cleanBookmarks(v.bookmarks) };
}

export const DEFAULT_REMOTE: RemoteSettings = { enabled: false, relayUrl: "", hostToken: "", readOnly: false };

export function remoteOf(s: AppSettings): RemoteSettings {
  return { ...DEFAULT_REMOTE, ...(s.remote ?? {}) };
}

export const SYNC_CATEGORIES: SyncCategory[] = ["sessions", "quickCommands", "themes", "settings", "senders", "history", "plugins", "credentials"];
/** Selected unless the user changes it: plugin credentials (passwords, tokens) are opt-in. */
export const DEFAULT_SYNC_CATEGORIES: SyncCategory[] = SYNC_CATEGORIES.filter((c) => c !== "credentials");

export const DEFAULT_SYNC: SyncSettings = {
  provider: "none",
  s3: { endpoint: "", region: "", bucket: "", accessKeyId: "", secretAccessKey: "", prefix: "nexterm", pathStyle: false },
  webdav: { url: "", username: "", password: "" },
  folder: { path: "" },
  gist: { token: "", gistId: "", apiUrl: "" },
  fileName: "nexterm-config.json",
  password: "",
  categories: [...DEFAULT_SYNC_CATEGORIES],
  autoSync: false,
  intervalMin: 30,
};

export function syncOf(s: AppSettings): SyncSettings {
  const saved: Partial<SyncSettings> = s.sync ?? {};
  return {
    ...DEFAULT_SYNC,
    ...saved,
    s3: { ...DEFAULT_SYNC.s3, ...(saved.s3 ?? {}) },
    webdav: { ...DEFAULT_SYNC.webdav, ...(saved.webdav ?? {}) },
    folder: { ...DEFAULT_SYNC.folder, ...(saved.folder ?? {}) },
    gist: { ...DEFAULT_SYNC.gist, ...(saved.gist ?? {}) },
    categories: Array.isArray(saved.categories) ? saved.categories : [...DEFAULT_SYNC_CATEGORIES],
  };
}

export function xserverOf(s: AppSettings): XServerSettings {
  return { ...DEFAULT_XSERVER, ...(s.xserver ?? {}) };
}
