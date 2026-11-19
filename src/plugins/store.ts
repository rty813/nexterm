import { isRecord, type InstalledPlugin, type PluginManifest, type PluginPackage } from "./model";

/** A configured store: identified by the Ed25519 key trusted when it was added, reachable at one or more mirror URLs. Synced. */
export interface PluginStoreConfig { id: string; name: string; publicKey: string; urls: string[]; enabled: boolean }
export type Permissions = PluginManifest["permissions"];
export interface StoreVersion { version: string; apiVersion: number; file: string; sha256: string; size: number; published: string; permissions: Permissions }
export interface StorePlugin { id: string; name: string; description?: {zh: string; en: string}; author?: string; homepage?: string; tags?: string[]; versions: StoreVersion[] }
export interface StoreRevocation { id: string; versions: string[]; reason?: string }
export interface StoreIndex { seq: number; generated: string; store: {name: string; publicKey: string}; plugins: StorePlugin[]; revoked: StoreRevocation[] }
/** A verified index together with the mirror it came from (packages are fetched from the same one). */
export interface StoreCatalog { store: PluginStoreConfig; index: StoreIndex; url: string }
export interface StoreOffer { store: PluginStoreConfig; url: string; plugin: StorePlugin; version: StoreVersion }

export const MAX_STORE_URLS = 8;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const PLUGIN_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/;
const STORE_ID = /^[0-9a-f]{16}$/;
const text = (value: unknown, limit: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= limit;

export const isVersion = (value: unknown): value is string => typeof value === "string" && SEMVER.test(value);
/** Semantic version order (same rules as scripts/plugin-store.mjs). Non-semver versions sort first. */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [SEMVER.exec(a), SEMVER.exec(b)];
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) < Number(y[i]) ? -1 : 1;
  if (!x[4] || !y[4]) return x[4] === y[4] ? 0 : x[4] ? -1 : 1;
  const [p, q] = [x[4].split("."), y[4].split(".")];
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined || q[i] === undefined) return p[i] === undefined ? -1 : 1;
    if (p[i] === q[i]) continue;
    const [m, n] = [/^\d+$/.test(p[i]), /^\d+$/.test(q[i])];
    if (m && n) return Number(p[i]) < Number(q[i]) ? -1 : 1;
    if (m !== n) return m ? -1 : 1;
    return p[i] < q[i] ? -1 : 1;
  }
  return 0;
}

function isPublicKey(value: string): boolean {
  try { return atob(value).length === 32; } catch { return false; }
}
/**
 * The address users paste to add a store: `https://host/store/` with a trailing slash, no credentials
 * or query. A fragment (for example from an older link) is ignored.
 */
export function storeUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "https:" || url.username || url.password || url.search) throw new Error("invalidUrl");
  url.hash = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}

export function parseStores(value: unknown): PluginStoreConfig[] {
  if (!Array.isArray(value)) return [];
  const out: PluginStoreConfig[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== "string" || !STORE_ID.test(item.id) || out.some(store => store.id === item.id)) continue;
    if (typeof item.publicKey !== "string" || !isPublicKey(item.publicKey) || !Array.isArray(item.urls)) continue;
    const urls = [...new Set(item.urls.flatMap(url => { try { return typeof url === "string" ? [storeUrl(url)] : []; } catch { return []; } }))].slice(0, MAX_STORE_URLS);
    if (!urls.length) continue;
    out.push({id: item.id, name: text(item.name, 200) ? item.name : item.id, publicKey: item.publicKey, urls, enabled: item.enabled !== false});
  }
  return out;
}

function parsePermissions(value: unknown): Permissions | undefined {
  if (!isRecord(value) || !Array.isArray(value.network) || !value.network.every(origin => typeof origin === "string")) return undefined;
  return {network: value.network as string[], ...(value.networkRequest === true ? {networkRequest: true} : {}), ...(value.sessions === "open" ? {sessions: "open"} : {}), ...(value.credentials === "store" ? {credentials: "store"} : {})};
}
/** Structure of an index whose signature the backend has already checked against `publicKey`. */
export function parseIndex(value: unknown, publicKey: string): StoreIndex {
  if (!isRecord(value) || value.schema !== 1 || !Number.isSafeInteger(value.seq) || !isRecord(value.store) || value.store.publicKey !== publicKey || !Array.isArray(value.plugins)) throw new Error("invalidIndex");
  const plugins: StorePlugin[] = [];
  for (const item of value.plugins) {
    if (!isRecord(item) || typeof item.id !== "string" || !PLUGIN_ID.test(item.id) || !text(item.name, 200) || !Array.isArray(item.versions) || plugins.some(plugin => plugin.id === item.id)) continue;
    const versions: StoreVersion[] = [];
    for (const version of item.versions) {
      if (!isRecord(version) || !isVersion(version.version) || typeof version.apiVersion !== "number" || typeof version.file !== "string" || version.file !== `packages/${item.id}/${version.version}.nexterm-plugin`) continue;
      if (typeof version.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(version.sha256) || !Number.isSafeInteger(version.size) || Number(version.size) <= 0) continue;
      const permissions = parsePermissions(version.permissions);
      if (!permissions) continue;
      versions.push({version: version.version, apiVersion: version.apiVersion, file: version.file, sha256: version.sha256, size: Number(version.size), published: typeof version.published === "string" ? version.published : "", permissions});
    }
    if (!versions.length) continue;
    versions.sort((a, b) => compareVersions(b.version, a.version));
    const description = isRecord(item.description) && text(item.description.zh, 500) && text(item.description.en, 500) ? {zh: item.description.zh, en: item.description.en} : undefined;
    plugins.push({id: item.id, name: item.name, versions,
      ...(description ? {description} : {}),
      ...(text(item.author, 100) ? {author: item.author} : {}),
      ...(text(item.homepage, 500) && item.homepage.startsWith("https://") ? {homepage: item.homepage} : {}),
      ...(Array.isArray(item.tags) ? {tags: item.tags.filter((tag): tag is string => text(tag, 32)).slice(0, 8)} : {})});
  }
  const revoked = (Array.isArray(value.revoked) ? value.revoked : []).flatMap(item => isRecord(item) && typeof item.id === "string" && Array.isArray(item.versions)
    ? [{id: item.id, versions: item.versions.filter((version): version is string => typeof version === "string"), ...(text(item.reason, 500) ? {reason: item.reason} : {})}] : []);
  return {seq: Number(value.seq), generated: typeof value.generated === "string" ? value.generated : "", store: {name: text(value.store.name, 200) ? value.store.name : "", publicKey}, plugins, revoked};
}

/** The newest version this Nexterm can run. */
export const latestVersion = (plugin: StorePlugin) => plugin.versions.find(version => version.apiVersion === 1);
export const describePlugin = (plugin: StorePlugin, language: string) => plugin.description?.[language.toLowerCase().startsWith("zh") ? "zh" : "en"];

/** Updates come only from the store a plugin was installed from. */
export function availableUpdates(entries: InstalledPlugin[], catalogs: StoreCatalog[]): {entry: InstalledPlugin; offer: StoreOffer}[] {
  return entries.flatMap(entry => {
    const catalog = entry.source && catalogs.find(item => item.store.id === entry.source!.storeId && item.store.enabled);
    const plugin = catalog?.index.plugins.find(item => item.id === entry.bundle.manifest.id);
    const version = plugin && latestVersion(plugin);
    if (!catalog || !plugin || !version || compareVersions(version.version, entry.bundle.manifest.version) <= 0) return [];
    return [{entry, offer: {store: catalog.store, url: catalog.url, plugin, version}}];
  });
}
/** Revocations only apply to plugins installed from the revoking store. `*` revokes every version. */
export function revokedEntries(entries: InstalledPlugin[], catalogs: StoreCatalog[]): {entry: InstalledPlugin; reason?: string}[] {
  return entries.flatMap(entry => {
    const catalog = entry.source && catalogs.find(item => item.store.id === entry.source!.storeId);
    const match = catalog?.index.revoked.find(item => item.id === entry.bundle.manifest.id && (item.versions.includes("*") || item.versions.includes(entry.bundle.manifest.version)));
    return match ? [{entry, reason: match.reason}] : [];
  });
}

/** Permissions the new version asks for that the installed one did not have. */
export function addedPermissions(before: Permissions, after: Permissions): string[] {
  return [
    ...after.network.filter(origin => !before.network.includes(origin)),
    ...(after.networkRequest && !before.networkRequest ? ["networkRequest"] : []),
    ...(after.sessions && !before.sessions ? ["sessions"] : []),
    ...(after.credentials && !before.credentials ? ["credentials"] : []),
  ];
}
const samePermissions = (a: Permissions, b: Permissions) => addedPermissions(a, b).length === 0 && addedPermissions(b, a).length === 0;
/** The downloaded package must be exactly what the signed index describes. */
export function checkDownloaded(bundle: PluginPackage, plugin: StorePlugin, version: StoreVersion) {
  if (bundle.manifest.id !== plugin.id || bundle.manifest.version !== version.version || bundle.manifest.apiVersion !== version.apiVersion || !samePermissions(bundle.manifest.permissions, version.permissions)) throw new Error("packageMismatch");
}
