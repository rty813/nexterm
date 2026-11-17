import { describe, expect, it } from "vitest";
import { byteUnderCursor, interpretValue, parseDumpRow, selectedBytes, type ScreenLine } from "../utils/dataInterpreter";

// As hexdump.rs prints them (without colors).
const ROW0 = "00000000  48 65 6C 6C 6F 20 57 6F  72 6C 64 0D 0A 00 01 02  |Hello World.....|";
const ROW1 = "00000010  2C 2C 2C 2C 2C 2C 2C 2C  FF 7C                    |,,,,,,,,.||";
const ROW8 = "00000000  30 31 32 33 34 35 36 37  |01234567|";

const lines = (...texts: string[]): ScreenLine[] => texts.map((text, i) => ({ text, startRow: i }));

describe("hex dump rows", () => {
  it("reads full, partial and narrow rows", () => {
    const r0 = parseDumpRow(ROW0)!;
    expect(r0.offset).toBe(0);
    expect(r0.cells.map((c) => c.value)).toEqual([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x20, 0x57, 0x6f, 0x72, 0x6c, 0x64, 0x0d, 0x0a, 0, 1, 2]);
    expect(r0.cells[0].hexCol).toBe(10);
    expect(r0.cells[8].hexCol).toBe(35);
    expect(ROW0[r0.cells[0].asciiCol]).toBe("H");
    expect(ROW0[r0.cells[15].asciiCol]).toBe(".");

    const r1 = parseDumpRow(ROW1)!;
    expect(r1.offset).toBe(16);
    expect(r1.cells.map((c) => c.value)).toEqual([...Array(8).fill(0x2c), 0xff, 0x7c]);
    // "|" as data does not end the ASCII column early.
    expect(ROW1[r1.cells[9].asciiCol]).toBe("|");

    expect(parseDumpRow(ROW8)!.cells).toHaveLength(8);
  });

  it("ignores other text", () => {
    expect(parseDumpRow("[串口打开失败] COM9 不存在")).toBeNull();
    expect(parseDumpRow("00000000  zz")).toBeNull();
    expect(parseDumpRow("00000000  48 65  |He")).toBeNull();
  });
});

describe("selected bytes", () => {
  const cols = 100;
  it("starts at the first selected byte and reads on into the next row", () => {
    // Double-click on "0D" (cols 44-45 of row 0: 10 + 11 * 3 + 1 for the gap after 8 bytes).
    const sel = selectedBytes(lines(ROW0, ROW1), cols, { x: 44, y: 0 }, { x: 46, y: 0 });
    expect(sel?.offset).toBe(11);
    expect(sel?.selected).toBe(1);
    expect(Array.from(sel!.bytes)).toEqual([0x0d, 0x0a, 0, 1, 2, 0x2c, 0x2c, 0x2c]);
    // Where to draw the mark: "0D" and its "." in the ASCII column.
    expect(sel?.cells).toEqual({ hex: [{ x: 44, y: 0, width: 2 }], ascii: [{ x: 72, y: 0, width: 1 }] });
  });

  it("counts bytes selected across rows and in the ASCII column", () => {
    const sel = selectedBytes(lines(ROW0, ROW1), cols, { x: 74, y: 0 }, { x: 13, y: 1 });
    // ASCII column starts at 61: col 74 is offset 13 (0x00 0x01 0x02), then the first 2C of row 1.
    expect(sel?.offset).toBe(13);
    expect(sel?.selected).toBe(4);
  });

  it("stops at a gap in the offsets and outside the dump", () => {
    const other = "00000040  AA BB                                             |..|";
    const sel = selectedBytes(lines(ROW1, other), cols, { x: 38, y: 0 }, { x: 40, y: 0 });
    expect(Array.from(sel!.bytes)).toEqual([0x7c]);
    expect(selectedBytes(lines("hello", ROW0), cols, { x: 0, y: 0 }, { x: 3, y: 0 })).toBeNull();
    // Only the offset or the spacing.
    expect(selectedBytes(lines(ROW0), cols, { x: 0, y: 0 }, { x: 9, y: 0 })).toBeNull();
  });

  it("maps positions on wrapped rows", () => {
    // 40 columns: ROW0 takes rows 0-1 (cols 40+ on row 1).
    const sel = selectedBytes([{ text: ROW0, startRow: 0 }], 40, { x: 5, y: 1 }, { x: 7, y: 1 });
    // Column 45 = hexCol of 0x0D? 10 + 11*3 + 1 = 44; 45 is its second digit.
    expect(sel?.offset).toBe(11);
  });
});

describe("interpreting", () => {
  // The bytes behind the WinHex screenshot (Big Endian).
  const bytes = Uint8Array.from([0x2c, 0x2c, 0x56, 0x2c, 0x2c, 0x2c, 0x2c, 0x2c]);
  it("matches WinHex, big endian", () => {
    expect(interpretValue(bytes, "int8", true)).toBe("44");
    expect(interpretValue(bytes, "uint8", true)).toBe("44");
    expect(interpretValue(bytes, "int16", true)).toBe("11,308");
    expect(interpretValue(bytes, "int32", true)).toBe("741,103,148");
    expect(interpretValue(bytes, "int64", true)).toBe("3,183,013,784,363,740,204");
    expect(interpretValue(bytes, "float32", true)).toBe("2.4490505e-12");
    expect(interpretValue(bytes, "float64", true)).toBe("6.63314220617233e-96");
  });

  it("reads signs, byte order and short input", () => {
    const b = Uint8Array.from([0xff, 0xfe, 0x00, 0x00]);
    expect(interpretValue(b, "int8", false)).toBe("-1");
    expect(interpretValue(b, "uint8", false)).toBe("255");
    expect(interpretValue(b, "int16", false)).toBe("-257");
    expect(interpretValue(b, "uint16", true)).toBe("65,534");
    expect(interpretValue(b, "uint32", false)).toBe("65,279");
    expect(interpretValue(b, "binary", false)).toBe("11111111");
    expect(interpretValue(b, "int64", false)).toBeNull();
    expect(interpretValue(Uint8Array.from([0, 0, 0x80, 0x3f]), "float32", false)).toBe("1");
    expect(interpretValue(Uint8Array.from([0x3f, 0x8c, 0xcc, 0xcd]), "float32", true)).toBe("1.1");
    expect(interpretValue(Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), "uint64", false)).toBe(
      "18,446,744,073,709,551,615"
    );
  });
});

describe("single click on a byte", () => {
  const cols = 100;
  it("finds the byte under the cursor in hex or ASCII", () => {
    // "0D" at cols 44-45 of ROW0; clicking either digit selects both.
    expect(byteUnderCursor(lines(ROW0, ROW1), cols, { x: 45, y: 0 })).toEqual({ start: { x: 44, y: 0 }, length: 2 });
    expect(byteUnderCursor(lines(ROW0, ROW1), cols, { x: 10, y: 1 })).toEqual({ start: { x: 10, y: 1 }, length: 2 });
    // "H" in the ASCII column of ROW0.
    expect(byteUnderCursor(lines(ROW0), cols, { x: 61, y: 0 })).toEqual({ start: { x: 61, y: 0 }, length: 1 });
  });

  it("ignores spacing, the offset and other text", () => {
    expect(byteUnderCursor(lines(ROW0), cols, { x: 12, y: 0 })).toBeNull();
    expect(byteUnderCursor(lines(ROW0), cols, { x: 3, y: 0 })).toBeNull();
    expect(byteUnderCursor(lines(ROW0), cols, { x: 60, y: 0 })).toBeNull();
    // Padding after the last byte of a short row.
    expect(byteUnderCursor(lines(ROW1), cols, { x: 45, y: 0 })).toBeNull();
    expect(byteUnderCursor(lines("hello world"), cols, { x: 2, y: 0 })).toBeNull();
    expect(byteUnderCursor(lines(ROW0), cols, { x: 10, y: 5 })).toBeNull();
  });

  it("maps clicks on a wrapped row", () => {
    // 40 columns: "0D" at linear 44-45 is row 1, cols 4-5.
    expect(byteUnderCursor([{ text: ROW0, startRow: 0 }], 40, { x: 5, y: 1 })).toEqual({ start: { x: 4, y: 1 }, length: 2 });
    // The selection it makes reads back as the same byte.
    const sel = selectedBytes([{ text: ROW0, startRow: 0 }], 40, { x: 4, y: 1 }, { x: 6, y: 1 });
    expect(sel?.offset).toBe(11);
    expect(sel?.cells.hex).toEqual([{ x: 4, y: 1, width: 2 }]);
    expect(sel?.cells.ascii).toEqual([{ x: 32, y: 1, width: 1 }]);
  });
});
