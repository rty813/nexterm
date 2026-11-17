// Session share page: one terminal someone shared from Nexterm (src-tauri/src/share.rs).
// The link's fragment holds the share's key (#k=<secret>&n=<title>&c=<computer>); the
// relay only sees the room derived from it. Read-only until the computer grants control;
// the viewer with control may also fit the terminal to its window ("take over size").
import { b64urlDecode, roomId, Session, HELLO, ACCEPT, concat } from "./crypto.js";
import { deviceName } from "./device.js";

const P_JSON = 1;
const P_OUTPUT = 2;
const NAME_KEY = "nexterm-share-name";

const $ = (id) => document.getElementById(id);
const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------- text ----------

const ZH = /^zh\b/i.test(navigator.language || "");
const T = ZH
  ? {
      invite: (title, computer) => `${computer ? `${computer} ` : ""}邀请你查看终端「${title}」`,
      name: "你的名字（对方会看到）",
      join: "加入",
      connecting: "正在连接…",
      offline: "分享者暂时不在线，正在等待…",
      waiting: "正在等待对方同意你加入…",
      loading: "正在加载画面…",
      readOnly: "只读",
      typing: "可操作",
      ask: "申请控制",
      asking: "等待同意…",
      giveBack: "交还控制",
      otherTyping: "其他访客正在操作",
      granted: "对方已允许你操作此终端",
      revoked: "控制权已收回",
      take: "接管尺寸",
      giveSize: "还给电脑",
      takeTip: "把电脑上这个终端改成本窗口的行列数",
      ended: {
        stopped: "分享已结束",
        expired: "分享链接已过期",
        closed: "对方已关闭这个终端",
        kicked: "你已被移出分享",
        denied: "对方拒绝了你的加入",
        full: "观看人数已满",
        used: "这是单人链接，已有人使用",
        badkey: "链接无效或已失效",
        gone: "链接无效或已失效",
      },
      noCrypto: "浏览器不支持加密（需要通过 HTTPS 打开链接）",
      badLink: "链接不完整，请向分享者重新索取。",
      e2e: "端到端加密 · 中继服务器看不到内容",
      ended2: "可以关闭这个页面了。",
      status: { connected: "", connecting: "正在连接", disconnected: "已断开", error: "连接失败" },
    }
  : {
      invite: (title, computer) => `${computer ? `${computer} invites` : "You are invited"} you to watch the terminal "${title}"`,
      name: "Your name (they will see it)",
      join: "Join",
      connecting: "Connecting…",
      offline: "The sharer is offline, waiting…",
      waiting: "Waiting for them to let you in…",
      loading: "Loading the screen…",
      readOnly: "Read-only",
      typing: "Can type",
      ask: "Ask for control",
      asking: "Waiting…",
      giveBack: "Give back control",
      otherTyping: "Another viewer is typing",
      granted: "You may type in this terminal now",
      revoked: "Control was taken back",
      take: "Take over size",
      giveSize: "Give size back",
      takeTip: "Resize the terminal on the computer to fit this window",
      ended: {
        stopped: "The share has ended",
        expired: "The share link has expired",
        closed: "The terminal was closed",
        kicked: "You were removed from the share",
        denied: "They did not let you in",
        full: "Too many viewers",
        used: "This single-viewer link is already in use",
        badkey: "The link is invalid or no longer works",
        gone: "The link is invalid or no longer works",
      },
      noCrypto: "This browser offers no encryption here (open the link over HTTPS)",
      badLink: "The link is incomplete: ask the sharer for it again.",
      e2e: "End-to-end encrypted · the relay cannot see the content",
      ended2: "You can close this page.",
      status: { connected: "", connecting: "connecting", disconnected: "disconnected", error: "failed" },
    };
document.documentElement.lang = ZH ? "zh-CN" : "en";

// ---------- link ----------

function readLink() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  const k = params.get("k");
  try {
    if (!k || b64urlDecode(k).length !== 32) return null;
  } catch {
    return null;
  }
  return { secret: b64urlDecode(k), title: params.get("n") || "Nexterm", computer: params.get("c") || "" };
}

const link = readLink();

// ---------- screens ----------

function showGate({ title, text, join = false, note = "" }) {
  $("term").classList.add("hidden");
  $("gate").classList.remove("hidden");
  $("gate-title").textContent = title ?? link?.title ?? "Nexterm";
  $("gate-text").textContent = text || "";
  $("join-form").classList.toggle("hidden", !join);
  $("gate-note").textContent = note;
}

function showTerm() {
  $("gate").classList.add("hidden");
  $("term").classList.remove("hidden");
  requestAnimationFrame(layoutTerm);
}

let toastTimer = 0;
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2500);
}

// ---------- terminal ----------

let fontSize = Number(localStorage.getItem("nexterm-share-font")) || 0;
const term = new window.Terminal({
  allowProposedApi: true,
  fontSize: fontSize || 14,
  fontFamily: "ui-monospace, Menlo, 'Cascadia Mono', 'Roboto Mono', 'Noto Sans Mono', monospace",
  scrollback: 5000,
  cursorBlink: false,
  disableStdin: true,
  theme: { background: "#1b1d23", foreground: "#d6d6d6", cursor: "#f0f0f0", selectionBackground: "#3a4a63" },
});
term.loadAddon(new window.Unicode11Addon.Unicode11Addon());
term.unicode.activeVersion = "11";
term.open($("term-host"));

let cols = 80;
let rows = 24;

function cellSize() {
  const cell = term._core?._renderService?.dimensions?.css?.cell;
  return cell?.width ? cell : null;
}

/** Font that fits the computer's columns into the window (until the user picks one). */
function fitFont() {
  if (fontSize) return fontSize;
  // Holding the size: the columns follow the font, not the other way round.
  if (holdingSize) return term.options.fontSize;
  const cell = cellSize();
  const wrap = $("term-wrap");
  if (!cell || !wrap.clientWidth) return term.options.fontSize;
  const per = cell.width / term.options.fontSize;
  return Math.max(7, Math.min(16, Math.floor((wrap.clientWidth - 6) / (cols * per))));
}

function layoutTerm() {
  const want = fitFont();
  if (term.options.fontSize !== want) term.options.fontSize = want;
  const cell = cellSize();
  const host = $("term-host");
  if (cell) {
    host.style.width = `${Math.ceil(cell.width * cols) + 2}px`;
    host.style.height = `${Math.ceil(cell.height * rows) + 2}px`;
  }
}

function resizeTerm(c, r) {
  cols = c;
  rows = r;
  if (term.cols !== c || term.rows !== r) term.resize(c, r);
  layoutTerm();
}

function setFont(size) {
  fontSize = Math.max(7, Math.min(24, size));
  localStorage.setItem("nexterm-share-font", String(fontSize));
  layoutTerm();
  if (holdingSize) takeSize();
}
$("font-up").onclick = () => setFont((fontSize || term.options.fontSize) + 1);
$("font-down").onclick = () => setFont((fontSize || term.options.fontSize) - 1);
let resizeTimer = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    layoutTerm();
    if (holdingSize) {
      const g = geometry();
      if (g.cols !== cols || g.rows !== rows) takeSize();
    }
  }, 150);
});

/** Rows / columns this window shows at the current font size. */
function geometry() {
  const wrap = $("term-wrap");
  const cell = cellSize();
  if (!cell) return { cols: 80, rows: 24 };
  return {
    cols: Math.max(20, Math.floor((wrap.clientWidth - 4) / cell.width)),
    rows: Math.max(5, Math.floor((wrap.clientHeight - 4) / cell.height)),
  };
}

function takeSize() {
  const g = geometry();
  void sendJson({ t: "take", cols: g.cols, rows: g.rows });
}

/** Keep the cursor in view when the screen is larger than the window. */
let followQueued = false;
let scrolledAt = 0;
function followCursor() {
  if (followQueued || Date.now() - scrolledAt < 4000) return;
  followQueued = true;
  requestAnimationFrame(() => {
    followQueued = false;
    const cell = cellSize();
    if (!cell) return;
    const wrap = $("term-wrap");
    const b = term.buffer.active;
    if (b.viewportY !== b.baseY) term.scrollToBottom();
    const y = (b.cursorY + 1) * cell.height;
    const x = b.cursorX * cell.width;
    if (y > wrap.scrollTop + wrap.clientHeight - cell.height || y < wrap.scrollTop + cell.height) {
      wrap.scrollTop = Math.max(0, y - wrap.clientHeight * 0.7);
    }
    if (x > wrap.scrollLeft + wrap.clientWidth - cell.width * 2) wrap.scrollLeft = x - wrap.clientWidth * 0.6;
    else if (x < wrap.scrollLeft) wrap.scrollLeft = Math.max(0, x - wrap.clientWidth * 0.3);
  });
}
const markScroll = () => (scrolledAt = Date.now());
$("term-wrap").addEventListener("touchmove", markScroll, { passive: true });
$("term-wrap").addEventListener("wheel", markScroll, { passive: true });

// ---------- control ----------

/** null | "me" | "other" */
let control = null;
let asking = false;
/** The computer resized the terminal to this window (only while having control). */
let holdingSize = false;
let tabTitle = link?.title ?? "";
let tabStatus = "connected";

function renderBar() {
  $("term-title").textContent = tabTitle;
  const st = T.status[tabStatus] ?? tabStatus;
  $("term-state").textContent = online ? `${cols}×${rows}${st ? ` · ${st}` : ""}` : T.offline;
  const badge = $("ro-badge");
  badge.textContent = control === "me" ? T.typing : T.readOnly;
  badge.classList.toggle("typing", control === "me");
  const btn = $("control");
  btn.textContent = control === "me" ? T.giveBack : asking ? T.asking : control === "other" ? T.otherTyping : T.ask;
  btn.disabled = asking || control === "other";
  btn.classList.toggle("on", control === "me");
  btn.classList.toggle("asking", asking);
  const take = $("take");
  take.classList.toggle("hidden", control !== "me");
  take.classList.toggle("on", holdingSize);
  take.textContent = holdingSize ? T.giveSize : T.take;
  take.title = T.takeTip;
  $("keys").classList.toggle("hidden", control !== "me");
  term.options.disableStdin = control !== "me";
}

$("take").onclick = () => {
  if (control !== "me") return;
  if (holdingSize) void sendJson({ t: "release" });
  else takeSize();
};

$("control").onclick = () => {
  if (control === "me") void sendJson({ t: "drop" });
  else if (!asking && control !== "other") void sendJson({ t: "ask" });
};

function send(data) {
  if (control !== "me" || !data) return;
  scrolledAt = 0;
  void sendJson({ t: "in", d: data });
}

let ctrl = false;
let alt = false;
function setMods(c, a) {
  ctrl = c;
  alt = a;
  for (const b of document.querySelectorAll("#keys .mod")) {
    b.classList.toggle("on", (b.dataset.mod === "ctrl" && ctrl) || (b.dataset.mod === "alt" && alt));
  }
}
function withMods(data) {
  if (!ctrl && !alt) return data;
  let out = data;
  if (ctrl && out.length === 1) {
    const c = out.toUpperCase().charCodeAt(0);
    if (c >= 64 && c <= 95) out = String.fromCharCode(c - 64);
  }
  if (alt) out = "\x1b" + out;
  setMods(false, false);
  return out;
}
term.onData((data) => send(withMods(data)));

const KEYS = {
  esc: "\x1b",
  tab: "\t",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  pgup: "\x1b[5~",
  pgdn: "\x1b[6~",
  "ctrl-c": "\x03",
  "ctrl-d": "\x04",
};
$("keys").addEventListener("click", (ev) => {
  const b = ev.target.closest("button");
  if (!b) return;
  ev.preventDefault();
  if (b.dataset.mod === "ctrl") return setMods(!ctrl, alt);
  if (b.dataset.mod === "alt") return setMods(ctrl, !alt);
  if (b.dataset.key === "kbd") return term.focus();
  let seq = KEYS[b.dataset.key] ?? b.dataset.key;
  if (term.modes.applicationCursorKeysMode && /^\x1b\[[ABCD]$/.test(seq)) seq = "\x1bO" + seq[2];
  send(withMods(seq));
});
$("keys").addEventListener("mousedown", (ev) => ev.preventDefault());

// ---------- link to the computer ----------

let ws = null;
let session = null;
let clientNonce = null;
let inbox = Promise.resolve();
let outbox = Promise.resolve();
let online = false;
let joined = false;
let ended = false;
let backoff = 1000;
let retryTimer = 0;
let myName = "";
/** Lets this viewer back in after a dropped connection without asking again. */
let tokenKey = "";

function sendJson(msg) {
  if (!session || !ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve(false);
  const s = session;
  const sock = ws;
  const body = concat(new Uint8Array([P_JSON]), enc.encode(JSON.stringify(msg)));
  outbox = outbox.then(async () => {
    if (s !== session) return false;
    const frame = await s.seal(body);
    if (sock.readyState !== WebSocket.OPEN) return false;
    sock.send(frame);
    return true;
  });
  return outbox;
}

function end(reason) {
  ended = true;
  online = false;
  clearTimeout(retryTimer);
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  session = null;
  showGate({ title: tabTitle || link?.title, text: T.ended[reason] ?? T.ended.stopped, note: T.ended2 });
}

function setCover(text) {
  $("term-cover").classList.toggle("hidden", !text);
  $("cover-text").textContent = text || "";
}

async function connect() {
  clearTimeout(retryTimer);
  const room = await roomId(link.secret);
  const url = new URL("ws", location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("role", "client");
  url.searchParams.set("room", room);
  tokenKey = `nexterm-share-token-${room}`;
  const sock = new WebSocket(url.href);
  sock.binaryType = "arraybuffer";
  ws = sock;
  sock.onopen = () => {
    backoff = 1000;
    handshake();
  };
  sock.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      const notice = JSON.parse(ev.data);
      if (notice.t === "host-down") {
        session = null;
        online = false;
        holdingSize = false;
        // Nobody serves this room: the share is gone (or its computer is reconnecting).
        if (joined) {
          setCover(T.offline);
          renderBar();
        } else showGate({ text: T.offline, note: T.e2e });
      } else if (notice.t === "host-up") handshake();
      return;
    }
    const frame = new Uint8Array(ev.data);
    inbox = inbox.then(() => onFrame(frame)).catch((e) => console.error(e));
  };
  sock.onclose = (ev) => {
    if (ws !== sock) return;
    ws = null;
    session = null;
    online = false;
    // The computer gives the size back when the link drops.
    holdingSize = false;
    control = null;
    if (ended) return;
    // Sent away by the computer without a reason we could read.
    if (ev.code === 4003) return end("kicked");
    if (joined) {
      setCover(T.connecting);
      renderBar();
    }
    retryTimer = setTimeout(() => void connect(), backoff);
    backoff = Math.min(backoff * 2, 15000);
  };
}

function handshake() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  clientNonce = crypto.getRandomValues(new Uint8Array(16));
  session = null;
  ws.send(concat(new Uint8Array([HELLO]), clientNonce));
}

async function onFrame(frame) {
  if (!session) {
    if (frame[0] === ACCEPT && frame.length === 17 && clientNonce) {
      session = await Session.create(link.secret, clientNonce, frame.subarray(1));
      let token = null;
      try {
        token = sessionStorage.getItem(tokenKey);
      } catch {}
      await sendJson({ t: "hi", name: myName || deviceName(), token });
    }
    return;
  }
  const plain = await session.open(frame);
  if (!plain) return end("badkey");
  if (plain[0] === P_JSON) onMessage(JSON.parse(dec.decode(plain.subarray(1))));
  else if (plain[0] === P_OUTPUT) {
    const len = plain[1];
    term.write(plain.subarray(2 + len), followCursor);
  }
}

function onMessage(msg) {
  switch (msg.t) {
    case "hello":
      joined = true;
      online = true;
      tabTitle = msg.title || tabTitle;
      tabStatus = msg.status || "connected";
      document.title = `${tabTitle} · Nexterm`;
      if (msg.token) {
        try {
          sessionStorage.setItem(tokenKey, msg.token);
        } catch {}
      }
      setCover(T.loading);
      showTerm();
      renderBar();
      break;
    case "wait":
      showGate({ title: msg.title || tabTitle, text: T.waiting, note: T.e2e });
      break;
    case "reset":
      term.reset();
      resizeTerm(msg.cols, msg.rows);
      setCover("");
      renderBar();
      scrolledAt = 0;
      break;
    case "size":
      resizeTerm(msg.cols, msg.rows);
      renderBar();
      break;
    case "control": {
      const before = control;
      control = msg.control;
      asking = Boolean(msg.asking);
      holdingSize = control === "me" && Boolean(msg.size);
      if (control === "me" && before !== "me") {
        toast(T.granted);
        term.focus();
      } else if (before === "me" && control !== "me") toast(T.revoked);
      renderBar();
      break;
    }
    case "tab":
      tabTitle = msg.title || tabTitle;
      tabStatus = msg.status || tabStatus;
      document.title = `${tabTitle} · Nexterm`;
      renderBar();
      break;
    case "end":
      end(msg.reason);
      break;
    default:
      break;
  }
}

// Keep-alive at the app level (some proxies drop idle WebSockets).
setInterval(() => {
  if (online) void sendJson({ t: "ping" });
}, 30000);

// The OS may freeze sockets in the background: reconnect when the page returns.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || ended || !myName) return;
  if (!ws || ws.readyState > WebSocket.OPEN) {
    backoff = 1000;
    void connect();
  }
});

// ---------- start ----------

if (!link) {
  showGate({ text: T.badLink });
} else if (!crypto.subtle) {
  showGate({ text: T.noCrypto });
} else {
  $("name-label").textContent = T.name;
  $("join-go").textContent = T.join;
  let saved = "";
  try {
    saved = localStorage.getItem(NAME_KEY) || "";
  } catch {}
  $("name-input").value = saved;
  $("name-input").placeholder = deviceName();
  showGate({ text: T.invite(link.title, link.computer), join: true, note: T.e2e });
  $("join-form").onsubmit = (ev) => {
    ev.preventDefault();
    myName = $("name-input").value.trim().slice(0, 40) || deviceName();
    try {
      localStorage.setItem(NAME_KEY, $("name-input").value.trim());
    } catch {}
    $("join-go").disabled = true;
    showGate({ text: T.connecting, note: T.e2e });
    void connect();
  };
  $("name-input").focus();
}

// Exposed for the end-to-end test.
window.__share = { term };
