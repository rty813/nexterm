import { describe, expect, it } from "vitest";
import type { CredentialSummary, Expect } from "../types/domain";
import {
  DEFAULT_EXPECT,
  REPEAT_WINDOW_MS,
  compileExpect,
  compileOnekeys,
  decideAction,
  manualItems,
  matchPrompt,
  onekeysFor,
  rankMatches,
} from "../utils/onekey";

const rule = (pattern: string, p: Partial<Expect> = {}): Expect => ({ pattern, regex: false, caseSensitive: false, wholeWord: false, ...p });

const key = (id: string, p: Partial<CredentialSummary> = {}): CredentialSummary => ({
  id, name: id, username: "", authType: "password", hasPassword: true, hasPassphrase: false,
  login: false, onekey: true, expect: DEFAULT_EXPECT, usedBy: 0, ...p,
});

const fields = (text: string, list: CredentialSummary[]) => matchPrompt(text, compileOnekeys(list)).map((m) => `${m.key.id}:${m.field}`);

describe("Expect rules", () => {
  it("match only at the end of the text before the cursor", () => {
    const re = compileExpect(rule("Password:")).re!;
    expect(re.test("Password: ")).toBe(true);
    expect(re.test("[sudo] password for me:")).toBe(false);
    expect(re.test("echo Password: ok")).toBe(false);
  });

  it("follow the regex, case and whole word options", () => {
    expect(compileExpect(rule("a.b")).re!.test("axb")).toBe(false);
    expect(compileExpect(rule("a.b", { regex: true })).re!.test("axb")).toBe(true);
    expect(compileExpect(rule("password:", { caseSensitive: true })).re!.test("Password:")).toBe(false);
    expect(compileExpect(rule("pass:", { wholeWord: true })).re!.test("bypass:")).toBe(false);
    expect(compileExpect(rule("口令:", { wholeWord: true })).re!.test("请输入 口令:")).toBe(true);
    expect(compileExpect(rule("口令:", { wholeWord: true })).re!.test("新口令:")).toBe(false);
  });

  it("leave an empty rule unmatched and report a bad regex", () => {
    expect(compileExpect(rule("  "))).toEqual({ re: null, error: null });
    const bad = compileExpect(rule("(", { regex: true }));
    expect(bad.re).toBeNull();
    expect(bad.error).toBeTruthy();
  });
});

describe("prompts", () => {
  const sudo = key("sudo");
  const tel = key("tel", { username: "admin", hasPassword: true });

  it("are recognised with the default rules", () => {
    expect(fields("[sudo] password for me: ", [sudo])).toEqual(["sudo:password"]);
    expect(fields("Password:", [sudo])).toEqual(["sudo:password"]);
    expect(fields("me@host's password: ", [sudo])).toEqual(["sudo:password"]);
    expect(fields("Password for 'https://me@github.com': ", [sudo])).toEqual(["sudo:password"]);
    expect(fields("Ubuntu 22.04 LTS\r\nhost login: ", [tel])).toEqual(["tel:username"]);
    expect(fields("Username: ", [tel])).toEqual(["tel:username"]);
  });

  it("ignore text that only contains a prompt", () => {
    expect(fields("$ echo Password: done", [sudo])).toEqual([]);
    expect(fields("", [sudo])).toEqual([]);
  });

  it("only offer values the OneKey has", () => {
    // No user name: "login:" offers nothing.
    expect(fields("login: ", [sudo])).toEqual([]);
    expect(fields("Password: ", [key("u", { username: "x", hasPassword: false })])).toEqual([]);
  });

  it("use each OneKey's own rules", () => {
    const custom = key("cn", { expect: { username: rule(""), password: rule("口令[:：]", { regex: true }) } });
    expect(fields("请输入口令：", [sudo, custom])).toEqual(["cn:password"]);
    expect(fields("Password:", [sudo, custom])).toEqual(["sudo:password"]);
  });

  it("can be listed by hand", () => {
    expect(manualItems(compileOnekeys([sudo, tel])).map((m) => `${m.key.id}:${m.field}`)).toEqual(["sudo:password", "tel:username", "tel:password"]);
  });
});

describe("OneKeys of a session", () => {
  const list = [key("a"), key("b"), key("login", { onekey: false, login: true })];

  it("are all OneKeys, or the ones it is limited to", () => {
    expect(onekeysFor(list, {}).map((c) => c.id)).toEqual(["a", "b"]);
    expect(onekeysFor(list, { onekeys: [] }).map((c) => c.id)).toEqual(["a", "b"]);
    expect(onekeysFor(list, { onekeys: ["b", "gone", "login"] }).map((c) => c.id)).toEqual(["b"]);
    expect(onekeysFor(list, { onekeys: ["gone"] })).toEqual([]);
  });

  it("are ranked by recent use, then the session's user, then name", () => {
    const keys = compileOnekeys([key("b"), key("a"), key("c", { username: "me" })]);
    const matches = keys.map((k) => ({ key: k, field: "password" as const }));
    expect(rankMatches(matches, {}).map((m) => m.key.id)).toEqual(["a", "b", "c"]);
    expect(rankMatches(matches, { sessionUser: "me" }).map((m) => m.key.id)).toEqual(["c", "a", "b"]);
    expect(rankMatches(matches, { sessionUser: "me", recent: ["b"] }).map((m) => m.key.id)).toEqual(["b", "c", "a"]);
  });
});

describe("automatic sending", () => {
  const [a, b] = compileOnekeys([key("a"), key("b")]);
  const one = [{ key: a, field: "password" as const }];

  it("is off unless enabled, and only for a single match", () => {
    expect(decideAction([], true, null, 0)).toBe("none");
    expect(decideAction(one, false, null, 0)).toBe("popup");
    expect(decideAction(one, true, null, 0)).toBe("send");
    expect(decideAction([...one, { key: b, field: "password" }], true, null, 0)).toBe("popup");
  });

  it("does not answer the same prompt again right after (wrong password)", () => {
    const last = { id: "a", field: "password" as const, at: 1000 };
    expect(decideAction(one, true, last, 1000 + REPEAT_WINDOW_MS - 1)).toBe("repeat");
    expect(decideAction(one, true, last, 1000 + REPEAT_WINDOW_MS)).toBe("send");
    expect(decideAction(one, true, { ...last, field: "username" }, 1500)).toBe("send");
    expect(decideAction([{ key: b, field: "password" }], true, last, 1500)).toBe("send");
  });
});

it("has the same strings in both languages", async () => {
  const { onekeyResources } = await import("../i18n.onekey");
  const keys = (o: object, prefix = ""): string[] =>
    Object.entries(o).flatMap(([k, v]) => (typeof v === "object" ? keys(v as object, `${prefix}${k}/`) : [`${prefix}${k}`]));
  expect(keys(onekeyResources["en-US"]).sort()).toEqual(keys(onekeyResources["zh-CN"]).sort());
});
