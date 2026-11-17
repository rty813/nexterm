import { describe, expect, it } from "vitest";
import { formatHex, joinPackets, parseHexLine, parseHexPackets, withEol } from "../utils/hexSend";

const bytes = (line: string) => {
  const r = parseHexLine(line);
  return r.ok ? r.bytes : r.token;
};

describe("hex sender input", () => {
  it("reads the usual notations", () => {
    expect(bytes("48 65 6C 6C 6F")).toEqual([0x48, 0x65, 0x6c, 0x6c, 0x6f]);
    expect(bytes("48656c6C6F")).toEqual([0x48, 0x65, 0x6c, 0x6c, 0x6f]);
    expect(bytes("0x01,0xFF; 0X7f")).toEqual([0x01, 0xff, 0x7f]);
    expect(bytes("\\x1B\\x5b")).toEqual([0x1b, 0x5b]);
    expect(bytes("AA-BB:CC\tDD")).toEqual([0xaa, 0xbb, 0xcc, 0xdd]);
    expect(bytes("A 0 F")).toEqual([0x0a, 0x00, 0x0f]);
    expect(bytes("   ")).toEqual([]);
  });

  it("names the bad token", () => {
    expect(bytes("01 0G 02")).toBe("0G");
    expect(bytes("123")).toBe("123");
    expect(bytes("01 hello")).toBe("hello");
    expect(bytes("0x")).toBe("0x");
  });

  it("splits lines into packets and skips blank ones", () => {
    const r = parseHexPackets("01 02\r\n\r\n  \nFF\n");
    expect(r.ok && r.packets.map((p) => Array.from(p))).toEqual([[1, 2], [0xff]]);
    expect(parseHexPackets("01\n02\nzz")).toEqual({ ok: false, line: 3, token: "zz" });
    expect(parseHexPackets("")).toEqual({ ok: true, packets: [] });
  });

  it("adds line endings and joins", () => {
    expect(Array.from(withEol(Uint8Array.from([1]), "\r\n"))).toEqual([1, 0x0d, 0x0a]);
    expect(Array.from(withEol(Uint8Array.from([1]), ""))).toEqual([1]);
    expect(Array.from(joinPackets([Uint8Array.from([1, 2]), Uint8Array.from([3])], "\r"))).toEqual([1, 2, 0x0d, 3, 0x0d]);
    expect(formatHex(Uint8Array.from([0, 0x0a, 0xff]))).toBe("00 0A FF");
  });
});
