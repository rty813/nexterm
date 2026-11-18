import { describe, expect, it } from "vitest";
import helloPackage from "../../plugins/hello.nexterm-plugin?raw";
import helloManifest from "../../plugins/hello/manifest.json?raw";
import helloMain from "../../plugins/hello/main.js?raw";
import helloView from "../../plugins/hello/view.html?raw";
import { parsePackage, sessionCatalog, sessionChoices, sessionSourceKey, statusLabelPrefix, temporarySsh } from "../plugins/model";
import { snapshotWorkspace } from "../utils/workspaceSnapshot";

const manifest = () => ({apiVersion: 1, id: "test.plugin", name: "Test", version: "1.0.0", main: "main.js", permissions: {network: ["https://example.com"]}, contributes: {commands: [{id: "show", title: "Show"}], views: [{id: "view", title: "View", location: "tab", file: "view.html"}]}});
const bundle = () => ({manifest: manifest(), files: {"main.js": "", "view.html": "<h1>test</h1>"}});

describe("compact title bar status", () => {
  it.each([
    ["计数：未开始", "计数：12", "计数："], ["Usage: unknown", "Usage: 80%", "Usage: "],
    ["Usage: unknown", "Offline", ""], ["Usage: unknown", "Usage: ", ""],
    ["14:30", "14:45", ""], ["https://example.com", "https://example.com", ""], ["Hello", "Hello 1", ""],
  ])("shortens %s only when %s preserves its declared label", (declared, current, prefix) => {
    expect(statusLabelPrefix(declared, current)).toBe(prefix);
  });
});

describe("plugin package validation", () => {
  it("ships a valid Hello package matching the public template", () => {
    const value = JSON.parse(helloPackage);
    expect(value.manifest).toEqual(JSON.parse(helloManifest));
    expect(Object.keys(value.files).sort()).toEqual(["main.js", "view.html"]);
    expect(value.files["main.js"].replace(/\r\n/g, "\n")).toBe(helloMain.replace(/\r\n/g, "\n"));
    expect(value.files["view.html"].replace(/\r\n/g, "\n")).toBe(helloView.replace(/\r\n/g, "\n"));
    expect(parsePackage(value).manifest.permissions).toEqual({network: []});
  });
  it("accepts opt-in runtime network permission but rejects wildcards and invalid flags", () => {
    const dynamic = bundle(); Object.assign(dynamic.manifest.permissions, {networkRequest: true});
    expect(parsePackage(dynamic).manifest.permissions.networkRequest).toBe(true);
    for (const networkRequest of [false, "true", "*", 1]) {
      const invalid = bundle(); Object.assign(invalid.manifest.permissions, {networkRequest});
      expect(() => parsePackage(invalid)).toThrow();
    }
    const wildcard = bundle(); wildcard.manifest.permissions.network = ["https://*"];
    expect(() => parsePackage(wildcard)).toThrow();
  });
  it("rejects arbitrary permissions, insecure origins, traversal and missing views", () => {
    const unknown = bundle(); Object.assign(unknown.manifest.permissions, {shell: true});
    const http = bundle(); http.manifest.permissions.network = ["http://example.com"];
    const path = bundle(); path.manifest.main = "../main.js";
    const missing = bundle(); delete (missing.files as Record<string, string>)["view.html"];
    for (const value of [unknown, http, path, missing]) expect(() => parsePackage(value)).toThrow();
  });
  it("rejects duplicate IDs and dangling commands", () => {
    const duplicate = bundle(); duplicate.manifest.contributes.views[0].id = "show";
    const dangling = bundle(); Object.assign(dangling.manifest.contributes, {toolbar: [{id: "button", text: "test", command: "missing"}]});
    expect(() => parsePackage(duplicate)).toThrow(); expect(() => parsePackage(dangling)).toThrow();
  });
  it("validates generic session source permissions and references", () => {
    const valid = bundle(); Object.assign(valid.manifest.permissions, {sessions: "open"});
    valid.manifest.contributes.views[0].location = "settings";
    Object.assign(valid.manifest.contributes, {sessionSources:[{id:"hosts",title:"Hosts",refreshCommand:"show",settingsView:"view"}]});
    expect(parsePackage(valid).manifest.contributes.sessionSources).toHaveLength(1);
    for (const change of [
      (value: typeof valid) => {delete (value.manifest.permissions as any).sessions;},
      (value: typeof valid) => {value.manifest.contributes.views[0].location = "tab";},
      (value: typeof valid) => {(value.manifest.contributes as any).sessionSources[0].refreshCommand = "missing";},
      (value: typeof valid) => {(value.manifest.contributes as any).sessionSources[0].id = "show";},
    ]) {const invalid = structuredClone(valid); change(invalid); expect(() => parsePackage(invalid)).toThrow();}
  });
  it("allows a command to open a standalone dialog without a docked panel", () => {
    const value = bundle();
    value.manifest.contributes.views[0].location = "dialog";
    Object.assign(value.manifest.contributes, {statusBar: [{id:"indicator",text:"Count",command:"show"}]});
    const {contributes} = parsePackage(value).manifest;
    expect(contributes.views?.map(view => view.location)).toEqual(["dialog"]);
    expect(contributes.statusBar?.[0].command).toBe("show");
  });
});

describe("session source data validation", () => {
  const item = {id:"item",label:"Server",description:"10.0.0.1",group:"Production"};
  it("copies only display metadata, never connection details or credentials", () => {
    const input = {state:"ready",items:[{...item,password:"secret",host:"untrusted"}]};
    const catalog = sessionCatalog(input);
    input.items[0].label = "changed";
    expect(catalog).toEqual({state:"ready",items:[item]});
    expect(sessionSourceKey("one", "hosts", "a:b")).not.toBe(sessionSourceKey("one", "hosts", "a%3Ab"));
  });
  it.each([
    {state:"unknown",items:[]}, {state:"signedOut",items:[item]},
    {state:"ready",items:[item,item]}, {state:"ready",items:[{...item,id:""}]},
    {state:"ready",items:[{...item,label:"a\n"}]}, {state:"ready",items:[{...item,description:"x".repeat(501)}]},
    {state:"ready",items:Array.from({length:1001}, (_, index) => ({id:String(index),label:"Host"}))},
    {state:"ready",items:[],message:"x".repeat(501)},
  ])("rejects invalid or excessive catalogs: %j", value => {expect(() => sessionCatalog(value)).toThrow();});
  it("bounds account choices and rejects duplicate or malformed IDs", () => {
    expect(sessionChoices([{id:"root",label:"Root",password:"ignored"}])).toEqual([{id:"root",label:"Root"}]);
    for (const choices of [[],[{id:"root",label:"Root"},{id:"root",label:"Other"}], [{id:"x",label:""}], Array.from({length:65}, (_, index) => ({id:String(index),label:"Account"}))]) expect(() => sessionChoices(choices)).toThrow();
  });
});

describe("structured plugin SSH sessions", () => {
  const input = {host: "ssh.example.com", port: 2222, username: "user#team#server-1", label: "host"};
  it("does not execute shell text or inherit unsafe session options", () => {
    const session = temporarySsh({...input, shellCommand: "bad", startupCommand: "bad", skipHostKeyCheck: true, password: "secret"});
    expect(session.username).toBe(input.username); expect(session.password).toBeUndefined();
    expect(session.skipHostKeyCheck).toBeUndefined(); expect(session.startupCommand).toBeUndefined(); expect(session.shellCommand).toBeUndefined();
  });
  it("rejects invalid ports, hosts and control characters", () => {
    for (const value of [{...input, port: 0}, {...input, port: 65536}, {...input, host: "host; command"}, {...input, username: "user\ncommand"}]) expect(() => temporarySsh(value)).toThrow();
  });
  it("strips one-time handoff state when saving a workspace", () => {
    const session = {...temporarySsh(input), authType: "password" as const, credentialHandoff: true};
    const snapshot = snapshotWorkspace({activeGroupId: "g", root: {kind: "group", id: "g", activeTabId: "p", tabs: [{kind: "leaf", paneId: "p", session, status: "connecting", reconnectCount: 0, cols: 80, rows: 24}]}}, []);
    expect(JSON.stringify(snapshot)).not.toContain("credentialHandoff");
  });
});
