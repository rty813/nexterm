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

test("serves the session share page at /s (Nexterm probes it with HEAD)", async () => {
  const http = base.replace("ws://", "http://").replace(/\/ws$/, "");
  const page = await fetch(`${http}/s`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.match(await page.text(), /share\.js/);
  assert.equal((await fetch(`${http}/s`, { method: "HEAD" })).status, 200);
  for (const f of ["share.js", "share.css", "device.js"]) assert.equal((await fetch(`${http}/${f}`)).status, 200);
});

test("device names for phones and desktop browsers", async () => {
  const { deviceName } = await import("../public/device.js");
  assert.equal(deviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1"), "iPhone");
  assert.equal(deviceName("Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP1A) Chrome/120 Mobile"), "Pixel 8");
  assert.equal(deviceName("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"), "Chrome · Windows");
  assert.equal(deviceName("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120 Safari/537.36 Edg/120"), "Edge · Windows");
  assert.equal(deviceName("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605 Version/17 Safari/605"), "Safari · Mac");
  assert.equal(deviceName("Mozilla/5.0 (X11; Linux x86_64; rv:120) Gecko Firefox/120"), "Firefox · Linux");
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

test("one phone stays connected to several computers at once", async () => {
  const roomB = await roomId(new Uint8Array(32).fill(3));
  const hostA = open(`${base}?role=host&room=${room}&token=tok`);
  const hostB = open(`${base}?role=host&room=${roomB}&token=tok`);
  await Promise.all([once(hostA, "open"), once(hostB, "open")]);
  // The phone page opens one socket per paired computer.
  const toA = open(`${base}?role=client&room=${room}`);
  const toB = open(`${base}?role=client&room=${roomB}`);
  await Promise.all([once(toA, "open"), once(toB, "open")]);
  const idA = new DataView((await hostA.next()).buffer).getUint32(1);
  const idB = new DataView((await hostB.next()).buffer).getUint32(1);
  toA.send(new Uint8Array([1, 0xa]));
  toB.send(new Uint8Array([1, 0xb]));
  assert.deepEqual((await hostA.next()).subarray(5), new Uint8Array([1, 0xa]));
  assert.deepEqual((await hostB.next()).subarray(5), new Uint8Array([1, 0xb]));
  hostA.send(envelope(DATA, idA, new Uint8Array([7])));
  hostB.send(envelope(DATA, idB, new Uint8Array([8])));
  assert.deepEqual(await toA.next(), new Uint8Array([7]));
  assert.deepEqual(await toB.next(), new Uint8Array([8]));
  // One computer going away leaves the other link alone.
  hostA.close();
  assert.deepEqual(await toA.next(), { t: "host-down" });
  hostB.send(envelope(DATA, idB, new Uint8Array([9])));
  assert.deepEqual(await toB.next(), new Uint8Array([9]));
  for (const ws of [toA, toB, hostB]) ws.close();
});

/** A relay serving a throwaway plugin store folder. */
async function storeRelay() {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexterm-store-"));
  await fs.mkdir(path.join(dir, "packages", "demo"), { recursive: true });
  await fs.writeFile(path.join(dir, "index.json"), '{"seq":1}');
  await fs.writeFile(path.join(dir, "index.json.sig"), "c2ln");
  await fs.writeFile(path.join(dir, "packages", "demo", "1.0.0.nexterm-plugin"), '{"manifest":{}}');
  const r = createRelay({ storeDir: dir });
  r.server.listen(0, "127.0.0.1");
  await once(r.server, "listening");
  const url = `http://127.0.0.1:${r.server.address().port}`;
  return { url, close: () => r.server.close(), cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

test("plugin store is off unless STORE_DIR is set", async () => {
  const http = base.replace("ws://", "http://").replace(/\/ws$/, "");
  assert.equal((await fetch(`${http}/store/index.json`)).status, 404);
});

test("plugin store serves the index, signature and packages read-only", async () => {
  const s = await storeRelay();
  try {
    const index = await fetch(`${s.url}/store/index.json`);
    assert.equal(index.status, 200);
    assert.equal(await index.text(), '{"seq":1}');
    assert.equal(index.headers.get("cache-control"), "no-cache");
    const again = await fetch(`${s.url}/store/index.json`, { headers: { "if-none-match": index.headers.get("etag") } });
    assert.equal(again.status, 304);
    assert.equal((await fetch(`${s.url}/store/index.json.sig`)).headers.get("content-type"), "text/plain; charset=utf-8");
    const pkg = await fetch(`${s.url}/store/packages/demo/1.0.0.nexterm-plugin`);
    assert.equal(pkg.status, 200);
    assert.equal(pkg.headers.get("content-type"), "application/json");
    assert.equal(pkg.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal((await fetch(`${s.url}/store/index.json`, { method: "HEAD" })).status, 200);
    assert.equal((await fetch(`${s.url}/store/index.json`, { method: "PUT", body: "x" })).status, 405);
    for (const bad of ["/store/", "/store", "/store/packages", "/store/nope.json", "/store/..%2fserver.js", "/store/packages%2f..%2f..%2fserver.js", "/store/%00", "/store/%E0"]) {
      assert.ok([400, 404].includes((await fetch(`${s.url}${bad}`)).status), bad);
    }
  } finally {
    s.close();
    await s.cleanup();
  }
});
