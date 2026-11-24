import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { Endpoint, PluginPlatform, fileRecords } from "../plugins/platform";
import type { PluginPackage } from "../plugins/model";
import type { SessionConfig } from "../types/domain";

const native = vi.hoisted(() => ({invoke: vi.fn(), confirm: vi.fn(), runtime: vi.fn(() => true)}));
vi.mock("@tauri-apps/api/core", () => ({invoke: native.invoke}));
vi.mock("@tauri-apps/plugin-dialog", () => ({confirm: native.confirm}));
vi.mock("../services/backend", () => ({isTauriRuntime: native.runtime}));

const bundle = (id = "test.plugin"): PluginPackage => ({
  manifest: {apiVersion: 1, id, name: "Test", version: "1.0.0", main: "main.js", permissions: {network: ["https://example.com"], sessions: "open"}, contributes: {
    commands: [{id: "show", title: "Show"}], statusBar: [{id: "status", text: "Test", command: "show"}],
    views: [{id: "page", title: "Page", location: "tab", file: "view.html"}, {id: "settings", title: "Settings", location: "settings", file: "view.html"}],
  }}, files: {"main.js": "", "view.html": "<h1>Test</h1>"},
});
const ssh = {host: "gateway.example.com", port: 2222, username: "user#account#asset", label: "Asset", passwordKey: "ssh-password"};
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>(done => {resolve = done;});
  return {promise, resolve};
}

let platform: PluginPlatform;
let values: Map<string, string>;
let storage: {getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn>; removeItem: ReturnType<typeof vi.fn>};
/** What the synced plugins.json would hold. */
let saved: unknown[] | null;
let records: {load: Mock<() => Promise<unknown>>; save: Mock<(records: unknown[]) => void>};
beforeEach(() => {
  values = new Map();
  storage = {getItem: vi.fn((key: string) => values.get(key) ?? null), setItem: vi.fn((key: string, value: string) => {values.set(key, value);}), removeItem: vi.fn((key: string) => {values.delete(key);})};
  vi.stubGlobal("localStorage", storage);
  native.invoke.mockReset().mockImplementation(async (method: string) => method === "plugin_grant" ? crypto.randomUUID() : undefined);
  native.confirm.mockReset().mockResolvedValue(true);
  native.runtime.mockReturnValue(true);
  saved = null;
  records = {load: vi.fn(async () => saved), save: vi.fn((value: unknown[]) => {saved = JSON.parse(JSON.stringify(value));})};
  platform = new PluginPlatform(records);
});
afterEach(() => {for (const id of platform.runtimes.keys()) platform.stop(id); vi.unstubAllGlobals();});
async function activate(id = "test.plugin") {
  platform.install(bundle(id));
  return platform.start(platform.entries.find(entry => entry.bundle.manifest.id === id)!);
}

describe("generic plugin session sources", () => {
  const catalog = {state: "ready", items: [{id: "asset", label: "Server", description: "10.0.0.1"}]};
  async function source(id = "test.plugin") {
    const packaged = bundle(id);
    packaged.manifest.contributes.sessionSources = [{id:"hosts",title:"Sessions",refreshCommand:"show",settingsView:"settings"}];
    platform.install(packaged);
    const runtime = await platform.start(platform.entries.find(entry => entry.bundle.manifest.id === id)!);
    const call = vi.fn(async (_method: string, _value?: unknown): Promise<unknown> => ({connection:ssh}));
    runtime.background = {call,close:vi.fn()} as unknown as Endpoint;
    await platform.dispatch(runtime, "background", "sessions.updateSource", {id:"hosts",catalog});
    platform.onSession = vi.fn(() => "pane");
    return {runtime,call};
  }
  it("appends more than 1000 entries without replacing existing item identities", async () => {
    const {runtime} = await source();
    const first = runtime.sources.get("hosts")!.items[0];
    for (let offset = 0; offset < 2400; offset += 200) {
      await platform.dispatch(runtime,"background","sessions.appendSource",{id:"hosts",catalog:{state:"loading",items:Array.from({length:200},(_, index) => ({id:String(offset + index),label:"Host"}))}});
    }
    expect(runtime.sources.get("hosts")!.items).toHaveLength(2401);
    expect(runtime.sources.get("hosts")!.items[0]).toBe(first);
    await expect(platform.dispatch(runtime,"background","sessions.appendSource",{id:"hosts",catalog:{state:"ready",items:[{id:"asset",label:"Duplicate"}]}})).rejects.toThrow("Duplicate");
    expect(runtime.sources.get("hosts")!.items).toHaveLength(2401);
  });
  it("allows connections to loaded hosts and does not cancel account selection on append", async () => {
    const {runtime,call} = await source();
    call.mockResolvedValueOnce({choices:[{id:"root",label:"Root"}]}).mockResolvedValue({connection:ssh});
    const connecting = platform.connectSource("test.plugin","hosts","asset");
    await vi.waitFor(() => expect(platform.accountPrompt).toBeDefined());
    await platform.dispatch(runtime,"background","sessions.appendSource",{id:"hosts",catalog:{state:"loading",items:[{id:"second",label:"Second"}]}});
    expect(platform.accountPrompt).toBeDefined();
    platform.chooseSessionAccount("root"); await connecting;
    expect(platform.onSession).toHaveBeenCalledOnce();
  });
  it("isolates same-named sources and items across plugins, without persisting catalogs", async () => {
    const first = await source(); const second = await source("other.plugin");
    expect(platform.sessionSources().map(item => item.pluginId)).toEqual(["test.plugin","other.plugin"]);
    expect(JSON.stringify(saved)).not.toContain("10.0.0.1");
    await platform.dispatch(first.runtime, "background", "sessions.updateSource", {id:"hosts",catalog:{state:"signedOut",items:[]}});
    expect(second.runtime.sources.get("hosts")?.items).toHaveLength(1);
    platform.hide("other.plugin","hosts"); expect(platform.sessionSources()).toHaveLength(1);
    platform.stop("test.plugin"); expect(platform.sessionSources()).toHaveLength(0);
  });
  it("permits only declared background sources and rejects malformed updates atomically", async () => {
    const {runtime} = await source();
    for (const [endpoint,id,data] of [["view","hosts",catalog],["background","missing",catalog],["background","hosts",{state:"signedOut",items:catalog.items}]] as const) {
      await expect(platform.dispatch(runtime,endpoint,"sessions.updateSource",{id,catalog:data})).rejects.toThrow();
    }
    expect(runtime.sources.get("hosts")).toEqual(catalog);
  });
  it("resolves the selected item through the background and preserves SSH confirmation and handoff", async () => {
    const {call} = await source();
    await platform.connectSource("test.plugin","hosts","asset");
    expect(call).toHaveBeenCalledWith("sessionSource:hosts",{itemId:"asset"});
    expect(native.confirm).toHaveBeenCalledOnce();
    const session = (platform.onSession as ReturnType<typeof vi.fn>).mock.calls[0][0] as SessionConfig;
    expect(session.credentialHandoff).toBe(true); expect(session).not.toHaveProperty("password");
    expect(platform.sessionKey(session.id)).toBe("plugin:test.plugin:hosts:asset");
    expect(native.invoke).toHaveBeenCalledWith("plugin_stage_ssh",expect.objectContaining({instanceId:session.id,host:ssh.host,username:ssh.username}));
    platform.pruneSessionOrigins(new Set()); expect(platform.sessionKey(session.id)).toBe(session.id);
  });
  it("skips SSH confirmation only for a user-picked item on a host the plugin already reaches", async () => {
    const {runtime,call} = await source(); call.mockResolvedValue({connection:{...ssh,host:"Example.com"}});
    await platform.connectSource("test.plugin","hosts","asset");
    expect(native.confirm).not.toHaveBeenCalled(); expect(platform.onSession).toHaveBeenCalledOnce();
    expect(native.invoke).toHaveBeenCalledWith("plugin_stage_ssh",expect.objectContaining({host:"Example.com"}));
    await platform.dispatch(runtime,"background","sessions.open",{...ssh,host:"example.com"});
    expect(native.confirm).toHaveBeenCalledOnce();
  });
  it("does not resolve unknown or signed-out items", async () => {
    const {runtime,call} = await source();
    await platform.connectSource("test.plugin","hosts","missing");
    await platform.dispatch(runtime,"background","sessions.updateSource",{id:"hosts",catalog:{state:"signedOut",items:[]}});
    await platform.connectSource("test.plugin","hosts","asset");
    expect(call).not.toHaveBeenCalled(); expect(native.confirm).not.toHaveBeenCalled();
  });
  it("refreshes only its declared command and exposes errors inline", async () => {
    const {call} = await source(); call.mockRejectedValueOnce(new Error("HTTP 503"));
    await platform.refreshSource("test.plugin","hosts");
    expect(call).toHaveBeenCalledWith("command:show",undefined);
    expect(platform.sessionSources()[0]).toMatchObject({busy:false,error:"HTTP 503"});
    await platform.refreshSource("test.plugin","missing"); expect(call).toHaveBeenCalledTimes(1);
  });
  it("revalidates after host-owned account selection before confirming an SSH destination", async () => {
    const {call} = await source(); call.mockResolvedValueOnce({choices:[{id:"reader",label:"Reader"},{id:"root",label:"Root"}]});
    const pending = platform.connectSource("test.plugin","hosts","asset");
    await vi.waitFor(() => expect(platform.accountPrompt?.choices).toHaveLength(2));
    expect(native.confirm).not.toHaveBeenCalled(); platform.chooseSessionAccount("root"); await pending;
    expect(call).toHaveBeenNthCalledWith(2,"sessionSource:hosts",{itemId:"asset",choiceId:"root"});
    expect(platform.onSession).toHaveBeenCalledOnce(); expect(platform.accountPrompt).toBeUndefined();
  });
  it.each(["cancel","invalid","stop","disable","replace","remove","lock","logout","hide"])("cancels a pending account choice on %s", async operation => {
    const {runtime,call} = await source(); call.mockResolvedValueOnce({choices:[{id:"root",label:"Root"}]});
    const pending = platform.connectSource("test.plugin","hosts","asset");
    await vi.waitFor(() => expect(platform.accountPrompt).toBeDefined());
    if (operation === "stop") platform.stop("test.plugin");
    else if (operation === "disable") platform.toggle("test.plugin",false);
    else if (operation === "replace") platform.install(bundle());
    else if (operation === "remove") platform.remove("test.plugin");
    else if (operation === "lock") platform.locked = true;
    else if (operation === "logout") await platform.dispatch(runtime,"background","sessions.updateSource",{id:"hosts",catalog:{state:"signedOut",items:[]}});
    else if (operation === "hide") platform.hide("test.plugin","hosts");
    else platform.chooseSessionAccount(operation === "invalid" ? "forged" : undefined);
    await pending; expect(platform.accountPrompt).toBeUndefined(); expect(call).toHaveBeenCalledTimes(1);
    expect(platform.onSession).not.toHaveBeenCalled(); expect(native.confirm).not.toHaveBeenCalled();
  });
  it.each(["resolve","confirmation","staging"])("checks catalog freshness after asynchronous %s", async phase => {
    const {runtime,call} = await source();
    const resolver = deferred<unknown>(); const confirmation = deferred<boolean>(); const staging = deferred<void>();
    if (phase === "resolve") call.mockReturnValueOnce(resolver.promise);
    if (phase === "confirmation") native.confirm.mockReturnValueOnce(confirmation.promise);
    if (phase === "staging") native.invoke.mockImplementation(async method => method === "plugin_stage_ssh" ? staging.promise : undefined);
    const pending = platform.connectSource("test.plugin","hosts","asset");
    if (phase === "confirmation") await vi.waitFor(() => expect(native.confirm).toHaveBeenCalled());
    if (phase === "staging") await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("plugin_stage_ssh",expect.anything()));
    await platform.dispatch(runtime,"background","sessions.updateSource",{id:"hosts",catalog:{state:"signedOut",items:[]}});
    resolver.resolve({connection:ssh}); confirmation.resolve(true); staging.resolve(); await pending;
    expect(platform.onSession).not.toHaveBeenCalled(); expect(platform.sessionSources()[0].busy).toBe(false);
  });
  it("does not duplicate concurrent connects or leave the source busy after failure", async () => {
    const {call} = await source(); const resolver = deferred<unknown>(); call.mockReturnValueOnce(resolver.promise);
    const pending = platform.connectSource("test.plugin","hosts","asset");
    await platform.connectSource("test.plugin","hosts","asset"); expect(call).toHaveBeenCalledTimes(1);
    resolver.resolve({connection:{...ssh,host:"bad;command"}}); await pending;
    expect(platform.onSession).not.toHaveBeenCalled(); expect(platform.sessionSources()[0]).toMatchObject({busy:false,error:expect.stringContaining("Invalid SSH")});
  });
  it("rejects ambiguous or repeated account responses without opening a terminal", async () => {
    const {call} = await source(); call.mockResolvedValueOnce({choices:[{id:"root",label:"Root"}],connection:ssh});
    await platform.connectSource("test.plugin","hosts","asset");
    expect(platform.onSession).not.toHaveBeenCalled(); expect(platform.accountPrompt).toBeUndefined();
  });
  const opened = () => (platform.onSession as ReturnType<typeof vi.fn>).mock.calls[0][0] as SessionConfig;
  const stagings = () => native.invoke.mock.calls.filter(([method]) => method === "plugin_stage_ssh");
  it("shows which item is resolving until the account prompt or the terminal opens", async () => {
    const {call} = await source(); const resolver = deferred<unknown>(); call.mockReturnValueOnce(resolver.promise);
    const pending = platform.connectSource("test.plugin","hosts","asset");
    expect(platform.sessionSources()[0].connecting).toBe("asset");
    resolver.resolve({choices:[{id:"root",label:"Root"}]});
    await vi.waitFor(() => expect(platform.accountPrompt).toBeDefined());
    expect(platform.sessionSources()[0].connecting).toBeUndefined();
    platform.chooseSessionAccount("root"); await pending;
    expect(platform.sessionSources()[0]).toMatchObject({busy:false,connecting:undefined});
  });
  it("uses the staged handoff for the first connect and asks the plugin again for the same account on reconnect", async () => {
    const {call} = await source(); call.mockResolvedValueOnce({choices:[{id:"reader",label:"Reader"},{id:"root",label:"Root"}]});
    const pending = platform.connectSource("test.plugin","hosts","asset");
    await vi.waitFor(() => expect(platform.accountPrompt).toBeDefined()); platform.chooseSessionAccount("root"); await pending;
    const session = opened();
    expect(platform.sessionOrigin(session.id)).toEqual({pluginId:"test.plugin",sourceId:"hosts",itemId:"asset",choiceId:"root"});
    expect(await platform.renewCredentials(session)).toBe(true); expect(call).toHaveBeenCalledTimes(2); expect(stagings()).toHaveLength(1);
    expect(await platform.renewCredentials(session)).toBe(true);
    expect(call).toHaveBeenLastCalledWith("sessionSource:hosts",{itemId:"asset",choiceId:"root"});
    expect(stagings()).toHaveLength(2); expect(stagings()[1][1]).toMatchObject({instanceId:session.id,secretKey:"ssh-password",host:ssh.host,port:ssh.port,username:ssh.username});
    expect(native.confirm).toHaveBeenCalledOnce();
  });
  it.each([
    ["another host", {connection:{...ssh,host:"other.example.com"}}],
    ["another account", {connection:{...ssh,username:"user#root#asset"}}],
    ["no password key", {connection:{...ssh,passwordKey:undefined}}],
    ["an account choice", {choices:[{id:"root",label:"Root"}]}],
  ])("does not hand over credentials when the plugin now returns %s", async (_case, response) => {
    const {call} = await source(); await platform.connectSource("test.plugin","hosts","asset");
    const session = opened(); await platform.renewCredentials(session);
    call.mockResolvedValueOnce(response);
    expect(await platform.renewCredentials(session)).toBe(false); expect(stagings()).toHaveLength(1);
  });
  it("waits for a restored tab's plugin to sign in and list the item, then stages without confirming", async () => {
    const {runtime,call} = await source();
    await platform.dispatch(runtime,"background","sessions.updateSource",{id:"hosts",catalog:{state:"signedOut",items:[]}});
    const session = {id:"restored",label:"Asset",group:"",protocol:"ssh",host:ssh.host,port:ssh.port,username:ssh.username,authType:"password",credentialHandoff:true,term:"xterm",keepAliveSecs:30} as SessionConfig;
    platform.adoptSession(session.id,{pluginId:"test.plugin",sourceId:"hosts",itemId:"asset"});
    expect(platform.sessionKey(session.id)).toBe("plugin:test.plugin:hosts:asset"); expect(platform.sessionPluginName(session.id)).toBe("Test");
    const renewed = platform.renewCredentials(session);
    await platform.dispatch(runtime,"background","sessions.updateSource",{id:"hosts",catalog:{state:"loading",items:[]}});
    expect(call).not.toHaveBeenCalled();
    await platform.dispatch(runtime,"background","sessions.updateSource",{id:"hosts",catalog:{state:"loading",items:catalog.items}});
    expect(await renewed).toBe(true);
    expect(call).toHaveBeenCalledWith("sessionSource:hosts",{itemId:"asset"}); expect(stagings()[0][1]).toMatchObject({instanceId:"restored"});
    expect(native.confirm).not.toHaveBeenCalled();
  });
  it("gives up when the item is no longer listed, the plugin is gone, the pane closes or it times out", async () => {
    const {runtime,call} = await source();
    const session = {id:"restored",label:"Asset",group:"",protocol:"ssh",host:ssh.host,port:ssh.port,username:ssh.username,authType:"password",credentialHandoff:true,term:"xterm",keepAliveSecs:30} as SessionConfig;
    platform.adoptSession(session.id,{pluginId:"test.plugin",sourceId:"hosts",itemId:"gone"});
    expect(await platform.renewCredentials(session)).toBe(false);
    platform.adoptSession(session.id,{pluginId:"test.plugin",sourceId:"hosts",itemId:"asset"});
    expect(await platform.renewCredentials(session,() => false)).toBe(false);
    await platform.dispatch(runtime,"background","sessions.updateSource",{id:"hosts",catalog:{state:"signedOut",items:[]}});
    expect(await platform.renewCredentials(session,undefined,20)).toBe(false);
    expect(await platform.renewCredentials({...session,id:"unknown"})).toBe(false);
    platform.toggle("test.plugin",false); expect(await platform.renewCredentials(session)).toBe(false);
    expect(call).not.toHaveBeenCalled(); expect(stagings()).toHaveLength(0);
  });
  it("keeps session links while the plugin restarts and drops them when it is uninstalled", async () => {
    await source(); await platform.connectSource("test.plugin","hosts","asset");
    const session = opened();
    platform.stop("test.plugin"); expect(platform.sessionKey(session.id)).toBe("plugin:test.plugin:hosts:asset");
    await platform.remove("test.plugin"); expect(platform.sessionKey(session.id)).toBe(session.id);
  });
});

describe("plugin quick commands", () => {
  const quick = (id = "test.plugin"): PluginPackage => {
    const value = bundle(id);
    value.manifest.contributes.quickCommands = [{id: "logs", label: "Logs", text: "tail -f log"}, {id: "open", label: "Open", command: "show"}];
    return value;
  };
  it("lists quick commands of running plugins only, without the hidden ones", async () => {
    platform.install(quick());
    expect(platform.quickCommands()).toEqual([]);
    await platform.start(platform.entries[0]);
    expect(platform.quickCommands().map(item => item.id)).toEqual(["plugin:test.plugin:logs", "plugin:test.plugin:open"]);
    expect(platform.quickCommands()).toBe(platform.quickCommands());
    platform.hide("test.plugin", "logs");
    expect(platform.quickCommands().map(item => item.contributionId)).toEqual(["open"]);
    expect(saved).toEqual([expect.objectContaining({hidden: ["logs"]})]);
    platform.stop("test.plugin");
    expect(platform.quickCommands()).toEqual([]);
  });
});

describe("plugin lifecycle", () => {
  it("revokes native permissions, closes channels and removes only the stopped plugin's views", async () => {
    const runtime = await activate();
    await activate("other.plugin");
    const close = vi.fn(); runtime.background = {close} as unknown as Endpoint;
    const client = {close: vi.fn()}; runtime.clients.add(client as unknown as Endpoint);
    platform.open("test.plugin", "page"); platform.open("other.plugin", "page");
    platform.open("test.plugin", "settings"); platform.stop("test.plugin");
    expect(close).toHaveBeenCalledOnce(); expect(client.close).toHaveBeenCalledOnce();
    expect(native.invoke).toHaveBeenCalledWith("plugin_revoke", {capability: runtime.capability});
    expect(platform.opened.map(item => item.pluginId)).toEqual(["other.plugin"]);
    expect(platform.modalView).toBeUndefined(); expect(platform.runtimes.has("other.plugin")).toBe(true);
    await expect(platform.dispatch(runtime, "view", "config.get", {})).rejects.toThrow("stopped");
  });
  it("revokes a grant that arrives after the plugin was disabled", async () => {
    platform.install(bundle()); const grant = deferred<string>(); native.invoke.mockReturnValueOnce(grant.promise);
    const starting = platform.start(platform.entries[0]); platform.toggle("test.plugin", false); grant.resolve("late-grant");
    await expect(starting).rejects.toThrow("cancelled");
    expect(platform.runtimes.size).toBe(0);
    expect(native.invoke).toHaveBeenCalledWith("plugin_revoke", {capability: "late-grant"});
  });
  it.each(["replace", "disable", "remove", "hide", "move"])("preserves an active plugin if storage fails during %s", async operation => {
    const runtime = await activate(); await activate("other.plugin"); platform.open("test.plugin", "page");
    const before = JSON.stringify(platform.entries);
    records.save.mockImplementation(() => {throw new Error("QuotaExceededError");});
    const actions = {replace: () => platform.install(bundle()), disable: () => platform.toggle("test.plugin", false), remove: () => platform.remove("test.plugin"), hide: () => platform.hide("test.plugin", "page"), move: () => platform.move("test.plugin", 1)};
    expect(actions[operation as keyof typeof actions]).toThrow("QuotaExceededError");
    expect(platform.runtimes.get("test.plugin")).toBe(runtime); expect(JSON.stringify(platform.entries)).toBe(before);
    expect(platform.active.tab).toBe("test.plugin:page"); expect(native.invoke.mock.calls.some(([method]) => method === "plugin_revoke")).toBe(false);
  });
  it("loads valid plugins independently of corrupt or duplicate entries", async () => {
    saved = [{bundle: bundle(), enabled: true, hidden: ["page", 2]}, {bundle: {}}, {bundle: bundle(), enabled: true}, {bundle: bundle("other.plugin"), enabled: false}];
    await Promise.all([platform.load(), platform.load()]);
    expect(records.load).toHaveBeenCalledTimes(1);
    expect(platform.entries.map(entry => entry.bundle.manifest.id)).toEqual(["test.plugin", "other.plugin"]);
    expect(platform.entries[0].hidden).toEqual(["page"]); expect(platform.entries[1].enabled).toBe(false);
  });
});

describe("plugin dialogs", () => {
  it("opens content dialogs independently of docked views and replaces settings without stacking", async () => {
    const runtime = await activate();
    runtime.entry.bundle.manifest.contributes.views!.push({id: "details", title: "Details", location: "dialog", file: "view.html"});
    platform.open("test.plugin", "page"); platform.open("test.plugin", "settings");
    await platform.dispatch(runtime, "background", "views.open", {id: "details"});
    platform.close("test.plugin:settings");
    expect(platform.modalView?.view.id).toBe("details");
    expect(platform.opened.map(item => item.view.id)).toEqual(["page", "details"]);
    expect(platform.active).toEqual({tab: "test.plugin:page"});
    await platform.dispatch(runtime, "view", "views.open", {id: "settings"});
    expect(platform.opened.map(item => item.view.id)).toEqual(["page", "settings"]);
  });
  it("closes settings without stopping the plugin or closing its workspace views", async () => {
    const runtime = await activate();
    platform.open("test.plugin", "page"); platform.open("test.plugin", "settings");
    expect(platform.modalView).toMatchObject({pluginId: "test.plugin", view: {id: "settings"}});
    platform.close("test.plugin:settings");
    expect(platform.modalView).toBeUndefined();
    expect(platform.opened.map(item => item.view.id)).toEqual(["page"]);
    expect(platform.active.tab).toBe("test.plugin:page");
    expect(platform.runtimes.get("test.plugin")).toBe(runtime);
    expect(native.invoke.mock.calls.some(([method]) => method === "plugin_revoke")).toBe(false);
  });
  it("replaces only the previous settings dialog and ignores a stale close", async () => {
    await activate(); await activate("other.plugin");
    platform.open("test.plugin", "page"); platform.open("other.plugin", "page");
    platform.open("test.plugin", "settings"); platform.open("other.plugin", "settings");
    platform.close("test.plugin:settings");
    expect(platform.modalView).toMatchObject({pluginId: "other.plugin", view: {id: "settings"}});
    expect(platform.opened.map(item => item.pluginId + ":" + item.view.id)).toEqual(["test.plugin:page", "other.plugin:page", "other.plugin:settings"]);
    expect(platform.active.tab).toBe("other.plugin:page");
  });
  it("opens declared settings directly through the SDK and switches pages within the plugin", async () => {
    const runtime = await activate();
    runtime.entry.bundle.manifest.contributes.views!.push({id: "advanced", title: "Advanced", location: "settings", file: "view.html"});
    await platform.dispatch(runtime, "background", "views.open", {id: "settings"});
    await platform.dispatch(runtime, "view", "views.open", {id: "advanced"});
    expect(platform.modalView?.view.id).toBe("advanced");
    expect(platform.opened.map(item => item.view.id)).toEqual(["advanced"]);
    expect(() => platform.open("test.plugin", "undeclared")).toThrow("Unknown");
    expect(platform.modalView?.view.id).toBe("advanced");
  });
  it.each(["reload", "disable", "remove", "replace"])("clears settings when the active plugin undergoes %s", async operation => {
    await activate(); await activate("other.plugin");
    platform.open("other.plugin", "page"); platform.open("test.plugin", "settings");
    const actions = {reload: () => platform.toggle("test.plugin", true), disable: () => platform.toggle("test.plugin", false), remove: () => platform.remove("test.plugin"), replace: () => platform.install(bundle())};
    await actions[operation as keyof typeof actions]();
    expect(platform.modalView).toBeUndefined();
    expect(platform.opened.map(item => item.pluginId + ":" + item.view.id)).toEqual(["other.plugin:page"]);
    expect(platform.runtimes.has("test.plugin")).toBe(false);
    expect(platform.runtimes.has("other.plugin")).toBe(true);
  });
});

describe("plugin capabilities", () => {
  it("gates persistent credentials by background permission and exact origin", async () => {
    const runtime = await activate();
    await expect(platform.dispatch(runtime,"background","credentials.get",{key:"login",origin:"https://example.com"})).rejects.toThrow("permission");
    runtime.entry.bundle.manifest.permissions.credentials = "store";
    await expect(platform.dispatch(runtime,"view","credentials.get",{key:"login",origin:"https://example.com"})).rejects.toThrow("background");
    await expect(platform.dispatch(runtime,"background","credentials.get",{key:"login",origin:"https://example.com:8443"})).rejects.toThrow("origin");
    await expect(platform.dispatch(runtime,"background","credentials.set",{key:"login",origin:"https://example.com",value:"密".repeat(1000)})).rejects.toThrow("Invalid");
    await platform.dispatch(runtime,"background","credentials.get",{key:"login",origin:"https://example.com"});
    expect(native.invoke).toHaveBeenCalledWith("plugin_credential",{capability:runtime.capability,key:"login",credentialOrigin:"https://example.com",operation:"get",value:null});
  });
  it("cancels credential reads completed after the app locks", async () => {
    const runtime = await activate(); runtime.entry.bundle.manifest.permissions.credentials = "store";
    const read = deferred<string>(); native.invoke.mockReturnValue(read.promise);
    const pending = platform.dispatch(runtime,"background","credentials.get",{key:"login",origin:"https://example.com"});
    platform.locked = true; read.resolve("secret");
    await expect(pending).rejects.toThrow("cancelled");
  });
  it("restores approved destinations from storage and explicitly revokes them", async () => {
    const packaged = bundle(); packaged.manifest.permissions.networkRequest = true;
    platform.install(packaged); const entry = platform.entries[0];
    const runtime = await platform.start(entry);
    await platform.dispatch(runtime,"background","network.request",{origin:"https://custom.example.com"});
    expect(platform.entries[0]).toBe(entry);
    expect(await platform.dispatch(runtime,"background","network.isGranted",{origin:"https://custom.example.com"})).toBe(true);
    const restored = new PluginPlatform(records); await restored.load();
    expect(restored.entries[0].approvedOrigins).toEqual(["https://custom.example.com"]);
    restored.revokeNetwork("test.plugin");
    expect(restored.entries[0].approvedOrigins).toEqual([]);
    platform.install(packaged);
    expect(platform.entries[0].approvedOrigins ?? []).toEqual([]);
  });
  async function dynamicRuntime(id = "test.plugin") {
    const value = bundle(id); value.manifest.permissions.networkRequest = true;
    platform.install(value); return platform.start(platform.entries.find(entry => entry.bundle.manifest.id === id)!);
  }
  it("requires opt-in before showing a dynamic network authorization prompt", async () => {
    const runtime = await activate();
    await expect(platform.dispatch(runtime, "background", "network.request", {origin: "https://custom.example.com:9443"})).rejects.toThrow("not declared");
    expect(native.confirm).not.toHaveBeenCalled();
  });
  it("authorizes an exact runtime origin before allowing HTTPS and credentials", async () => {
    const runtime = await dynamicRuntime(); const origin = "https://custom.example.com:9443";
    await expect(platform.dispatch(runtime, "background", "http.request", {url: origin + "/api"})).rejects.toThrow("not granted");
    await expect(platform.dispatch(runtime, "background", "secrets.set", {key: "token", value: "secret", origin})).rejects.toThrow("not granted");
    expect(await platform.dispatch(runtime, "background", "network.request", {origin})).toBe(true);
    expect(native.confirm).toHaveBeenCalledWith(expect.stringContaining(origin), {title: "插件网络授权", kind: "warning"});
    expect(native.invoke).toHaveBeenCalledWith("plugin_allow_origin", {capability: runtime.capability, requestedOrigin: origin});
    await platform.dispatch(runtime, "background", "http.request", {url: origin + "/api"});
    await platform.dispatch(runtime, "background", "secrets.set", {key: "token", value: "secret", origin});
    expect(native.invoke).toHaveBeenCalledWith("plugin_http", {capability: runtime.capability, request: {url: origin + "/api"}});
    expect(native.invoke).toHaveBeenCalledWith("plugin_secret", {capability: runtime.capability, key: "token", value: "secret", secretOrigin: origin});
    expect(await platform.dispatch(runtime, "view", "network.request", {origin})).toBe(true);
    expect(native.confirm).toHaveBeenCalledOnce();
    for (const url of ["https://custom.example.com/api", "https://custom.example.com:9444/api"]) await expect(platform.dispatch(runtime, "background", "http.request", {url})).rejects.toThrow("not granted");
    const other = await dynamicRuntime("other.plugin");
    await expect(platform.dispatch(other, "background", "http.request", {url: origin + "/api"})).rejects.toThrow("not granted");
  });
  it("does not grant a destination after authorization is declined", async () => {
    const runtime = await dynamicRuntime(); const origin = "https://custom.example.com:9443"; native.confirm.mockResolvedValue(false);
    expect(await platform.dispatch(runtime, "background", "network.request", {origin})).toBe(false);
    expect(runtime.origins.has(origin)).toBe(false);
    expect(native.invoke.mock.calls.some(([method]) => method === "plugin_allow_origin")).toBe(false);
    await expect(platform.dispatch(runtime, "background", "http.request", {url: origin})).rejects.toThrow("not granted");
  });
  it.each(["http://example.com", "https://user:password@example.com", "https://example.com/path", "https://example.com/", "https://*", "file:///tmp/file"])("rejects non-exact or insecure network permissions: %s", async origin => {
    const runtime = await dynamicRuntime();
    await expect(platform.dispatch(runtime, "background", "network.request", {origin})).rejects.toThrow();
    expect(native.confirm).not.toHaveBeenCalled();
  });
  it.each(["disable", "replace", "remove", "lock"])("does not apply pending network approval after %s", async operation => {
    const runtime = await dynamicRuntime(); const confirmation = deferred<boolean>(); native.confirm.mockReturnValue(confirmation.promise);
    const opening = platform.dispatch(runtime, "background", "network.request", {origin: "https://custom.example.com"});
    if (operation === "disable") platform.toggle("test.plugin", false);
    else if (operation === "replace") platform.install(bundle());
    else if (operation === "remove") platform.remove("test.plugin");
    else platform.locked = true;
    confirmation.resolve(true); await expect(opening).rejects.toThrow("cancelled");
    expect(native.invoke.mock.calls.some(([method]) => method === "plugin_allow_origin")).toBe(false);
  });
  it("coalesces concurrent requests for one origin and blocks conflicting prompts", async () => {
    const runtime = await dynamicRuntime(); const confirmation = deferred<boolean>(); native.confirm.mockReturnValue(confirmation.promise);
    const first = platform.dispatch(runtime, "background", "network.request", {origin: "https://custom.example.com"});
    const second = platform.dispatch(runtime, "view", "network.request", {origin: "https://custom.example.com"});
    await expect(platform.dispatch(runtime, "view", "network.request", {origin: "https://other.example.com"})).rejects.toThrow("in progress");
    confirmation.resolve(true); expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(native.confirm).toHaveBeenCalledOnce();
    expect(native.invoke.mock.calls.filter(([method]) => method === "plugin_allow_origin")).toHaveLength(1);
  });
  it("does not retain an origin when the native grant fails", async () => {
    const runtime = await dynamicRuntime();
    native.invoke.mockImplementation(async (method: string) => {if (method === "plugin_allow_origin") throw new Error("grant failed");});
    await expect(platform.dispatch(runtime, "background", "network.request", {origin: "https://custom.example.com"})).rejects.toThrow("grant failed");
    expect(runtime.origins.has("https://custom.example.com")).toBe(false); expect(runtime.networkRequest).toBeUndefined();
  });
  it.each(["disable", "lock"])("does not expose a late native network grant after %s", async operation => {
    const runtime = await dynamicRuntime(); const grant = deferred<void>();
    native.invoke.mockImplementation((method: string) => method === "plugin_allow_origin" ? grant.promise : Promise.resolve());
    const opening = platform.dispatch(runtime, "background", "network.request", {origin: "https://custom.example.com"});
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("plugin_allow_origin", expect.anything()));
    if (operation === "disable") platform.toggle("test.plugin", false); else platform.locked = true;
    grant.resolve(); await expect(opening).rejects.toThrow("cancelled");
    expect(runtime.origins.has("https://custom.example.com")).toBe(false); expect(runtime.networkRequest).toBeUndefined();
    if (operation === "lock") {
      platform.locked = false;
      await expect(platform.dispatch(runtime, "background", "http.request", {url: "https://custom.example.com/api"})).rejects.toThrow("not granted");
    }
  });
  it("remembers approved origins on reload without modifying the installed manifest", async () => {
    const runtime = await dynamicRuntime();
    await platform.dispatch(runtime, "background", "network.request", {origin: "https://custom.example.com"});
    expect(runtime.entry.bundle.manifest.permissions.network).toEqual(["https://example.com"]);
    platform.toggle("test.plugin", true); const reloaded = await platform.start(platform.entries[0]);
    expect(reloaded.origins.has("https://custom.example.com")).toBe(true);
    await platform.dispatch(reloaded, "background", "network.request", {origin: "https://custom.example.com"});
    expect(native.confirm).toHaveBeenCalledTimes(1);
  });
  it("caps runtime destinations before displaying another authorization prompt", async () => {
    const runtime = await dynamicRuntime();
    for (let index = 1; index < 16; index++) runtime.origins.add(`https://host${index}.example.com`);
    await expect(platform.dispatch(runtime, "background", "network.request", {origin: "https://extra.example.com"})).rejects.toThrow("limit");
    expect(native.confirm).not.toHaveBeenCalled();
  });
  it("isolates configuration, events, network origins and UI contributions", async () => {
    const runtime = await activate(); const other = await activate("other.plugin");
    await platform.dispatch(runtime, "background", "config.set", {count: 2});
    expect(await platform.dispatch(other, "background", "config.get", {})).toEqual({});
    expect(await platform.dispatch(runtime, "view", "config.get", {})).toEqual({count: 2});
    await expect(platform.dispatch(runtime, "view", "events.publish", {name: "state", value: 1})).rejects.toThrow();
    await platform.dispatch(runtime, "background", "events.publish", {name: "state", value: 1}); expect(other.events.size).toBe(0);
    await expect(platform.dispatch(runtime, "view", "http.request", {url: "https://attacker.example/data"})).rejects.toThrow("origin");
    await expect(platform.dispatch(runtime, "view", "status.update", {id: "undeclared", text: "bad"})).rejects.toThrow();
    await platform.dispatch(runtime, "background", "http.request", {url: "https://example.com/data", bearer: "token"});
    expect(native.invoke).toHaveBeenCalledWith("plugin_http", {capability: runtime.capability, request: {url: "https://example.com/data", bearer: "token"}});
    platform.locked = true; await expect(platform.dispatch(runtime, "view", "config.get", {})).rejects.toThrow("locked");
  });
  it("requires a declared session permission and confirmation", async () => {
    const runtime = await activate(); const onSession = vi.fn(); platform.onSession = onSession;
    delete runtime.entry.bundle.manifest.permissions.sessions;
    await expect(platform.dispatch(runtime, "background", "sessions.open", ssh)).rejects.toThrow("permission");
    expect(native.confirm).not.toHaveBeenCalled();
    runtime.entry.bundle.manifest.permissions.sessions = "open"; native.confirm.mockResolvedValue(false);
    await expect(platform.dispatch(runtime, "background", "sessions.open", ssh)).rejects.toThrow("cancelled");
    expect(onSession).not.toHaveBeenCalled(); expect(native.invoke.mock.calls.some(([method]) => method === "plugin_stage_ssh")).toBe(false);
  });
  it.each(["disable", "lock"])("cancels a pending confirmation after %s", async operation => {
    const runtime = await activate(); const confirmation = deferred<boolean>(); native.confirm.mockReturnValue(confirmation.promise);
    platform.onSession = vi.fn(); const opening = platform.dispatch(runtime, "background", "sessions.open", ssh);
    if (operation === "disable") platform.toggle("test.plugin", false); else platform.locked = true;
    confirmation.resolve(true); await expect(opening).rejects.toThrow("cancelled"); expect(platform.onSession).not.toHaveBeenCalled();
  });
  it("rechecks lifecycle after asynchronous credential staging", async () => {
    const runtime = await activate(); const staged = deferred<void>(); native.invoke.mockReturnValue(staged.promise);
    platform.onSession = vi.fn(); const opening = platform.dispatch(runtime, "background", "sessions.open", ssh);
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("plugin_stage_ssh", expect.anything()));
    platform.stop("test.plugin"); staged.resolve(); await expect(opening).rejects.toThrow("cancelled"); expect(platform.onSession).not.toHaveBeenCalled();
  });
  it("hands off a destination-bound credential without exposing the password in session state", async () => {
    const runtime = await activate(); const onSession = vi.fn((_session: SessionConfig) => "native-pane"); platform.onSession = onSession;
    expect(await platform.dispatch(runtime, "background", "sessions.open", {...ssh, password: "ignored-secret", skipHostKeyCheck: true})).toEqual({paneId: "native-pane"});
    const session = onSession.mock.calls[0][0];
    expect(session).toMatchObject({host: ssh.host, port: ssh.port, username: ssh.username, credentialHandoff: true, authType: "password"});
    expect(session).not.toHaveProperty("password"); expect(session).not.toHaveProperty("skipHostKeyCheck");
    expect(native.invoke).toHaveBeenCalledWith("plugin_stage_ssh", {capability: runtime.capability, instanceId: session.id, secretKey: "ssh-password", host: ssh.host, port: ssh.port, username: ssh.username});
  });
});

describe("plugin RPC cleanup", () => {
  it.each(["oversized", "cyclic", "bigint"])("rejects %s responses without stranding the caller", async kind => {
    const port = {postMessage: vi.fn(), close: vi.fn(), onmessage: undefined as undefined | ((event: {data: unknown}) => Promise<void>)};
    const endpoint = new Endpoint(port as unknown as MessagePort, async () => undefined);
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    const value = kind === "oversized" ? "x".repeat(262145) : kind === "cyclic" ? cyclic : BigInt(1);
    const pending = endpoint.call("query");
    const rejection = expect(pending).rejects.toThrow(kind === "oversized" ? "limit" : "Invalid plugin response");
    await port.onmessage!({data: {kind: "result", id: 1, value}});
    await rejection;
    endpoint.close();
  });
  it("rejects pending requests and ignores further calls when closed", async () => {
    const port = {postMessage: vi.fn(), close: vi.fn(), onmessage: null};
    const endpoint = new Endpoint(port as unknown as MessagePort, async () => undefined);
    const pending = endpoint.call("query"); const rejection = expect(pending).rejects.toThrow("stopped");
    endpoint.close(); await rejection; expect(port.close).toHaveBeenCalledOnce();
    await expect(endpoint.call("query")).rejects.toThrow("unavailable"); expect(port.postMessage).toHaveBeenCalledTimes(1);
  });
});

describe("synced plugin records", () => {
  it("keeps configuration and store source in the synced records and across a replace", async () => {
    const source = {storeId: "2648d2bab1b4c559", storeName: "Team", version: "1.0.0", sha256: "a".repeat(64)};
    platform.install(bundle(), source);
    const runtime = await platform.start(platform.entries[0]);
    await platform.dispatch(runtime, "view", "config.set", {url: "https://example.com"});
    expect(saved).toEqual([expect.objectContaining({id: "test.plugin", enabled: true, source, config: {url: "https://example.com"}})]);
    platform.install(bundle());
    expect(platform.entries[0].source).toBeUndefined();
    expect(platform.entries[0].config).toEqual({url: "https://example.com"});
    const restored = new PluginPlatform(records); await restored.load();
    expect(restored.entries[0].config).toEqual({url: "https://example.com"});
    restored.remove("test.plugin");
    expect(saved).toEqual([]);
  });
  it("reloads from synced data", async () => {
    await activate();
    saved = [{id: "other.plugin", bundle: bundle("other.plugin"), enabled: true, hidden: []}];
    await platform.reload();
    expect(platform.runtimes.size).toBe(0);
    expect(platform.entries.map(entry => entry.bundle.manifest.id)).toEqual(["other.plugin"]);
  });
  it("moves plugins and their configuration out of WebView storage once", async () => {
    values.set("nexterm.plugins.v1", JSON.stringify([{bundle: bundle(), enabled: true, hidden: []}]));
    values.set("nexterm.plugin.config.test.plugin", JSON.stringify({user: "me"}));
    const files = new Map<string, unknown>();
    native.invoke.mockImplementation(async (method: string, args: {name: string; value?: unknown}) => {
      if (method === "load_data_file") return files.get(args.name) ?? null;
      if (method === "save_data_file") files.set(args.name, args.value);
    });
    const migrated = new PluginPlatform(fileRecords(() => undefined));
    await migrated.load();
    expect(migrated.entries[0].config).toEqual({user: "me"});
    expect(files.get("plugins")).toEqual([expect.objectContaining({id: "test.plugin", config: {user: "me"}})]);
    expect(values.has("nexterm.plugins.v1")).toBe(false);
    expect(values.has("nexterm.plugin.config.test.plugin")).toBe(false);
  });
});
