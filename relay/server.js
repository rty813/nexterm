// Nexterm relay: forwards end-to-end encrypted frames between one computer (host)
// and its phones (clients), and serves the phone page. It never sees terminal content:
// rooms are named by a hash of the pairing secret, and the secret stays on the two ends.
//
//   GET  /                   phone page (public/)
//   WS   /ws?role=host&room=<id>[&token=<HOST_TOKEN>]
//   WS   /ws?role=client&room=<id>
//
// Host <-> relay binary frames: [kind u8][client id u32 BE][payload]
//   relay -> host: JOIN (payload: none), LEAVE, DATA
//   host -> relay: DATA (to that client), KICK
// Client <-> relay: the payload alone, both ways.

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

export const JOIN = 1;
export const LEAVE = 2;
export const DATA = 3;
export const KICK = 4;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_FRAME = 4 * 1024 * 1024;
/** A phone that cannot keep up is dropped (it reconnects and gets a fresh screen). */
const CLIENT_BUFFER_LIMIT = 8 * 1024 * 1024;
const MAX_CLIENTS_PER_ROOM = 16;
const ROOM_RE = /^[0-9a-f]{32}$/;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

/** URL path -> file. Vendor files come from node_modules so the page needs no CDN. */
function staticFiles() {
  const vendor = (pkg, file) => path.join(HERE, "node_modules", pkg, file);
  return {
    "/vendor/xterm.js": vendor("@xterm/xterm", "lib/xterm.js"),
    "/vendor/xterm.css": vendor("@xterm/xterm", "css/xterm.css"),
    "/vendor/addon-unicode11.js": vendor("@xterm/addon-unicode11", "lib/addon-unicode11.js"),
  };
}

function header(kind, id, payload) {
  const out = Buffer.allocUnsafe(5 + (payload ? payload.length : 0));
  out[0] = kind;
  out.writeUInt32BE(id, 1);
  if (payload) payload.copy ? payload.copy(out, 5) : out.set(payload, 5);
  return out;
}

export function createRelay({ hostToken = "", log = () => {}, pingMs = 25_000 } = {}) {
  /** room -> { host: ws | null, clients: Map<id, ws> } */
  const rooms = new Map();
  let nextId = 1;
  const files = staticFiles();

  const room = (id) => {
    let r = rooms.get(id);
    if (!r) {
      r = { host: null, clients: new Map() };
      rooms.set(id, r);
    }
    return r;
  };
  const prune = (id) => {
    const r = rooms.get(id);
    if (r && !r.host && r.clients.size === 0) rooms.delete(id);
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    let file = files[url.pathname];
    if (!file) {
      const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const full = path.normalize(path.join(HERE, "public", rel));
      if (!full.startsWith(path.join(HERE, "public") + path.sep)) {
        res.writeHead(403).end();
        return;
      }
      file = full;
    }
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    fs.readFile(file, (err, body) => {
      if (err) {
        res.writeHead(404).end("not found");
        return;
      }
      // Revalidated on every load, so phones pick up a relay update right away.
      const etag = `"${crypto.createHash("sha1").update(body).digest("base64url")}"`;
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, { etag }).end();
        return;
      }
      res.writeHead(200, {
        etag,
        "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "content-security-policy":
          "default-src 'self'; connect-src 'self' ws: wss:; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
      });
      res.end(body);
    });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://x");
    const role = url.searchParams.get("role");
    const id = url.searchParams.get("room") ?? "";
    const reject = (code, text) => {
      socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
    };
    if (url.pathname !== "/ws" || !ROOM_RE.test(id) || (role !== "host" && role !== "client")) return reject(400, "Bad Request");
    if (role === "host" && hostToken && url.searchParams.get("token") !== hostToken) return reject(401, "Unauthorized");
    if (role === "client" && (rooms.get(id)?.clients.size ?? 0) >= MAX_CLIENTS_PER_ROOM) return reject(429, "Too Many Clients");
    wss.handleUpgrade(req, socket, head, (ws) => {
      // noServer mode never emits "connection" by itself; the keepalive below relies on it.
      wss.emit("connection", ws, req);
      role === "host" ? onHost(ws, id) : onClient(ws, id);
    });
  });

  function onHost(ws, id) {
    const r = room(id);
    if (r.host) r.host.close(4000, "replaced by another host");
    r.host = ws;
    log(`host up   ${id.slice(0, 8)} (${r.clients.size} waiting)`);
    // Phones already waiting introduce themselves again.
    for (const [cid, c] of r.clients) {
      ws.send(header(JOIN, cid));
      c.send(JSON.stringify({ t: "host-up" }));
    }
    ws.on("message", (data, isBinary) => {
      if (!isBinary || data.length < 5) return;
      const cid = data.readUInt32BE(1);
      const client = r.clients.get(cid);
      if (!client) return;
      if (data[0] === KICK) {
        client.close(4003, "removed by the computer");
      } else if (data[0] === DATA) {
        if (client.bufferedAmount > CLIENT_BUFFER_LIMIT) {
          client.terminate();
          return;
        }
        client.send(data.subarray(5), { binary: true });
      }
    });
    ws.on("close", () => {
      if (r.host !== ws) return;
      r.host = null;
      log(`host down ${id.slice(0, 8)}`);
      for (const c of r.clients.values()) c.send(JSON.stringify({ t: "host-down" }));
      prune(id);
    });
    ws.on("error", () => {});
  }

  function onClient(ws, id) {
    const r = room(id);
    const cid = nextId++;
    if (nextId > 0xffffffff) nextId = 1;
    r.clients.set(cid, ws);
    if (r.host) r.host.send(header(JOIN, cid));
    else ws.send(JSON.stringify({ t: "host-down" }));
    ws.on("message", (data, isBinary) => {
      if (!isBinary) return;
      r.host?.send(header(DATA, cid, data));
    });
    ws.on("close", () => {
      r.clients.delete(cid);
      r.host?.send(header(LEAVE, cid));
      prune(id);
    });
    ws.on("error", () => {});
  }

  // Keep NAT / proxy mappings alive and notice dead peers.
  const alive = new WeakSet();
  wss.on("connection", (ws) => {
    alive.add(ws);
    ws.on("pong", () => alive.add(ws));
  });
  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, pingMs);
  server.on("close", () => clearInterval(timer));

  return { server, rooms };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8080);
  const host = process.env.HOST || "0.0.0.0";
  const { server } = createRelay({
    hostToken: process.env.HOST_TOKEN || "",
    log: (m) => console.log(new Date().toISOString(), m),
  });
  server.listen(port, host, () => {
    console.log(`Nexterm relay on http://${host}:${port}${process.env.HOST_TOKEN ? " (host token required)" : ""}`);
  });
}
