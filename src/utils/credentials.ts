import type { AuthType, CredentialSummary, ProtocolType, SessionConfig } from "../types/domain";

/** Protocols whose login can come from the credential manager (Rust `credentials::takes_login`); Telnet answers the login prompts with it. */
export function takesCredential(protocol: ProtocolType): boolean {
  return protocol === "ssh" || protocol === "telnet" || protocol === "rdp" || protocol === "vnc";
}

/** The login credentials a session of this protocol can use, by name: only SSH takes private keys. */
export function credentialsFor(protocol: ProtocolType, list: CredentialSummary[]): CredentialSummary[] {
  if (!takesCredential(protocol)) return [];
  return list
    .filter((c) => c.login !== false && (protocol === "ssh" || c.authType !== "privatekey"))
    .sort((a, b) => a.name.localeCompare(b.name, "zh"));
}

export interface LoginForm {
  credentialId?: string;
  username: string;
  authType: AuthType;
  /** The user name comes from the credential and can't be edited. */
  usernameLocked: boolean;
}

/**
 * The login part of the session form with the picked credential applied. An id that is not in
 * the list is kept (the list may still be loading, or the credential was deleted: connecting
 * says so); one the protocol can't use is dropped.
 */
export function resolveLogin(
  protocol: ProtocolType,
  picked: string,
  own: { username: string; authType: AuthType },
  list: CredentialSummary[]
): LoginForm {
  const credential = list.find((c) => c.id === picked);
  if (!picked || !takesCredential(protocol) || (credential && !credentialsFor(protocol, [credential]).length)) {
    return { ...own, usernameLocked: false };
  }
  // A VNC user name selects macOS ARD authentication: it stays the session's own.
  const usernameLocked = Boolean(credential?.username) && protocol !== "vnc";
  return {
    credentialId: picked,
    username: usernameLocked ? credential!.username : own.username,
    authType: protocol === "ssh" && credential ? credential.authType : own.authType,
    usernameLocked,
  };
}

/** A login change applied to several sessions at once (session manager). */
export type BatchLogin =
  | { kind: "credential"; credentialId: string }
  | {
      kind: "own";
      /** Empty: each session keeps its user name. */
      username: string;
      /** SSH sessions only; "keep": each keeps its own. */
      authType: "keep" | "password" | "privatekey";
      /** Empty: the saved password is kept (or removed with `clearSecret`). */
      password: string;
      /** SSH with a private key; empty: kept. */
      privateKeyPath: string;
      passphrase: string;
      /** Remove the saved password (private key: the saved passphrase). */
      clearSecret: boolean;
    };

/**
 * One session with the batch login applied, or null when it can't take it (a protocol
 * without a login, or a credential it can't use). Mirrors what the session form saves.
 */
export function applyBatchLogin<S extends SessionConfig>(session: S, change: BatchLogin, list: CredentialSummary[]): S | null {
  const { protocol } = session;
  if (!takesCredential(protocol)) return null;
  if (change.kind === "credential") {
    const credential = list.find((c) => c.id === change.credentialId);
    if (!credential || !credentialsFor(protocol, [credential]).length) return null;
    const login = resolveLogin(protocol, credential.id, { username: session.username, authType: session.authType }, list);
    return {
      ...session,
      credentialId: credential.id,
      username: login.username,
      authType: login.authType,
      password: undefined,
      privateKeyPath: undefined,
      passphrase: undefined,
    };
  }
  const next: S = { ...session, credentialId: undefined };
  // A VNC user name selects macOS ARD authentication: never set it in bulk.
  const username = change.username.trim();
  if (username && protocol !== "vnc") next.username = username;
  const usesKey = protocol === "ssh" && (change.authType === "keep" ? session.authType : change.authType) === "privatekey";
  if (protocol === "ssh" && change.authType !== "keep") next.authType = change.authType;
  if (usesKey) {
    if (change.privateKeyPath.trim()) next.privateKeyPath = change.privateKeyPath.trim();
    if (change.passphrase) next.passphrase = change.passphrase;
    else if (change.clearSecret) next.passphrase = undefined;
  } else if (change.password) {
    next.password = change.password;
  } else if (change.clearSecret) {
    next.password = undefined;
  }
  return next;
}
