import type { QuickCommand, SessionConfig } from "../types/domain";

export type DockedViewLocation = "sidebar" | "panel" | "tab";
export type ViewLocation = DockedViewLocation | "settings" | "dialog";
export const isModalLocation = (location: ViewLocation): location is "settings" | "dialog" => location === "settings" || location === "dialog";
export interface PluginCommand { id: string; title: string; shortcut?: string }
export interface PluginViewSize { width?: number; height?: number }
export interface PluginView { id: string; title: string; location: ViewLocation; file: string; size?: PluginViewSize }
/** Dialog sizes in CSS pixels; the host still clamps them to the window. */
export const VIEW_SIZE_LIMITS = {width: [320, 2400], height: [200, 1600]} as const;
export function viewSize(value: unknown): PluginViewSize {
  if (!isRecord(value) || Object.keys(value).some(key => key !== "width" && key !== "height") || (value.width === undefined && value.height === undefined)) throw new Error("Invalid view size");
  const size: PluginViewSize = {};
  for (const key of ["width", "height"] as const) {
    const item = value[key];
    if (item === undefined) continue;
    const [min, max] = VIEW_SIZE_LIMITS[key];
    if (typeof item !== "number" || !Number.isInteger(item) || item < min || item > max) throw new Error(`View ${key} must be an integer between ${min} and ${max}`);
    size[key] = item;
  }
  return size;
}
const validViewSize = (value: unknown) => { try { viewSize(value); return true; } catch { return false; } };
export interface PluginItem { id: string; text: string; tooltip?: string; command: string }
export function statusLabelPrefix(declared: string, current: string): string {
  const prefix = declared.match(/^[^:：\n]+(?:：\s*|:\s+)/)?.[0];
  return prefix && current.startsWith(prefix) && current.slice(prefix.length).trim() ? prefix : "";
}
/**
 * A quick command a plugin adds to the quick bar: either `text` sent to the active terminal (line
 * breaks as Enter, like the user's own quick commands) or `command`, one of the plugin's commands.
 */
export interface PluginQuickCommand { id: string; label: string; group?: string; text?: string; command?: string; enter?: boolean; escapes?: boolean; icon?: string; tooltip?: string }
export const QUICK_COMMAND_LIMITS = {count: 200, text: 4096} as const;
export interface PluginSessionSource { id: string; title: string; refreshCommand?: string; settingsView?: string }
export interface PluginSessionItem { id: string; label: string; description?: string; group?: string }
export interface PluginSessionCatalog { state: "loading" | "ready" | "signedOut" | "error"; items: PluginSessionItem[]; message?: string }
export interface PluginSessionChoice { id: string; label: string }
export interface PluginManifest {
  apiVersion: 1;
  id: string;
  name: string;
  version: string;
  main: string;
  permissions: { network: string[]; networkRequest?: true; sessions?: "open"; credentials?: "store" };
  contributes: {
    commands?: PluginCommand[];
    views?: PluginView[];
    statusBar?: PluginItem[];
    toolbar?: PluginItem[];
    menus?: { command: string; title: string; selectionOnly?: boolean }[];
    sessionSources?: PluginSessionSource[];
    quickCommands?: PluginQuickCommand[];
  };
}
export interface PluginPackage { manifest: PluginManifest; files: Record<string, string> }
/** Where an installed plugin came from: updates and revocations are only taken from that store. */
export interface PluginSource { storeId: string; storeName: string; version: string; sha256: string }
export interface InstalledPlugin { bundle: PluginPackage; enabled: boolean; revision: string; hidden: string[]; approvedOrigins?: string[]; source?: PluginSource; config?: Record<string, unknown> }
export function pluginSource(value: unknown): PluginSource | undefined {
  if (!isRecord(value) || typeof value.storeId !== "string" || !/^[0-9a-f]{16}$/.test(value.storeId) || typeof value.storeName !== "string" || value.storeName.length > 200 || typeof value.version !== "string" || value.version.length > 100 || typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256)) return undefined;
  return {storeId: value.storeId, storeName: value.storeName, version: value.version, sha256: value.sha256};
}
export interface SshRequest { host: string; port: number; username: string; label: string; passwordKey?: string }

const identifier = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 200;
export const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export function httpsOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hostname.includes("*") || url.origin !== value) throw new Error("Network permissions must be exact HTTPS origins");
  return url.origin;
}
export function parsePackage(value: unknown): PluginPackage {
  const fail = (): never => { throw new Error("Invalid Nexterm plugin package (API v1)"); };
  if (!isRecord(value) || !isRecord(value.manifest) || !isRecord(value.files)) return fail();
  const manifest = value.manifest;
  if (manifest.apiVersion !== 1 || !identifier(manifest.id) || !text(manifest.name) || !text(manifest.version) || !identifier(manifest.main)) return fail();
  if (!isRecord(manifest.permissions) || !Array.isArray(manifest.permissions.network) || manifest.permissions.network.length > 16) return fail();
  if (Object.keys(manifest.permissions).some(name => !["network", "networkRequest", "sessions", "credentials"].includes(name))) return fail();
  if (manifest.permissions.networkRequest !== undefined && manifest.permissions.networkRequest !== true) return fail();
  for (const origin of manifest.permissions.network) { if (typeof origin !== "string") return fail(); httpsOrigin(origin); }
  if (manifest.permissions.sessions !== undefined && manifest.permissions.sessions !== "open") return fail();
  if (manifest.permissions.credentials !== undefined && manifest.permissions.credentials !== "store") return fail();
  const files = value.files;
  const names = Object.keys(files);
  if (names.length > 64 || !names.includes(manifest.main) || names.some(name => !identifier(name) || typeof files[name] !== "string")) return fail();
  if (JSON.stringify(value).length > 2 * 1024 * 1024) throw new Error("Plugin package exceeds 2 MiB");
  if (!isRecord(manifest.contributes)) return fail();
  const contributes = manifest.contributes;
  if (Object.keys(contributes).some(name => !["commands", "views", "statusBar", "toolbar", "menus", "sessionSources", "quickCommands"].includes(name))) return fail();
  const ids = new Set<string>();
  for (const kind of ["commands", "views", "statusBar", "toolbar", "menus", "sessionSources", "quickCommands"]) {
    const list = contributes[kind];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length > (kind === "quickCommands" ? QUICK_COMMAND_LIMITS.count : 32)) return fail();
    for (const item of list) {
      if (!isRecord(item)) return fail();
      if (kind !== "menus") { if (!identifier(item.id) || ids.has(item.id)) return fail(); ids.add(item.id); }
      if (kind === "commands" && (!text(item.title) || (item.shortcut !== undefined && !text(item.shortcut)))) return fail();
      if (kind === "views" && (!text(item.title) || !["sidebar", "panel", "tab", "settings", "dialog"].includes(String(item.location)) || typeof item.file !== "string" || !names.includes(item.file) || (item.size !== undefined && (!isModalLocation(item.location as ViewLocation) || !validViewSize(item.size))))) return fail();
      if (["statusBar", "toolbar"].includes(kind) && (!text(item.text) || !identifier(item.command) || (item.tooltip !== undefined && !text(item.tooltip)))) return fail();
      if (kind === "menus" && (!text(item.title) || !identifier(item.command) || (item.selectionOnly !== undefined && typeof item.selectionOnly !== "boolean"))) return fail();
      if (kind === "quickCommands" && !validQuickCommand(item)) return fail();
      if (kind === "sessionSources" && (!text(item.title) || (item.refreshCommand !== undefined && !identifier(item.refreshCommand)) || (item.settingsView !== undefined && !identifier(item.settingsView)))) return fail();
    }
  }
  const commands = new Set((contributes.commands as PluginCommand[] | undefined)?.map(command => command.id));
  for (const item of [...(contributes.statusBar as PluginItem[] ?? []), ...(contributes.toolbar as PluginItem[] ?? []), ...(contributes.menus as {command: string}[] ?? [])]) if (!commands.has(item.command)) return fail();
  for (const item of contributes.quickCommands as PluginQuickCommand[] ?? []) if (item.command !== undefined && !commands.has(item.command)) return fail();
  for (const source of contributes.sessionSources as PluginSessionSource[] ?? []) {
    if (manifest.permissions.sessions !== "open" || (source.refreshCommand && !commands.has(source.refreshCommand)) || (source.settingsView && !(contributes.views as PluginView[] | undefined)?.some(view => view.id === source.settingsView && view.location === "settings"))) return fail();
  }
  return value as unknown as PluginPackage;
}

const QUICK_KEYS = ["id", "label", "group", "text", "command", "enter", "escapes", "icon", "tooltip"];
/** "shape-color" as quick commands store it; unknown shapes and colors fall back when shown. */
const quickIcon = (value: unknown) => typeof value === "string" && /^[a-z]{1,20}(?:-(?:[a-z]{1,30}|#[0-9a-fA-F]{3,8}))?$/.test(value);
function validQuickCommand(item: Record<string, unknown>): boolean {
  if (Object.keys(item).some(key => !QUICK_KEYS.includes(key)) || !boundedText(item.label, 100) || (item.group !== undefined && !boundedText(item.group, 100)) || (item.tooltip !== undefined && !boundedText(item.tooltip, 500)) || (item.icon !== undefined && !quickIcon(item.icon))) return false;
  // Exactly one of: text for the terminal, or a declared plugin command.
  if ((item.text === undefined) === (item.command === undefined)) return false;
  if (item.command !== undefined) return identifier(item.command) && item.enter === undefined && item.escapes === undefined;
  return typeof item.text === "string" && item.text.length > 0 && item.text.length <= QUICK_COMMAND_LIMITS.text && !item.text.includes("\0") &&
    (item.enter === undefined || typeof item.enter === "boolean") && (item.escapes === undefined || typeof item.escapes === "boolean");
}

/** A plugin's quick command as the quick bar shows it: read-only, not saved with the user's own. */
export interface ContributedQuickCommand extends QuickCommand { pluginId: string; pluginName: string; contributionId: string; pluginCommand?: string; tooltip?: string }
export const isContributedQuick = (value: QuickCommand): value is ContributedQuickCommand => "pluginId" in value;
export function contributedQuickCommand(pluginId: string, pluginName: string, item: PluginQuickCommand): ContributedQuickCommand {
  const base = {id: `plugin:${pluginId}:${item.id}`, label: item.label, group: item.group ?? pluginName, pluginId, pluginName, contributionId: item.id, ...(item.icon ? {icon: item.icon} : {}), ...(item.tooltip ? {tooltip: item.tooltip} : {})};
  if (item.command !== undefined) return {...base, kind: "action", command: "", appendNewline: false, pluginCommand: item.command};
  return {...base, kind: "text", command: item.text!.replace(/\r\n|\n/g, "\r"), appendNewline: item.enter ?? true, ...(item.escapes ? {escapes: true} : {})};
}

const boundedText = (value: unknown, limit: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value);
export function sessionCatalog(value: unknown): PluginSessionCatalog {
  if (!isRecord(value) || !["loading", "ready", "signedOut", "error"].includes(String(value.state)) || !Array.isArray(value.items) || value.items.length > 1000 || (value.state === "signedOut" && value.items.length > 0) || (value.message !== undefined && !boundedText(value.message, 500)) || JSON.stringify(value).length > 240000) throw new Error("Invalid session catalog batch (up to 1000 items / 240000 characters)");
  const ids = new Set<string>();
  const items = value.items.map(item => {
    if (!isRecord(item) || !boundedText(item.id, 200) || ids.has(item.id) || !boundedText(item.label, 200) || (item.description !== undefined && !boundedText(item.description, 500)) || (item.group !== undefined && !boundedText(item.group, 200))) throw new Error("Invalid session item");
    ids.add(item.id);
    return {id: item.id, label: item.label, ...(item.description ? {description: item.description} : {}), ...(item.group ? {group: item.group} : {})} as PluginSessionItem;
  });
  return {state: value.state as PluginSessionCatalog["state"], items, ...(value.message ? {message: value.message as string} : {})};
}
export function sessionChoices(value: unknown): PluginSessionChoice[] {
  if (!Array.isArray(value) || !value.length || value.length > 64) throw new Error("Invalid session account choices");
  const ids = new Set<string>();
  return value.map(item => {
    if (!isRecord(item) || !boundedText(item.id, 200) || ids.has(item.id) || !boundedText(item.label, 200)) throw new Error("Invalid session account choice");
    ids.add(item.id); return {id: item.id, label: item.label};
  });
}
export const sessionSourceKey = (pluginId: string, sourceId: string, itemId?: string) => `plugin:${pluginId}:${sourceId}${itemId === undefined ? "" : ":" + encodeURIComponent(itemId)}`;
/** Which plugin session item (and account) a temporary SSH tab was opened from; kept with the tab between runs. */
export interface PluginSessionOrigin { pluginId: string; sourceId: string; itemId: string; choiceId?: string }
export function pluginSessionOrigin(value: unknown): PluginSessionOrigin | undefined {
  if (!isRecord(value) || !boundedText(value.pluginId, 200) || !boundedText(value.sourceId, 200) || !boundedText(value.itemId, 200) || (value.choiceId !== undefined && !boundedText(value.choiceId, 200))) return undefined;
  return {pluginId: value.pluginId, sourceId: value.sourceId, itemId: value.itemId, ...(value.choiceId !== undefined ? {choiceId: value.choiceId} : {})};
}

export function temporarySsh(value: unknown): SessionConfig {
  if (!isRecord(value) || !text(value.host) || !/^[a-zA-Z0-9.:-]+$/.test(value.host) || !text(value.username) || /[\r\n\0]/.test(value.username) || !Number.isInteger(value.port) || Number(value.port) < 1 || Number(value.port) > 65535 || !text(value.label) || (value.passwordKey !== undefined && !identifier(value.passwordKey))) throw new Error("Invalid SSH connection parameters");
  return {id: crypto.randomUUID(), label: value.label, group: "", protocol: "ssh", host: value.host, port: Number(value.port), username: value.username, authType: "none", term: "xterm-256color", keepAliveSecs: 30};
}
