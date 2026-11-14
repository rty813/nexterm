//! End-to-end encryption between Nexterm and the phone page (`relay/public/crypto.js`).
//!
//! The relay only forwards frames; the pairing secret is in the QR code's URL fragment,
//! which browsers never send to the server.
//!
//! ```text
//! room   = hex(HKDF-SHA256(secret, salt = "", info = "nexterm relay room", 16))
//! phone -> [HELLO][16-byte client nonce]
//! host  -> [ACCEPT][16-byte host nonce]
//! keys   = HKDF-SHA256(secret, salt = clientNonce || hostNonce, info = "nexterm c2h" | "... h2c", 32)
//! frame  = [DATA][u64 BE seq][AES-256-GCM(nonce = 4 zero bytes || seq, aad = [DATA])]
//! ```
//! Sequence numbers start at 1 and must arrive in order, so the relay can neither replay,
//! drop nor reorder frames; both sides' fresh nonces keep a recorded session from being replayed.

use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use ring::hkdf::{KeyType, Salt, HKDF_SHA256};
use ring::rand::{SecureRandom, SystemRandom};

pub const SECRET_LEN: usize = 32;
pub const NONCE_LEN: usize = 16;
pub const HELLO: u8 = 1;
pub const ACCEPT: u8 = 2;
pub const DATA: u8 = 3;
const TAG_LEN: usize = 16;

struct Len(usize);

impl KeyType for Len {
    fn len(&self) -> usize {
        self.0
    }
}

fn hkdf(ikm: &[u8], salt: &[u8], info: &str, out: &mut [u8]) {
    let info = [info.as_bytes()];
    let prk = Salt::new(HKDF_SHA256, salt).extract(ikm);
    prk.expand(&info, Len(out.len())).expect("HKDF length").fill(out).expect("HKDF length");
}

pub fn random<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    SystemRandom::new().fill(&mut out).expect("system random");
    out
}

/// Relay room of a pairing secret: the relay learns this, never the secret.
pub fn room_id(secret: &[u8; SECRET_LEN]) -> String {
    let mut out = [0u8; 16];
    hkdf(secret, &[], "nexterm relay room", &mut out);
    out.iter().map(|b| format!("{b:02x}")).collect()
}

fn aes_key(secret: &[u8], salt: &[u8], info: &str) -> LessSafeKey {
    let mut raw = [0u8; 32];
    hkdf(secret, salt, info, &mut raw);
    LessSafeKey::new(UnboundKey::new(&AES_256_GCM, &raw).expect("AES-256 key"))
}

fn nonce(seq: u64) -> Nonce {
    let mut n = [0u8; 12];
    n[4..].copy_from_slice(&seq.to_be_bytes());
    Nonce::assume_unique_for_key(n)
}

/// One phone's encrypted session.
pub struct Session {
    send: LessSafeKey,
    recv: LessSafeKey,
    send_seq: u64,
    recv_seq: u64,
}

impl Session {
    fn new(secret: &[u8; SECRET_LEN], client_nonce: &[u8], host_nonce: &[u8], host: bool) -> Self {
        let salt = [client_nonce, host_nonce].concat();
        let c2h = aes_key(secret, &salt, "nexterm c2h");
        let h2c = aes_key(secret, &salt, "nexterm h2c");
        let (send, recv) = if host { (h2c, c2h) } else { (c2h, h2c) };
        Session { send, recv, send_seq: 0, recv_seq: 0 }
    }

    /// The host end, once the phone's HELLO arrived and our ACCEPT nonce is chosen.
    pub fn host(secret: &[u8; SECRET_LEN], client_nonce: &[u8], host_nonce: &[u8]) -> Self {
        Self::new(secret, client_nonce, host_nonce, true)
    }

    pub fn seal(&mut self, plain: &[u8]) -> Vec<u8> {
        self.send_seq += 1;
        let seq = self.send_seq;
        let mut buf = Vec::with_capacity(9 + plain.len() + TAG_LEN);
        buf.push(DATA);
        buf.extend_from_slice(&seq.to_be_bytes());
        let mut body = plain.to_vec();
        self.send
            .seal_in_place_append_tag(nonce(seq), Aad::from([DATA]), &mut body)
            .expect("AES-GCM seal");
        buf.extend_from_slice(&body);
        buf
    }

    /// The plaintext, or `None` for a forged, replayed or out-of-order frame.
    pub fn open(&mut self, frame: &[u8]) -> Option<Vec<u8>> {
        if frame.len() < 9 + TAG_LEN || frame[0] != DATA {
            return None;
        }
        let seq = u64::from_be_bytes(frame[1..9].try_into().ok()?);
        if seq != self.recv_seq.checked_add(1)? {
            return None;
        }
        let mut body = frame[9..].to_vec();
        let plain_len = self.recv.open_in_place(nonce(seq), Aad::from([DATA]), &mut body).ok()?.len();
        body.truncate(plain_len);
        self.recv_seq = seq;
        Some(body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    fn fixture() -> ([u8; 32], [u8; 16], [u8; 16]) {
        let secret: [u8; 32] = std::array::from_fn(|i| i as u8);
        let nc: [u8; 16] = std::array::from_fn(|i| 0x10 + i as u8);
        let nh: [u8; 16] = std::array::from_fn(|i| 0x20 + i as u8);
        (secret, nc, nh)
    }

    /// Vectors produced by `relay/public/crypto.js` (WebCrypto), so both ends agree.
    #[test]
    fn matches_the_phone_page() {
        let (secret, nc, nh) = fixture();
        assert_eq!(room_id(&secret), "fae110f938628dd8f222534633f521bc");
        let mut host = Session::host(&secret, &nc, &nh);
        assert_eq!(host.seal(b"hello"), unhex("0300000000000000018856156cd197bd4ad9bd22f7280478d4d71000da8a"));
        let from_phone = unhex("030000000000000001b88d25ad1d18eb8522c87a3023ade7ed8e83187605");
        assert_eq!(host.open(&from_phone).as_deref(), Some(&b"world"[..]));
    }

    #[test]
    fn rejects_replay_reorder_and_tampering() {
        let (secret, nc, nh) = fixture();
        let mut host = Session::host(&secret, &nc, &nh);
        let mut phone = Session::new(&secret, &nc, &nh, false);
        let a = phone.seal(b"a");
        let b = phone.seal(b"b");
        assert!(host.open(&b).is_none(), "out of order");
        assert_eq!(host.open(&a).as_deref(), Some(&b"a"[..]));
        assert!(host.open(&a).is_none(), "replayed");
        let mut forged = b.clone();
        *forged.last_mut().unwrap() ^= 1;
        assert!(host.open(&forged).is_none(), "tampered");
        assert_eq!(host.open(&b).as_deref(), Some(&b"b"[..]));
        // A frame of another session (other nonces) does not open.
        let mut other = Session::new(&secret, &nh, &nc, false);
        assert!(host.open(&other.seal(b"c")).is_none());
        // Our own frames cannot be reflected back to us.
        let mut host2 = Session::host(&secret, &nc, &nh);
        let echo = host2.seal(b"x");
        assert!(Session::host(&secret, &nc, &nh).open(&echo).is_none());
    }
}
