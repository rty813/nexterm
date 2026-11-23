/**
 * Search over the settings dialog: an index of option labels (i18n keys) by tab, and
 * a matcher that checks every language's label so "代理" and "proxy" both find the
 * HTTP proxy whatever the UI language is.
 */

export type SettingsSearchTab =
  | "general"
  | "theme"
  | "terminal"
  | "mouse"
  | "logs"
  | "xserver"
  | "remote"
  | "sync"
  | "triggers"
  | "keys"
  | "toolbar"
  | "plugins";

export interface SettingsSearchEntry {
  tab: SettingsSearchTab;
  /** i18n key of the option's label as shown in the dialog. */
  key: string;
}

const entries = (tab: SettingsSearchTab, keys: string[]): SettingsSearchEntry[] => keys.map((key) => ({ tab, key }));

/** Labels of the options in each tab, in the order they appear. */
export const SETTINGS_SEARCH_INDEX: SettingsSearchEntry[] = [
  ...entries("general", [
    "settingsModal.language",
    "settingsModal.theme",
    "settingsModal.fontFamily",
    "settingsModal.fontSize",
    "settingsModal.cursorStyle",
    "settingsModal.scrollback",
    "fullHistory.enabled",
    "fullHistory.memoryMb",
    "fullHistory.diskMb",
    "settingsModal.cursorBlink",
    "settingsModal.syntaxHighlight",
    "settingsModal.terminalBehavior",
    "settingsModal.showTimestamps",
    "settingsModal.timestampMs",
    "settingsModal.gutterLineNumbers",
    "settingsModal.highlightCurrentLine",
    "settingsModal.windowSection",
    "toolbar.alwaysOnTop",
    "toolbar.opacity",
    "agent.section",
    "agent.tabActivity",
    "tabbar.hostSetting",
    "tabbar.cmdSetting",
    "tabbar.shellIntegration",
    "agent.screenDetect",
    "agent.notifySetting",
    "settingsModal.closeAction",
    "update.section",
    "update.checkAtStartup",
    "httpProxy.section",
    "httpProxy.mode",
    "httpProxy.url",
    "settingsModal.lockPasscode",
  ]),
  ...entries("theme", [
    "themeSettings.schemes",
    "themeSettings.editSelected",
    "themeSettings.name",
    "themeSettings.isLight",
    "themeSettings.termColors",
    "themeSettings.ansiColors",
    "themeSettings.guiColors",
    "themeSettings.preview",
    "themeSettings.background",
    "themeSettings.bgFit",
  ]),
  ...entries("terminal", [
    "st.startup",
    "st.startupSessions",
    "st.display",
    "st.altRows",
    "st.foldMargin",
    "st.wrapMarks",
    "st.whitespace",
    "st.confirm",
    "st.askCloseTab",
    "st.askCloseWindow",
    "st.pasteConfirm",
    "st.pasteConfirmAlt",
    "st.lockTimeout",
    "st.clipboard",
    "st.remoteRead",
    "st.remoteWrite",
    "st.ssh",
    "st.reuseSsh",
    "st.history",
    "st.historyOn",
    "st.historySize",
    "st.historyDays",
    "st.historyPerSession",
    "st.autoComplete",
    "st.acOn",
    "st.acRows",
    "st.acThreshold",
    "st.acPreselect",
    "st.acHistory",
    "st.acNames",
    "st.acOptions",
    "st.acQuick",
  ]),
  ...entries("mouse", [
    "mouse.terminal",
    "settingsModal.copyOnSelect",
    "settingsModal.wordSeparators",
    "settingsModal.wheelLines",
    "mouse.ctrlWheel",
    "mouse.double",
    "mouse.middle",
    "mouse.right",
    "mouse.tracking",
    "mouse.tClick",
    "mouse.tDouble",
    "mouse.tMiddle",
    "mouse.tRight",
    "mouse.tMove",
    "mouse.tWheel",
    "mouse.tabbar",
    "mouse.tabHoverSwitch",
  ]),
  ...entries("logs", [
    "settingsModal.logDir",
    "settingsModal.logFilePattern",
    "settingsModal.logTimestamp",
    "lg.section",
    "lg.type",
    "lg.linePattern",
    "lg.maxSize",
    "settingsModal.zmodemDir",
    "modem.section",
    "modem.zCmd",
    "modem.xCmd",
    "modem.xPacket",
    "modem.yCmd",
    "modem.yPacket",
    "sftp.settingsTitle",
    "sftp.protocol",
    "sftp.downloadDir",
    "sftp.editor",
    "sftp.concurrency",
    "sftp.conflictTitle",
    "sftp.followCwd",
    "sftp.preserveTimes",
  ]),
  ...entries("xserver", [
    "xs.enabled",
    "xs.mode",
    "xs.path",
    "xs.display",
    "xs.layout",
    "xs.autoStart",
    "xs.clipboard",
    "xs.primary",
    "xs.noAccessControl",
    "xs.keyhook",
    "xs.tray",
    "xs.extra",
  ]),
  ...entries("remote", ["remote.enabled", "remote.relayUrl", "remote.hostToken", "remote.readOnly", "remote.phones", "share.active"]),
  ...entries("sync", [
    "cfgSync.provider",
    "cfgSync.autoSync",
    "cfgSync.interval",
    "cfgSync.content",
    "cfgSync.password",
    "cfgSync.s3.endpoint",
    "cfgSync.s3.region",
    "cfgSync.s3.bucket",
    "cfgSync.s3.prefix",
    "cfgSync.s3.accessKeyId",
    "cfgSync.s3.secretAccessKey",
    "cfgSync.s3.pathStyle",
    "cfgSync.webdav.url",
    "cfgSync.webdav.username",
    "cfgSync.webdav.password",
    "cfgSync.gist.apiUrl",
    "cfgSync.gist.gistId",
    "cfgSync.gist.token",
    "cfgSync.folder.path",
    "cfgSync.exportTitle",
    "cfgSync.importTitle",
    "cfgSync.importMode",
    "cfgSync.fileName",
    "cfgSync.filePassword",
  ]),
  ...entries("triggers", ["trigger.name", "trigger.pattern", "trigger.action", "trigger.activation", "trigger.underline", "trigger.tooltip"]),
  ...entries("keys", ["keys.resetAll"]),
  ...entries("toolbar", ["toolbarEdit.reset"]),
];

export interface SettingsSearchHit extends SettingsSearchEntry {
  /** The label in the UI language (what the dialog shows). */
  label: string;
  /** True for the tab itself rather than an option in it. */
  isTab: boolean;
}

/** Label text without interpolation placeholders, trailing colons or ellipses. */
export function cleanLabel(text: string): string {
  return text
    .replace(/\{\{[^}]*\}\}/g, "")
    .replace(/[\s:：…]+$/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Options whose label (in any language) or tab name contains every word of the query.
 * `labels(key)` returns the label in the UI language first, then the other languages.
 * Tabs whose names match come first, then options matching on their own label (prefix
 * matches before the rest), then options found only through their tab's name.
 */
export function searchSettings(
  query: string,
  labels: (key: string) => string[],
  tabs: readonly SettingsSearchTab[],
  index: SettingsSearchEntry[] = SETTINGS_SEARCH_INDEX,
): SettingsSearchHit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const texts = (key: string) => labels(key).map((l) => cleanLabel(l).toLowerCase());
  const matchesAll = (haystacks: string[]) => words.every((w) => haystacks.some((h) => h.includes(w)));
  const tabKey = (tab: SettingsSearchTab) => `settingsModal.tab.${tab}`;

  const scored: { hit: SettingsSearchHit; score: number; order: number }[] = [];
  tabs.forEach((tab, i) => {
    if (matchesAll(texts(tabKey(tab)))) {
      scored.push({ hit: { tab, key: tabKey(tab), label: cleanLabel(labels(tabKey(tab))[0] ?? ""), isTab: true }, score: 0, order: i });
    }
  });
  const seen = new Set<string>();
  index.forEach((entry, i) => {
    const own = texts(entry.key);
    const label = cleanLabel(labels(entry.key)[0] ?? "");
    const id = `${entry.tab}\u0000${label}`;
    if (!label || seen.has(id)) return;
    let score: number;
    if (matchesAll(own)) score = own.some((t) => t.startsWith(words[0])) ? 1 : 2;
    else if (matchesAll([...own, ...texts(tabKey(entry.tab))])) score = 3;
    else return;
    seen.add(id);
    scored.push({ hit: { ...entry, label, isTab: false }, score, order: tabs.length + i });
  });
  return scored.sort((a, b) => a.score - b.score || a.order - b.order).map((s) => s.hit);
}

/**
 * The element showing `label` inside `root` (the field or checkbox row around it),
 * skipping hidden tabs. Exact text matches beat ones that only start with the label
 * (the opacity label carries its percentage).
 */
export function findSettingElement(root: HTMLElement, label: string): HTMLElement | null {
  const want = cleanLabel(label).toLowerCase();
  if (!want) return null;
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let prefix: HTMLElement | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || parent.closest(".hidden, option, script, style")) continue;
    const text = cleanLabel(parent.textContent ?? "").toLowerCase();
    if (!text.startsWith(want)) continue;
    const target = parent.closest<HTMLElement>("label, .field, .checkbox-row") ?? parent;
    if (text === want) return target;
    prefix ??= target;
  }
  return prefix;
}
