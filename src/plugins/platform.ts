import { invoke } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import { backend, isTauriRuntime } from "../services/backend";
import i18n from "../i18n";
import { httpsOrigin, isModalLocation, isRecord, parsePackage, pluginSource, sessionCatalog, sessionChoices, sessionSourceKey, temporarySsh, type DockedViewLocation, type PluginSessionOrigin, type InstalledPlugin, type PluginSource, type PluginPackage, type PluginView, type PluginSessionCatalog, type PluginSessionChoice } from "./model";
import type { SessionConfig } from "../types/domain";

/**
 * Installed plugins are kept in the synced data file `plugins.json` (package, enablement, hidden
 * contributions, remembered origins, store source and the plugin's own configuration). `save` must
 * throw synchronously when it cannot accept the records, so callers can leave their state untouched.
 */
export interface PluginRecords { load(): Promise<unknown>; save(records: unknown[]): void }
const legacyKey = "nexterm.plugins.v1";
const legacyConfigKey = (id: string) => "nexterm.plugin.config." + id;
export function fileRecords(onError: (error: unknown) => void): PluginRecords {
  let queue = Promise.resolve();
  const write = (records: unknown[]) => isTauriRuntime() ? invoke<void>("save_data_file", {name: "plugins", value: records}) : backend.saveDataFile("plugins", records);
  return {
    async load() {
      const saved = await (isTauriRuntime() ? invoke<unknown>("load_data_file", {name: "plugins"}) : backend.loadDataFile<unknown>("plugins"));
      if (saved !== null && saved !== undefined) return saved;
      // First start with file storage: move what earlier versions kept in this WebView.
      const legacy: unknown = JSON.parse(localStorage.getItem(legacyKey) ?? "null");
      if (!Array.isArray(legacy)) return [];
      const records = legacy.filter(isRecord).map(item => {
        const id = isRecord(item.bundle) && isRecord(item.bundle.manifest) ? item.bundle.manifest.id : undefined;
        let config: unknown;
        try { config = typeof id === "string" ? JSON.parse(localStorage.getItem(legacyConfigKey(id)) ?? "null") : null; } catch { config = null; }
        return {...item, id, ...(isRecord(config) ? {config} : {})};
      });
      await write(records);
      localStorage.removeItem(legacyKey);
      for (const item of records) if (typeof item.id === "string") localStorage.removeItem(legacyConfigKey(item.id));
      return records;
    },
    save(records) {
      const value = JSON.parse(JSON.stringify(records)) as unknown[];
      queue = queue.then(() => write(value)).catch(onError);
    },
  };
}
const record = (entry: InstalledPlugin) => ({id: entry.bundle.manifest.id, bundle: entry.bundle, enabled: entry.enabled, hidden: entry.hidden, approvedOrigins: entry.approvedOrigins ?? [], ...(entry.source ? {source: entry.source} : {}), ...(entry.config ? {config: entry.config} : {})});
export class Endpoint {
  private next = 0;
  private closed = false;
  private inflight = 0;
  private pending = new Map<number, {resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>}>();
  constructor(private port: MessagePort, dispatch: (method: string, value: unknown) => Promise<unknown>) {
    port.onmessage = async event => {
      const message = event.data;
      if (!isRecord(message)) return;
      if (message.kind === "result") {
        const pending = this.pending.get(Number(message.id));
        if (!pending) return;
        this.pending.delete(Number(message.id)); clearTimeout(pending.timer);
        try {
          if (JSON.stringify(message).length > 262144) pending.reject(new Error("Plugin response limit exceeded"));
          else if (message.error) pending.reject(new Error(String(message.error))); else pending.resolve(message.value);
        } catch { pending.reject(new Error("Invalid plugin response")); }
      } else if (message.kind === "call" && typeof message.method === "string" && Number.isInteger(message.id)) {
        if (this.closed) return;
        this.inflight++;
        try {
          if (this.inflight > 32 || JSON.stringify(message).length > 262144) throw new Error("Plugin request limit exceeded");
          const value = await dispatch(message.method, message.value);
          if (!this.closed) port.postMessage({kind: "result", id: message.id, value});
        } catch (reason) { if (!this.closed) port.postMessage({kind: "result", id: message.id, error: String(reason)}); }
        finally { this.inflight--; }
      }
    };
  }
  call(method: string, value?: unknown): Promise<unknown> {
    if (this.closed || this.pending.size >= 32) return Promise.reject(new Error("Plugin unavailable or busy"));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Plugin did not respond")); }, 30000);
      this.pending.set(id, {resolve, reject, timer}); this.port.postMessage({kind: "call", id, method, value});
    });
  }
  event(name: string, value: unknown) { if (!this.closed) this.port.postMessage({kind: "event", name, value}); }
  close() { this.closed = true; this.port.close(); for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Plugin stopped")); } this.pending.clear(); }
}
export interface Runtime {
  entry: InstalledPlugin;
  capability: string;
  origins: Set<string>;
  networkRequest?: {origin: string; promise: Promise<boolean>};
  background?: Endpoint;
  clients: Set<Endpoint>;
  status: Map<string, {text: string; tooltip?: string}>;
  events: Map<string, unknown>;
  sources: Map<string, PluginSessionCatalog>;
  sourceBusy: Set<string>;
  /** The item each source is resolving a connection for (shown in the session bar). */
  sourceConnecting: Map<string, string>;
  sourceErrors: Map<string, string>;
  error?: string;
}
export class PluginPlatform {
  private listeners = new Set<() => void>();
  private generations = new Map<string, number>();
  private loaded?: Promise<void>;
  private version = 0;
  constructor(private records: PluginRecords = fileRecords(() => {this.lastError = i18n.t("plugin.actionFailedStorage"); this.emit();})) {}
  entries: InstalledPlugin[] = [];
  runtimes = new Map<string, Runtime>();
  opened: {pluginId: string; view: PluginView}[] = [];
  active: Partial<Record<DockedViewLocation, string>> = {};
  get modalView() { return this.opened.find(item => isModalLocation(item.view.location)); }
  onSession?: (session: SessionConfig) => string;
  private isLocked = false;
  get locked() { return this.isLocked; }
  set locked(value: boolean) { if (this.isLocked === value) return; this.isLocked = value; if (value) this.chooseSessionAccount(undefined); this.emit(); }
  /** Open temporary SSH sessions by session id: the plugin item they came from. Kept while the plugin restarts. */
  private sessionOrigins = new Map<string, PluginSessionOrigin & {key: string}>();
  /** Sessions whose credential handoff was just staged by `openSsh`, for their first connect. */
  private freshHandoffs = new Set<string>();
  /** Credential renewals run one at a time per plugin (its HTTP requests are limited). */
  private renewals = new Map<string, Promise<unknown>>();
  accountPrompt?: {pluginId: string; sourceId: string; title: string; choices: PluginSessionChoice[]; finish: (id?: string) => void};
  lastError = "";
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => {this.listeners.delete(listener);}; };
  snapshot = () => this.version;
  emit = () => {this.version++; for (const listener of this.listeners) listener();};
  load(): Promise<void> {
    this.loaded ??= this.records.load().then(stored => this.restore(stored), () => {this.lastError = i18n.t("plugin.actionFailedStorage"); this.emit();});
    return this.loaded;
  }
  /** Synced data replaced the file: stop everything and load it again. */
  async reload() {
    for (const id of [...this.runtimes.keys()]) this.stop(id);
    this.entries = []; this.failures.clear(); this.loaded = undefined;
    await this.load();
  }
  private restore(stored: unknown) {
    try {
      if (Array.isArray(stored)) for (const item of stored) {
        try {
          if (!isRecord(item)) continue;
          const bundle = parsePackage(item.bundle);
          if (this.entries.some(entry => entry.bundle.manifest.id === bundle.manifest.id)) continue;
          const approvedOrigins = bundle.manifest.permissions.networkRequest && Array.isArray(item.approvedOrigins) ? [...new Set(item.approvedOrigins.filter((value): value is string => {try {return typeof value === "string" && httpsOrigin(value) === value;} catch {return false;}}))].slice(0, 16 - bundle.manifest.permissions.network.length) : [];
          const source = pluginSource(item.source);
          this.entries.push({bundle, revision: crypto.randomUUID(), approvedOrigins, hidden: Array.isArray(item.hidden) ? item.hidden.filter((value): value is string => typeof value === "string") : [], enabled: item.enabled === true, ...(source ? {source} : {}), ...(isRecord(item.config) ? {config: item.config} : {})});
        } catch { continue; }
      }
    }
    catch { this.entries = []; }
    this.emit();
  }
  private save(entries: InstalledPlugin[]) { this.records.save(entries.map(record)); }
  private persist(entries: InstalledPlugin[]) { this.save(entries); this.entries = entries; }
  /** Installs or replaces a plugin; `source` marks a store install (a local file clears it). */
  install(bundle: PluginPackage, source?: PluginSource) {
    const existing = this.entries.find(entry => entry.bundle.manifest.id === bundle.manifest.id);
    const entry: InstalledPlugin = {bundle, revision: crypto.randomUUID(), enabled: true, hidden: existing?.hidden ?? [], ...(source ? {source} : {}), ...(existing?.config ? {config: existing.config} : {})};
    this.persist(existing ? this.entries.map(item => item === existing ? entry : item) : [...this.entries, entry]);
    this.stop(bundle.manifest.id);
  }
  toggle(id: string, enabled: boolean) { this.persist(this.entries.map(entry => entry.bundle.manifest.id === id ? {...entry, enabled, revision: crypto.randomUUID()} : entry)); this.stop(id); }
  remove(id: string) {
    this.persist(this.entries.filter(entry => entry.bundle.manifest.id !== id));
    this.stop(id);
    for (const [sessionId, origin] of this.sessionOrigins) if (origin.pluginId === id) this.sessionOrigins.delete(sessionId);
    if (isTauriRuntime()) return invoke<void>("plugin_forget_credentials", {pluginId: id});
  }
  revokeNetwork(id: string) { this.persist(this.entries.map(entry => entry.bundle.manifest.id === id ? {...entry, approvedOrigins: [], revision: crypto.randomUUID()} : entry)); this.stop(id); }
  hide(id: string, contribution: string) {
    const entry = this.entries.find(entry => entry.bundle.manifest.id === id);
    if (!entry) return;
    const hidden = entry.hidden.includes(contribution) ? entry.hidden.filter(item => item !== contribution) : [...entry.hidden, contribution];
    this.save(this.entries.map(item => item === entry ? {...entry, hidden} : item));
    entry.hidden = hidden;
    if (hidden.includes(contribution) && this.accountPrompt?.pluginId === id && this.accountPrompt.sourceId === contribution) this.chooseSessionAccount(undefined);
    this.emit();
  }
  move(id: string, offset: number) { const index = this.entries.findIndex(entry => entry.bundle.manifest.id === id); const target = index + offset; if (index < 0 || target < 0 || target >= this.entries.length) return; const entries = [...this.entries]; [entries[index], entries[target]] = [entries[target], entries[index]]; this.persist(entries); this.emit(); }
  async start(entry: InstalledPlugin): Promise<Runtime> {
    const manifest = entry.bundle.manifest;
    const generation = (this.generations.get(manifest.id) ?? 0) + 1;
    this.generations.set(manifest.id, generation);
    const origins = [...new Set([...manifest.permissions.network, ...(manifest.permissions.networkRequest ? entry.approvedOrigins ?? [] : [])])];
    const capability = isTauriRuntime() ? await invoke<string>("plugin_grant", {pluginId: manifest.id, origins, requestNetwork: manifest.permissions.networkRequest === true, sessions: manifest.permissions.sessions === "open", credentials: manifest.permissions.credentials === "store"}) : "browser-preview";
    const runtime: Runtime = {entry, capability, origins: new Set(origins), clients: new Set(), events: new Map(), status: new Map(), sources: new Map((manifest.contributes.sessionSources ?? []).map(source => [source.id, {state: "loading", items: []}])), sourceBusy: new Set(), sourceConnecting: new Map(), sourceErrors: new Map()};
    if (!this.entries.includes(entry) || !entry.enabled || this.generations.get(manifest.id) !== generation) { if (isTauriRuntime()) void invoke("plugin_revoke", {capability}).catch(() => undefined); throw new Error("Plugin activation cancelled"); }
    this.runtimes.set(manifest.id, runtime); this.emit(); return runtime;
  }
  stop(id: string, error?: string) {
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    const runtime = this.runtimes.get(id);
    if (this.accountPrompt?.pluginId === id) this.chooseSessionAccount(undefined);
    if (runtime) {runtime.background?.close(); for (const client of runtime.clients) client.close(); if (isTauriRuntime()) void invoke("plugin_revoke", {capability: runtime.capability}).catch(() => undefined); this.runtimes.delete(id);}
    this.opened = this.opened.filter(item => item.pluginId !== id);
    for (const location of ["sidebar", "panel", "tab"] as const) if (!this.opened.some(item => item.pluginId + ":" + item.view.id === this.active[location])) delete this.active[location];
    if (error) {if (runtime) runtime.error = error; this.failures.set(id, error);} else this.failures.delete(id);
    this.emit();
  }
  failures = new Map<string, string>();
  commands() { return this.entries.filter(entry => this.runtimes.has(entry.bundle.manifest.id)).flatMap(entry => (entry.bundle.manifest.contributes.commands ?? []).map(command => ({...command, pluginId: entry.bundle.manifest.id, pluginName: entry.bundle.manifest.name}))); }
  run(id: string, command: string, value?: unknown) { void this.command(id, command, value).catch(() => {this.lastError = i18n.t("plugin.commandFailed"); this.emit();}); }
  open(id: string, viewId: string) {
    const runtime = this.runtimes.get(id);
    const view = runtime?.entry.bundle.manifest.contributes.views?.find(view => view.id === viewId);
    if (!view) throw new Error("Unknown or disabled plugin view");
    const key = id + ":" + viewId;
    if (isModalLocation(view.location)) this.opened = this.opened.filter(item => !isModalLocation(item.view.location));
    if (!this.opened.some(item => item.pluginId + ":" + item.view.id === key)) this.opened = [...this.opened, {pluginId: id, view}];
    if (!isModalLocation(view.location)) this.active[view.location] = key;
    this.emit();
  }
  close(key: string) { const view = this.opened.find(item => item.pluginId + ":" + item.view.id === key); this.opened = this.opened.filter(item => item !== view); if (view && !isModalLocation(view.view.location) && this.active[view.view.location] === key) delete this.active[view.view.location]; this.emit(); }
  async command(id: string, command: string, value?: unknown) { const runtime = this.runtimes.get(id); if (this.locked || !runtime?.background || !runtime.entry.bundle.manifest.contributes.commands?.some(item => item.id === command)) throw new Error("Plugin unavailable"); await runtime.background.call("command:" + command, value); }
  sessionSources() {
    return this.entries.flatMap(entry => {
      const manifest = entry.bundle.manifest;
      const runtime = this.runtimes.get(manifest.id);
      if (!runtime) return [];
      return (manifest.contributes.sessionSources ?? []).filter(source => !entry.hidden.includes(source.id)).map(source => ({...source, pluginId: manifest.id, pluginName: manifest.name, catalog: runtime.sources.get(source.id)!, busy: runtime.sourceBusy.has(source.id), connecting: runtime.sourceConnecting.get(source.id), error: runtime.sourceErrors.get(source.id)}));
    });
  }
  sessionKey(id: string) { return this.sessionOrigins.get(id)?.key ?? id; }
  pruneSessionOrigins(activeIds: Set<string>) {
    for (const id of this.sessionOrigins.keys()) if (!activeIds.has(id)) this.sessionOrigins.delete(id);
    for (const id of this.freshHandoffs) if (!activeIds.has(id)) this.freshHandoffs.delete(id);
  }
  /** The plugin item a session was opened from, to save with the workspace. */
  sessionOrigin(id: string): PluginSessionOrigin | undefined {
    const origin = this.sessionOrigins.get(id);
    return origin && {pluginId: origin.pluginId, sourceId: origin.sourceId, itemId: origin.itemId, ...(origin.choiceId !== undefined ? {choiceId: origin.choiceId} : {})};
  }
  /** A restored tab: link it to its plugin item again, so it can get credentials from the plugin. */
  adoptSession(id: string, origin: PluginSessionOrigin) { this.sessionOrigins.set(id, {...origin, key: sessionSourceKey(origin.pluginId, origin.sourceId, origin.itemId)}); }
  /** Name of the plugin a session was opened from. */
  sessionPluginName(id: string) {
    const pluginId = this.sessionOrigins.get(id)?.pluginId;
    return pluginId ? this.entries.find(entry => entry.bundle.manifest.id === pluginId)?.bundle.manifest.name : undefined;
  }
  /**
   * Make sure a plugin's credential handoff is staged before `session` connects: right after `openSsh` it already is;
   * for a reconnect or a restored tab, ask the plugin for the same item (and account) again, once it has signed in and
   * listed it. The plugin must return the very destination the tab already has, so nothing is confirmed again.
   * Resolves false when the plugin cannot provide credentials (removed, disabled, signed out, item no longer listed,
   * timeout); the user types the password instead. `wanted` turns false when the pane no longer needs it.
   */
  renewCredentials(session: SessionConfig, wanted: () => boolean = () => true, timeoutMs = 30000): Promise<boolean> {
    if (this.freshHandoffs.delete(session.id)) return Promise.resolve(true);
    const origin = this.sessionOrigins.get(session.id);
    if (!origin) return Promise.resolve(false);
    const previous = this.renewals.get(origin.pluginId) ?? Promise.resolve();
    const run = previous.then(() => this.renew(session, origin, wanted, timeoutMs)).catch(() => false);
    this.renewals.set(origin.pluginId, run);
    void run.finally(() => {if (this.renewals.get(origin.pluginId) === run) this.renewals.delete(origin.pluginId);});
    return run;
  }
  private async renew(session: SessionConfig, origin: PluginSessionOrigin, wanted: () => boolean, timeoutMs: number) {
    if (!wanted()) return false;
    await this.load();
    const available = (runtime: Runtime) => {
      const catalog = runtime.sources.get(origin.sourceId);
      return this.runtimes.get(origin.pluginId) === runtime && !!runtime.background && !!catalog && ["ready", "loading"].includes(catalog.state) && catalog.items.some(item => item.id === origin.itemId) && !runtime.entry.hidden.includes(origin.sourceId) && !this.locked && wanted();
    };
    const runtime = await this.until(() => {
      if (!wanted()) return false;
      const entry = this.entries.find(entry => entry.bundle.manifest.id === origin.pluginId);
      if (!entry?.enabled || entry.hidden.includes(origin.sourceId) || this.failures.has(origin.pluginId) || entry.bundle.manifest.permissions.sessions !== "open") return false;
      const runtime = this.runtimes.get(origin.pluginId);
      const catalog = runtime?.sources.get(origin.sourceId);
      if (!runtime || !catalog) return undefined;
      if (available(runtime)) return runtime;
      // Fully listed without the item: it is no longer authorized.
      return catalog.state === "ready" ? false : undefined;
    }, timeoutMs);
    if (!runtime) return false;
    const result = await runtime.background!.call("sessionSource:" + origin.sourceId, {itemId: origin.itemId, ...(origin.choiceId !== undefined ? {choiceId: origin.choiceId} : {})});
    if (!available(runtime) || !isRecord(result) || !isRecord(result.connection) || result.choices !== undefined) return false;
    const connection = result.connection;
    const target = temporarySsh(connection);
    if (typeof connection.passwordKey !== "string" || target.host !== session.host || target.port !== session.port || target.username !== session.username) return false;
    await invoke("plugin_stage_ssh", {capability: runtime.capability, instanceId: session.id, secretKey: connection.passwordKey, host: session.host, port: session.port, username: session.username});
    return available(runtime);
  }
  /** Wait until `check` gives a value (false = give up), checking on every change and every second. */
  private until<Value>(check: () => Value | false | undefined, timeoutMs: number): Promise<Value | false> {
    return new Promise(resolve => {
      let done = false;
      const test = () => {
        if (done) return;
        let value: Value | false | undefined;
        try {value = check();} catch {value = false;}
        if (value === undefined) return;
        done = true; clearTimeout(timeout); clearInterval(poll); unsubscribe(); resolve(value);
      };
      const timeout = setTimeout(() => {if (!done) {done = true; clearInterval(poll); unsubscribe(); resolve(false);}}, timeoutMs);
      const poll = setInterval(test, 1000);
      const unsubscribe = this.subscribe(test);
      test();
    });
  }
  chooseSessionAccount(id?: string) { this.accountPrompt?.finish(id); }
  private chooseAccount(pluginId: string, sourceId: string, title: string, choices: PluginSessionChoice[]): Promise<string | undefined> {
    if (this.accountPrompt) throw new Error(i18n.t("plugin.accountPromptBusy"));
    return new Promise(resolve => {
      const timer = setTimeout(() => prompt.finish(), 60000);
      const prompt = {pluginId, sourceId, title, choices, finish: (id?: string) => {
        if (this.accountPrompt !== prompt) return;
        clearTimeout(timer); this.accountPrompt = undefined; this.emit();
        resolve(choices.some(choice => choice.id === id) ? id : undefined);
      }};
      this.accountPrompt = prompt; this.emit();
    });
  }
  async refreshSource(pluginId: string, sourceId: string) {
    const runtime = this.runtimes.get(pluginId);
    const source = runtime?.entry.bundle.manifest.contributes.sessionSources?.find(item => item.id === sourceId);
    if (!runtime || !source?.refreshCommand || runtime.sourceBusy.has(sourceId) || this.locked) return;
    runtime.sourceBusy.add(sourceId); runtime.sourceErrors.delete(sourceId); this.emit();
    try { await this.command(pluginId, source.refreshCommand); }
    catch (reason) { if (this.runtimes.get(pluginId) === runtime) runtime.sourceErrors.set(sourceId, String(reason).replace(/^(?:Error:\s*)+/, "")); }
    finally { runtime.sourceBusy.delete(sourceId); this.emit(); }
  }
  async connectSource(pluginId: string, sourceId: string, itemId: string) {
    const runtime = this.runtimes.get(pluginId);
    const catalog = runtime?.sources.get(sourceId);
    const item = catalog?.items.find(item => item.id === itemId);
    if (!runtime?.background || !catalog || !["ready", "loading"].includes(catalog.state) || !item || runtime.sourceBusy.has(sourceId) || runtime.entry.hidden.includes(sourceId) || this.locked) return;
    const current = () => {const latest = runtime.sources.get(sourceId); return this.runtimes.get(pluginId) === runtime && !!latest && ["ready", "loading"].includes(latest.state) && latest.items.includes(item) && !runtime.entry.hidden.includes(sourceId) && !this.locked;};
    runtime.sourceBusy.add(sourceId); runtime.sourceConnecting.set(sourceId, itemId); runtime.sourceErrors.delete(sourceId); this.emit();
    let choiceId: string | undefined;
    try {
      let result = await runtime.background.call("sessionSource:" + sourceId, {itemId});
      if (!current()) throw new Error(i18n.t("plugin.sourceChanged"));
      if (isRecord(result) && result.choices !== undefined && result.connection === undefined) {
        const choices = sessionChoices(result.choices);
        runtime.sourceConnecting.delete(sourceId); this.emit();
        choiceId = await this.chooseAccount(pluginId, sourceId, catalog.items.find(item => item.id === itemId)!.label, choices);
        if (!choiceId) return;
        if (!current()) throw new Error(i18n.t("plugin.sourceChanged"));
        runtime.sourceConnecting.set(sourceId, itemId); this.emit();
        result = await runtime.background.call("sessionSource:" + sourceId, {itemId, choiceId});
      }
      if (!current()) throw new Error(i18n.t("plugin.sourceChanged"));
      if (!isRecord(result) || result.connection === undefined || result.choices !== undefined) throw new Error(i18n.t("plugin.invalidConnection"));
      await this.openSsh(runtime, result.connection, {pluginId, sourceId, itemId, ...(choiceId !== undefined ? {choiceId} : {})}, current, true);
    } catch (reason) { if (this.runtimes.get(pluginId) === runtime) runtime.sourceErrors.set(sourceId, String(reason).replace(/^(?:Error:\s*)+/, "")); }
    finally { runtime.sourceBusy.delete(sourceId); runtime.sourceConnecting.delete(sourceId); this.emit(); }
  }
  // userPicked: the user clicked this item in the session bar. Then no prompt when the SSH host is the host of an
  // origin the plugin can already reach, since the connection can't carry the plugin's secrets anywhere new.
  private async openSsh(runtime: Runtime, value: unknown, origin?: PluginSessionOrigin, current = () => this.runtimes.get(runtime.entry.bundle.manifest.id) === runtime && !this.locked, userPicked = false) {
    if (runtime.entry.bundle.manifest.permissions.sessions !== "open") throw new Error("Session permission not granted");
    const session = temporarySsh(value);
    const known = userPicked && [...runtime.origins].some(origin => new URL(origin).hostname === session.host.toLowerCase());
    if (!known) {
      const message = `${runtime.entry.bundle.manifest.name}\n${session.username}@${session.host}:${session.port}\n\n${i18n.t("plugin.sshConfirm")}`;
      const approved = isTauriRuntime() ? await confirm(message, {title: i18n.t("plugin.sshConfirmTitle"), kind: "warning"}) : window.confirm(message);
      if (!approved) throw new Error("Connection cancelled");
    }
    if (!current()) throw new Error("Connection cancelled");
    session.authType = "password";
    if (isRecord(value) && typeof value.passwordKey === "string") {
      await invoke("plugin_stage_ssh", {capability: runtime.capability, instanceId: session.id, secretKey: value.passwordKey, host: session.host, port: session.port, username: session.username});
      if (!current()) throw new Error("Connection cancelled");
      session.credentialHandoff = true;
    }
    if (!this.onSession) throw new Error("Session service unavailable");
    if (origin) this.adoptSession(session.id, origin);
    if (session.credentialHandoff) this.freshHandoffs.add(session.id);
    try { return {paneId: this.onSession(session)}; }
    catch (reason) { this.sessionOrigins.delete(session.id); this.freshHandoffs.delete(session.id); throw reason; }
  }
  private async requestNetwork(runtime: Runtime, origin: string): Promise<boolean> {
    httpsOrigin(origin);
    if (runtime.origins.has(origin)) return true;
    const manifest = runtime.entry.bundle.manifest;
    if (manifest.permissions.networkRequest !== true) throw new Error("Dynamic network permission not declared");
    if (runtime.origins.size >= 16) throw new Error("Plugin network origin limit reached");
    if (runtime.networkRequest) {
      if (runtime.networkRequest.origin !== origin) throw new Error("Another network authorization is in progress");
      return runtime.networkRequest.promise;
    }
    const pending = {origin, promise: (async () => {
      const message = `${manifest.name}\n${manifest.id}\n\n${i18n.t("plugin.networkConfirm")}\n${origin}\n\n${i18n.t("plugin.networkConfirmNote")}`;
      const approved = isTauriRuntime() ? await confirm(message, {title: i18n.t("plugin.networkConfirmTitle"), kind: "warning"}) : window.confirm(message);
      if (this.runtimes.get(manifest.id) !== runtime || this.locked) throw new Error("Network authorization cancelled");
      if (!approved) return false;
      if (isTauriRuntime()) await invoke("plugin_allow_origin", {capability: runtime.capability, requestedOrigin: origin});
      if (this.runtimes.get(manifest.id) !== runtime || this.locked) throw new Error("Network authorization cancelled");
      const approvedOrigins = [...new Set([...(runtime.entry.approvedOrigins ?? []), origin])];
      this.save(this.entries.map(entry => entry === runtime.entry ? {...entry, approvedOrigins} : entry));
      runtime.entry.approvedOrigins = approvedOrigins;
      runtime.origins.add(origin);
      return true;
    })()};
    runtime.networkRequest = pending;
    try {return await pending.promise;} finally {if (runtime.networkRequest === pending) delete runtime.networkRequest;}
  }
  async dispatch(runtime: Runtime, endpoint: "background" | "view", method: string, value: unknown): Promise<unknown> {
    const id = runtime.entry.bundle.manifest.id;
    if (this.runtimes.get(id) !== runtime || this.locked) throw new Error("Plugin unavailable while stopped or locked");
    const data = isRecord(value) ? value : {};
    const capability = runtime.capability;
    switch (method) {
      case "plugin.request": if (endpoint !== "view") throw new Error("Only views can request background handlers"); return runtime.background?.call(String(data.name), data.value);
      case "network.request":
        if (typeof data.origin !== "string") throw new Error("Invalid network origin");
        return this.requestNetwork(runtime, data.origin);
      case "network.isGranted": return typeof data.origin === "string" && runtime.origins.has(httpsOrigin(data.origin));
      case "http.request": {
        if (typeof data.url !== "string" || !runtime.origins.has(new URL(data.url).origin)) throw new Error("Network origin not granted");
        if (!isTauriRuntime()) throw new Error("HTTPS transport requires the desktop app");
        return invoke("plugin_http", {capability, request: data});
      }
      case "secrets.set": case "secrets.delete":
        if (typeof data.origin !== "string" || !runtime.origins.has(httpsOrigin(data.origin))) throw new Error("Secret origin not granted");
        if (!isTauriRuntime()) throw new Error("Credentials require the desktop app");
        return invoke("plugin_secret", {capability, key: data.key, value: method === "secrets.set" ? data.value : null, secretOrigin: data.origin});
      case "credentials.get": case "credentials.set": case "credentials.delete": {
        if (endpoint !== "background" || runtime.entry.bundle.manifest.permissions.credentials !== "store") throw new Error("Persistent credentials require a declared background permission");
        if (typeof data.origin !== "string" || !runtime.origins.has(httpsOrigin(data.origin))) throw new Error("Credential origin not granted");
        if (typeof data.key !== "string" || !data.key || data.key.length > 100 || (method === "credentials.set" && (typeof data.value !== "string" || new TextEncoder().encode(data.value).length > 2560))) throw new Error("Invalid persistent credential");
        if (!isTauriRuntime()) throw new Error("Persistent credentials require the desktop app");
        const result = await invoke("plugin_credential", {capability, key: data.key, credentialOrigin: data.origin, operation: method.slice(12), value: method === "credentials.set" ? data.value : null});
        if (this.runtimes.get(id) !== runtime || this.locked) throw new Error("Credential request cancelled");
        return result;
      }
      case "config.get": return structuredClone(runtime.entry.config ?? {});
      case "config.set": {
        if (!isRecord(value) || JSON.stringify(value).length > 32768) throw new Error("Invalid plugin configuration");
        const config = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
        this.save(this.entries.map(entry => entry === runtime.entry ? {...entry, config} : entry));
        runtime.entry.config = config;
        for (const client of [runtime.background, ...runtime.clients]) client?.event("configChanged", value);
        return;
      }
      case "events.publish":
        if (endpoint !== "background" || typeof data.name !== "string" || JSON.stringify(data.value ?? null).length > 262144 || (runtime.events.size >= 32 && !runtime.events.has(data.name))) throw new Error("Invalid plugin event");
        runtime.events.set(data.name, data.value); for (const client of runtime.clients) client.event(data.name, data.value); return;
      case "status.update":
        if (typeof data.id !== "string" || !runtime.entry.bundle.manifest.contributes.statusBar?.some(item => item.id === data.id) || typeof data.text !== "string" || data.text.length > 100 || (data.tooltip !== undefined && (typeof data.tooltip !== "string" || data.tooltip.length > 500))) throw new Error("Invalid status item");
        runtime.status.set(data.id, {text: data.text, tooltip: data.tooltip as string | undefined}); this.emit(); return;
      case "views.open": this.open(id, String(data.id)); return;
      case "sessions.updateSource": case "sessions.appendSource": {
        if (endpoint !== "background" || typeof data.id !== "string" || !runtime.entry.bundle.manifest.contributes.sessionSources?.some(source => source.id === data.id) || runtime.entry.bundle.manifest.permissions.sessions !== "open") throw new Error("Session source not declared or not a background request");
        const batch = sessionCatalog(data.catalog);
        if (method === "sessions.appendSource") {
          const previous = runtime.sources.get(data.id)!;
          if (!["loading", "ready"].includes(batch.state) || !["loading", "ready"].includes(previous.state)) throw new Error("Cannot append to an inactive session source");
          if (previous.items.length + batch.items.length > 100000) throw new Error("Session source exceeds 100000 items");
          const ids = new Set(previous.items.map(item => item.id));
          if (batch.items.some(item => ids.has(item.id))) throw new Error("Duplicate session item in append");
          batch.items = [...previous.items, ...batch.items];
        }
        runtime.sources.set(data.id, batch);
        runtime.sourceErrors.delete(data.id);
        if (method === "sessions.updateSource" && this.accountPrompt?.pluginId === id && this.accountPrompt.sourceId === data.id) this.chooseSessionAccount(undefined);
        this.emit(); return;
      }
      case "sessions.open": return this.openSsh(runtime, value);
      default: throw new Error("Unknown Nexterm SDK method");
    }
  }
}
export const plugins = new PluginPlatform();
