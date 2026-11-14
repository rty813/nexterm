// End-to-end encryption between the phone and Nexterm (see src-tauri/src/remote_crypto.rs).
// The relay only forwards these frames; the pairing secret never leaves the two ends
// (the phone gets it from the QR code, in the URL fragment that browsers do not send).
//
//   room     = hex(HKDF-SHA256(secret, salt = "", info = "nexterm relay room", 16))
//   phone -> [HELLO][16-byte client nonce]
//   host  -> [ACCEPT][16-byte host nonce]
//   keys     = HKDF-SHA256(secret, salt = clientNonce || hostNonce, info = "nexterm c2h" | "... h2c", 32)
//   frame    = [DATA][u64 BE seq][AES-256-GCM(nonce = 4 zero bytes || seq, aad = [DATA])]
// Sequence numbers start at 1 and must arrive in order, so the relay cannot replay,
// drop or reorder frames; fresh nonces on both sides keep old sessions from being replayed.

export const HELLO = 1;
export const ACCEPT = 2;
export const DATA = 3;

const enc = new TextEncoder();

export function b64urlEncode(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(text) {
  const s = text.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function hkdf(ikm, salt, info, len) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: enc.encode(info) }, key, len * 8);
  return new Uint8Array(bits);
}

export async function roomId(secret) {
  return hex(await hkdf(secret, new Uint8Array(0), "nexterm relay room", 16));
}

function aesKey(raw) {
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function nonceOf(seq) {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setBigUint64(4, seq);
  return iv;
}

const AAD = new Uint8Array([DATA]);

export class Session {
  /** role: "client" (the phone) or "host" (Nexterm, used by the tests). */
  static async create(secret, clientNonce, hostNonce, role = "client") {
    const salt = concat(clientNonce, hostNonce);
    const c2h = await aesKey(await hkdf(secret, salt, "nexterm c2h", 32));
    const h2c = await aesKey(await hkdf(secret, salt, "nexterm h2c", 32));
    return role === "client" ? new Session(c2h, h2c) : new Session(h2c, c2h);
  }

  constructor(sendKey, recvKey) {
    this.sendKey = sendKey;
    this.recvKey = recvKey;
    this.sendSeq = 0n;
    this.recvSeq = 0n;
  }

  /** Callers must send the frames in the order they called seal(). */
  async seal(plain) {
    const seq = ++this.sendSeq;
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonceOf(seq), additionalData: AAD }, this.sendKey, plain);
    const head = new Uint8Array(9);
    head[0] = DATA;
    new DataView(head.buffer).setBigUint64(1, seq);
    return concat(head, new Uint8Array(ct));
  }

  /** Returns the plaintext, or null for a forged, replayed or out-of-order frame. Call in arrival order. */
  async open(frame) {
    if (frame.length < 9 + 16 || frame[0] !== DATA) return null;
    const seq = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getBigUint64(1);
    if (seq !== this.recvSeq + 1n) return null;
    try {
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonceOf(seq), additionalData: AAD }, this.recvKey, frame.subarray(9));
      this.recvSeq = seq;
      return new Uint8Array(plain);
    } catch {
      return null;
    }
  }
}
