// Remote access page (phone or desktop browser): any number of paired computers, each on its own end-to-end encrypted link
// (crypto.js). Per computer: mirror and type into its tabs, manage its saved sessions,
// browse the files of its SSH tabs (download to the phone, upload from it).
import { b64urlDecode, b64urlEncode, roomId, Session, HELLO, ACCEPT, concat } from "./crypto.js";
import { installWidths, setWideAmbiguous } from "./ambiguous.js";
import { deviceName } from "./device.js";

const P_JSON = 1;
const P_OUTPUT = 2;
const P_FILE = 3;
const STORE = "nexterm-computers";
/** Pairings kept by earlier versions of this page (one pairing, or the WindTerm Next names). */
const OLD_STORES = ["nexterm-pairing", "windterm-next-computers", "windterm-next-pairing"];
const UP_CHUNK = 192 * 1024;
/** Upload bytes in flight before the computer acknowledges them. */
const UP_WINDOW = 1024 * 1024;
const ACK_EVERY = 256 * 1024;
/** Downloads are kept in memory until saved. */
const DOWN_LIMIT = 1024 * 1024 * 1024;

const $ = (id) => document.getElementById(id);
const enc = new TextEncoder();
const dec = new TextDecoder();
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

// ---------- pairings ----------

/** From a pairing link's fragment (#k=<secret>&n=<computer name>). */
function readFragment(hash) {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const k = params.get("k");
  if (!k) return null;
  try {
    if (b64urlDecode(k).length !== 32) return null;
    return { k, name: params.get("n") || "" };
  } catch {
    return null;
  }
}

function loadPairings() {
  let list = [];
  try {
    list = JSON.parse(localStorage.getItem(STORE) || "[]");
  } catch {}
  if (!Array.isArray(list)) list = [];
  let moved = false;
  for (const key of OLD_STORES) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const old = JSON.parse(raw);
      for (const p of Array.isArray(old) ? old : [old]) {
        if (p?.k && !list.some((x) => x.k === p.k)) list.push({ k: p.k, name: p.name || "", relay: p.relay || "" });
      }
      moved = true;
    } catch {}
  }
  list = list.filter((p) => p && p.k);
  if (moved) {
    // Saved under the new name before the old ones go.
    localStorage.setItem(STORE, JSON.stringify(list));
    for (const key of OLD_STORES) localStorage.removeItem(key);
  }
  return list;
}

function savePairings() {
  localStorage.setItem(STORE, JSON.stringify(computers.map((c) => c.p)));
}

/** Adds (or refreshes) a computer from a pairing link; `relay` is the page it points at. */
function addPairing(p, relay) {
  let c = computers.find((x) => x.p.k === p.k);
  if (c) {
    if (p.name) c.p.name = p.name;
    if (relay) c.p.relay = relay;
  } else {
    c = new Computer({ ...p, relay: relay || "" });
    computers.push(c);
  }
  savePairings();
  c.connect();
  return c;
}

function pairingFromText(text) {
  const at = text.indexOf("#");
  const p = readFragment(at >= 0 ? text.slice(at) : text);
  if (!p) return null;
  let relay = "";
  if (at > 0) {
    try {
      relay = new URL(".", text.slice(0, at)).href;
    } catch {}
  }
  return { p, relay };
}

// ---------- one computer ----------

class Computer {
  constructor(p) {
    /** { k, name, relay }: what is saved on this phone. */
    this.p = p;
    this.ws = null;
    this.session = null;
    this.inbox = Promise.resolve();
    this.outbox = Promise.resolve();
    this.clientNonce = null;
    /** idle | connecting | online | offline | kicked | badkey | error */
    this.state = "idle";
    this.tabs = [];
    this.readOnly = false;
    this.features = [];
    this.backoff = 1000;
    this.timer = 0;
    this.rid = 0;
    /** rid -> { resolve, reject, timer } */
    this.pending = new Map();
    /** transfer id -> download / upload state */
    this.xfers = new Map();
  }

  get name() {
    return this.p.name || "电脑";
  }

  wsUrl(room) {
    const base = new URL("ws", this.p.relay || location.href);
    base.protocol = base.protocol === "https:" || base.protocol === "wss:" ? "wss:" : "ws:";
    base.searchParams.set("role", "client");
    base.searchParams.set("room", room);
    return base.href;
  }

  async connect() {
    clearTimeout(this.timer);
    if (!crypto.subtle) {
      this.setState("error", "浏览器不支持加密（需要 HTTPS 访问中继服务器）");
      return;
    }
    const secret = b64urlDecode(this.p.k);
    const room = await roomId(secret);
    this.drop();
    this.setState("connecting");
    const sock = new WebSocket(this.wsUrl(room));
    sock.binaryType = "arraybuffer";
    this.ws = sock;
    sock.onopen = () => {
      this.backoff = 1000;
      // If the computer is online the relay already told it we joined.
      this.handshake();
    };
    sock.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        this.onNotice(JSON.parse(ev.data));
        return;
      }
      const frame = new Uint8Array(ev.data);
      this.inbox = this.inbox.then(() => this.onFrame(secret, frame)).catch((e) => console.error(e));
    };
    sock.onclose = (ev) => {
      if (this.ws !== sock) return;
      this.ws = null;
      this.session = null;
      this.failAll("连接中断");
      if (ev.code === 4003) {
        this.setState("kicked");
        return;
      }
      if (this.state === "badkey") return;
      this.setState("connecting");
      this.timer = setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 15000);
    };
  }

  /** Close the socket without reconnecting. */
  drop() {
    clearTimeout(this.timer);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.session = null;
    this.failAll("连接中断");
  }

  handshake() {
    this.clientNonce = crypto.getRandomValues(new Uint8Array(16));
    this.session = null;
    this.ws.send(concat(new Uint8Array([HELLO]), this.clientNonce));
  }

  onNotice(msg) {
    if (msg.t === "host-down") {
      this.session = null;
      this.failAll("电脑离线");
      this.setState("offline");
    } else if (msg.t === "host-up") {
      this.handshake();
    }
  }

  async onFrame(secret, frame) {
    if (!this.session) {
      if (frame[0] === ACCEPT && frame.length === 17 && this.clientNonce) {
        this.session = await Session.create(secret, this.clientNonce, frame.subarray(1));
        await this.sendJson({ t: "hi", name: deviceName() });
      }
      return;
    }
    const plain = await this.session.open(frame);
    if (!plain) {
      // Wrong key (the computer regenerated it) or a tampered frame.
      this.setState("badkey");
      this.drop();
      return;
    }
    if (plain[0] === P_JSON) this.onMessage(JSON.parse(dec.decode(plain.subarray(1))));
    else if (plain[0] === P_OUTPUT) {
      const len = plain[1];
      const id = dec.decode(plain.subarray(2, 2 + len));
      if (this === cur && id === watching) term.write(plain.subarray(2 + len), followCursor);
    } else if (plain[0] === P_FILE && plain.length >= 5) {
      const x = new DataView(plain.buffer, plain.byteOffset).getUint32(1);
      this.onFileData(x, plain.slice(5));
    }
  }

  /** Seal in call order: sequence numbers must reach the computer in order. */
  sendPlain(body) {
    if (!this.session || !this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.resolve(false);
    const s = this.session;
    const sock = this.ws;
    this.outbox = this.outbox.then(async () => {
      if (s !== this.session) return false;
      const frame = await s.seal(body);
      if (sock.readyState !== WebSocket.OPEN) return false;
      sock.send(frame);
      return true;
    });
    return this.outbox;
  }

  sendJson(msg) {
    return this.sendPlain(concat(new Uint8Array([P_JSON]), enc.encode(JSON.stringify(msg))));
  }

  sendFile(x, bytes) {
    const head = new Uint8Array(5);
    head[0] = P_FILE;
    new DataView(head.buffer).setUint32(1, x);
    return this.sendPlain(concat(head, bytes));
  }

  nextRid() {
    this.rid = (this.rid + 1) >>> 0 || 1;
    return this.rid;
  }

  /** One request to the computer; resolves with its data or rejects with its error. */
  req(op, a = {}, rid = this.nextRid(), timeoutMs = 60000) {
    if (this.state !== "online") return Promise.reject(new Error(stateText(this)));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(new Error("电脑没有回应"));
      }, timeoutMs);
      this.pending.set(rid, { resolve, reject, timer });
      void this.sendJson({ t: "req", rid, op, a });
    });
  }

  failAll(why) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(why));
    }
    this.pending.clear();
    for (const [, x] of this.xfers) x.fail(why);
    this.xfers.clear();
  }

  setState(state, note = "") {
    this.state = state;
    this.note = note;
    onComputerChanged(this);
  }

  onMessage(msg) {
    switch (msg.t) {
      case "hello":
        this.readOnly = msg.readOnly;
        this.features = msg.features || [];
        if (msg.computer && this.p.name !== msg.computer) {
          this.p.name = msg.computer;
          savePairings();
        }
        this.setState("online");
        // Resume the tab we were on after a reconnect.
        if (this === cur && watching) void this.sendJson({ t: "sub", id: watching });
        break;
      case "tabs":
        this.tabs = msg.tabs;
        this.readOnly = msg.readOnly;
        onTabsChanged(this);
        break;
      case "reset":
      case "size":
        if (this === cur && msg.id === watching) onTermMessage(msg);
        break;
      case "res": {
        const p = this.pending.get(msg.rid);
        if (!p) return;
        this.pending.delete(msg.rid);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.data);
        else p.reject(new Error(errorText(msg.error)));
        break;
      }
      case "fsAck": {
        const x = this.xfers.get(msg.x);
        if (x?.kind === "up") x.ack(msg.n);
        break;
      }
      case "fsEnd": {
        const x = this.xfers.get(msg.x);
        if (!x) return;
        this.xfers.delete(msg.x);
        if (msg.ok) x.finish();
        else x.fail(errorText(msg.error));
        break;
      }
      case "error":
        if (msg.code === "too-many") this.setState("error", "连接的设备太多了");
        break;
    }
  }

  onFileData(x, bytes) {
    const d = this.xfers.get(x);
    if (d?.kind !== "down") return;
    d.parts.push(bytes);
    d.got += bytes.length;
    d.progress(d.got);
    if (d.got - d.acked >= ACK_EVERY) {
      d.acked = d.got;
      void this.sendJson({ t: "fsAck", x, n: d.got });
    }
  }

  /** Remote file -> Blob. `progress(bytes, total)`; `t.cancel()` stops it. */
  download(pane, path, t) {
    const x = this.nextRid();
    return new Promise((resolve, reject) => {
      let total = 0;
      const d = {
        kind: "down",
        parts: [],
        got: 0,
        acked: 0,
        progress: (n) => t.progress(n, total),
        finish: () => resolve(new Blob(d.parts)),
        fail: (why) => reject(new Error(why)),
      };
      this.xfers.set(x, d);
      t.cancel = () => {
        this.xfers.delete(x);
        void this.sendJson({ t: "fsCancel", x });
        reject(new Error("已取消"));
      };
      this.req("fs.get", { pane, path }, x).then(
        (info) => {
          total = info.size;
          if (total > DOWN_LIMIT) {
            t.cancel();
            reject(new Error("文件太大（最多下载 1 GB）"));
          }
          d.progress(d.got);
        },
        (e) => {
          this.xfers.delete(x);
          reject(e);
        }
      );
    });
  }

  /** Phone File -> remote folder `dir`. */
  async upload(pane, dir, file, t) {
    const x = this.nextRid();
    let acked = 0;
    let wake = null;
    let failed = null;
    const done = new Promise((resolve, reject) => {
      this.xfers.set(x, {
        kind: "up",
        ack: (n) => {
          acked = n;
          t.progress(n, file.size);
          wake?.();
        },
        finish: resolve,
        fail: (why) => {
          failed = why;
          wake?.();
          reject(new Error(why));
        },
      });
    });
    done.catch(() => {});
    t.cancel = () => {
      const u = this.xfers.get(x);
      this.xfers.delete(x);
      void this.sendJson({ t: "fsCancel", x });
      u?.fail("已取消");
    };
    try {
      await this.req("fs.put", { pane, path: dir, name: file.name, size: file.size }, x);
    } catch (e) {
      this.xfers.delete(x);
      throw e;
    }
    let off = 0;
    while (off < file.size) {
      while (!failed && off - acked >= UP_WINDOW) await new Promise((r) => (wake = r));
      if (failed) break;
      const chunk = new Uint8Array(await file.slice(off, off + UP_CHUNK).arrayBuffer());
      if (!(await this.sendFile(x, chunk))) break;
      off += chunk.length;
    }
    if (!failed) void this.sendJson({ t: "fsEnd", x });
    return done;
  }
}

function stateText(c) {
  switch (c.state) {
    case "online":
      return "在线";
    case "connecting":
    case "idle":
      return "正在连接…";
    case "offline":
      return "不在线（请确认 Nexterm 已开启远程访问）";
    case "kicked":
      return "已被电脑断开";
    case "badkey":
      return "配对已失效，请重新配对";
    default:
      return c.note || "连接失败";
  }
}

function errorText(e) {
  if (e === "read-only") return "电脑设置为只读，不能修改";
  if (e === "locked") return "该标签页在电脑上已锁定，不能关闭";
  if (e === "tab not found") return "该标签页已不存在";
  if (e === "the tab did not close") return "电脑没有关闭该标签页";
  return String(e || "失败");
}

// ---------- state ----------

const computers = loadPairings().map((p) => new Computer(p));
/** The computer on screen (its tabs / sessions / files / terminal). */
let cur = null;
let watching = null; // pane id in the terminal
let currentTab = null;
let fontSize = Number(localStorage.getItem("wtn-font") || 13);
let ctrl = false;
let alt = false;

// ---------- navigation ----------

const stack = [];
let skipPops = 0;

function show(id) {
  for (const s of document.querySelectorAll(".screen")) s.classList.toggle("hidden", s.id !== id);
}

/** Open a screen on top; the system back gesture returns. */
function go(id) {
  stack.push(id);
  history.pushState({ depth: stack.length }, "");
  show(id);
}

/**
 * Back to the bottom screen (home, or pairing when nothing is paired). Resolves once the
 * browser history went back too, so a screen opened next lands on top of it.
 */
function resetNav() {
  const extra = stack.length - 1;
  while (stack.length > 1) leave(stack.pop());
  stack[0] = computers.length ? "home" : "gate";
  if (stack[0] === "home") renderHome();
  else gate("这个浏览器还没有配对电脑。");
  show(stack[0]);
  if (extra <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    // One traversal, one popstate, however many entries it skips.
    skipPops++;
    afterSkip = resolve;
    history.go(-extra);
  });
}
let afterSkip = null;

function top() {
  return stack[stack.length - 1];
}

function leave(id) {
  if (id === "term") leaveTerm();
  if (id === "computer") cur = null;
}

window.addEventListener("popstate", () => {
  if (skipPops > 0) {
    skipPops--;
    if (!skipPops && afterSkip) {
      const done = afterSkip;
      afterSkip = null;
      done();
    }
    return;
  }
  if (stack.length <= 1) return;
  leave(stack.pop());
  const id = top();
  if (id === "home") renderHome();
  if (id === "computer") renderComputer();
  show(id);
});
for (const b of document.querySelectorAll("[data-back]")) b.onclick = () => history.back();

function gate(text) {
  $("gate-text").textContent = text;
  $("gate-cancel").classList.toggle("hidden", stack[0] !== "home" || top() !== "gate");
}

let toastTimer = 0;
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2500);
}

/** Action sheet: [{ label, danger?, run }]. */
function sheet(title, items) {
  $("sheet-title").textContent = title || "";
  $("sheet-title").classList.toggle("hidden", !title);
  const box = $("sheet-items");
  box.textContent = "";
  for (const it of items) {
    const b = el("button", `sheet-item${it.danger ? " danger" : ""}`, it.label);
    b.onclick = () => {
      $("sheet").classList.add("hidden");
      it.run();
    };
    box.append(b);
  }
  $("sheet").classList.remove("hidden");
}
$("sheet-close").onclick = () => $("sheet").classList.add("hidden");
$("sheet").onclick = (ev) => {
  if (ev.target.id === "sheet") $("sheet").classList.add("hidden");
};

// ---------- computers ----------

function onComputerChanged(c) {
  if (top() === "home") renderHome();
  if (c === cur) {
    renderComputerBar();
    if (top() === "computer") renderComputer();
    if (top() === "term") {
      setTermStatus(c.state === "online" ? "" : stateText(c));
      updateTermBar();
    }
  }
}

function renderHome() {
  const list = $("computer-list");
  list.textContent = "";
  for (const c of computers) {
    const li = el("li", "row-item");
    const dot = el("span", `dot ${c.state === "online" ? "connected" : c.state === "connecting" || c.state === "idle" ? "connecting" : "error"}`);
    const main = el("div", "tab-main");
    main.append(el("div", "tab-title", c.name));
    const sub = c.state === "online" ? `在线 · ${c.tabs.length} 个标签页` : stateText(c);
    main.append(el("div", "tab-sub", sub));
    const more = el("button", "icon", "⋯");
    more.setAttribute("aria-label", "更多");
    more.onclick = (ev) => {
      ev.stopPropagation();
      computerMenu(c);
    };
    li.append(dot, main, more);
    li.onclick = () => openComputer(c);
    list.append(li);
  }
}

function computerMenu(c) {
  sheet(c.name, [
    { label: "重新连接", run: () => ((c.backoff = 1000), c.connect()) },
    {
      label: "重命名",
      run: () => {
        const name = prompt("名称", c.name);
        if (name?.trim()) {
          c.p.name = name.trim();
          savePairings();
          onComputerChanged(c);
          renderHome();
        }
      },
    },
    {
      label: "忘记这台电脑",
      danger: true,
      run: () => {
        if (!confirm(`忘记 ${c.name}？之后需要重新扫码配对。`)) return;
        c.drop();
        computers.splice(computers.indexOf(c), 1);
        savePairings();
        void resetNav();
      },
    },
  ]);
}

function openComputer(c) {
  cur = c;
  if (c.state !== "online" && c.state !== "connecting") {
    c.backoff = 1000;
    c.connect();
  }
  setPane("tabs");
  renderComputer();
  go("computer");
}

$("add-computer").onclick = () => {
  gate("");
  go("gate");
  gate("添加电脑");
};
$("gate-cancel").onclick = () => history.back();
$("computer-menu").onclick = () => cur && computerMenu(cur);

$("pair-go").onclick = () => {
  const got = pairingFromText($("pair-input").value.trim());
  if (!got) {
    toast("链接无效");
    return;
  }
  $("pair-input").value = "";
  const c = addPairing(got.p, got.relay);
  void resetNav().then(() => openComputer(c));
};

// ---------- one computer: tabs / sessions / files ----------

let pane = "tabs";

function setPane(p) {
  pane = p;
  for (const b of document.querySelectorAll(".seg button")) b.classList.toggle("on", b.dataset.pane === p);
  for (const id of ["tabs", "sessions", "files"]) $(`pane-${id}`).classList.toggle("hidden", id !== p);
  if (p === "sessions") void loadSessions();
}
for (const b of document.querySelectorAll(".seg button")) b.onclick = () => setPane(b.dataset.pane);

function renderComputerBar() {
  if (!cur) return;
  $("computer-name").textContent = cur.name;
  $("computer-state").textContent = cur.state === "online" ? "" : stateText(cur);
  $("ro-badge").classList.toggle("hidden", !cur.readOnly);
  $("session-new").classList.toggle("hidden", cur.readOnly);
}

function renderComputer() {
  if (!cur) return;
  renderComputerBar();
  renderTabs();
  renderFileTargets();
}

function onTabsChanged(c) {
  if (top() === "home") renderHome();
  if (c !== cur) return;
  renderComputer();
  // A session opened from this phone: show its new tab.
  if (openWait && Date.now() < openWait.until) {
    const fresh = c.tabs.find((t) => !openWait.known.has(t.id));
    if (fresh) {
      openWait = null;
      if (top() === "computer") openTab(fresh);
    }
  }
  if (watching) {
    currentTab = c.tabs.find((t) => t.id === watching) || null;
    if (!currentTab) {
      toast("该标签页已在电脑上关闭");
      if (top() === "term") history.back();
    } else updateTermBar();
  }
}

function renderTabs() {
  const list = $("tab-list");
  list.textContent = "";
  const tabs = cur.state === "online" ? cur.tabs : [];
  $("tab-empty").classList.toggle("hidden", tabs.length > 0);
  $("tab-empty").textContent = cur.state === "online" ? "电脑上没有打开的标签页" : stateText(cur);
  let lastWindow = null;
  for (const tab of tabs) {
    if (tab.window !== lastWindow && tabs.some((t) => t.window !== tabs[0].window)) {
      list.append(el("li", "group", tab.window === "main" ? "主窗口" : "其它窗口"));
    }
    lastWindow = tab.window;
    const li = el("li", "row-item");
    const main = el("div", "tab-main");
    main.append(el("div", "tab-title", tab.host ? `${tab.title} · ${tab.host}` : tab.title));
    const waits = tab.hostKey ? "🔑 等待确认主机密钥" : tab.auth ? "🔑 等待输入登录信息" : "";
    for (const [cls, text] of [["tab-agent", waits], ["tab-cmd", tab.command ? `▶ ${tab.command}` : ""], ["tab-agent", tab.agent]]) {
      if (text) main.append(el("div", `tab-sub ${cls}`, text));
    }
    const meta = el("span", "muted small", `${tab.cols}×${tab.rows}${tab.active ? " · 当前" : ""}${tab.takenBy === "me" ? " · 我接管" : ""}`);
    li.append(el("span", `dot ${tab.status}`), main, meta);
    if (canClose(tab)) {
      const x = el("button", "icon", "✕");
      x.setAttribute("aria-label", "关闭标签页");
      x.onclick = (ev) => {
        ev.stopPropagation();
        void closeTab(tab);
      };
      li.append(x);
    }
    li.onclick = () => openTab(tab);
    list.append(li);
  }
}

function canClose(tab) {
  return Boolean(cur && !cur.readOnly && !tab.locked && hasFeature("tabs"));
}

/** Close a tab on the computer (asks here; the computer does not ask again). */
async function closeTab(tab) {
  const live = tab.status === "connected" || tab.status === "connecting";
  if (!confirm(`关闭标签页「${tab.title}」？${live ? "连接会断开。" : ""}`)) return;
  try {
    await cur.req("tabs.close", { id: tab.id }, undefined, 15000);
    if (watching !== tab.id) toast("已关闭");
  } catch (e) {
    toast(e.message);
  }
}

// Sessions

let sessions = [];
let openWait = null;

function hasFeature(f) {
  return cur?.features.includes(f);
}

async function loadSessions() {
  const c = cur;
  if (!c) return;
  const empty = $("session-empty");
  if (c.state !== "online") {
    sessions = [];
    renderSessions();
    empty.textContent = stateText(c);
    return;
  }
  if (!hasFeature("sessions")) {
    sessions = [];
    renderSessions();
    empty.textContent = "电脑上的 Nexterm 版本太旧，请更新后再管理会话";
    return;
  }
  try {
    const list = await c.req("sessions.list");
    if (c !== cur) return;
    sessions = list;
    renderSessions();
  } catch (e) {
    toast(e.message);
  }
}

function renderSessions() {
  const list = $("session-list");
  list.textContent = "";
  const q = $("session-filter").value.trim().toLowerCase();
  const shown = sessions.filter((s) => !q || `${s.label} ${s.group} ${s.host} ${s.username}`.toLowerCase().includes(q));
  const empty = $("session-empty");
  empty.classList.toggle("hidden", shown.length > 0);
  empty.textContent = sessions.length ? "没有匹配的会话" : "没有保存的会话";
  const groups = new Map();
  for (const s of shown) {
    const g = s.group || "";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(s);
  }
  const names = [...groups.keys()].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
  for (const g of names) {
    if (g) list.append(el("li", "group", g));
    for (const s of groups.get(g)) {
      const li = el("li", "row-item");
      const main = el("div", "tab-main");
      main.append(el("div", "tab-title", s.label));
      const target = s.host ? `${s.username ? `${s.username}@` : ""}${s.host}${s.port && ![22, 23].includes(s.port) ? `:${s.port}` : ""}` : "";
      main.append(el("div", "tab-sub", [s.protocol.toUpperCase(), target].filter(Boolean).join(" · ")));
      li.append(el("span", "proto", s.protocol.slice(0, 3).toUpperCase()), main);
      li.onclick = () => sessionMenu(s);
      list.append(li);
    }
  }
}
$("session-filter").oninput = renderSessions;

function sessionMenu(s) {
  const items = [{ label: "在电脑上打开", run: () => void openSession(s) }];
  if (!cur.readOnly) {
    if (s.editable) items.push({ label: "编辑", run: () => editSession(s) });
    if (s.editable) items.push({ label: "复制为新会话", run: () => editSession({ ...s, id: "", label: `${s.label} 副本`, hasPassword: false }, true) });
    items.push({
      label: "删除",
      danger: true,
      run: async () => {
        if (!confirm(`删除会话「${s.label}」？`)) return;
        try {
          await cur.req("sessions.delete", { id: s.id });
          toast("已删除");
          void loadSessions();
        } catch (e) {
          toast(e.message);
        }
      },
    });
  }
  sheet(s.editable || cur.readOnly ? s.label : `${s.label}（此协议只能在电脑上编辑）`, items);
}

async function openSession(s) {
  if (cur.readOnly) {
    toast(errorText("read-only"));
    return;
  }
  const known = new Set(cur.tabs.map((t) => t.id));
  try {
    openWait = { known, until: Date.now() + 15000 };
    await cur.req("sessions.open", { id: s.id });
    toast(`正在电脑上打开 ${s.label}…`);
    setPane("tabs");
  } catch (e) {
    openWait = null;
    toast(e.message);
  }
}

// Session form

let editing = null;
const form = $("sf");

function editSession(s, copy = false) {
  editing = s && !copy ? s : null;
  $("sf-title").textContent = editing ? "编辑会话" : "新建会话";
  form.reset();
  const v = s || { protocol: "ssh", port: 22, authType: "password" };
  for (const key of ["label", "group", "protocol", "host", "port", "username", "authType", "privateKeyPath", "startupCommand"]) {
    if (form.elements[key]) form.elements[key].value = v[key] ?? "";
  }
  if (!v.port) form.elements.port.value = "";
  $("sf-pw-hint").textContent = editing?.hasPassword ? "已保存密码，留空则不修改" : "";
  $("sf-clear-row").classList.toggle("hidden", !editing?.hasPassword);
  syncForm();
  go("session-form");
}

function syncForm() {
  const protocol = form.elements.protocol.value;
  const remote = ["ssh", "telnet", "tcp"].includes(protocol);
  const ssh = protocol === "ssh";
  const auth = form.elements.authType.value;
  for (const e of form.querySelectorAll(".remote-only")) e.classList.toggle("hidden", !remote);
  for (const e of form.querySelectorAll(".ssh-only")) e.classList.toggle("hidden", !ssh);
  for (const e of form.querySelectorAll(".auth-password")) e.classList.toggle("hidden", !ssh || auth !== "password" || (e.id === "sf-clear-row" && !editing?.hasPassword));
  for (const e of form.querySelectorAll(".auth-key")) e.classList.toggle("hidden", !ssh || auth !== "privatekey");
}
form.elements.protocol.onchange = () => {
  const p = form.elements.protocol.value;
  const port = form.elements.port;
  if (p === "ssh" && (!port.value || port.value === "23")) port.value = "22";
  if (p === "telnet" && (!port.value || port.value === "22")) port.value = "23";
  syncForm();
};
form.elements.authType.onchange = syncForm;
form.onsubmit = (ev) => {
  ev.preventDefault();
  void saveSession();
};
$("sf-save").onclick = () => void saveSession();

async function saveSession() {
  const f = form.elements;
  const session = {
    id: editing?.id || "",
    label: f.label.value,
    group: f.group.value,
    protocol: f.protocol.value,
    host: f.host.value,
    port: Number(f.port.value) || 0,
    username: f.username.value,
    authType: f.authType.value,
    password: f.password.value,
    clearPassword: f.clearPassword.checked,
    privateKeyPath: f.privateKeyPath.value,
    startupCommand: f.startupCommand.value,
  };
  if (["ssh", "telnet", "tcp"].includes(session.protocol) && !session.host.trim()) {
    toast("请填写主机");
    return;
  }
  try {
    await cur.req("sessions.save", { session });
    toast("已保存");
    history.back();
    void loadSessions();
  } catch (e) {
    toast(e.message);
  }
}
$("session-new").onclick = () => editSession(null);

// ---------- files ----------

function renderFileTargets() {
  const list = $("file-targets");
  list.textContent = "";
  // Older computers do not report the protocol: offer every connected tab.
  const tabs = cur.state === "online" ? cur.tabs.filter((t) => t.status === "connected" && (!t.protocol || t.protocol === "ssh")) : [];
  const empty = $("file-targets-empty");
  empty.classList.toggle("hidden", tabs.length > 0);
  empty.textContent = cur.state !== "online" ? stateText(cur) : !hasFeature("files") ? "电脑上的 Nexterm 版本太旧，请更新后再使用文件管理" : "没有已连接的 SSH 标签页";
  if (!hasFeature("files")) return;
  for (const tab of tabs) {
    const li = el("li", "row-item");
    const main = el("div", "tab-main");
    main.append(el("div", "tab-title", tab.host ? `${tab.title} · ${tab.host}` : tab.title));
    li.append(el("span", "file-icon", "📁"), main);
    li.onclick = () => openFiles(tab);
    list.append(li);
  }
}

let fsPane = null;
let fsPath = "";
let fsEntries = [];
let fsLoading = 0;

async function openFiles(tab) {
  fsPane = tab.id;
  fsPath = "";
  fsEntries = [];
  $("files-title").textContent = tab.title;
  renderFiles();
  go("files");
  await listDir("");
}

async function listDir(path) {
  const c = cur;
  const ticket = ++fsLoading;
  fileStatus("正在读取…");
  try {
    const target = path || (await c.req("fs.home", { pane: fsPane }));
    const listing = await c.req("fs.list", { pane: fsPane, path: target });
    if (ticket !== fsLoading) return;
    fsPath = listing.path;
    fsEntries = listing.entries;
    fileStatus("");
    renderFiles();
  } catch (e) {
    if (ticket !== fsLoading) return;
    fileStatus(e.message);
  }
}

function fileStatus(text) {
  const s = $("file-status");
  s.textContent = text;
  s.classList.toggle("hidden", !text);
}

const isDir = (e) => e.kind === "dir" || e.linkDir;

function renderFiles() {
  $("files-path").value = fsPath;
  const list = $("file-list");
  list.textContent = "";
  const sorted = [...fsEntries].sort((a, b) => Number(isDir(b)) - Number(isDir(a)) || a.name.localeCompare(b.name));
  for (const e of sorted) {
    const li = el("li", "row-item");
    const main = el("div", "tab-main");
    main.append(el("div", "tab-title", e.name));
    const when = e.mtime ? new Date(e.mtime * 1000).toLocaleString() : "";
    main.append(el("div", "tab-sub", [isDir(e) ? "" : formatSize(e.size), when, e.kind === "link" ? `→ ${e.linkTarget || ""}` : ""].filter(Boolean).join(" · ")));
    const more = el("button", "icon", "⋯");
    more.setAttribute("aria-label", "更多");
    more.onclick = (ev) => {
      ev.stopPropagation();
      fileMenu(e);
    };
    li.append(el("span", "file-icon", isDir(e) ? "📁" : e.kind === "link" ? "🔗" : "📄"), main, more);
    li.onclick = () => (isDir(e) ? void listDir(e.path) : fileMenu(e));
    list.append(li);
  }
  if (!sorted.length && !$("file-status").textContent) fileStatus("空文件夹");
}

function formatSize(n) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n;
  let i = -1;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

function parentOf(path) {
  if (!path || path === "/") return "/";
  const p = path.replace(/\/+$/, "");
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

function joinPath(dir, name) {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

function fileMenu(e) {
  const items = [];
  if (isDir(e)) items.push({ label: "打开", run: () => void listDir(e.path) });
  else items.push({ label: "下载到本设备", run: () => void downloadFile(e) });
  if (!cur.readOnly) {
    items.push({
      label: "重命名",
      run: async () => {
        const name = prompt("新名称", e.name)?.trim();
        if (!name || name === e.name) return;
        if (name.includes("/")) return toast("名称不能包含 /");
        await fsOp("fs.rename", { pane: fsPane, path: e.path, to: joinPath(parentOf(e.path), name) });
      },
    });
    items.push({
      label: "删除",
      danger: true,
      run: async () => {
        if (!confirm(`删除${isDir(e) ? "文件夹" : ""}「${e.name}」？${isDir(e) ? "里面的内容也会删除。" : ""}`)) return;
        await fsOp("fs.remove", { pane: fsPane, path: e.path });
      },
    });
  }
  sheet(e.name, items);
}

async function fsOp(op, a) {
  try {
    await cur.req(op, a, undefined, 120000);
    void listDir(fsPath);
  } catch (err) {
    toast(err.message);
  }
}

$("files-up").onclick = () => void listDir(parentOf(fsPath));
$("files-refresh").onclick = () => void listDir(fsPath);
$("files-path").onkeydown = (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    $("files-path").blur();
    void listDir($("files-path").value.trim() || fsPath);
  }
};
$("files-menu").onclick = () => {
  const items = [];
  if (!cur.readOnly) {
    items.push({ label: "从本设备上传文件", run: () => $("upload-input").click() });
    items.push({
      label: "新建文件夹",
      run: async () => {
        const name = prompt("文件夹名称")?.trim();
        if (!name) return;
        if (name.includes("/")) return toast("名称不能包含 /");
        await fsOp("fs.mkdir", { pane: fsPane, path: joinPath(fsPath, name) });
      },
    });
  }
  items.push({ label: "转到主目录", run: () => void listDir("") });
  sheet(fsPath, items);
};

$("upload-input").onchange = async () => {
  const files = [...$("upload-input").files];
  $("upload-input").value = "";
  const c = cur;
  const pane = fsPane;
  const dir = fsPath;
  for (const f of files) {
    if (fsEntries.some((e) => e.name === f.name) && !confirm(`「${f.name}」已存在，覆盖？`)) continue;
    const t = transfer(`⬆ ${f.name}`);
    try {
      await c.upload(pane, dir, f, t);
      t.done("已上传");
      if (cur === c && fsPane === pane && fsPath === dir) void listDir(dir);
    } catch (e) {
      t.done(e.message, true);
    }
  }
};

async function downloadFile(e) {
  const t = transfer(`⬇ ${e.name}`);
  try {
    const blob = await cur.download(fsPane, e.path, t);
    const save = () => saveBlob(blob, e.name);
    t.done("完成 · 点此保存", false, save);
    save();
  } catch (err) {
    t.done(err.message, true);
  }
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = el("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** Progress row in the file screen. */
function transfer(label) {
  const box = $("transfers");
  const row = el("div", "xfer");
  const name = el("div", "xfer-name", label);
  const bar = el("div", "xfer-bar");
  const fill = el("div", "xfer-fill");
  bar.append(fill);
  const info = el("div", "xfer-info muted small", "等待中…");
  const x = el("button", "icon", "×");
  x.setAttribute("aria-label", "取消");
  row.append(name, x, bar, info);
  box.append(row);
  box.classList.remove("hidden");
  const t = {
    cancel: null,
    progress(n, total) {
      const pct = total ? Math.min(100, (n / total) * 100) : 0;
      fill.style.width = `${pct}%`;
      info.textContent = total ? `${formatSize(n)} / ${formatSize(total)}` : formatSize(n);
    },
    done(text, failed = false, action = null) {
      info.textContent = text;
      row.classList.toggle("failed", failed);
      fill.style.width = failed ? fill.style.width : "100%";
      x.onclick = () => {
        row.remove();
        box.classList.toggle("hidden", !box.children.length);
      };
      if (action) {
        info.classList.add("action");
        info.onclick = action;
      } else if (!failed) setTimeout(() => x.onclick(), 4000);
    },
  };
  x.onclick = () => t.cancel?.();
  return t;
}

// ---------- terminal ----------

const term = new window.Terminal({
  allowProposedApi: true,
  fontSize,
  fontFamily: "ui-monospace, Menlo, 'Cascadia Mono', 'Roboto Mono', 'Noto Sans Mono', monospace",
  scrollback: 3000,
  cursorBlink: false,
  theme: { background: "#1b1d23", foreground: "#d6d6d6", cursor: "#f0f0f0", selectionBackground: "#3a4a63" },
});
installWidths(term, window.Unicode11Addon.Unicode11Addon);
term.open($("term-host"));

/** The computer's size; the page scales the font so the columns fit the screen. */
let remoteCols = 80;
let remoteRows = 24;

function onTermMessage(msg) {
  // Ambiguous-width characters as the tab lays them out (before the screen that follows).
  setWideAmbiguous(term, Boolean(msg.wide));
  if (msg.t === "reset") {
    term.reset();
    resizeTerm(msg.cols, msg.rows);
    if (currentTab) currentTab.takenBy = msg.takenBy;
    setTermStatus("");
    updateTermBar();
    userScrolledAt = 0;
  } else if (msg.t === "size") {
    resizeTerm(msg.cols, msg.rows);
  }
}

function resizeTerm(cols, rows) {
  remoteCols = cols;
  remoteRows = rows;
  if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
  layoutTerm();
  updateTermBar();
}

/** The screen is remoteCols wide at the chosen font size; the wrapper scrolls sideways. */
function layoutTerm() {
  if (term.options.fontSize !== fontSize) term.options.fontSize = fontSize;
  const cell = cellSize();
  const host = $("term-host");
  if (cell) {
    host.style.width = `${Math.ceil(cell.width * remoteCols) + 2}px`;
    host.style.height = `${Math.ceil(cell.height * remoteRows) + 2}px`;
  }
}

/**
 * The computer's screen is usually taller and wider than the phone: keep the cursor in view
 * (unless the user scrolled away in the last few seconds to read something).
 */
let userScrolledAt = 0;
let followQueued = false;
function followCursor() {
  if (followQueued || Date.now() - userScrolledAt < 4000) return;
  followQueued = true;
  requestAnimationFrame(() => {
    followQueued = false;
    const cell = cellSize();
    if (!cell) return;
    const wrap = $("term-wrap");
    const b = term.buffer.active;
    // Bottom of the xterm viewport holds the newest line; xterm itself scrolls its scrollback.
    if (b.viewportY !== b.baseY) term.scrollToBottom();
    const y = (b.cursorY + 1) * cell.height;
    const x = b.cursorX * cell.width;
    const topY = Math.max(0, y - wrap.clientHeight * 0.7);
    if (y > wrap.scrollTop + wrap.clientHeight - cell.height || y < wrap.scrollTop + cell.height) wrap.scrollTop = topY;
    if (x > wrap.scrollLeft + wrap.clientWidth - cell.width * 2) wrap.scrollLeft = x - wrap.clientWidth * 0.6;
    else if (x < wrap.scrollLeft) wrap.scrollLeft = Math.max(0, x - wrap.clientWidth * 0.3);
  });
}
const markUserScroll = () => (userScrolledAt = Date.now());
$("term-wrap").addEventListener("touchmove", markUserScroll, { passive: true });
$("term-wrap").addEventListener("wheel", markUserScroll, { passive: true });

function cellSize() {
  const cell = term._core?._renderService?.dimensions?.css?.cell;
  return cell?.width ? cell : null;
}

/** Rows / columns this phone could show at the current font size. */
function phoneGeometry() {
  const wrap = $("term-wrap");
  const cell = cellSize();
  if (!cell) return { cols: 80, rows: 24 };
  return {
    cols: Math.max(20, Math.floor((wrap.clientWidth - 4) / cell.width)),
    rows: Math.max(5, Math.floor((wrap.clientHeight - 4) / cell.height)),
  };
}

function openTab(tab) {
  watching = tab.id;
  currentTab = tab;
  gateRetry = false;
  term.reset();
  resizeTerm(tab.cols, tab.rows);
  setTermStatus("正在加载画面…");
  go("term");
  updateTermBar();
  void cur.sendJson({ t: "sub", id: tab.id });
  requestAnimationFrame(layoutTerm);
}

function leaveTerm() {
  if (cur) {
    if (currentTab?.takenBy === "me") void cur.sendJson({ t: "release", id: watching });
    void cur.sendJson({ t: "sub", id: null });
  }
  watching = null;
  currentTab = null;
  renderGate();
  term.blur();
}

// The desktop asks for a login, a host key decision or a reconnect in dialogs over the
// terminal, which the mirrored screen does not contain: the phone shows its own card.
let gateKey = "";
/** The user chose to enter another password for a failed tab. */
let gateRetry = false;

function gateKind(tab) {
  if (!tab || !cur) return "";
  if (tab.hostKey) return "hostKey";
  if (tab.auth) return "login";
  if (tab.status === "error" || tab.status === "disconnected") return gateRetry && tab.passwordAuth ? "retry" : "failed";
  return "";
}

function renderGate() {
  const box = $("term-gate");
  const tab = currentTab;
  const kind = gateKind(tab);
  if (!kind) gateRetry = false;
  const key = kind && JSON.stringify([tab.id, kind, tab.hostKey, tab.auth, tab.message, cur.readOnly]);
  // Rebuilding would wipe what the user is typing.
  if (key === gateKey) return;
  gateKey = key;
  box.textContent = "";
  box.classList.toggle("hidden", !kind);
  if (!kind) return;
  const card = el("div", "gate-card");
  box.append(card);
  const target = tab.host ? `${tab.title} · ${tab.host}` : tab.title;
  const actions = el("div", "gate-actions");
  const button = (label, cls, run) => {
    const b = el("button", `btn ${cls}`, label);
    b.type = "button";
    b.onclick = run;
    actions.append(b);
    return b;
  };
  const readOnlyNote = () => card.append(el("p", "muted small", "只读模式：请在电脑上操作。"));

  if (kind === "hostKey") {
    const h = tab.hostKey;
    const addr = h.port === 22 ? h.host : `[${h.host}]:${h.port}`;
    card.classList.toggle("danger", h.changed);
    card.append(el("b", h.changed ? "danger-text" : "", h.changed ? "主机密钥已变更！" : "确认主机密钥"));
    card.append(
      el(
        "p",
        "muted small",
        h.changed
          ? `${addr} 的密钥和 known_hosts 里记录的不一样，连接可能被人截获。确认服务器确实更换过密钥再接受。`
          : `第一次连接 ${addr}，请核对服务器的密钥指纹。`
      )
    );
    card.append(el("div", "muted small", h.keyType), el("code", "mono fp", h.fingerprint));
    if (cur.readOnly) return readOnlyNote();
    const answer = (d) => () => {
      for (const b of actions.querySelectorAll("button")) b.disabled = true;
      void cur.sendJson({ t: "hostKey", id: tab.id, d });
    };
    button(h.changed ? "替换并保存" : "接受并保存", h.changed ? "danger" : "", answer("acceptAndSave"));
    button("仅本次接受", "ghost", answer("acceptOnce"));
    button("拒绝", "ghost", answer("reject"));
    card.append(actions);
    return;
  }

  if (kind === "failed") {
    card.append(el("b", "", tab.status === "error" ? "连接失败" : "会话已结束"));
    card.append(el("p", "muted small", tab.message ? `${target}：${tab.message}` : target));
    if (cur.readOnly) return readOnlyNote();
    button("重新连接", "", () => void cur.sendJson({ t: "login", id: tab.id }));
    if (tab.passwordAuth) {
      button("输入密码", "ghost", () => {
        gateRetry = true;
        renderGate();
      });
    }
    card.append(actions);
    return;
  }

  // Login form: what the pane is waiting for, or a new password after a failure.
  const askUser = kind === "login" && tab.auth.user;
  const askPwd = kind === "retry" || tab.auth.password;
  card.append(el("b", "", "SSH 登录"), el("p", "muted small", target));
  if (cur.readOnly) return readOnlyNote();
  const form = el("form", "form");
  form.autocomplete = "off";
  const field = (label, type, value) => {
    const row = el("label", "", label);
    const input = el("input");
    input.type = type;
    input.value = value || "";
    input.autocapitalize = "off";
    input.spellcheck = false;
    if (type === "password") input.autocomplete = "off";
    row.append(input);
    form.append(row);
    return input;
  };
  const user = askUser ? field("用户名", "text", tab.auth.username) : null;
  const pwd = askPwd ? field("密码", "password", "") : null;
  const remember = el("input");
  remember.type = "checkbox";
  remember.checked = true;
  const rememberRow = el("label", "check");
  rememberRow.append(remember, document.createTextNode(askPwd ? " 记住密码" : " 记住用户名"));
  form.append(rememberRow);
  const submit = el("button", "btn", "连接");
  submit.type = "submit";
  form.append(submit);
  if (kind === "retry") {
    const back = el("button", "btn ghost", "取消");
    back.type = "button";
    back.onclick = () => {
      gateRetry = false;
      renderGate();
    };
    form.append(back);
  }
  form.onsubmit = (ev) => {
    ev.preventDefault();
    if (user && !user.value.trim()) return user.focus();
    submit.disabled = true;
    submit.textContent = "正在连接…";
    void cur.sendJson({
      t: "login",
      id: tab.id,
      user: user ? user.value.trim() : null,
      pwd: pwd ? pwd.value : null,
      remember: remember.checked,
    });
  };
  card.append(form);
  (user || pwd)?.focus();
}

let statusText = "";
function setTermStatus(text) {
  statusText = text;
  updateTermBar();
}

function updateTermBar() {
  renderGate();
  if (!currentTab || !cur) return;
  $("term-title").textContent = currentTab.title;
  $("term-size").textContent = statusText || `${remoteCols}×${remoteRows}`;
  const take = $("take");
  take.classList.toggle("hidden", cur.readOnly);
  take.classList.toggle("on", currentTab.takenBy === "me");
  take.textContent = currentTab.takenBy === "me" ? "还给电脑" : "接管尺寸";
  $("term-close").classList.toggle("hidden", !canClose(currentTab));
  $("keys").classList.toggle("hidden", cur.readOnly);
}

function send(data) {
  if (!watching || !cur || cur.readOnly || !data) return;
  // Typing brings the cursor back into view.
  userScrolledAt = 0;
  void cur.sendJson({ t: "in", id: watching, d: data });
}

/** Apply the sticky Ctrl / Alt keys of the toolbar to typed text. */
function withMods(data) {
  if (!ctrl && !alt) return data;
  let out = data;
  if (ctrl && out.length === 1) {
    const c = out.toUpperCase().charCodeAt(0);
    if (c >= 64 && c <= 95) out = String.fromCharCode(c - 64);
    else if (out === " ") out = "\x00";
  }
  if (alt) out = "\x1b" + out;
  setMods(false, false);
  return out;
}

function setMods(c, a) {
  ctrl = c;
  alt = a;
  for (const b of document.querySelectorAll("#keys .mod")) {
    b.classList.toggle("on", (b.dataset.mod === "ctrl" && ctrl) || (b.dataset.mod === "alt" && alt));
  }
}

term.onData((data) => send(withMods(data)));

const KEYS = {
  esc: "\x1b",
  tab: "\t",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  home: "\x1b[H",
  end: "\x1b[F",
  pgup: "\x1b[5~",
  pgdn: "\x1b[6~",
  "ctrl-c": "\x03",
  "ctrl-d": "\x04",
  "ctrl-z": "\x1a",
};

$("keys").addEventListener("click", async (ev) => {
  const b = ev.target.closest("button");
  if (!b) return;
  ev.preventDefault();
  if (b.dataset.mod === "ctrl") return setMods(!ctrl, alt);
  if (b.dataset.mod === "alt") return setMods(ctrl, !alt);
  const key = b.dataset.key;
  if (key === "kbd") {
    term.focus();
    return;
  }
  if (key === "paste") {
    try {
      const text = await navigator.clipboard.readText();
      if (text) send(term.modes.bracketedPasteMode ? `\x1b[200~${text}\x1b[201~` : text);
    } catch {
      toast("无法读取剪贴板");
    }
    return;
  }
  let seq = KEYS[key] ?? key;
  // Application cursor mode (vim, less ...) uses SS3 arrows.
  if (term.modes.applicationCursorKeysMode && /^\x1b\[[ABCDHF]$/.test(seq)) seq = "\x1bO" + seq[2];
  if (alt && seq.length >= 1) seq = (seq.startsWith("\x1b") ? "" : "\x1b") + seq;
  if (ctrl && seq.length === 1) seq = withMods(seq);
  else setMods(false, false);
  send(seq);
});
// Keep the soft keyboard open when tapping toolbar keys.
$("keys").addEventListener("mousedown", (ev) => ev.preventDefault());

$("term-close").onclick = () => {
  if (currentTab) void closeTab(currentTab);
};
$("take").onclick = () => {
  if (!currentTab || !cur) return;
  if (currentTab.takenBy === "me") {
    void cur.sendJson({ t: "release", id: watching });
  } else {
    const g = phoneGeometry();
    void cur.sendJson({ t: "take", id: watching, cols: g.cols, rows: g.rows });
  }
};

function setFont(size) {
  fontSize = Math.max(7, Math.min(24, size));
  localStorage.setItem("wtn-font", String(fontSize));
  layoutTerm();
  // Holding the size: follow the new font.
  if (currentTab?.takenBy === "me") {
    const g = phoneGeometry();
    void cur.sendJson({ t: "take", id: watching, cols: g.cols, rows: g.rows });
  }
}
$("font-up").onclick = () => setFont(fontSize + 1);
$("font-down").onclick = () => setFont(fontSize - 1);

let resizeTimer = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    layoutTerm();
    if (currentTab?.takenBy === "me") {
      const g = phoneGeometry();
      if (g.cols !== remoteCols || g.rows !== remoteRows) void cur.sendJson({ t: "take", id: watching, cols: g.cols, rows: g.rows });
    }
  }, 200);
});

// ---------- lifecycle ----------

// The OS may freeze sockets in the background: reconnect when the page returns.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  for (const c of computers) {
    if (c.state === "kicked" || c.state === "badkey") continue;
    if (!c.ws || c.ws.readyState > WebSocket.OPEN) {
      c.backoff = 1000;
      c.connect();
    }
  }
});

/** A pairing link opened on this page (QR code scanned): add that computer. */
function takeFragment() {
  const p = readFragment(location.hash);
  if (!p) return null;
  // Do not leave the key in the address bar / history.
  history.replaceState(null, "", location.pathname + location.search);
  return addPairing(p, new URL(".", location.href).href);
}

window.addEventListener("hashchange", () => {
  const c = takeFragment();
  if (c) void resetNav().then(() => openComputer(c));
});

// Keep-alive at the app level (some proxies drop idle WebSockets).
setInterval(() => {
  for (const c of computers) if (c.state === "online") void c.sendJson({ t: "ping" });
}, 30000);

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

const scanned = takeFragment();
stack.push(computers.length ? "home" : "gate");
history.replaceState({ depth: 1 }, "");
for (const c of computers) if (c !== scanned) c.connect();
void resetNav();
if (scanned || computers.length === 1) openComputer(scanned || computers[0]);

// Exposed for the end-to-end test.
window.__wtn = {
  term,
  get current() {
    return watching;
  },
  get computers() {
    return computers;
  },
  b64urlEncode,
};
