import { describe, expect, it } from "vitest";
import { DEFAULT_TERMINAL_OPTIONS, type SessionConfig, type TerminalLeafNode } from "../types/domain";
import { applyPaneSessionEdits, findSavedLogin, hasSavedPassword, paneFormSession, rememberPaneLogin, savePaneProfile } from "../utils/paneSession";
import { parseQuickConnectInput } from "../utils/quickConnect";
import { snapshotWorkspace } from "../utils/workspaceSnapshot";

const edits: Partial<SessionConfig> = {
  label: "Build host", group: "Work", term: "xterm", charset: "GBK", system: "linux",
  termOptions: { ...DEFAULT_TERMINAL_OPTIONS, enterKey: "lf" }, tabColor: "#f00",
};

const leafOf = (session: SessionConfig, extra: Partial<TerminalLeafNode> = {}): TerminalLeafNode =>
  ({ kind: "leaf", paneId: "p", session, status: "connected", rows: 24, cols: 100, reconnectCount: 0, ...extra });

/** What the unified session form returns: the form's session with the user's edits. */
const submit = (leaf: TerminalLeafNode, saved: SessionConfig | undefined, patch: Partial<SessionConfig>): SessionConfig =>
  ({ ...paneFormSession(leaf, saved), ...patch });

describe("settings for an open session", () => {
  it("changes a quick tab in place and only switches snapshots to a reference once saved", () => {
    const session = parseQuickConnectInput("build.example:2222")!;
    expect(session.label).toBe("build.example");
    const leaf = leafOf(session, { reconnectCount: 2, title: "old title" });
    const form = submit(leaf, undefined, edits);
    const applied = applyPaneSessionEdits(leaf, form);
    expect(applied).toMatchObject({ paneId: "p", status: "connected", reconnectCount: 2, color: "#f00", session: { ...session, ...edits } });
    expect(applied.title).toBeUndefined();
    const workspace = { root: { kind: "group" as const, id: "group", activeTabId: "p", tabs: [applied] }, activeGroupId: "group" };
    expect(snapshotWorkspace(workspace, []).root).toMatchObject({ tabs: [{ session: { ...edits, port: 2222 } }] });
    const profiles = savePaneProfile([], applied.session, form, false);
    expect(snapshotWorkspace(workspace, profiles.map((profile) => profile.id)).root).toMatchObject({ tabs: [{ sessionId: session.id }] });
    expect(session.termOptions).toBeUndefined();
  });

  it("edits connection settings too, keeping the tab's login secrets when the form leaves them blank", () => {
    const live: SessionConfig = {
      ...parseQuickConnectInput("ops@example")!, password: "typed-at-login",
      jumpHost: { host: "jump", enabled: true, username: "ops", port: 22, authType: "password", password: "jump-login" },
    };
    const leaf = leafOf(live);
    const form = paneFormSession(leaf);
    expect(form.password).toBeUndefined();
    expect(form.jumpHost?.password).toBeUndefined();
    const applied = applyPaneSessionEdits(leaf, { ...form, port: 2200, keepAliveSecs: 15 });
    expect(applied.session).toMatchObject({ port: 2200, keepAliveSecs: 15, password: "typed-at-login", jumpHost: { password: "jump-login" } });
    const retyped = applyPaneSessionEdits(leaf, { ...form, password: "new" });
    expect(retyped.session.password).toBe("new");
  });

  it("shows the saved profile's secrets, not the ones typed at login", () => {
    const live = { ...parseQuickConnectInput("ops@example")!, password: "typed" };
    const saved = { ...live, password: "stored" };
    expect(paneFormSession(leafOf(live), saved).password).toBe("stored");
    expect(paneFormSession(leafOf(live, { color: "#0f0" })).tabColor).toBe("#0f0");
  });

  it.each(["wsl", "telnet://example:2323", "tcp://example:9000", "ssh -p 2022 -i ~/.ssh/build ops@example"]) (
    "preserves the connection details when saving %s", (raw) => {
      const live = parseQuickConnectInput(raw)!;
      const form = submit(leafOf(live), undefined, edits);
      expect(savePaneProfile([], live, form, false)).toEqual([{ ...live, ...edits, tabColor: "#f00" }]);
    }
  );

  it("updates the same profile with what the form shows, keeping stored credentials", () => {
    const live = { ...parseQuickConnectInput("user@example")!, password: "temporary" };
    const other = parseQuickConnectInput("wsl")!;
    const saved = savePaneProfile([other], live, submit(leafOf(live), undefined, edits), false);
    const stored = { ...saved[1], password: "stored", keepAliveSecs: 180 };
    const form = submit(leafOf(live), stored, { ...edits, label: "Renamed", keepAliveSecs: 30 });
    const updated = savePaneProfile([other, stored], live, form, true);
    expect(updated).toHaveLength(2);
    expect(updated[0]).toBe(other);
    expect(updated[1]).toMatchObject({ id: live.id, label: "Renamed", password: "stored", keepAliveSecs: 30 });
  });

  it("only stores the login password on opt-in and never copies handoff or nested transient secrets", () => {
    const live: SessionConfig = {
      ...parseQuickConnectInput("ops@example")!, password: "secret-login", passphrase: "secret-key",
      jumpHost: { host: "jump", enabled: true, username: "ops", port: 22, authType: "privatekey", password: "secret-jump", passphrase: "secret-phrase" },
      proxy: { host: "proxy", kind: "http", port: 8080, password: "secret-proxy" },
    };
    const form = submit(leafOf(live), undefined, edits);
    expect(JSON.stringify(savePaneProfile([], live, form, false))).not.toContain("secret");
    expect(savePaneProfile([], live, form, true)[0].password).toBe("secret-login");
    expect(savePaneProfile([], live, { ...form, password: "typed-in-form" }, true)[0].password).toBe("typed-in-form");
    const handoffLive = { ...live, credentialHandoff: true };
    const handoff = savePaneProfile([], handoffLive, submit(leafOf(handoffLive), undefined, edits), true)[0];
    expect(handoff).not.toHaveProperty("credentialHandoff");
    expect(JSON.stringify(handoff)).not.toContain("secret");
    expect(live.jumpHost?.passphrase).toBe("secret-phrase");
  });
});

describe("hasSavedPassword", () => {
  it("counts a blank password as saved", () => {
    expect(hasSavedPassword({ password: "" })).toBe(true);
    expect(hasSavedPassword({ password: "x" })).toBe(true);
    expect(hasSavedPassword({})).toBe(false);
    expect(hasSavedPassword({ password: undefined })).toBe(false);
  });
});

describe("remembering a quick-connect login", () => {
  it("creates a profile that the same address finds again after a restart", () => {
    const live = parseQuickConnectInput("root@10.0.0.5:2222")!;
    const saved = rememberPaneLogin([], live, { password: "pw" });
    expect(saved).toEqual([{ ...live, password: "pw" }]);
    const again = parseQuickConnectInput("root@10.0.0.5:2222")!;
    expect(again.id).not.toBe(live.id);
    expect(findSavedLogin(saved, again)).toBe(saved[0]);
  });

  it("updates an existing profile instead of adding one", () => {
    const live = parseQuickConnectInput("root@host")!;
    const updated = rememberPaneLogin([{ ...live, password: "old", keepAliveSecs: 180 }], live, { password: "new" });
    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({ password: "new", keepAliveSecs: 180 });
  });

  it("never makes a profile from a plugin handoff session", () => {
    const live = { ...parseQuickConnectInput("root@host")!, credentialHandoff: true };
    const sessions: SessionConfig[] = [];
    expect(rememberPaneLogin(sessions, live, { password: "pw" })).toBe(sessions);
  });

  it("does not match another user, port, or a profile without a password", () => {
    const saved = { ...parseQuickConnectInput("root@host")!, password: "pw" };
    expect(findSavedLogin([saved], parseQuickConnectInput("admin@host")!)).toBeUndefined();
    expect(findSavedLogin([saved], parseQuickConnectInput("root@host:2222")!)).toBeUndefined();
    expect(findSavedLogin([{ ...saved, password: undefined }], parseQuickConnectInput("root@host")!)).toBeUndefined();
  });

  it("only fills in a missing user when one profile fits", () => {
    const root = { ...parseQuickConnectInput("root@host")!, password: "pw" };
    const admin = { ...parseQuickConnectInput("admin@host")!, password: "pw" };
    expect(findSavedLogin([root], parseQuickConnectInput("host")!)).toBe(root);
    expect(findSavedLogin([root, admin], parseQuickConnectInput("host")!)).toBeUndefined();
  });
});
