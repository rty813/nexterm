import { describe, expect, it } from "vitest";
import { DEFAULT_TERMINAL_OPTIONS, type SessionConfig, type TerminalLeafNode } from "../types/domain";
import { applyPaneSessionEdits, savePaneProfile, type PaneSessionEdits } from "../utils/paneSession";
import { parseQuickConnectInput } from "../utils/quickConnect";
import { snapshotWorkspace } from "../utils/workspaceSnapshot";

const edits: PaneSessionEdits = {
  label: "Build host", group: "Work", term: "xterm", charset: "GBK", system: "linux",
  termOptions: { ...DEFAULT_TERMINAL_OPTIONS, enterKey: "lf" }, tabColor: "#f00",
};

describe("settings for an open session", () => {
  it("changes a quick tab in place and only switches snapshots to a reference once saved", () => {
    const session = parseQuickConnectInput("build.example:2222")!;
    expect(session.label).toBe("build.example");
    const leaf: TerminalLeafNode = { kind: "leaf", paneId: "p", session, status: "connected", rows: 24, cols: 100, reconnectCount: 2, title: "old title" };
    const applied = applyPaneSessionEdits(leaf, edits);
    expect(applied).toMatchObject({ paneId: "p", status: "connected", reconnectCount: 2, color: "#f00", session: { ...session, ...edits } });
    expect(applied.title).toBeUndefined();
    const workspace = { root: { kind: "group" as const, id: "group", activeTabId: "p", tabs: [applied] }, activeGroupId: "group" };
    expect(snapshotWorkspace(workspace, []).root).toMatchObject({ tabs: [{ session: { ...edits, port: 2222 } }] });
    const profiles = savePaneProfile([], applied.session, edits, false);
    expect(snapshotWorkspace(workspace, profiles.map((profile) => profile.id)).root).toMatchObject({ tabs: [{ sessionId: session.id }] });
    expect(session.termOptions).toBeUndefined();
  });

  it.each(["wsl", "telnet://example:2323", "tcp://example:9000", "ssh -p 2022 -i ~/.ssh/build ops@example"]) (
    "preserves the connection details when saving %s", (raw) => {
      const live = parseQuickConnectInput(raw)!;
      expect(savePaneProfile([], live, edits, false)).toEqual([{ ...live, ...edits }]);
    }
  );

  it("updates the same profile without copying unrelated live settings or overwriting stored credentials", () => {
    const live = { ...parseQuickConnectInput("user@example")!, password: "temporary" };
    const other = parseQuickConnectInput("wsl")!;
    const saved = savePaneProfile([other], live, edits, false);
    const updated = savePaneProfile([other, { ...saved[1], password: "stored", keepAliveSecs: 180 }], live, { ...edits, label: "Renamed" }, true);
    expect(updated).toHaveLength(2);
    expect(updated[0]).toBe(other);
    expect(updated[1]).toMatchObject({ id: live.id, label: "Renamed", password: "stored", keepAliveSecs: 180 });
  });

  it("only stores the login password on opt-in and never copies handoff or nested transient secrets", () => {
    const live: SessionConfig = {
      ...parseQuickConnectInput("ops@example")!, password: "secret-login", passphrase: "secret-key",
      jumpHost: { host: "jump", enabled: true, username: "ops", port: 22, authType: "privatekey", password: "secret-jump", passphrase: "secret-phrase" },
      proxy: { host: "proxy", kind: "http", port: 8080, password: "secret-proxy" },
    };
    expect(JSON.stringify(savePaneProfile([], live, edits, false))).not.toContain("secret");
    expect(savePaneProfile([], live, edits, true)[0].password).toBe("secret-login");
    const handoff = savePaneProfile([], { ...live, credentialHandoff: true }, edits, true)[0];
    expect(handoff).not.toHaveProperty("credentialHandoff");
    expect(JSON.stringify(handoff)).not.toContain("secret");
    expect(live.jumpHost?.passphrase).toBe("secret-phrase");
  });
});
