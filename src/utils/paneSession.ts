import type { SessionConfig, TerminalLeafNode } from "../types/domain";

/** A saved password, including an empty one (servers that accept a blank password). `undefined`/`null` = not saved. */
export function hasSavedPassword(session: Pick<SessionConfig, "password">): boolean {
  return typeof session.password === "string";
}

/** Nothing to ask before connecting with a password: one is saved, or a credential provides it. */
export function hasSavedLogin(session: Pick<SessionConfig, "password" | "credentialId">): boolean {
  return Boolean(session.credentialId) || hasSavedPassword(session);
}

/**
 * What a login form changes in the session: a typed password replaces its credential, a picked
 * credential replaces the password (`username`: the credential's own user name, when it has one).
 */
export function loginPatch(creds?: { username?: string; password?: string; credentialId?: string }): Partial<Pick<SessionConfig, "username" | "password" | "credentialId">> {
  if (creds?.credentialId) {
    return { ...(creds.username ? { username: creds.username } : {}), credentialId: creds.credentialId, password: undefined };
  }
  return {
    ...(creds?.username !== undefined ? { username: creds.username } : {}),
    ...(creds?.password !== undefined ? { password: creds.password, credentialId: undefined } : {}),
  };
}

export function withoutSessionSecrets(session: SessionConfig): SessionConfig {
  const { password, passphrase, credentialHandoff, ...config } = session;
  if (config.jumpHost) config.jumpHost = { ...config.jumpHost, password: undefined, passphrase: undefined };
  if (config.proxy) config.proxy = { ...config.proxy, password: undefined };
  return config;
}

/**
 * What the session form shows for an open tab: the tab's live settings, with the secrets of
 * its saved profile (none for a quick tab). A password typed only at the login prompt is
 * never shown, so saving the form can't store it without the "remember" opt-in.
 */
export function paneFormSession(leaf: TerminalLeafNode, saved?: SessionConfig): SessionConfig {
  const base = { ...withoutSessionSecrets(leaf.session), tabColor: leaf.color ?? null };
  if (!saved) return base;
  return {
    ...base,
    password: saved.password,
    passphrase: saved.passphrase,
    jumpHost: base.jumpHost ? { ...base.jumpHost, password: saved.jumpHost?.password, passphrase: saved.jumpHost?.passphrase } : base.jumpHost,
    proxy: base.proxy ? { ...base.proxy, password: saved.proxy?.password } : base.proxy,
  };
}

/** The form over the live session; a secret the form leaves blank keeps the one the tab logged in with. */
export function withLiveSecrets(live: SessionConfig, form: SessionConfig): SessionConfig {
  const next: SessionConfig = { ...live, ...form, password: form.password || live.password, passphrase: form.passphrase || live.passphrase };
  if (next.jumpHost && live.jumpHost && next.jumpHost.host === live.jumpHost.host && next.jumpHost.username === live.jumpHost.username) {
    next.jumpHost = { ...next.jumpHost, password: next.jumpHost.password || live.jumpHost.password, passphrase: next.jumpHost.passphrase || live.jumpHost.passphrase };
  }
  if (next.proxy && live.proxy && next.proxy.host === live.proxy.host && next.proxy.username === live.proxy.username) {
    next.proxy = { ...next.proxy, password: next.proxy.password || live.proxy.password };
  }
  return next;
}

/** "Apply to this tab": connection changes take effect on the next (re)connect. */
export function applyPaneSessionEdits(leaf: TerminalLeafNode, form: SessionConfig): TerminalLeafNode {
  return { ...leaf, session: withLiveSecrets(leaf.session, form), title: undefined, color: form.tabColor ?? null };
}

export function savePaneProfile(sessions: SessionConfig[], live: SessionConfig, form: SessionConfig, rememberPassword: boolean): SessionConfig[] {
  const existing = sessions.find((session) => session.id === live.id);
  if (existing) return sessions.map((session) => session === existing ? { ...session, ...form } : session);
  const profile = { ...withoutSessionSecrets(live), ...form };
  if (rememberPassword && !form.password && live.authType === "password" && !live.credentialHandoff) profile.password = live.password;
  return [...sessions, profile];
}

/**
 * Keep what the user typed into the login form. A pane without a profile (quick connect)
 * gets one, otherwise the password would be gone after a restart. Plugin handoff sessions
 * belong to the plugin and are never turned into profiles.
 */
export function rememberPaneLogin(sessions: SessionConfig[], live: SessionConfig, credentials: Partial<Pick<SessionConfig, "username" | "password" | "credentialId">>): SessionConfig[] {
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
    session.protocol === "ssh" && session.authType === "password" && hasSavedLogin(session)
    && session.host.toLowerCase() === host && session.port === parsed.port
    && (!parsed.username || session.username === parsed.username));
  return parsed.username || matches.length === 1 ? matches[0] : undefined;
}
