import { describe, expect, it } from "vitest";
import {
  execKill,
  newTabAttach,
  nextSessionName,
  parseTmuxListing,
  shQuote,
  tmuxTarget,
  typedNew,
  typedSwitch,
  validSessionName,
} from "../utils/tmux";

describe("parseTmuxListing", () => {
  it("reads sessions and their windows", () => {
    const out = [
      "main:2:1:1700000000",
      "work:1:0:1700000100",
      "@@NEXTERM_TMUX_WINDOWS",
      "main:1:0:vim",
      "main:0:1:bash: logs",
      "work:0:1:top",
    ].join("\r\n");
    const l = parseTmuxListing(out);
    expect(l.installed).toBe(true);
    expect(l.sessions.map((s) => [s.name, s.windows, s.attached])).toEqual([
      ["main", 2, 1],
      ["work", 1, 0],
    ]);
    expect(l.sessions[0].windowList).toEqual([
      { index: 0, active: true, name: "bash: logs" },
      { index: 1, active: false, name: "vim" },
    ]);
  });

  it("reports a missing tmux and an empty server", () => {
    expect(parseTmuxListing("@@NEXTERM_NO_TMUX\n")).toEqual({ installed: false, sessions: [] });
    expect(parseTmuxListing("@@NEXTERM_TMUX_WINDOWS\n")).toEqual({ installed: true, sessions: [] });
  });

  it("ignores shell start-up noise", () => {
    const l = parseTmuxListing("Welcome!\nlast login: x\ns1:1:0:5\n@@NEXTERM_TMUX_WINDOWS\n");
    expect(l.sessions.map((s) => s.name)).toEqual(["s1"]);
  });
});

describe("tmux commands", () => {
  it("quotes names and targets exactly", () => {
    expect(shQuote("it's")).toBe(`'it'\\''s'`);
    expect(tmuxTarget("web")).toBe(`'=web'`);
    expect(tmuxTarget("web", 2)).toBe(`'=web:2'`);
    expect(execKill("web")).toBe(`tmux kill-session -t '=web'`);
    expect(newTabAttach("web")).toBe(`tmux attach -t '=web'`);
  });

  it("switches the client inside tmux instead of nesting", () => {
    expect(typedSwitch("web")).toBe(` [ -n "$TMUX" ] && tmux switch-client -t '=web' || tmux attach -t '=web'`);
    expect(typedNew("dev")).toBe(
      ` [ -n "$TMUX" ] && tmux new-session -d -s 'dev' \\; switch-client -t '=dev' || tmux new-session -s 'dev'`
    );
  });

  it("validates and generates names", () => {
    expect(validSessionName("dev-1_x")).toBe(true);
    for (const bad of ["", "a b", "a:b", "a.b", "a'b"]) expect(validSessionName(bad)).toBe(false);
    expect(nextSessionName([])).toBe("0");
    expect(nextSessionName(["0", "1", "3"])).toBe("2");
  });
});
