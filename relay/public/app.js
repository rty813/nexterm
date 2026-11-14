// Phone page: lists the computer's tabs, mirrors one of them, sends input.
// Every frame past the relay is end-to-end encrypted (crypto.js).
import { b64urlDecode, b64urlEncode, roomId, Session, HELLO, ACCEPT, concat } from "./crypto.js";

const P_JSON = 1;
const P_OUTPUT = 2;
const STORE = "nexterm-pairing";

const $ = (id) => document.getElementById(id);
const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------- pairing ----------

/** From the QR code's fragment (#k=<secret>&n=<computer name>); kept on this phone only. */
function readFragment(hash) {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const k = params.get("k");
  if (!k) return null;
  try {
    const secret = b64urlDecode(k);
    if (secret.length !== 32) return null;
    return { k, name: params.get("n") || "" };
  } catch {
    return null;
  }
}

function loadPairing() {
  const fromUrl = readFragment(location.hash);
  if (fromUrl) {
    localStorage.setItem(STORE, JSON.stringify(fromUrl));
    // Do not leave the key in the address bar / history.
    history.replaceState(null, "", location.pathname + location.search);
    return fromUrl;
  }
  try {
    return JSON.parse(localStorage.getItem(STORE) || "null");
  } catch {
    return null;
  }
}

// ---------- state ----------

let pairing = loadPairing();
let ws = null;
let session = null;
/** Frames are decrypted strictly in arrival order. */
let inbox = Promise.resolve();
let outbox = Promise.resolve();
let clientNonce = null;
let reconnectTimer = 0;
let backoff = 1000;
let tabs = [];
let readOnly = false;
let current = null; // pane id being watched
let currentTab = null;
let fontSize = Number(localStorage.getItem("wtn-font") || 13);
let ctrl = false;
let alt = false;

// ---------- screens ----------

function show(id) {
  for (const s of document.querySelectorAll(".screen")) s.classList.toggle("hidden", s.id !== id);
}

function gate(text, { pair = false, retry = false } = {}) {
  show("gate");
  $("gate-text").textContent = text;
  $("gate-pair").classList.toggle("hidden", !pair);
  $("gate-retry").classList.toggle("hidden", !retry);
  $("gate-forget").classList.toggle("hidden", !pairing || pair);
}

let toastTimer = 0;
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2500);
}

// ---------- connection ----------

function wsUrl(room) {
  const base = new URL("ws", location.href);
  base.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  base.searchParams.set("role", "client");
  base.searchParams.set("room", room);
  return base.href;
}

async function connect() {
  clearTimeout(reconnectTimer);
  if (!pairing) {
    gate("这台手机还没有配对。", { pair: true });
    return;
  }
  if (!crypto.subtle) {
    gate("浏览器不支持加密（需要 HTTPS 访问中继服务器）。");
    return;
  }
  const secret = b64urlDecode(pairing.k);
  const room = await roomId(secret);
  if (ws) {
    ws.onclose = null;
    ws.close();
  }
  session = null;
  if (!current) gate(`正在连接 ${pairing.name || "电脑"}…`);
  const sock = new WebSocket(wsUrl(room));
  sock.binaryType = "arraybuffer";
  ws = sock;
  sock.onopen = () => {
    backoff = 1000;
    // If the computer is online the relay already told it we joined.
    startHandshake();
  };
  sock.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      onRelayNotice(JSON.parse(ev.data));
      return;
    }
    const frame = new Uint8Array(ev.data);
    inbox = inbox.then(() => onFrame(secret, frame)).catch((e) => console.error(e));
  };
  sock.onclose = (ev) => {
    if (ws !== sock) return;
    session = null;
    if (ev.code === 4003) {
      gate("已被电脑断开。", { retry: true });
      return;
    }
    scheduleReconnect(current ? "连接中断，正在重连…" : "连接中断，正在重连…");
  };
}

function scheduleReconnect(text) {
  if (current) setTermStatus(text);
  else gate(text, { retry: true });
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, backoff);
  backoff = Math.min(backoff * 2, 15000);
}

function startHandshake() {
  clientNonce = crypto.getRandomValues(new Uint8Array(16));
  session = null;
  ws.send(concat(new Uint8Array([HELLO]), clientNonce));
}

function onRelayNotice(msg) {
  if (msg.t === "host-down") {
    session = null;
    if (current) setTermStatus("电脑离线，等待重新上线…");
    else gate(`${pairing?.name || "电脑"} 当前不在线。请确认 Nexterm 已开启手机远程。`, { retry: true });
  } else if (msg.t === "host-up") {
    startHandshake();
  }
}

async function onFrame(secret, frame) {
  if (!session) {
    if (frame[0] === ACCEPT && frame.length === 17 && clientNonce) {
      session = await Session.create(secret, clientNonce, frame.subarray(1));
      await sendJson({ t: "hi", name: deviceName() });
    }
    return;
  }
  const plain = await session.open(frame);
  if (!plain) {
    // Wrong key (the computer regenerated it) or a tampered frame.
    ws.close();
    gate("无法解密：配对已失效，请在电脑上重新扫码配对。", { pair: true });
    return;
  }
  if (plain[0] === P_JSON) onMessage(JSON.parse(dec.decode(plain.subarray(1))));
  else if (plain[0] === P_OUTPUT) {
    const len = plain[1];
    const id = dec.decode(plain.subarray(2, 2 + len));
    if (id === current) term.write(plain.subarray(2 + len), followCursor);
  }
}

function sendJson(msg) {
  if (!session || !ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve();
  const s = session;
  const sock = ws;
  const body = concat(new Uint8Array([P_JSON]), enc.encode(JSON.stringify(msg)));
  // Seal in call order: sequence numbers must reach the computer in order.
  outbox = outbox.then(async () => {
    if (s !== session) return;
    const frame = await s.seal(body);
    if (sock.readyState === WebSocket.OPEN) sock.send(frame);
  });
  return outbox;
}

function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  const m = ua.match(/Android [\d.]+; ([^;)]+)/);
  if (m) return m[1].replace(/ Build.*$/, "").trim();
  if (/Android/.test(ua)) return "Android";
  return "Browser";
}

// ---------- messages ----------

function onMessage(msg) {
  switch (msg.t) {
    case "hello":
      readOnly = msg.readOnly;
      $("computer").textContent = msg.computer || pairing.name || "电脑";
      if (msg.computer && pairing.name !== msg.computer) {
        pairing.name = msg.computer;
        localStorage.setItem(STORE, JSON.stringify(pairing));
      }
      // Resume the tab we were on after a reconnect.
      if (current) void sendJson({ t: "sub", id: current });
      else show("tabs");
      break;
    case "tabs":
      tabs = msg.tabs;
      readOnly = msg.readOnly;
      $("ro-badge").classList.toggle("hidden", !readOnly);
      renderTabs();
      if (current) {
        currentTab = tabs.find((t) => t.id === current) || null;
        if (!currentTab) {
          toast("该标签页已在电脑上关闭");
          leaveTerm();
        } else updateTermBar();
      }
      break;
    case "reset":
      if (msg.id !== current) return;
      term.reset();
      resizeTerm(msg.cols, msg.rows);
      if (currentTab) currentTab.takenBy = msg.takenBy;
      setTermStatus("");
      updateTermBar();
      userScrolledAt = 0;
      break;
    case "size":
      if (msg.id === current) resizeTerm(msg.cols, msg.rows);
      break;
    case "error":
      if (msg.code === "too-many") gate("连接的手机太多了。", { retry: true });
      break;
  }
}

// ---------- tab list ----------

function renderTabs() {
  const list = $("tab-list");
  list.textContent = "";
  $("tab-empty").classList.toggle("hidden", tabs.length > 0);
  let lastWindow = null;
  for (const tab of tabs) {
    if (tab.window !== lastWindow && tabs.some((t) => t.window !== tabs[0].window)) {
      const h = document.createElement("li");
      h.className = "group";
      h.textContent = tab.window === "main" ? "主窗口" : "其它窗口";
      list.append(h);
    }
    lastWindow = tab.window;
    const li = document.createElement("li");
    li.className = "tab";
    const dot = document.createElement("span");
    dot.className = `dot ${tab.status}`;
    const main = document.createElement("div");
    main.className = "tab-main";
    const title = document.createElement("div");
    title.className = "tab-title";
    title.textContent = tab.host ? `${tab.title} · ${tab.host}` : tab.title;
    main.append(title);
    for (const [cls, text] of [["tab-cmd", tab.command ? `▶ ${tab.command}` : ""], ["tab-agent", tab.agent]]) {
      if (!text) continue;
      const line = document.createElement("div");
      line.className = `tab-sub ${cls}`;
      line.textContent = text;
      main.append(line);
    }
    const meta = document.createElement("span");
    meta.className = "muted small";
    meta.textContent = `${tab.cols}×${tab.rows}${tab.active ? " · 当前" : ""}${tab.takenBy === "me" ? " · 我接管" : ""}`;
    li.append(dot, main, meta);
    li.onclick = () => openTab(tab);
    list.append(li);
  }
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
term.loadAddon(new window.Unicode11Addon.Unicode11Addon());
term.unicode.activeVersion = "11";
term.open($("term-host"));

/** The computer's size; the page scales the font so the columns fit the screen. */
let remoteCols = 80;
let remoteRows = 24;

function resizeTerm(cols, rows) {
  remoteCols = cols;
  remoteRows = rows;
  if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
  layoutTerm();
  updateTermBar();
}

/** Fit the computer's columns to the screen width (pinch-free), within readable limits. */
function layoutTerm() {
  if (term.options.fontSize !== fontSize) term.options.fontSize = fontSize;
  // The screen is remoteCols wide at the chosen font size; the wrapper scrolls sideways.
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
    const top = Math.max(0, y - wrap.clientHeight * 0.7);
    if (y > wrap.scrollTop + wrap.clientHeight - cell.height || y < wrap.scrollTop + cell.height) wrap.scrollTop = top;
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
  current = tab.id;
  currentTab = tab;
  term.reset();
  resizeTerm(tab.cols, tab.rows);
  setTermStatus("正在加载画面…");
  show("term");
  updateTermBar();
  void sendJson({ t: "sub", id: tab.id });
  history.pushState({ tab: tab.id }, "");
  requestAnimationFrame(layoutTerm);
}

function leaveTerm() {
  if (currentTab?.takenBy === "me") void sendJson({ t: "release", id: current });
  current = null;
  currentTab = null;
  void sendJson({ t: "sub", id: null });
  term.blur();
  show("tabs");
}

let statusText = "";
function setTermStatus(text) {
  statusText = text;
  updateTermBar();
}

function updateTermBar() {
  if (!currentTab) return;
  $("term-title").textContent = currentTab.title;
  $("term-size").textContent = statusText || `${remoteCols}×${remoteRows}`;
  const take = $("take");
  take.classList.toggle("hidden", readOnly);
  take.classList.toggle("on", currentTab.takenBy === "me");
  take.textContent = currentTab.takenBy === "me" ? "还给电脑" : "接管尺寸";
  $("keys").classList.toggle("hidden", readOnly);
}

function send(data) {
  if (!current || readOnly || !data) return;
  // Typing brings the cursor back into view.
  userScrolledAt = 0;
  void sendJson({ t: "in", id: current, d: data });
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

$("take").onclick = () => {
  if (!currentTab) return;
  if (currentTab.takenBy === "me") {
    void sendJson({ t: "release", id: current });
  } else {
    const g = phoneGeometry();
    void sendJson({ t: "take", id: current, cols: g.cols, rows: g.rows });
  }
};

function setFont(size) {
  fontSize = Math.max(7, Math.min(24, size));
  localStorage.setItem("wtn-font", String(fontSize));
  layoutTerm();
  // Holding the size: follow the new font.
  if (currentTab?.takenBy === "me") {
    const g = phoneGeometry();
    void sendJson({ t: "take", id: current, cols: g.cols, rows: g.rows });
  }
}
$("font-up").onclick = () => setFont(fontSize + 1);
$("font-down").onclick = () => setFont(fontSize - 1);

$("back").onclick = () => history.back();
window.addEventListener("popstate", () => {
  if (current) leaveTerm();
});

let resizeTimer = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    layoutTerm();
    if (currentTab?.takenBy === "me") {
      const g = phoneGeometry();
      if (g.cols !== remoteCols || g.rows !== remoteRows) void sendJson({ t: "take", id: current, cols: g.cols, rows: g.rows });
    }
  }, 200);
});

// The OS may freeze the socket in the background: reconnect when the page returns.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && (!ws || ws.readyState > WebSocket.OPEN)) connect();
});

// ---------- gate / menu ----------

function forget() {
  localStorage.removeItem(STORE);
  pairing = null;
  current = null;
  if (ws) {
    ws.onclose = null;
    ws.close();
  }
  gate("已忘记这台电脑。", { pair: true });
}

$("gate-retry").onclick = () => connect();
$("gate-forget").onclick = forget;
$("pair-go").onclick = () => {
  const text = $("pair-input").value.trim();
  const p = readFragment(text.includes("#") ? text.slice(text.indexOf("#")) : text);
  if (!p) {
    toast("链接无效");
    return;
  }
  pairing = p;
  localStorage.setItem(STORE, JSON.stringify(p));
  connect();
};
$("menu-btn").onclick = () => $("sheet").classList.remove("hidden");
$("sheet-close").onclick = () => $("sheet").classList.add("hidden");
$("sheet").onclick = (ev) => {
  if (ev.target.id === "sheet") $("sheet").classList.add("hidden");
};
$("sheet-forget").onclick = () => {
  $("sheet").classList.add("hidden");
  if (confirm("忘记这台电脑？之后需要重新扫码配对。")) forget();
};

window.addEventListener("hashchange", () => {
  const p = readFragment(location.hash);
  if (p) {
    pairing = loadPairing();
    connect();
  }
});

// Keep-alive at the app level (some proxies drop idle WebSockets).
setInterval(() => void sendJson({ t: "ping" }), 30000);

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

connect();

// Exposed for the end-to-end test.
window.__wtn = { term, get current() { return current; }, b64urlEncode };
