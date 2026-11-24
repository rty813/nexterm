import { describe, expect, it } from "vitest";
import { LogBuffer, formatEntry, makeFilter, parseQuery } from "../utils/logcatFilter";
import { adbSerialOf, adbSessionFor, isNetworkSerial, logcatSessionOf, splitAdbAddress } from "../utils/adbSession";
import { avcCodecString, fitBox, keycodeFor, parseMirrorPacket, textFor, toDevice } from "../utils/adbScreen";
import { parseBattery, parseServerSample } from "../utils/serverStats";
import { parseQuickConnectInput } from "../utils/quickConnect";
import { isLogcatSession, type LogEntry } from "../types/domain";

const entry = (p: Partial<LogEntry>): LogEntry => ({ ts: "11-23 10:00:00.000", pid: 100, tid: 100, uid: 10012, level: "I", tag: "App", msg: "hello", ...p });

describe("logcat filter", () => {
  it("parses terms", () => {
    const q = parseQuery('tag:Net -tag:=Chatty pid:42 package:com.a level:w "connection reset" -spam /time(out)?/');
    expect(q.tags).toEqual([
      { value: "net", exact: false, not: false },
      { value: "chatty", exact: true, not: true },
    ]);
    expect(q.pids).toEqual([{ value: 42, not: false }]);
    expect(q.packages).toEqual([{ value: "com.a", not: false }]);
    expect(q.level).toBe(3);
    expect(q.words).toEqual([
      { value: "connection reset", not: false },
      { value: "spam", not: true },
    ]);
    expect(q.regexes).toHaveLength(1);
    expect(q.errors).toEqual([]);
  });

  it("ignores keys still being typed", () => {
    const q = parseQuery("tag: -package: tag:= level:");
    expect([q.tags, q.packages, q.words, q.level]).toEqual([[], [], [], null]);
  });

  it("reports bad regexes", () => {
    expect(parseQuery("/(/").errors).toEqual(["/(/"]);
  });

  it("filters by level, tag, pid, words", () => {
    const f = makeFilter(parseQuery("tag:net -boring"), "D");
    expect(f(entry({ tag: "Network", msg: "up" }))).toBe(true);
    expect(f(entry({ tag: "Network", level: "V" }))).toBe(false);
    expect(f(entry({ tag: "Network", msg: "boring stuff" }))).toBe(false);
    expect(f(entry({ tag: "Audio" }))).toBe(false);
    // Markers always pass the level.
    expect(makeFilter(parseQuery(""), "E")(entry({ level: "S" }))).toBe(true);
    const pid = makeFilter(parseQuery("pid:7"), "V");
    expect(pid(entry({ pid: 7 }))).toBe(true);
    expect(pid(entry({ pid: 8 }))).toBe(false);
  });

  it("follows a package by uid", () => {
    const uids = new Map([["com.example.app", 10012]]);
    const f = makeFilter(parseQuery("package:com.example"), "V", uids);
    expect(f(entry({ uid: 10012, pid: 1 }))).toBe(true);
    expect(f(entry({ uid: 10012, pid: 999 }))).toBe(true);
    expect(f(entry({ uid: 1000 }))).toBe(false);
    expect(f(entry({ uid: null }))).toBe(false);
  });

  it("keeps a bounded buffer with stable indexes", () => {
    const b = new LogBuffer(3);
    b.push([entry({ msg: "1" }), entry({ msg: "2" })]);
    b.push([entry({ msg: "3" }), entry({ msg: "4" })]);
    expect(b.entries.map((e) => e.msg)).toEqual(["2", "3", "4"]);
    expect(b.base).toBe(1);
    b.clear();
    expect(b.entries).toEqual([]);
    expect(b.base).toBe(4);
  });

  it("formats like threadtime", () => {
    expect(formatEntry(entry({ pid: 12, tid: 34, level: "W", tag: "T", msg: "m" }))).toBe("11-23 10:00:00.000    12    34 W T: m");
  });
});

describe("adb sessions", () => {
  it("recognizes WLAN serials", () => {
    expect(isNetworkSerial("192.168.1.5:5555")).toBe(true);
    expect(isNetworkSerial("adb-R5CT-abc._adb-tls-connect._tcp")).toBe(true);
    expect(isNetworkSerial("R5CT10ABCDE")).toBe(false);
    expect(isNetworkSerial("emulator-5554")).toBe(false);
  });

  it("splits addresses", () => {
    expect(splitAdbAddress("10.0.0.2:5556")).toEqual({ host: "10.0.0.2", port: 5556 });
    expect(splitAdbAddress("10.0.0.2")).toEqual({ host: "10.0.0.2", port: 5555 });
    expect(splitAdbAddress("[fe80::1]:5555")).toEqual({ host: "fe80::1", port: 5555 });
  });

  it("builds USB and WLAN sessions and their serials", () => {
    const usb = adbSessionFor("R5CT10ABCDE", { id: "a" });
    expect(usb.adb).toEqual({ serial: "R5CT10ABCDE", connect: "usb", view: "shell" });
    expect(adbSerialOf(usb)).toBe("R5CT10ABCDE");
    const wlan = adbSessionFor("192.168.1.5:5555", { id: "b" });
    expect(wlan.host).toBe("192.168.1.5");
    expect(wlan.adb?.connect).toBe("wlan");
    expect(adbSerialOf(wlan)).toBe("192.168.1.5:5555");
  });

  it("makes a logcat tab of a shell session", () => {
    const tab = logcatSessionOf(adbSessionFor("X", { id: "a" }), "lc", "Logcat");
    expect(isLogcatSession(tab)).toBe(true);
    expect(tab.adb?.serial).toBe("X");
    expect(tab.adb?.logcat?.level).toBe("V");
  });

  it("parses quick connect", () => {
    const auto = parseQuickConnectInput("adb");
    expect(auto?.protocol).toBe("adb");
    expect(auto?.adb?.serial).toBe("");
    const ip = parseQuickConnectInput("adb 192.168.1.9");
    expect(ip?.adb?.connect).toBe("wlan");
    expect(adbSerialOf(ip!)).toBe("192.168.1.9:5555");
    expect(parseQuickConnectInput("adb R5CT10")?.adb?.serial).toBe("R5CT10");
  });
});

describe("screen mirror helpers", () => {
  const header = (hi: number, lo: number, len: number) => {
    const buf = new ArrayBuffer(12 + len);
    const v = new DataView(buf);
    v.setUint32(0, hi);
    v.setUint32(4, lo);
    v.setUint32(8, len);
    return buf;
  };

  it("parses packet kinds", () => {
    expect(parseMirrorPacket(header(0x80000000, 1080, 2400))).toEqual({ kind: "session", width: 1080, height: 2400 });
    expect(parseMirrorPacket(header(1 << 30, 0, 4))?.kind).toBe("config");
    const key = parseMirrorPacket(header((1 << 29) | 1, 5, 2));
    expect(key).toMatchObject({ kind: "frame", key: true, pts: 0x1_0000_0005 });
    expect(parseMirrorPacket(header(0, 7, 2))).toMatchObject({ kind: "frame", key: false, pts: 7 });
  });

  it("builds the codec string from the SPS", () => {
    const cfg = new Uint8Array([0, 0, 0, 1, 0x67, 0x64, 0x00, 0x28, 0xac, 0, 0, 0, 1, 0x68, 0xee]);
    expect(avcCodecString(cfg)).toBe("avc1.640028");
    expect(avcCodecString(new Uint8Array([1, 2, 3]))).toBe("avc1.42E01F");
  });

  it("maps points and boxes", () => {
    expect(fitBox(300, 600, 1080, 2400)).toEqual({ w: 270, h: 600 });
    expect(toDevice(135, 300, { w: 270, h: 600 }, { w: 1080, h: 2400 })).toEqual({ x: 540, y: 1200 });
    expect(toDevice(999, -5, { w: 270, h: 600 }, { w: 1080, h: 2400 })).toEqual({ x: 1079, y: 0 });
  });

  it("splits keys into keycodes and text", () => {
    const k = (code: string, key: string, mods: Partial<{ ctrlKey: boolean; altKey: boolean; metaKey: boolean }> = {}) => ({
      code,
      key,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      ...mods,
    });
    expect(keycodeFor(k("Enter", "Enter"))).toBe(66);
    expect(keycodeFor(k("Backspace", "Backspace"))).toBe(67);
    expect(keycodeFor(k("KeyA", "a"))).toBeNull();
    expect(textFor(k("KeyA", "a"))).toBe("a");
    expect(keycodeFor(k("KeyA", "a", { ctrlKey: true }))).toBe(29);
    expect(textFor(k("KeyA", "a", { ctrlKey: true }))).toBeNull();
    expect(textFor(k("Enter", "Enter"))).toBeNull();
  });
});

describe("android monitor sample", () => {
  it("parses dumpsys battery", () => {
    const b = parseBattery(["  AC powered: false", "  USB powered: true", "  status: 2", "  health: 2", "  level: 87", "  scale: 100", "  temperature: 312"]);
    expect(b).toEqual({ level: 87, status: "charging", plugged: "USB", temperature: 31.2, health: "good" });
    expect(parseBattery(["nothing"])).toBeNull();
  });

  it("accepts a sample without /proc/stat (Android 8+)", () => {
    const text = "@@cpu\n@@mem\nMemTotal: 8000000 kB\nMemAvailable: 4000000 kB\n@@battery\n  level: 50\n@@end\n";
    const r = parseServerSample(text, 0);
    expect(r.supported).toBe(true);
    if (r.supported) {
      expect(r.sample.cpu).toBeNull();
      expect(r.sample.battery?.level).toBe(50);
    }
  });
});
