import { describe, expect, it } from "vitest";
import { hostFromOsc7, hostFromPrompt, hostFromTitle, titleShowsHost } from "../utils/hostname";

describe("hostFromOsc7", () => {
  it("reads the host of a file URL", () => {
    expect(hostFromOsc7("file://web1/home/me")).toBe("web1");
    expect(hostFromOsc7("file://db.example.com/tmp")).toBe("db.example.com");
  });
  it("ignores empty or bad hosts", () => {
    expect(hostFromOsc7("file:///tmp")).toBeNull();
    expect(hostFromOsc7("http://x/")).toBeNull();
    expect(hostFromOsc7("file://bad host/")).toBeNull();
  });
});

describe("hostFromTitle", () => {
  it("reads common shell titles", () => {
    expect(hostFromTitle("root@web1: ~")).toBe("web1");
    expect(hostFromTitle("[me@db01 ~]")).toBe("db01");
    expect(hostFromTitle("me@box.local:~/src")).toBe("box.local");
    expect(hostFromTitle("ssh: me@gw")).toBe("gw");
  });
  it("ignores titles without user@host", () => {
    expect(hostFromTitle("vim main.rs")).toBeNull();
    expect(hostFromTitle("Windows PowerShell")).toBeNull();
  });
});

describe("hostFromPrompt", () => {
  it("reads bash / zsh / RHEL prompts", () => {
    expect(hostFromPrompt("root@web1:~# ")).toBe("web1");
    expect(hostFromPrompt("[root@db ~]$ ")).toBe("db");
    expect(hostFromPrompt("(venv) me@box ~/src % ")).toBe("box");
    expect(hostFromPrompt("alice@MacBook-Pro ~ % ")).toBe("MacBook-Pro");
  });
  it("ignores output and typed commands", () => {
    expect(hostFromPrompt("root@web1:~# ssh git@github.com")).toBeNull();
    expect(hostFromPrompt("mail sent to bob@example.com")).toBeNull();
    expect(hostFromPrompt("PS C:\\Users\\me> ")).toBeNull();
    expect(hostFromPrompt("50%")).toBeNull();
  });
});

describe("titleShowsHost", () => {
  it("matches the host as a whole word", () => {
    expect(titleShowsHost("web1", "web1")).toBe(true);
    expect(titleShowsHost("root@web1", "web1")).toBe(true);
    expect(titleShowsHost("web1.example.com", "web1")).toBe(true);
    expect(titleShowsHost("web10", "web1")).toBe(false);
    expect(titleShowsHost("jump", "web1")).toBe(false);
  });
});
