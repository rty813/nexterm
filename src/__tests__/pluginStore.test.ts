import { beforeEach, describe, expect, it, vi } from "vitest";
import { addedPermissions, availableUpdates, checkDownloaded, compareVersions, parseIndex, parseStores, revokedEntries, storeUrl, type StoreCatalog } from "../plugins/store";
import type { InstalledPlugin, PluginPackage } from "../plugins/model";

const native = vi.hoisted(() => ({invoke: vi.fn(), runtime: vi.fn(() => true), files: new Map<string, unknown>()}));
vi.mock("@tauri-apps/api/core", () => ({invoke: native.invoke}));
vi.mock("@tauri-apps/plugin-dialog", () => ({confirm: vi.fn()}));
vi.mock("../services/backend", () => ({isTauriRuntime: native.runtime, backend: {loadDataFile: async (name: string) => native.files.get(name) ?? null, saveDataFile: async (name: string, value: unknown) => {native.files.set(name, value);}}}));

const KEY = "+U256mSOOHNxlniYqhFy5Tg0OYPDkI/127OGmH9OSgU=";
const ID = "2648d2bab1b4c559";
const permissions = {network: ["https://api.example.com"]};
const pkg = (version: string, extra: Partial<PluginPackage["manifest"]["permissions"]> = {}): PluginPackage => ({manifest: {apiVersion: 1, id: "team.demo", name: "Demo", version, main: "main.js", permissions: {...permissions, ...extra}, contributes: {}}, files: {"main.js": ""}});
const versionEntry = (version: string, extra = {}) => ({version, apiVersion: 1, file: `packages/team.demo/${version}.nexterm-plugin`, sha256: "b".repeat(64), size: 10, published: "", permissions: {...permissions, ...extra}});
const rawIndex = (versions = [versionEntry("1.1.0"), versionEntry("1.0.0")], revoked: unknown[] = []) => ({schema: 1, seq: 4, generated: "", store: {name: "Team", publicKey: KEY}, plugins: [{id: "team.demo", name: "Demo", description: {zh: "演示", en: "Demo"}, versions}], revoked});
const store = {id: ID, name: "Team", publicKey: KEY, urls: ["https://relay.example.com/store/"], enabled: true};
const installed = (version: string, source = true): InstalledPlugin => ({bundle: pkg(version), enabled: true, revision: "r", hidden: [], ...(source ? {source: {storeId: ID, storeName: "Team", version, sha256: "a".repeat(64)}} : {})});
const catalog = (index = rawIndex()): StoreCatalog => ({store, index: parseIndex(index, KEY), url: store.urls[0]});

describe("store addresses", () => {
  it("normalizes a pasted address and ignores a fragment", () => {
    expect(storeUrl("  https://relay.example.com/store ")).toBe("https://relay.example.com/store/");
    expect(storeUrl(`https://relay.example.com/store/#key=${encodeURIComponent(KEY)}&token=x`)).toBe("https://relay.example.com/store/");
  });
  it("rejects plain http, credentials, queries and non-URLs", () => {
    for (const bad of ["http://relay.example.com/store/", "https://" + "a:b" + "@relay.example.com/store/", "https://relay.example.com/store/?x=1", "not a url"]) expect(() => storeUrl(bad)).toThrow();
  });
});

describe("store configuration and index", () => {
  it("keeps only valid stores and drops fields older versions synced", () => {
    expect(parseStores([{...store, token: "old"}, {...store}, {...store, id: "nope"}, {...store, id: "0".repeat(16), urls: ["http://x/"]}, null])).toEqual([store]);
    expect(parseStores("x")).toEqual([]);
  });
  it("accepts a well-formed index for the pinned key and drops broken entries", () => {
    const index = parseIndex(rawIndex([versionEntry("1.0.0"), versionEntry("1.1.0"), {...versionEntry("2.0.0"), file: "../evil"}, {...versionEntry("x")}]), KEY);
    expect(index.plugins[0].versions.map(item => item.version)).toEqual(["1.1.0", "1.0.0"]);
    expect(() => parseIndex(rawIndex(), "other")).toThrow("invalidIndex");
  });
  it("orders versions", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
  });
});

describe("updates, revocation and permissions", () => {
  it("offers updates only from the store a plugin came from", () => {
    expect(availableUpdates([installed("1.0.0")], [catalog()]).map(item => item.offer.version.version)).toEqual(["1.1.0"]);
    expect(availableUpdates([installed("1.1.0")], [catalog()])).toEqual([]);
    expect(availableUpdates([installed("1.0.0", false)], [catalog()])).toEqual([]);
    expect(availableUpdates([installed("1.0.0")], [{...catalog(), store: {...store, enabled: false}}])).toEqual([]);
  });
  it("revokes only plugins installed from the revoking store", () => {
    const revoking = catalog(rawIndex(undefined, [{id: "team.demo", versions: ["1.0.0"], reason: "bug"}]));
    expect(revokedEntries([installed("1.0.0")], [revoking])).toEqual([{entry: expect.anything(), reason: "bug"}]);
    expect(revokedEntries([installed("1.1.0"), installed("1.0.0", false)], [revoking])).toEqual([]);
    expect(revokedEntries([installed("1.1.0")], [catalog(rawIndex(undefined, [{id: "team.demo", versions: ["*"]}]))])).toHaveLength(1);
  });
  it("lists permissions a new version adds and checks downloads against the index", () => {
    expect(addedPermissions(permissions, {network: ["https://api.example.com", "https://new.example.com"], sessions: "open"})).toEqual(["https://new.example.com", "sessions"]);
    expect(addedPermissions({...permissions, credentials: "store"}, permissions)).toEqual([]);
    const plugin = catalog().index.plugins[0];
    expect(() => checkDownloaded(pkg("1.1.0"), plugin, plugin.versions[0])).not.toThrow();
    expect(() => checkDownloaded(pkg("1.0.0"), plugin, plugin.versions[0])).toThrow("packageMismatch");
    expect(() => checkDownloaded(pkg("1.1.0", {sessions: "open"}), plugin, plugin.versions[0])).toThrow("packageMismatch");
  });
});

describe("store service", () => {
  let values: Map<string, string>;
  beforeEach(() => {
    values = new Map();
    vi.stubGlobal("localStorage", {getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => {values.set(key, value);}, removeItem: (key: string) => {values.delete(key);}});
    native.files.clear();
    native.invoke.mockReset();
  });
  async function setup(platformEntries: InstalledPlugin[] = []) {
    const { PluginStores } = await import("../plugins/storeService");
    const platform = {entries: platformEntries, failures: new Map(), install: vi.fn(), toggle: vi.fn(), stop: vi.fn(), load: vi.fn(async () => undefined)};
    return {stores: new PluginStores(platform as never), platform};
  }
  it("adds a store from its address alone, trusting the key it declares", async () => {
    native.invoke.mockResolvedValue({index: rawIndex(), publicKey: KEY, fingerprint: ID, url: store.urls[0]});
    const {stores} = await setup();
    await stores.addAddress("https://relay.example.com/store");
    expect(native.invoke).toHaveBeenCalledWith("plugin_store_probe", {url: store.urls[0]});
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("save_data_file", {name: "plugin_stores", value: [store]}));
    // The same key again only adds a mirror.
    native.invoke.mockResolvedValue({index: rawIndex(), publicKey: KEY, fingerprint: ID, url: "https://mirror.example.com/store/"});
    await stores.addAddress("https://mirror.example.com/store/");
    expect(stores.stores[0].urls).toEqual([store.urls[0], "https://mirror.example.com/store/"]);
  });
  it("refreshes with the pinned key and the newest seq seen, then offers and installs updates", async () => {
    const entry = installed("1.0.0");
    const {stores, platform} = await setup([entry]);
    native.files.set("plugin_stores", [store]);
    values.set("nexterm.pluginStores.seq.v1", JSON.stringify({[ID]: 3}));
    const text = JSON.stringify(pkg("1.1.0"));
    native.invoke.mockImplementation(async (method: string) => method === "plugin_store_index" ? {index: rawIndex(), url: store.urls[0]} : text);
    await stores.checkForUpdates();
    expect(native.invoke).toHaveBeenCalledWith("plugin_store_index", {storeId: ID, urls: store.urls, publicKey: KEY, minSeq: 3});
    expect(JSON.parse(values.get("nexterm.pluginStores.seq.v1")!)).toEqual({[ID]: 4});
    const updates = stores.updates();
    expect(updates).toHaveLength(1);
    expect(await stores.update(updates.map(item => item.offer))).toEqual({installed: 1, review: 0, failed: []});
    expect(native.invoke).toHaveBeenCalledWith("plugin_store_fetch", expect.objectContaining({storeId: ID, file: "packages/team.demo/1.1.0.nexterm-plugin"}));
    expect(platform.install).toHaveBeenCalledWith(expect.objectContaining({manifest: expect.objectContaining({version: "1.1.0"})}), expect.objectContaining({storeId: ID, version: "1.1.0"}));
  });
  it("holds an update that asks for more permissions for review", async () => {
    const {stores, platform} = await setup([installed("1.0.0")]);
    native.files.set("plugin_stores", [store]);
    const index = rawIndex([versionEntry("1.1.0", {sessions: "open"}), versionEntry("1.0.0")]);
    native.invoke.mockImplementation(async (method: string) => method === "plugin_store_index" ? {index, url: store.urls[0]} : JSON.stringify(pkg("1.1.0", {sessions: "open"})));
    await stores.checkForUpdates();
    expect(await stores.update(stores.updates().map(item => item.offer))).toEqual({installed: 0, review: 1, failed: []});
    expect(platform.install).not.toHaveBeenCalled();
    expect(stores.review?.added).toEqual(["sessions"]);
    stores.approveReview();
    expect(platform.install).toHaveBeenCalledTimes(1);
  });
  it("disables a revoked plugin and reports store errors per store", async () => {
    const {stores, platform} = await setup([installed("1.0.0")]);
    native.files.set("plugin_stores", [store, {...store, id: "0123456789abcdef", publicKey: btoa("x".repeat(32))}]);
    native.invoke.mockImplementation(async (_method: string, args: {storeId: string}) => {
      if (args.storeId !== ID) throw "signature: index.json does not match its signature";
      return {index: rawIndex(undefined, [{id: "team.demo", versions: ["1.0.0"], reason: "bug"}]), url: store.urls[0]};
    });
    await stores.checkForUpdates();
    expect(platform.toggle).toHaveBeenCalledWith("team.demo", false);
    expect(platform.stop).toHaveBeenCalledWith("team.demo", expect.stringContaining("bug"));
    expect(stores.states.get("0123456789abcdef")).toMatchObject({status: "error"});
    expect(stores.states.get(ID)).toMatchObject({status: "ready"});
  });
});
