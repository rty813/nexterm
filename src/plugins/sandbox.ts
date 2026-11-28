function bridge(dismissOnEscape = false) {
  let port: MessagePort;
  let next = 0;
  const pending = new Map<number, {resolve: (value: unknown) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout>}>();
  const handlers = new Map<string, (value: unknown) => unknown>();
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  const ready = new Promise<void>(resolve => {
    addEventListener("message", function init(event) {
      if (event.data !== "nexterm:init" || !event.ports[0] || (typeof document !== "undefined" && event.source !== parent)) return;
      removeEventListener("message", init);
      port = event.ports[0];
      port.onmessage = async event => {
        const message = event.data;
        if (message.kind === "result") {
          const item = pending.get(message.id);
          if (!item) return;
          pending.delete(message.id); clearTimeout(item.timer);
          if (message.error) item.reject(new Error(message.error)); else item.resolve(message.value);
        } else if (message.kind === "call") {
          try {
            const handler = handlers.get(message.method);
            if (!handler) throw new Error("Plugin handler not found: " + message.method);
            const value = await handler(message.value);
            port.postMessage({kind: "result", id: message.id, value});
          } catch (reason) { port.postMessage({kind: "result", id: message.id, error: String(reason)}); }
        } else if (message.kind === "event") {
          for (const listener of listeners.get(message.name) ?? []) listener(message.value);
        }
      };
      resolve();
    });
  });
  async function call(method: string, value?: unknown): Promise<any> {
    await ready;
    if (pending.size >= 32) throw new Error("Too many pending plugin calls");
    const id = ++next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("Plugin request timed out")); }, 30000);
      pending.set(id, {resolve, reject, timer});
      port.postMessage({kind: "call", id, method, value});
    });
  }
  // Same as the app: no WebView2 browser menu (Back / Refresh / Print ...) outside text fields.
  if (typeof document !== "undefined") window.addEventListener("contextmenu", event => {
    const el = event.target as HTMLElement | null;
    const text = !!el && (el instanceof HTMLTextAreaElement || el.isContentEditable
      || (el instanceof HTMLInputElement && ["text", "search", "url", "tel", "email", "password", "number"].includes(el.type)));
    if (!text) event.preventDefault();
  });
  if (dismissOnEscape && typeof document !== "undefined") window.addEventListener("keydown", event => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    void call("views.dismiss").catch(() => undefined);
  });
  const api = {
    ready,
    request: (name: string, value?: unknown) => call("plugin.request", {name, value}),
    handle: (name: string, handler: (value: any) => unknown) => { handlers.set(name, handler); return () => handlers.delete(name); },
    onCommand: (id: string, handler: (value: any) => unknown) => { handlers.set("command:" + id, handler); return () => handlers.delete("command:" + id); },
    on: (name: string, listener: (value: any) => void) => { const set = listeners.get(name) ?? new Set(); set.add(listener); listeners.set(name, set); return () => set.delete(listener); },
    publish: (name: string, value: unknown) => call("events.publish", {name, value}),
    http: (request: unknown) => call("http.request", request),
    network: {request: (origin: string) => call("network.request", {origin}), isGranted: (origin: string) => call("network.isGranted", {origin})},
    config: {get: () => call("config.get"), set: (value: unknown) => call("config.set", value)},
    secrets: {set: (key: string, value: string, origin: string) => call("secrets.set", {key, value, origin}), delete: (key: string, origin: string) => call("secrets.delete", {key, origin})},
    credentials: {get: (key: string, origin: string) => call("credentials.get", {key, origin}), set: (key: string, value: string, origin: string) => call("credentials.set", {key, value, origin}), delete: (key: string, origin: string) => call("credentials.delete", {key, origin})},
    status: {update: (id: string, text: string, tooltip?: string) => call("status.update", {id, text, tooltip})},
    views: {open: (id: string) => call("views.open", {id}), resize: (size: unknown) => call("views.resize", size)},
    sessions: {
      openSsh: (request: unknown) => call("sessions.open", request),
      updateSource: (id: string, catalog: unknown) => call("sessions.updateSource", {id, catalog}),
      appendSource: (id: string, catalog: unknown) => call("sessions.appendSource", {id, catalog}),
      onConnect: (id: string, handler: (value: any) => unknown) => { handlers.set("sessionSource:" + id, handler); return () => handlers.delete("sessionSource:" + id); },
    },
  };
  Object.defineProperty(globalThis, "nexterm", {value: Object.freeze(api)});
}

const escapeScript = (value: string) => value.replace(/<\/script/gi, "<\\/script");
const csp = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; worker-src blob:; frame-src 'none'; form-action 'none'; base-uri 'none'";
export function viewDocument(html: string, dismissOnEscape = false): string {
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><script>(${bridge.toString()})(${dismissOnEscape});<\/script>${html}`;
}
export function backgroundDocument(source: string): string {
  const worker = `(${bridge.toString()})(); addEventListener('unhandledrejection', event => { event.preventDefault(); postMessage({kind:'failure'}); }); setInterval(() => postMessage({kind:'heartbeat'}), 1000); nexterm.ready.then(async () => { try { await (async () => {${source}\n})(); } catch (_) { postMessage({kind:'failure'}); } });`;
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}"><script>
  const url = URL.createObjectURL(new Blob([${escapeScript(JSON.stringify(worker))}],{type:'text/javascript'}));
  const worker = new Worker(url); URL.revokeObjectURL(url);
  worker.onmessage = event => parent.postMessage(event.data, '*');
  worker.onerror = () => parent.postMessage({kind:'failure'}, '*');
  addEventListener('message', event => { if(event.source === parent && event.data === 'nexterm:init') worker.postMessage(event.data, event.ports); });
  <\/script>`;
}
