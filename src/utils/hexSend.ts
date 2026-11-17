/**
 * Hex input for the sender: each non-blank line is one packet of bytes.
 *
 * Accepted: "48 65 6C 6C 6F", "48656C6C6F", "0x48,0x65", "\x48\x65", "AA-BB:CC".
 * Tokens are split on whitespace , ; : - and may carry a 0x / \x prefix; a token is
 * an even number of hex digits, or a single digit standing alone ("A" = 0x0A).
 */

export type HexParse = { ok: true; packets: Uint8Array[] } | { ok: false; line: number; token: string };

const SEPARATORS = /[\s,;:-]+/;

/** Bytes of one line, or the first token that is not hex. */
export function parseHexLine(line: string): { ok: true; bytes: number[] } | { ok: false; token: string } {
  const bytes: number[] = [];
  // "\x48\x65" has no separators: split before every \x.
  const tokens = line.replace(/\\x/gi, " ").split(SEPARATORS).filter(Boolean);
  for (const raw of tokens) {
    const hex = raw.replace(/^0x/i, "");
    if (!/^[0-9a-f]+$/i.test(hex) || (hex.length > 1 && hex.length % 2 !== 0)) return { ok: false, token: raw };
    if (hex.length === 1) bytes.push(parseInt(hex, 16));
    else for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  }
  return { ok: true, bytes };
}

/** Packets of every non-blank line; on error the 1-based line and the bad token. */
export function parseHexPackets(text: string): HexParse {
  const packets: Uint8Array[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const r = parseHexLine(lines[i]);
    if (!r.ok) return { ok: false, line: i + 1, token: r.token };
    if (r.bytes.length) packets.push(Uint8Array.from(r.bytes));
  }
  return { ok: true, packets };
}

/** Packet followed by the line ending's bytes. */
export function withEol(packet: Uint8Array, eol: string): Uint8Array {
  if (!eol) return packet;
  const out = new Uint8Array(packet.length + eol.length);
  out.set(packet);
  for (let i = 0; i < eol.length; i++) out[packet.length + i] = eol.charCodeAt(i);
  return out;
}

/** All packets (each with its line ending) as one buffer. */
export function joinPackets(packets: Uint8Array[], eol: string): Uint8Array {
  const parts = packets.map((p) => withEol(p, eol));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** "48 65 6C" for a preview / tooltip. */
export function formatHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");
}
