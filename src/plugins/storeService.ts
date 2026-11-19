import { invoke } from "@tauri-apps/api/core";
import { backend, isTauriRuntime } from "../services/backend";
import i18n from "../i18n";
import { parsePackage, type PluginPackage, type PluginSource } from "./model";
import { plugins, type PluginPlatform } from "./platform";
import { addedPermissions, availableUpdates, checkDownloaded, MAX_STORE_URLS, parseIndex, parseStores, revokedEntries, storeUrl, type PluginStoreConfig, type StoreCatalog, type StoreIndex, type StoreOffer } from "./store";

/** What the store backend checked on first contact: a validly signed index and the key it declares. */
export interface StoreProbe { url: string; publicKey: string; fingerprint: string; index: StoreIndex }
export interface StoreState { status: "idle" | "loading" | "ready" | "error"; index?: StoreIndex; url?: string; error?: string; checkedAt?: number }
/** A package waiting for the user's authorization in the plugin manager. */
export interface InstallReview { bundle: PluginPackage; source?: PluginSource; added?: string[]; storeName?: string }

const seqKey = "nexterm.pluginStores.seq.v1";
/** Error codes from `plugin_store.rs` (`code: detail`) and `store.ts`, translated as `pluginStore.err.<code>`. */
const CODES = ["invalidUrl", "invalidIndex", "invalidStore", "keyMismatch", "signature", "rollback", "unauthorized", "http", "network", "tooLarge", "hash", "packageMismatch", "desktopOnly"];
export function storeError(reason: unknown): string {
  const message = String(reason instanceof Error ? reason.message : reason).replace(/^(?:Error:\s*)+/, "");
  const code = message.split(":")[0].trim();
  if (!CODES.includes(code)) return message;
  const detail = message.slice(code.length + 1).trim();
  return i18n.t(`pluginStore.err.${code}`) + (detail && ["http", "network"].includes(code) ? ` (${detail})` : "");
}
const desktop = () => { if (!isTauriRuntime()) throw new Error("desktopOnly"); };

export class PluginStores {
  private listeners = new Set<() => void>();
  private version = 0;
  private loaded?: Promise<void>;
  private queue = Promise.resolve();
  stores: PluginStoreConfig[] = [];
  states = new Map<string, StoreState>();
  review?: InstallReview;
  /** Which part of the plugin manager to show (the update notice opens the installed list). */
  view: "installed" | "store" = "installed";
  noticeDismissed = false;
  lastError = "";
  constructor(private platform: PluginPlatform = plugins) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => {this.listeners.delete(listener);}; };
  snapshot = () => this.version;
  emit = () => {this.version++; for (const listener of this.listeners) listener();};

  load(): Promise<void> {
    this.loaded ??= backend.loadDataFile<unknown>("plugin_stores").then(value => {this.stores = parseStores(value); this.emit();}, () => undefined);
    return this.loaded;
  }
  async reload() { this.loaded = undefined; this.states.clear(); await this.load(); }
  private save(stores: PluginStoreConfig[]) {
    this.stores = stores; this.emit();
    const value = JSON.parse(JSON.stringify(stores)) as unknown;
    this.queue = this.queue.then(() => isTauriRuntime() ? invoke<void>("save_data_file", {name: "plugin_stores", value}) : backend.saveDataFile("plugin_stores", value))
      .catch(() => {this.lastError = i18n.t("plugin.actionFailedStorage"); this.emit();});
  }
  catalogs(): StoreCatalog[] {
    return this.stores.flatMap(store => {
      const state = this.states.get(store.id);
      return store.enabled && state?.index && state.url ? [{store, index: state.index, url: state.url}] : [];
    });
  }
  updates() { return availableUpdates(this.platform.entries, this.catalogs()); }

  /** Checks a pasted store address before it is added. */
  async probe(address: string): Promise<StoreProbe> {
    desktop();
    let url: string;
    try { url = storeUrl(address); } catch { throw new Error("invalidUrl"); }
    const result = await invoke<{index: unknown; publicKey: string; fingerprint: string; url: string}>("plugin_store_probe", {url});
    return {url: result.url, publicKey: result.publicKey, fingerprint: result.fingerprint, index: parseIndex(result.index, result.publicKey)};
  }
  /** Trusts the probed key and adds the store; the same key again only adds the address. */
  async addAddress(address: string) { return this.add(await this.probe(address)); }
  add(probe: StoreProbe) {
    const existing = this.stores.find(store => store.id === probe.fingerprint);
    const store: PluginStoreConfig = existing
      ? {...existing, urls: [...new Set([...existing.urls, probe.url])].slice(0, MAX_STORE_URLS), enabled: true}
      : {id: probe.fingerprint, name: probe.index.store.name || probe.fingerprint, publicKey: probe.publicKey, urls: [probe.url], enabled: true};
    this.save(existing ? this.stores.map(item => item === existing ? store : item) : [...this.stores, store]);
    this.remember(store.id, probe.index.seq);
    this.states.set(store.id, {status: "ready", index: probe.index, url: probe.url, checkedAt: Date.now()});
    this.view = "store"; this.emit();
    return store;
  }
  remove(id: string) { this.save(this.stores.filter(store => store.id !== id)); this.states.delete(id); this.emit(); }
  setEnabled(id: string, enabled: boolean) { this.save(this.stores.map(store => store.id === id ? {...store, enabled} : store)); if (enabled) void this.refresh(id); }
  setUrls(id: string, urls: string[]) {
    const clean = [...new Set(urls.map(storeUrl))].slice(0, MAX_STORE_URLS);
    if (!clean.length) throw new Error("invalidUrl");
    this.save(this.stores.map(store => store.id === id ? {...store, urls: clean} : store));
    void this.refresh(id);
  }

  private seen(): Record<string, number> { try { const value: unknown = JSON.parse(localStorage.getItem(seqKey) ?? "{}"); return value && typeof value === "object" ? value as Record<string, number> : {}; } catch { return {}; } }
  /** The newest index seen per store stays on this computer: a mirror cannot roll it back later. */
  private remember(id: string, seq: number) { const seen = this.seen(); if ((seen[id] ?? 0) < seq) { seen[id] = seq; try { localStorage.setItem(seqKey, JSON.stringify(seen)); } catch { /* best effort */ } } }

  async refresh(id: string) {
    const store = this.stores.find(item => item.id === id);
    if (!store?.enabled || this.states.get(id)?.status === "loading") return;
    const previous = this.states.get(id);
    this.states.set(id, {...previous, status: "loading", error: undefined}); this.emit();
    try {
      desktop();
      const result = await invoke<{index: unknown; url: string}>("plugin_store_index", {storeId: store.id, urls: store.urls, publicKey: store.publicKey, minSeq: this.seen()[store.id] ?? 0});
      const index = parseIndex(result.index, store.publicKey);
      this.remember(store.id, index.seq);
      this.states.set(id, {status: "ready", index, url: result.url, checkedAt: Date.now()});
      const current = this.stores.find(item => item.id === id);
      if (current && index.store.name && index.store.name !== current.name) this.save(this.stores.map(item => item === current ? {...item, name: index.store.name} : item));
      this.applyRevocations();
    } catch (reason) {
      this.states.set(id, {...previous, status: "error", error: storeError(reason), checkedAt: Date.now()});
    }
    this.emit();
  }
  async refreshAll() { await Promise.all(this.stores.filter(store => store.enabled).map(store => this.refresh(store.id))); }
  /** Startup check: load what is installed and configured, ask every store, then show the notice. */
  async checkForUpdates() {
    await Promise.all([this.platform.load(), this.load()]);
    await this.refreshAll();
    this.noticeDismissed = false; this.emit();
  }
  private applyRevocations() {
    for (const {entry, reason} of revokedEntries(this.platform.entries, this.catalogs())) {
      const id = entry.bundle.manifest.id;
      if (!entry.enabled && this.platform.failures.has(id)) continue;
      try { if (entry.enabled) this.platform.toggle(id, false); } catch { /* storage failure: still report it */ }
      this.platform.stop(id, i18n.t("pluginStore.revoked", {name: entry.bundle.manifest.name, reason: reason ?? i18n.t("pluginStore.noReason")}));
    }
  }

  /** Downloads and checks a package; the result still goes through the install review. */
  async download(offer: StoreOffer): Promise<InstallReview> {
    desktop();
    const text = await invoke<string>("plugin_store_fetch", {storeId: offer.store.id, base: offer.url, file: offer.version.file, sha256: offer.version.sha256, size: offer.version.size});
    let bundle: PluginPackage;
    try { bundle = parsePackage(JSON.parse(text)); } catch { throw new Error("packageMismatch"); }
    checkDownloaded(bundle, offer.plugin, offer.version);
    const installed = this.platform.entries.find(entry => entry.bundle.manifest.id === bundle.manifest.id);
    return {bundle, storeName: offer.store.name, source: {storeId: offer.store.id, storeName: offer.store.name, version: offer.version.version, sha256: offer.version.sha256},
      ...(installed ? {added: addedPermissions(installed.bundle.manifest.permissions, bundle.manifest.permissions)} : {})};
  }
  /** Opens the review for a store package (install, replace or an update that asks for more). */
  async requestInstall(offer: StoreOffer) { this.review = await this.download(offer); this.emit(); }
  /**
   * Installs updates the user asked for. An update from the same store that asks for no new
   * permissions installs directly; one that asks for more waits in the review.
   * Returns how many were installed, how many need review and what failed.
   */
  async update(offers: StoreOffer[]): Promise<{installed: number; review: number; failed: string[]}> {
    const result = {installed: 0, review: 0, failed: [] as string[]};
    for (const offer of offers) {
      try {
        const review = await this.download(offer);
        const installed = this.platform.entries.find(entry => entry.bundle.manifest.id === review.bundle.manifest.id);
        if (installed?.source?.storeId === offer.store.id && review.added?.length === 0) {
          this.platform.install(review.bundle, review.source); result.installed++;
        } else {
          // One review at a time; the others stay listed as updates.
          this.review ??= review; result.review++;
        }
      } catch (reason) {
        result.failed.push(`${offer.plugin.name}: ${storeError(reason)}`);
      }
    }
    this.emit();
    return result;
  }
  reviewFile(bundle: PluginPackage) { this.review = {bundle}; this.emit(); }
  clearReview() { this.review = undefined; this.emit(); }
  /** Installs the package under review (the user pressed the authorize button). */
  approveReview() {
    const review = this.review;
    if (!review) return;
    this.platform.install(review.bundle, review.source);
    this.review = undefined; this.emit();
  }
}
export const pluginStores = new PluginStores();
