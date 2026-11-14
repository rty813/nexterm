import type {
  AppSettings,
  AutoCompleteSettings,
  HistorySettings,
  ModemSettings,
  MouseSettings,
  RemoteSettings,
  SftpSettings,
  XServerSettings,
} from "../types/domain";

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
};

export function sftpOf(s: AppSettings): SftpSettings {
  const v = { ...DEFAULT_SFTP, ...(s.sftp ?? {}) };
  return { ...v, concurrency: Math.min(16, Math.max(1, Math.round(v.concurrency) || 3)) };
}

export const DEFAULT_REMOTE: RemoteSettings = { enabled: false, relayUrl: "", hostToken: "", readOnly: false };

export function remoteOf(s: AppSettings): RemoteSettings {
  return { ...DEFAULT_REMOTE, ...(s.remote ?? {}) };
}

export function xserverOf(s: AppSettings): XServerSettings {
  return { ...DEFAULT_XSERVER, ...(s.xserver ?? {}) };
}
