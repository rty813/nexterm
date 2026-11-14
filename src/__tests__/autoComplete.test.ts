import { describe, expect, it } from "vitest";
import { commandOfInput, computeCandidates } from "../utils/autoComplete";
import { DEFAULT_AUTOCOMPLETE } from "../utils/settingsDefaults";
import type { HistoryEntry } from "../types/domain";

const h = (command: string, count = 1): HistoryEntry => ({ command, time: Date.now(), count });

const catalog = [
  { name: "git", description: "the stupid content tracker" },
  { name: "git add", description: "Add file contents to the index" },
  { name: "git commit", description: "Record changes" },
  { name: "grep", description: "print lines that match patterns" },
  { name: "ls", description: "list directory contents" },
];

describe("computeCandidates", () => {
  it("completes from history, quick commands and command names", () => {
    const items = computeCandidates(
      "g",
      {
        history: [h("git status")],
        quickCommands: [{ id: "q", label: "grep logs", group: "", command: "grep -i error /var/log/syslog", appendNewline: true }],
        catalog,
        options: [],
      },
      DEFAULT_AUTOCOMPLETE
    );
    expect(items.map((i) => [i.kind, i.label])).toEqual([
      ["history", "git status"],
      ["quick", "grep -i error /var/log/syslog"],
      ["command", "git"],
      ["command", "grep"],
    ]);
    // Accepting only sends the missing characters.
    expect(items[0].insert).toBe("it status");
    expect(items[2].insert).toBe("it ");
  });

  it("completes sub commands and options", () => {
    const sub = computeCandidates("git co", { history: [], quickCommands: [], catalog, options: [] }, DEFAULT_AUTOCOMPLETE);
    expect(sub.map((i) => i.label)).toEqual(["git commit"]);
    expect(sub[0].insert).toBe("mmit ");

    const opts = computeCandidates(
      "ls --co",
      {
        history: [],
        quickCommands: [],
        catalog,
        options: [
          { flags: ["--color"], label: "--color[=WHEN]", description: "colorize the output" },
          { flags: ["--block-size="], label: "--block-size=SIZE", description: "" },
        ],
      },
      DEFAULT_AUTOCOMPLETE
    );
    expect(opts.map((i) => [i.label, i.insert])).toEqual([["--color", "lor "]]);
    expect(commandOfInput("git commit --am", catalog)).toBe("git commit");
    expect(commandOfInput("ls -l", catalog)).toBe("ls");
  });

  it("respects the threshold and the switches", () => {
    const src = { history: [h("ls -la")], quickCommands: [], catalog, options: [] };
    expect(computeCandidates("l", src, { ...DEFAULT_AUTOCOMPLETE, threshold: 2 })).toEqual([]);
    expect(computeCandidates("l", src, { ...DEFAULT_AUTOCOMPLETE, enabled: false })).toEqual([]);
    expect(computeCandidates("l", src, { ...DEFAULT_AUTOCOMPLETE, history: false }).map((i) => i.kind)).toEqual(["command"]);
  });
});

import { cleanLegacyCommand, historyKeyOf } from "../utils/commandHistory";

describe("command history", () => {
  it("strips a right-hand prompt recorded by older versions", () => {
    expect(cleanLegacyCommand("rm asdf                       Thu Nov 12 17:37:45 2026")).toBe("rm asdf");
    expect(cleanLegacyCommand('echo " adsf" > asdf')).toBe('echo " adsf" > asdf');
  });

  it("keys history by connection target", () => {
    const base = { id: "x", label: "a", group: "", authType: "password", term: "", keepAliveSecs: 0 } as const;
    const a = historyKeyOf({ ...base, protocol: "ssh", host: "Dev-Server", port: 22, username: "alice" });
    const b = historyKeyOf({ ...base, id: "quick-1", label: "b", protocol: "ssh", host: "dev-server", port: 22, username: "alice" });
    const c = historyKeyOf({ ...base, protocol: "ssh", host: "dev-server", port: 22, username: "root" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
