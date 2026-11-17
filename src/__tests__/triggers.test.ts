import { describe, expect, it } from "vitest";
import type { TriggerRule } from "../types/domain";
import {
  activationMatches,
  compileTriggers,
  DEFAULT_TRIGGERS,
  fillTemplate,
  findTriggerHits,
  hexTooltip,
  isoTime,
  isScript,
  linkEffect,
  patternError,
  sanitizeTooltip,
  shellQuote,
  timestampTooltip,
  triggersOf,
  trimLink,
  unarchiveCommand,
  underlineMarks,
  unescapeText,
  type TriggerContext,
} from "../utils/triggers";

const t = (key: string, o?: Record<string, unknown>) => (o ? `${key}${JSON.stringify(o)}` : key);
const ctx: TriggerContext = { t, scheme: "linux" };
const compiled = compileTriggers(DEFAULT_TRIGGERS);
const hits = (text: string, c = ctx) => findTriggerHits(text, compiled, c);
const only = (text: string, id: string, c = ctx) => hits(text, c).filter((h) => h.rule.id === id);

describe("hyperlink trigger", () => {
  it("finds common links and trims trailing punctuation", () => {
    const h = only("see https://example.com/a?b=1, and (http://x.io/p).", "builtin-hyperlink");
    expect(h.map((x) => x.text)).toEqual(["https://example.com/a?b=1", "http://x.io/p"]);
    expect(h[0].effect).toEqual({ kind: "open", url: "https://example.com/a?b=1" });
  });

  it("keeps balanced parentheses in links", () => {
    expect(trimLink("https://en.wikipedia.org/wiki/Foo_(bar)")).toBe("https://en.wikipedia.org/wiki/Foo_(bar)");
    expect(trimLink("https://x.io/a)")).toBe("https://x.io/a");
  });

  it("recognizes email, ftp, sftp, scp, ssh, file and www links", () => {
    const text = "mail a.b@corp.example.com ftp://f.org/x ftps://f.org/y sftp://u@h:2222/p scp://h/x file:///C:/Temp/a.txt www.foo.com";
    const h = only(text, "builtin-hyperlink");
    expect(h.map((x) => x.text)).toEqual([
      "a.b@corp.example.com",
      "ftp://f.org/x",
      "ftps://f.org/y",
      "sftp://u@h:2222/p",
      "scp://h/x",
      "file:///C:/Temp/a.txt",
      "www.foo.com",
    ]);
    expect(h.map((x) => x.effect)).toEqual([
      { kind: "open", url: "mailto:a.b@corp.example.com" },
      { kind: "open", url: "ftp://f.org/x" },
      { kind: "open", url: "ftps://f.org/y" },
      { kind: "connect", target: "ssh://u@h:2222", label: "u@h" },
      { kind: "connect", target: "ssh://h", label: "h" },
      { kind: "reveal", path: "C:\\Temp\\a.txt" },
      { kind: "open", url: "http://www.foo.com" },
    ]);
  });

  it("does not take prompts or ssh targets for email addresses", () => {
    expect(only("eric@myhost.local:~$ ls", "builtin-hyperlink")).toEqual([]);
    expect(only("root@192.168.1.1's password:", "builtin-hyperlink")).toEqual([]);
  });

  it("refuses unsafe links", () => {
    expect(linkEffect("javascript:alert(1)")).toBeNull();
    expect(linkEffect("file://evil-host/share/x")).toBeNull();
    expect(linkEffect("file:////evil/share")).toBeNull();
    expect(linkEffect("https://x.io/\x07")).toBeNull();
    expect(linkEffect("telnet://h:23")).toEqual({ kind: "connect", target: "telnet://h:23", label: "h:23" });
    expect(linkEffect("ssh://h:99999")).toBeNull();
  });

  it("is a Ctrl + click by default", () => {
    expect(activationMatches("ctrlClick", { ctrlKey: false, metaKey: false })).toBe(false);
    expect(activationMatches("ctrlClick", { ctrlKey: true, metaKey: false })).toBe(true);
    expect(activationMatches(undefined, { ctrlKey: false, metaKey: true })).toBe(true);
    expect(activationMatches("click", { ctrlKey: false, metaKey: false })).toBe(true);
  });
});

describe("hexadecimal converter", () => {
  it("shows decimal and octal", () => {
    const h = only("addr 0x1F, 0XfF, abc0x12, 0x1g", "builtin-hex");
    expect(h.map((x) => x.text)).toEqual(["0x1F", "0XfF"]);
    expect(hexTooltip("1F", t)).toBe("trigger.tip.decimal31\ntrigger.tip.octal37");
    expect(h[0].tip).toEqual({ html: "trigger.tip.decimal31<br>trigger.tip.octal37" });
  });

  it("handles numbers wider than 53 bits", () => {
    expect(hexTooltip("ffffffffffffffff", t)).toContain("18446744073709551615");
  });
});

describe("timestamp converter", () => {
  it("converts 10 and 13 digit timestamps", () => {
    const h = only("t=1700000000 ms=1700000000123 n=12345678901 v=1.1700000000", "builtin-timestamp");
    expect(h.map((x) => x.text)).toEqual(["1700000000", "1700000000123"]);
    expect(timestampTooltip("1700000000", t)).toContain("trigger.tip.utc2023-11-14T22:13:20Z");
    expect(timestampTooltip("1700000000123", t)).toContain("2023-11-14T22:13:20.123Z");
    expect(timestampTooltip("12345678901", t)).toBeNull();
  });

  it("formats ISO times with an offset", () => {
    expect(isoTime(0, 480, false)).toBe("1970-01-01T08:00:00+08:00");
    expect(isoTime(0, -330, true)).toBe("1969-12-31T18:30:00.000-05:30");
  });
});

describe("unarchiver", () => {
  it("picks the command by suffix", () => {
    expect(unarchiveCommand("a.tar.gz")).toBe("tar -xvzf a.tar.gz");
    expect(unarchiveCommand("a.tgz")).toBe("tar -xvzf a.tgz");
    expect(unarchiveCommand("a.tar.bz2")).toBe("tar -xvjf a.tar.bz2");
    expect(unarchiveCommand("a.tar.xz")).toBe("tar -xvJf a.tar.xz");
    expect(unarchiveCommand("a.gz")).toBe("gzip -d a.gz");
    expect(unarchiveCommand("a.zip")).toBe("unzip a.zip");
    expect(unarchiveCommand("a.rar")).toBe("unrar x a.rar");
    expect(unarchiveCommand("a.7z")).toBe("7z x a.7z");
    expect(unarchiveCommand("a.Z")).toBe("uncompress a.Z");
    expect(unarchiveCommand("a.z")).toBeNull();
    expect(unarchiveCommand("it's.zip")).toBe(`unzip 'it'\\''s.zip'`);
  });

  it("finds archive names in ls output and types the command", () => {
    const h = only("node-v20.tar.gz  ./dist/app.zip  notes.txt  x.tar.gz.sig", "builtin-unarchiver");
    expect(h.map((x) => x.text)).toEqual(["node-v20.tar.gz", "./dist/app.zip"]);
    expect(h[0].effect).toEqual({ kind: "send", text: "tar -xvzf node-v20.tar.gz" });
  });

  it("is off in PowerShell and CMD", () => {
    expect(only("a.zip", "builtin-unarchiver", { t, scheme: "powershell" })).toEqual([]);
  });
});

describe("python error trigger", () => {
  it("types the vim command for the file and line", () => {
    const h = only('  File "/srv/app/main.py", line 42, in <module>', "python-error");
    expect(h).toHaveLength(1);
    expect(h[0].captures.file).toBe("/srv/app/main.py");
    expect(h[0].effect).toEqual({ kind: "send", text: "vim /srv/app/main.py +42\r" });
  });

  it("quotes captured text that is not plain", () => {
    const h = only('File "x; rm -rf ~", line 1', "python-error");
    expect(h[0].effect).toEqual({ kind: "send", text: "vim 'x; rm -rf ~' +1\r" });
  });
});

describe("calculator trigger", () => {
  it("captures the expression and uses a script tooltip", () => {
    const h = only("1+2*3=", "calculator");
    expect(h[0].captures.expr).toBe("1+2*3");
    expect(h[0].tip).toEqual({ script: DEFAULT_TRIGGERS.find((r) => r.id === "calculator")!.tooltip });
    expect(h[0].effect).toBeNull();
  });
});

describe("user triggers", () => {
  const rule = (p: Partial<TriggerRule>): TriggerRule => ({ id: "u", name: "u", enabled: true, pattern: "", caseSensitive: false, ...p });

  it("fills tooltip and link templates", () => {
    const c = compileTriggers([
      rule({ pattern: String.raw`JIRA-(?<n>\d+)`, tooltip: "Issue <b>${n}</b><script>x</script>", action: "openLink", actionText: "https://jira/browse/JIRA-${n}" }),
    ]);
    const h = findTriggerHits("fix JIRA-12 now", c, ctx);
    expect(h[0].tip).toEqual({ html: "Issue <b>12</b>&lt;script&gt;x&lt;/script&gt;" });
    expect(h[0].effect).toEqual({ kind: "open", url: "https://jira/browse/JIRA-12" });
  });

  it("skips disabled, invalid and empty-matching patterns", () => {
    expect(compileTriggers([rule({ pattern: "a", enabled: false }), rule({ pattern: "(" }), rule({ pattern: "a*" })])).toEqual([]);
    expect(patternError("(")).not.toBeNull();
    expect(patternError("a*")).toBe("empty");
    expect(patternError("a+")).toBeNull();
  });

  it("ignores matches with neither tooltip nor action", () => {
    expect(findTriggerHits("abc", compileTriggers([rule({ pattern: "b" })]), ctx)).toEqual([]);
  });

  it("keeps trigger order as priority", () => {
    const h = hits("https://x.io/0x10");
    expect(h[0].rule.builtin).toBe("hyperlink");
  });
});

describe("underlines", () => {
  it("is solid for clickable matches, dotted for tooltips, and skips failed scripts", () => {
    const text = "PATH=/usr/bin 1+2=  https://x.io  0x1F";
    const shows = (_src: string, c: Record<string, string>) => c.expr === "1+2";
    const marks = underlineMarks(hits(text), shows);
    expect(marks.map((m) => [text.slice(m.start, m.end), m.solid])).toEqual([
      ["1+2=", false],
      ["https://x.io", true],
      ["0x1F", false],
    ]);
  });

  it("lets the higher-priority trigger win an overlap", () => {
    const text = "https://x.io/0x10";
    expect(underlineMarks(hits(text), () => true)).toEqual([{ start: 0, end: text.length, solid: true }]);
  });
});

describe("helpers", () => {
  it("sanitizes tooltip HTML", () => {
    expect(sanitizeTooltip(`a<font color='red'>3</font>`)).toBe(`a<font color="red">3</font>`);
    expect(sanitizeTooltip(`<font color="x;background:url(y)">z</font>`)).toBe(`<font>z</font>`);
    expect(sanitizeTooltip(`<img src=x onerror=alert(1)>`)).toBe(`&lt;img src=x onerror=alert(1)&gt;`);
    expect(sanitizeTooltip(`<b onclick="x">b</b>`)).toBe(`<b>b</b>`);
    expect(sanitizeTooltip("a\nb & c")).toBe("a<br>b &amp; c");
  });

  it("detects scripts", () => {
    expect(isScript("(captures)=>{ return 1 }")).toBe(true);
    expect(isScript("c => c.x")).toBe(true);
    expect(isScript("function (c) { return 1 }")).toBe(true);
    expect(isScript("Value ${x}")).toBe(false);
  });

  it("fills and unescapes templates", () => {
    expect(fillTemplate("${a}-${1}-${zz}", { a: "A", "1": "one" })).toBe("A-one-");
    expect(unescapeText(String.raw`a\nb\\n\e`)).toBe("a\nb\\n\x1b");
    expect(shellQuote("/a/b-c.py")).toBe("/a/b-c.py");
    expect(shellQuote("a b")).toBe("'a b'");
  });

  it("adds built-ins missing from a saved list", () => {
    const saved = [DEFAULT_TRIGGERS[1]];
    expect(triggersOf({ triggers: saved }).map((r) => r.builtin ?? r.id)).toEqual([
      "python-error",
      "hyperlink",
      "unarchiver",
      "hexConverter",
      "timestampConverter",
    ]);
    expect(triggersOf({})).toBe(DEFAULT_TRIGGERS);
  });
});
