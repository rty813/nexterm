import { describe, expect, it } from "vitest";
import type { CredentialSummary, SessionConfig } from "../types/domain";
import { applyBatchLogin, credentialsFor, resolveLogin, type BatchLogin } from "../utils/credentials";
import { findSavedLogin, hasSavedLogin, loginPatch, rememberPaneLogin, withoutSessionSecrets } from "../utils/paneSession";
import { missingDesktopCredentials } from "../utils/desktopView";
import { credentialResources } from "../i18n.credentials";
import { DEFAULT_EXPECT } from "../utils/onekey";

const cred = (id: string, p: Partial<CredentialSummary> = {}): CredentialSummary => ({
  id, name: id, username: "ops", authType: "password", hasPassword: true, hasPassphrase: false, login: true, onekey: false, expect: DEFAULT_EXPECT, usedBy: 0, ...p,
});
const list = [cred("pw"), cred("key", { authType: "privatekey", username: "git" }), cred("anon", { username: "" })];
const own = { username: "me", authType: "password" as const };
const ssh = { id: "s", label: "s", group: "", protocol: "ssh", host: "h", port: 22, username: "me", authType: "password", term: "xterm", keepAliveSecs: 0 } as SessionConfig;

describe("credentials in the session form", () => {
  it("offers keys to SSH only, passwords to Telnet and desktops, and nothing to other protocols", () => {
    expect(credentialsFor("ssh", list).map((c) => c.id)).toEqual(["anon", "key", "pw"]);
    expect(credentialsFor("rdp", list).map((c) => c.id)).toEqual(["anon", "pw"]);
    expect(credentialsFor("telnet", list).map((c) => c.id)).toEqual(["anon", "pw"]);
    expect(credentialsFor("tcp", list)).toEqual([]);
    expect(credentialsFor("ssh", [...list, cred("sudo", { login: false, onekey: true })]).map((c) => c.id)).toEqual(["anon", "key", "pw"]);
  });

  it("applies the picked credential", () => {
    expect(resolveLogin("ssh", "key", own, list)).toEqual({ credentialId: "key", username: "git", authType: "privatekey", usernameLocked: true });
    expect(resolveLogin("ssh", "anon", own, list)).toMatchObject({ username: "me", usernameLocked: false });
    expect(resolveLogin("vnc", "pw", own, list)).toMatchObject({ credentialId: "pw", username: "me", usernameLocked: false });
    expect(resolveLogin("telnet", "pw", own, list)).toMatchObject({ credentialId: "pw", username: "ops", usernameLocked: true });
    expect(resolveLogin("ssh", "", own, list).credentialId).toBeUndefined();
  });

  it("drops a credential the protocol can't use, keeps one that is not (yet) known", () => {
    expect(resolveLogin("rdp", "key", own, list).credentialId).toBeUndefined();
    expect(resolveLogin("serial", "pw", own, list).credentialId).toBeUndefined();
    expect(resolveLogin("ssh", "gone", own, [])).toMatchObject({ credentialId: "gone", username: "me" });
  });
});

describe("sessions with a credential", () => {
  const withCred: SessionConfig = { ...ssh, credentialId: "pw" };

  it("connect without asking and are found by quick connect", () => {
    expect(hasSavedLogin(withCred)).toBe(true);
    expect(hasSavedLogin(ssh)).toBe(false);
    expect(findSavedLogin([withCred], { ...ssh, id: "other" })).toBe(withCred);
    const rdp = { ...withCred, protocol: "rdp" as const };
    expect(missingDesktopCredentials(rdp)).toBeNull();
    expect(missingDesktopCredentials({ ...rdp, username: "" })).toEqual({ user: true, password: false });
  });

  it("a typed password replaces the credential, a typed user name does not", () => {
    expect(rememberPaneLogin([withCred], withCred, loginPatch({ password: "x" }))[0]).toMatchObject({ password: "x", credentialId: undefined });
    expect(rememberPaneLogin([withCred], withCred, loginPatch({ username: "u" }))[0]).toMatchObject({ username: "u", credentialId: "pw" });
    expect(loginPatch()).toEqual({});
  });

  it("a credential picked in the login form replaces the typed password", () => {
    const typed: SessionConfig = { ...ssh, password: "old" };
    const next = rememberPaneLogin([typed], typed, loginPatch({ credentialId: "pw", username: "ops" }))[0];
    expect(next).toMatchObject({ credentialId: "pw", username: "ops", password: undefined });
    expect(hasSavedLogin(next)).toBe(true);
    // A credential without a user name keeps the session's.
    expect(loginPatch({ credentialId: "anon" })).toEqual({ credentialId: "anon", password: undefined });
  });

  it("keep the reference (not a secret) in workspace snapshots", () => {
    expect(withoutSessionSecrets(withCred).credentialId).toBe("pw");
  });
});

describe("changing the login of several sessions", () => {
  const own = (p: Partial<Extract<BatchLogin, { kind: "own" }>> = {}): BatchLogin => ({
    kind: "own", username: "", authType: "keep", password: "", privateKeyPath: "", passphrase: "", clearSecret: false, ...p,
  });
  const saved: SessionConfig = { ...ssh, password: "old", credentialId: undefined };
  const keyed: SessionConfig = { ...ssh, authType: "privatekey", privateKeyPath: "~/.ssh/a", passphrase: "pp" };
  const rdp: SessionConfig = { ...ssh, protocol: "rdp", password: "r" };
  const vnc: SessionConfig = { ...ssh, protocol: "vnc", username: "" };
  const serial: SessionConfig = { ...ssh, protocol: "serial" };

  it("picks a credential, dropping the session's own secrets", () => {
    expect(applyBatchLogin(keyed, { kind: "credential", credentialId: "pw" }, list)).toMatchObject({
      credentialId: "pw", username: "ops", authType: "password", password: undefined, privateKeyPath: undefined, passphrase: undefined,
    });
    expect(applyBatchLogin(saved, { kind: "credential", credentialId: "anon" }, list)).toMatchObject({ credentialId: "anon", username: "me" });
    // VNC keeps its own (empty) user name; a key can't log in to RDP; serial has no login.
    expect(applyBatchLogin(vnc, { kind: "credential", credentialId: "pw" }, list)).toMatchObject({ credentialId: "pw", username: "" });
    expect(applyBatchLogin(rdp, { kind: "credential", credentialId: "key" }, list)).toBeNull();
    expect(applyBatchLogin(serial, { kind: "credential", credentialId: "pw" }, list)).toBeNull();
    expect(applyBatchLogin(saved, { kind: "credential", credentialId: "gone" }, list)).toBeNull();
  });

  it("keeps what is left empty", () => {
    const withCred: SessionConfig = { ...saved, credentialId: "pw" };
    expect(applyBatchLogin(withCred, own(), list)).toEqual({ ...saved, credentialId: undefined });
    expect(applyBatchLogin(keyed, own(), list)).toEqual({ ...keyed, credentialId: undefined });
  });

  it("sets the user name, auth type and secrets", () => {
    expect(applyBatchLogin(saved, own({ username: " root ", password: "new" }), list)).toMatchObject({ username: "root", password: "new" });
    expect(applyBatchLogin(saved, own({ authType: "privatekey", privateKeyPath: " ~/.ssh/b " }), list)).toMatchObject({
      authType: "privatekey", privateKeyPath: "~/.ssh/b", password: "old",
    });
    expect(applyBatchLogin(keyed, own({ authType: "password", password: "p" }), list)).toMatchObject({ authType: "password", password: "p" });
    // Desktops and Telnet take the password; the auth type is SSH's only.
    expect(applyBatchLogin(rdp, own({ authType: "privatekey", password: "x", username: "adm" }), list)).toMatchObject({ authType: "password", password: "x", username: "adm" });
    expect(applyBatchLogin(vnc, own({ username: "adm" }), list)!.username).toBe("");
    expect(applyBatchLogin(serial, own({ username: "adm" }), list)).toBeNull();
  });

  it("removes the saved password, or the key passphrase", () => {
    expect(applyBatchLogin(saved, own({ clearSecret: true }), list)!.password).toBeUndefined();
    expect(applyBatchLogin(keyed, own({ clearSecret: true }), list)).toMatchObject({ passphrase: undefined, privateKeyPath: "~/.ssh/a" });
    expect(applyBatchLogin(saved, own({ clearSecret: true, password: "typed" }), list)!.password).toBe("typed");
  });
});

it("has the same strings in both languages", () => {
  const keys = (o: object, prefix = ""): string[] =>
    Object.entries(o).flatMap(([k, v]) => (typeof v === "object" ? keys(v as object, `${prefix}${k}/`) : [`${prefix}${k.replace(/_(one|other)$/, "")}`]));
  const set = (o: object) => [...new Set(keys(o))].sort();
  expect(set(credentialResources["en-US"])).toEqual(set(credentialResources["zh-CN"]));
});
