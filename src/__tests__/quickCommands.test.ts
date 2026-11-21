import { describe, expect, it } from "vitest";
import type { QuickCommand } from "../types/domain";
import { commandsOf, fromEditor, moveInGroup, parseQuickIcon, quickGroups, quickPayload, toEditor } from "../utils/quickCommands";

const qc = (id: string, group: string, extra: Partial<QuickCommand> = {}): QuickCommand => ({
  id,
  label: id,
  group,
  command: "",
  appendNewline: false,
  ...extra,
});

describe("quick command text", () => {
  it("sends line breaks as Enter and adds Enter when asked", () => {
    expect(quickPayload(qc("a", "g", { command: "ls -l", appendNewline: true }))).toBe("ls -l\r");
    expect(quickPayload(qc("a", "g", { command: "a\nb\r\nc" }))).toBe("a\rb\rc");
    // Imported WindTerm text already ends with CR: no second Enter.
    expect(quickPayload(qc("a", "g", { command: "ip link\r", appendNewline: true }))).toBe("ip link\r");
  });

  it("decodes backslash escapes when sending, like WindTerm", () => {
    // Off unless the command asks for it (WindTerm imports): backslashes go out as typed.
    expect(quickPayload(qc("a", "g", { command: "printf 'a\\nb' C:\\tools" }))).toBe("printf 'a\\nb' C:\\tools");
    const plain = qc;
    const qcEsc = (id: string, group: string, extra: Partial<QuickCommand> = {}) => plain(id, group, { escapes: true, ...extra });
    expect(quickPayload(qcEsc("a", "g", { command: "ls\\r" }))).toBe("ls\r");
    expect(quickPayload(qcEsc("a", "g", { command: "a\\nb\\tc\\x03\\e[A" }))).toBe("a\rb\tc\x03\x1b[A");
    expect(quickPayload(qcEsc("a", "g", { command: "echo \\\\n \\. \\x4" }))).toBe("echo \\n \\. \\x4");
    // An escaped CR at the end counts as Enter: no second one.
    expect(quickPayload(qcEsc("a", "g", { command: "ip link\\r", appendNewline: true }))).toBe("ip link\r");
    // The editor keeps the escapes as written.
    expect(toEditor(qc("a", "g", { command: "ls\\r" })).text).toBe("ls\\r");
  });

  it("round-trips through the editor", () => {
    const imported = qc("a", "g", { command: "export A=1\rexport B=2\r" });
    const ed = toEditor(imported);
    expect(ed).toEqual({ text: "export A=1\nexport B=2", enter: true });
    const back = fromEditor(ed.text, ed.enter);
    expect(quickPayload({ ...imported, ...back })).toBe("export A=1\rexport B=2\r");
  });
});

describe("quick command icons", () => {
  it("reads WindTerm icons and falls back for unknown ones", () => {
    expect(parseQuickIcon("session::wifi-darkturquoise")).toEqual({ shape: "wifi", color: "darkturquoise" });
    expect(parseQuickIcon("pinwheel-coral")).toEqual({ shape: "pinwheel", color: "coral" });
    expect(parseQuickIcon("nonsense-#12345g")).toEqual({ shape: "tag", color: "coral" });
    expect(parseQuickIcon(undefined).shape).toBe("tag");
  });
});

describe("quick command groups", () => {
  const list = [qc("b", "快速"), qc("a", "运维"), qc("c", "快速"), qc("d", "")];

  it("keeps the saved group order, then groups only commands use", () => {
    expect(quickGroups(list, { groups: ["运维", "空分组"] }, "自定义")).toEqual(["运维", "空分组", "快速", "自定义"]);
  });

  it("lists a group's commands in order or by label", () => {
    expect(commandsOf(list, "快速", "自定义").map((c) => c.id)).toEqual(["b", "c"]);
    expect(commandsOf(list, "快速", "自定义", true).map((c) => c.id)).toEqual(["b", "c"].sort());
    expect(commandsOf(list, "自定义", "自定义").map((c) => c.id)).toEqual(["d"]);
  });

  it("moves a command within its group only", () => {
    const moved = moveInGroup(list, "c", -1, "自定义");
    expect(moved.map((c) => c.id)).toEqual(["c", "a", "b", "d"]);
    expect(moveInGroup(list, "b", -1, "自定义")).toBe(list);
    expect(moveInGroup(list, "a", 1, "自定义")).toBe(list);
  });
});
