// Manual check of the share page: a relay on PORT plus a fake Nexterm sharing one terminal.
// Speaks share.rs's protocol (hello / reset / output / control); grants control when asked.
//   node dev/fake-share-host.mjs   -> prints the link to open
import { once } from "node:events";
import WebSocket from "ws";
import { createRelay, JOIN, DATA } from "../server.js";
import { Session, roomId, b64urlEncode, HELLO, ACCEPT, concat } from "../public/crypto.js";

const PORT = Number(process.env.PORT || 8099);
const secret = new Uint8Array(32).map((_, i) => i * 7 + 1);
const relay = createRelay();
relay.server.listen(PORT, "127.0.0.1");
await once(relay.server, "listening");

const room = await roomId(secret);
const host = new WebSocket(`ws://127.0.0.1:${PORT}/ws?role=host&room=${room}`);
await once(host, "open");
const enc = new TextEncoder();
const dec = new TextDecoder();
/** viewer id -> { session, chain } */
const viewers = new Map();

const env = (kind, id, payload) => {
  const out = new Uint8Array(5 + payload.length);
  out[0] = kind;
  new DataView(out.buffer).setUint32(1, id);
  out.set(payload, 5);
  return out;
};
function sealTo(id, plain) {
  const v = viewers.get(id);
  v.chain = v.chain.then(async () => host.send(env(DATA, id, await v.session.seal(plain))));
  return v.chain;
}
const json = (id, msg) => sealTo(id, concat(new Uint8Array([1]), enc.encode(JSON.stringify(msg))));
const output = (id, text) => sealTo(id, concat(new Uint8Array([2, 2]), enc.encode("p1"), enc.encode(text)));

host.on("message", async (data) => {
  const frame = new Uint8Array(data);
  const id = new DataView(frame.buffer, frame.byteOffset).getUint32(1);
  const payload = frame.subarray(5);
  if (frame[0] === JOIN) {
    viewers.set(id, { session: null, chain: Promise.resolve(), name: "" });
    return;
  }
  if (frame[0] !== DATA) return;
  const v = viewers.get(id);
  if (payload[0] === HELLO) {
    const hostNonce = crypto.getRandomValues(new Uint8Array(16));
    v.session = await Session.create(secret, payload.subarray(1), hostNonce, "host");
    host.send(env(DATA, id, concat(new Uint8Array([ACCEPT]), hostNonce)));
    return;
  }
  const plain = await v.session.open(payload);
  if (!plain || plain[0] !== 1) return;
  const msg = JSON.parse(dec.decode(plain.subarray(1)));
  console.log("viewer", id, msg);
  if (msg.t === "hi") {
    v.name = msg.name;
    await json(id, { t: "hello", title: "prod-web-01", status: "connected", computer: "DEV-PC", token: "tok" });
    await json(id, { t: "control", control: null, asking: false });
    await json(id, { t: "reset", cols: 100, rows: 30 });
    await output(id, "\x1b[32mluke@prod-web-01\x1b[0m:\x1b[34m~\x1b[0m$ uptime\r\n 18:20:01 up 42 days,  3:11,  1 user,  load average: 0.08, 0.05, 0.01\r\n\x1b[32mluke@prod-web-01\x1b[0m:\x1b[34m~\x1b[0m$ ");
  } else if (msg.t === "ask") {
    await json(id, { t: "control", control: null, asking: true });
    setTimeout(() => void json(id, { t: "control", control: "me", asking: false }), 800);
  } else if (msg.t === "drop") {
    await json(id, { t: "control", control: null, asking: false, size: false });
  } else if (msg.t === "take") {
    await json(id, { t: "control", control: "me", asking: false, size: true });
    await json(id, { t: "size", cols: msg.cols, rows: msg.rows });
  } else if (msg.t === "release") {
    await json(id, { t: "control", control: "me", asking: false, size: false });
    await json(id, { t: "size", cols: 100, rows: 30 });
  } else if (msg.t === "in") {
    // Echo like a shell would.
    await output(id, msg.d.replace(/\r/g, "\r\n"));
  }
});

console.log(`http://localhost:${PORT}/s#k=${b64urlEncode(secret)}&n=prod-web-01&c=DEV-PC`);
