import type { AutofillField, CredentialSummary, Expect, OnekeyExpect, SessionConfig } from "../types/domain";
import { buildMatcher } from "./textMatch";

/**
 * OneKeys (WindTerm's OneKeys): saved user names / passwords offered when a pane's output
 * shows a prompt matching the OneKey's Expect rules. Only the rules live here; the secrets
 * stay in the backend (`credentials::autofill_credential` types them into the pane).
 */

/** Same as Rust `OnekeyExpect::default` (WindTerm's defaults). */
export const DEFAULT_EXPECT: OnekeyExpect = {
  username: { pattern: "username:|login:", regex: true, caseSensitive: false, wholeWord: false },
  password: { pattern: "Password:|Password for \\S+:", regex: true, caseSensitive: false, wholeWord: false },
};

/** A same-OneKey prompt this soon after an automatic send is not answered automatically again. */
export const REPEAT_WINDOW_MS = 10_000;

export interface CompiledOnekey {
  id: string;
  name: string;
  username: string;
  hasPassword: boolean;
  rules: Record<AutofillField, RegExp | null>;
}

export interface OnekeyMatch {
  key: CompiledOnekey;
  field: AutofillField;
}

/**
 * A rule as a RegExp that only matches at the end of the text (trailing blanks allowed): the
 * prompt is what the cursor waits after. Null for an empty rule; `error` for a bad regex.
 */
export function compileExpect(e: Expect): { re: RegExp | null; error: string | null } {
  if (!e.pattern.trim()) return { re: null, error: null };
  const built = buildMatcher(e.pattern, e);
  if (!built.re) return built;
  return { re: new RegExp(`(?:${built.re.source})\\s*$`, built.re.flags.replace("g", "")), error: null };
}

/** A session group path as "A>B" (blanks around the separators dropped). */
export function normalizeGroup(group: string | undefined): string {
  return (group || "").split(">").map((part) => part.trim()).filter(Boolean).join(">");
}

/** Whether a session is in a group or one of its subgroups. */
export function inGroup(sessionGroup: string | undefined, group: string): boolean {
  const s = normalizeGroup(sessionGroup);
  const g = normalizeGroup(group);
  return Boolean(g) && (s === g || s.startsWith(`${g}>`));
}

/** The OneKey is offered in this session (its own targets; no targets = every session). */
export function appliesTo(key: Pick<CredentialSummary, "appliesTo">, session: Pick<SessionConfig, "id" | "group">): boolean {
  const t = key.appliesTo;
  if (!t) return true;
  return t.sessions.includes(session.id) || t.groups.some((g) => inGroup(session.group, g));
}

/** OneKeys that may be used in this session, before its own choice. */
export function applicableOnekeys(list: CredentialSummary[], session: Pick<SessionConfig, "id" | "group">): CredentialSummary[] {
  return list.filter((c) => c.onekey && appliesTo(c, session));
}

/**
 * The OneKeys a session offers: those offered in it, all of them or only the ones the session
 * picked (`onekeys`; [] = none).
 */
export function onekeysFor(list: CredentialSummary[], session: Pick<SessionConfig, "id" | "group" | "onekeys">): CredentialSummary[] {
  const keys = applicableOnekeys(list, session);
  if (!Array.isArray(session.onekeys)) return keys;
  const only = new Set(session.onekeys);
  return keys.filter((c) => only.has(c.id));
}

export function compileOnekeys(list: CredentialSummary[]): CompiledOnekey[] {
  return list.map((c) => ({
    id: c.id,
    name: c.name,
    username: c.username,
    hasPassword: c.hasPassword,
    rules: { username: compileExpect(c.expect?.username ?? DEFAULT_EXPECT.username).re, password: compileExpect(c.expect?.password ?? DEFAULT_EXPECT.password).re },
  }));
}

export function hasValue(key: CompiledOnekey, field: AutofillField): boolean {
  return field === "password" ? key.hasPassword : Boolean(key.username);
}

/**
 * The OneKeys whose rule matches the end of the text before the cursor (its logical line).
 * Each OneKey answers with its password if that rule matches, otherwise its user name.
 */
export function matchPrompt(beforeCursor: string, keys: CompiledOnekey[]): OnekeyMatch[] {
  if (!beforeCursor.trim()) return [];
  const out: OnekeyMatch[] = [];
  for (const key of keys) {
    for (const field of ["password", "username"] as const) {
      if (hasValue(key, field) && key.rules[field]?.test(beforeCursor)) {
        out.push({ key, field });
        break;
      }
    }
  }
  return out;
}

const DEFAULT_RULES: Record<AutofillField, RegExp | null> = {
  username: compileExpect(DEFAULT_EXPECT.username).re,
  password: compileExpect(DEFAULT_EXPECT.password).re,
};

/**
 * Whether the text before the cursor is a login prompt at all, matched or not: the default
 * rules or any OneKey's own (values aside). Such a prompt with no OneKey to send gets a list
 * that only offers adding one.
 */
export function promptField(beforeCursor: string, keys: CompiledOnekey[]): AutofillField | null {
  if (!beforeCursor.trim()) return null;
  for (const rules of [...keys.map((k) => k.rules), DEFAULT_RULES]) {
    for (const field of ["password", "username"] as const) {
      if (rules[field]?.test(beforeCursor)) return field;
    }
  }
  return null;
}

/** A free name for a new OneKey: `base`, else `base (2)`, `base (3)` ... (names are unique, any case). */
export function freeName(base: string, taken: string[]): string {
  const used = new Set(taken.map((n) => n.trim().toLowerCase()));
  const name = base.trim() || "OneKey";
  if (!used.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) {
    const next = `${name} (${i})`;
    if (!used.has(next.toLowerCase())) return next;
  }
}

/** Every value of the OneKeys, for the list opened by hand. */
export function manualItems(keys: CompiledOnekey[]): OnekeyMatch[] {
  return keys.flatMap((key) => (["username", "password"] as const).filter((f) => hasValue(key, f)).map((field) => ({ key, field })));
}

/** Recently used in this session first, then the session's own user name, then by name. */
export function rankMatches(matches: OnekeyMatch[], ctx: { sessionUser?: string; recent?: string[] }): OnekeyMatch[] {
  const recent = ctx.recent ?? [];
  const score = (m: OnekeyMatch) => {
    const r = recent.indexOf(m.key.id);
    return [r < 0 ? Infinity : r, ctx.sessionUser && m.key.username === ctx.sessionUser ? 0 : 1] as const;
  };
  return [...matches].sort((a, b) => {
    const [ra, ua] = score(a);
    const [rb, ub] = score(b);
    return ra - rb || ua - ub || a.key.name.localeCompare(b.key.name, "zh");
  });
}

export interface AutoSent {
  id: string;
  field: AutofillField;
  at: number;
}

/**
 * What a prompt leads to. "repeat": a single match, sent automatically moments ago, came
 * back (wrong password, a program asking again): list it instead of sending it again.
 */
export function decideAction(matches: OnekeyMatch[], autoSend: boolean, last: AutoSent | null, now: number): "none" | "popup" | "send" | "repeat" {
  if (!matches.length) return "none";
  if (!autoSend || matches.length > 1) return "popup";
  const m = matches[0];
  if (last && last.id === m.key.id && last.field === m.field && now - last.at < REPEAT_WINDOW_MS) return "repeat";
  return "send";
}

const RECENT_KEY = "nexterm.onekey.recent";
const RECENT_PER_SESSION = 5;
const RECENT_SESSIONS = 200;

/** OneKey ids last used in a session (historyKeyOf), newest first. Ids only, no secrets. */
export function recentOnekeys(sessionKey: string): string[] {
  try {
    const all = JSON.parse(localStorage.getItem(RECENT_KEY) || "{}") as Record<string, string[]>;
    return Array.isArray(all[sessionKey]) ? all[sessionKey] : [];
  } catch {
    return [];
  }
}

export function noteRecentOnekey(sessionKey: string, id: string): void {
  try {
    const all = JSON.parse(localStorage.getItem(RECENT_KEY) || "{}") as Record<string, string[]>;
    delete all[sessionKey];
    const next = [id, ...recentOnekeys(sessionKey).filter((x) => x !== id)].slice(0, RECENT_PER_SESSION);
    const entries = [[sessionKey, next] as const, ...Object.entries(all)].slice(0, RECENT_SESSIONS);
    localStorage.setItem(RECENT_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // storage full / unavailable: ranking just loses the hint
  }
}
