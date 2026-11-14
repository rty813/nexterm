// Relay + end-to-end encryption, with a fake computer playing Nexterm's side.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import WebSocket from "ws";
import { createRelay, JOIN, LEAVE, DATA, KICK } from "../server.js";
import { Session, roomId, HELLO, ACCEPT, concat } from "../public/crypto.js";

let relay;
let base;
const secret = new Uint8Array(32).fill(7);
let room;

before(async () => {
  relay = createRelay({ hostToken: "tok" });
  relay.server.listen(0, "127.0.0.1");
  await once(relay.server, "listening");
  base = `ws://127.0.0.1:${relay.server.address().port}/ws`;
  room = await roomId(secret);
});

after(() => relay.server.close());

/** Collects messages so tests can await the next one. */
function open(url) {
  const ws = new WebSocket(url);
  const queue = [];
  const waiters = [];
  ws.on("message", (data, isBinary) => {
    const msg = isBinary ? new Uint8Array(data) : JSON.parse(data.toString());
    const w = waiters.shift();
    if (w) w(msg);
    else queue.push(msg);
  });
  ws.next = () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r)));
  return ws;
}

function envelope(kind, id, payload = new Uint8Array(0)) {
  const out = new Uint8Array(5 + payload.length);
  out[0] = kind;
  new DataView(out.buffer).setUint32(1, id);
  out.set(payload, 5);
  return out;
}

test("rejects bad rooms and a wrong host token", async () => {
  for (const url of [`${base}?role=host&room=${room}&token=nope`, `${base}?role=client&room=xyz`]) {
    const ws = new WebSocket(url);
    const [err] = await once(ws, "error");
    assert.match(String(err.message), /Unexpected server response: (401|400)/);
  }
});

test("phone and computer talk end to end; the relay only sees ciphertext", async () => {
  const host = open(`${base}?role=host&room=${room}&token=tok`);
  await once(host, "open");
  const phone = open(`${base}?role=client&room=${room}`);
  await once(phone, "open");

  const join = await host.next();
  assert.equal(join[0], JOIN);
  const id = new DataView(join.buffer).getUint32(1);

  // Handshake.
  const nc = crypto.getRandomValues(new Uint8Array(16));
  phone.send(concat(new Uint8Array([HELLO]), nc));
  const hello = await host.next();
  assert.equal(hello[0], DATA);
  assert.deepEqual(hello.subarray(5), concat(new Uint8Array([HELLO]), nc));
  const nh = crypto.getRandomValues(new Uint8Array(16));
  host.send(envelope(DATA, id, concat(new Uint8Array([ACCEPT]), nh)));
  const accept = await phone.next();
  assert.equal(accept[0], ACCEPT);
  const ps = await Session.create(secret, nc, accept.subarray(1), "client");
  const hs = await Session.create(secret, nc, nh, "host");

  // Phone -> computer.
  const secretText = new TextEncoder().encode("ls -la /root\r");
  phone.send(await ps.seal(secretText));
  const up = await host.next();
  assert.ok(!Buffer.from(up).includes(Buffer.from("ls -la")), "relay frame must not carry plaintext");
  assert.deepEqual(await hs.open(up.subarray(5)), secretText);

  // Computer -> phone.
  host.send(envelope(DATA, id, await hs.seal(new TextEncoder().encode("total 0"))));
  assert.equal(new TextDecoder().decode(await ps.open(await phone.next())), "total 0");

  // A replayed frame is refused.
  assert.equal(await hs.open(up.subarray(5)), null);

  // Computer drops, phone hears it; a new computer gets the waiting phone.
  host.close();
  assert.deepEqual(await phone.next(), { t: "host-down" });
  const host2 = open(`${base}?role=host&room=${room}&token=tok`);
  assert.equal((await host2.next())[0], JOIN);
  assert.deepEqual(await phone.next(), { t: "host-up" });

  // Kick.
  host2.send(envelope(KICK, id));
  const [code] = await once(phone, "close");
  assert.equal(code, 4003);
  assert.equal((await host2.next())[0], LEAVE);
  host2.close();
});

test("rooms are isolated", async () => {
  const otherRoom = await roomId(new Uint8Array(32).fill(9));
  const host = open(`${base}?role=host&room=${room}&token=tok`);
  await once(host, "open");
  const stranger = open(`${base}?role=client&room=${otherRoom}`);
  assert.deepEqual(await stranger.next(), { t: "host-down" });
  stranger.send(new Uint8Array([1, 2, 3]));
  const got = await Promise.race([host.next(), new Promise((r) => setTimeout(() => r("none"), 200))]);
  assert.equal(got, "none");
  stranger.close();
  host.close();
});

test("serves the phone page and the vendored xterm.js", async () => {
  const http = base.replace("ws://", "http://").replace(/\/ws$/, "");
  const page = await fetch(`${http}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Nexterm/);
  assert.equal((await fetch(`${http}/vendor/xterm.js`)).status, 200);
  assert.equal((await fetch(`${http}/crypto.js`)).status, 200);
  assert.equal((await fetch(`${http}/..%2fserver.js`)).status, 403);
  assert.equal((await fetch(`${http}/nope.js`)).status, 404);
});

test("static files revalidate with an ETag", async () => {
  const http = base.replace("ws://", "http://").replace(/\/ws$/, "");
  const first = await fetch(`${http}/app.js`);
  assert.equal(first.headers.get("cache-control"), "no-cache");
  const again = await fetch(`${http}/app.js`, { headers: { "if-none-match": first.headers.get("etag") } });
  assert.equal(again.status, 304);
});

test("keepalive does not drop healthy connections", async () => {
  const r = createRelay({ pingMs: 50 });
  r.server.listen(0, "127.0.0.1");
  await once(r.server, "listening");
  const url = `ws://127.0.0.1:${r.server.address().port}/ws?role=host&room=${room}`;
  const ws = new WebSocket(url);
  await once(ws, "open");
  let closed = false;
  ws.on("close", () => (closed = true));
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(closed, false);
  ws.close();
  r.server.close();
});
