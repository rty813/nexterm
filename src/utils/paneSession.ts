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

/**
 * Keep what the user typed into the login form. A pane without a profile (quick connect)
 * gets one, otherwise the password would be gone after a restart. Plugin handoff sessions
 * belong to the plugin and are never turned into profiles.
 */
export function rememberPaneLogin(sessions: SessionConfig[], live: SessionConfig, credentials: Pick<SessionConfig, "password"> & { username?: string }): SessionConfig[] {
  if (sessions.some((session) => session.id === live.id)) {
    return sessions.map((session) => session.id === live.id ? { ...session, ...credentials } : session);
  }
  if (live.credentialHandoff) return sessions;
  return [...sessions, { ...withoutSessionSecrets(live), ...credentials }];
}

/**
 * The saved password profile a quick-connect address refers to. Each parse makes a new id,
 * so without this a remembered login is never found again. An address with no user only
 * matches when exactly one profile fits, so it can't log in as the wrong account.
 */
export function findSavedLogin(sessions: SessionConfig[], parsed: SessionConfig): SessionConfig | undefined {
  if (parsed.protocol !== "ssh" || parsed.authType !== "password") return undefined;
  const host = parsed.host.toLowerCase();
  const matches = sessions.filter((session) =>
    session.protocol === "ssh" && session.authType === "password" && hasSavedPassword(session)
    && session.host.toLowerCase() === host && session.port === parsed.port
    && (!parsed.username || session.username === parsed.username));
  return parsed.username || matches.length === 1 ? matches[0] : undefined;
}
