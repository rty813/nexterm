import type { SessionConfig, TerminalLeafNode } from "../types/domain";

export type PaneSessionEdits = Pick<SessionConfig, "label" | "group" | "term" | "charset" | "system" | "termOptions" | "tabColor">;

/** A saved password, including an empty one (servers that accept a blank password). `undefined`/`null` = not saved. */
export function hasSavedPassword(session: Pick<SessionConfig, "password">): boolean {
  return typeof session.password === "string";
}

export function withoutSessionSecrets(session: SessionConfig): SessionConfig {
  const { password, passphrase, credentialHandoff, ...config } = session;
  if (config.jumpHost) config.jumpHost = { ...config.jumpHost, password: undefined, passphrase: undefined };
  if (config.proxy) config.proxy = { ...config.proxy, password: undefined };
  return config;
}

export function applyPaneSessionEdits(leaf: TerminalLeafNode, edits: PaneSessionEdits): TerminalLeafNode {
  return { ...leaf, session: { ...leaf.session, ...edits }, title: undefined, color: edits.tabColor };
}

export function savePaneProfile(sessions: SessionConfig[], live: SessionConfig, edits: PaneSessionEdits, rememberPassword: boolean): SessionConfig[] {
  const existing = sessions.find((session) => session.id === live.id);
  if (existing) return sessions.map((session) => session === existing ? { ...session, ...edits } : session);
  const profile = { ...withoutSessionSecrets(live), ...edits };
  if (rememberPassword && live.authType === "password" && !live.credentialHandoff) profile.password = live.password;
  return [...sessions, profile];
}
