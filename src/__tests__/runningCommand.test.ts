import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandTracker, isShellPrompt, splitPromptLine, type RunningCommand } from "../utils/runningCommand";

describe("splitPromptLine", () => {
  it("splits common prompts", () => {
    expect(splitPromptLine("root@web1:~# make -j8")).toEqual({ prompt: "root@web1:~#", command: "make -j8" });
    expect(splitPromptLine("[me@db ws]$ colcon build  --symlink-install ")?.command).toBe("colcon build --symlink-install");
    expect(splitPromptLine("~/ros2_ws ❯ colcon build")?.command).toBe("colcon build");
    expect(splitPromptLine("➜  src git:(main) ✗ make test")?.command).toBe("make test");
    expect(splitPromptLine("PS C:\\src> cargo build")?.command).toBe("cargo build");
    expect(splitPromptLine("C:\\src>nmake")?.command).toBe("nmake");
  });
  it("ignores lines without a command or prompt", () => {
    expect(splitPromptLine("root@web1:~# ")).toBeNull();
    expect(splitPromptLine("Password: hunter2")).toBeNull();
    expect(splitPromptLine("compiling foo.c")).toBeNull();
  });
});

describe("isShellPrompt", () => {
  it("knows the prompt is back", () => {
    expect(isShellPrompt("root@web1:~# ", "root@web1:~#")).toBe(true);
    expect(isShellPrompt("me@web1:/tmp$ ", "me@jump:~$")).toBe(true);
    expect(isShellPrompt("~/build ❯ ", "~/src ❯")).toBe(true);
    expect(isShellPrompt("PS C:\\other> ", "PS C:\\src>")).toBe(true);
  });
  it("is not fooled by program output or REPLs", () => {
    expect(isShellPrompt("[ 42%] Building CXX object", "root@web1:~#")).toBe(false);
    expect(isShellPrompt(">>> ", "root@web1:~#")).toBe(false);
    expect(isShellPrompt("mysql> ", "me@db:~$")).toBe(false);
  });
});

describe("CommandTracker", () => {
  let seen: (RunningCommand | null)[];
  let tracker: CommandTracker;
  beforeEach(() => {
    vi.useFakeTimers();
    seen = [];
    tracker = new CommandTracker((c) => seen.push(c), 1000);
  });
  afterEach(() => vi.useRealTimers());

  it("shows a long command and clears it at the next prompt", () => {
    tracker.onEnter("me@box:~/ws$ colcon build");
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(seen[0]?.command).toBe("colcon build");
    tracker.onQuiet("[ 50%] Building", false);
    expect(seen).toHaveLength(1);
    tracker.onQuiet("me@box:~/ws$ ", false);
    expect(seen[1]).toBeNull();
  });

  it("never shows quick commands", () => {
    tracker.onEnter("me@box:~$ ls");
    tracker.onQuiet("me@box:~$ ", false);
    vi.advanceTimersByTime(2000);
    expect(seen).toEqual([]);
  });

  it("ignores Enter typed into a running program", () => {
    tracker.onEnter("me@box:~$ python3");
    vi.advanceTimersByTime(1000);
    expect(tracker.acceptsEnter(false)).toBe(false);
    tracker.onQuiet(">>> ", false);
    expect(tracker.current?.command).toBe("python3");
  });

  it("keeps full-screen programs until the prompt is back", () => {
    tracker.onEnter("me@box:~$ htop");
    vi.advanceTimersByTime(1000);
    tracker.onQuiet("", true);
    expect(tracker.current?.command).toBe("htop");
    tracker.onQuiet("me@box:~$ ", false);
    expect(tracker.current).toBeNull();
  });

  it("follows OSC 133 when the shell has integration", () => {
    tracker.onEnter("~ $ make all");
    tracker.onShellMark("C");
    vi.advanceTimersByTime(1000);
    expect(tracker.current?.command).toBe("make all");
    tracker.onQuiet("~ $ ", false); // heuristics off now
    expect(tracker.current?.command).toBe("make all");
    tracker.onShellMark("D;0");
    expect(tracker.current).toBeNull();
    expect(tracker.acceptsEnter(false)).toBe(true);
    // Integrated from now on: Enter queues the line, C starts it.
    tracker.onEnter("~ $ colcon build");
    expect(tracker.current).toBeNull();
    tracker.onShellMark("C");
    vi.advanceTimersByTime(1000);
    expect(tracker.current?.command).toBe("colcon build");
  });

  it("takes the command line from OSC 633 E", () => {
    tracker.onShellMark("E;colcon build\\x3b echo done;nonce", 633);
    tracker.onShellMark("C", 633);
    vi.advanceTimersByTime(1000);
    expect(tracker.current?.command).toBe("colcon build; echo done");
  });

  it("ignores the integration ready mark (OSC 633 P)", () => {
    tracker.onShellMark("P;NextermShellIntegration=1", 633);
    tracker.onShellMark("D;0");
    tracker.onShellMark("E;make -j8", 633);
    tracker.onShellMark("C");
    vi.advanceTimersByTime(1000);
    expect(tracker.current?.command).toBe("make -j8");
  });

  it("reset clears a running command", () => {
    tracker.onEnter("me@box:~$ make");
    vi.advanceTimersByTime(1000);
    tracker.reset();
    expect(seen[seen.length - 1]).toBeNull();
  });
});
