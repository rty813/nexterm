import type { AuthType, CredentialSummary, ProtocolType } from "../types/domain";

/** Protocols whose login can come from the credential manager (Rust `credentials::takes_login`). */
export function takesCredential(protocol: ProtocolType): boolean {
  return protocol === "ssh" || protocol === "rdp" || protocol === "vnc";
}

/** The login credentials a session of this protocol can use, by name: remote desktops only take passwords. */
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
