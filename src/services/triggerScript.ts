/**
 * Runs trigger tooltip scripts (`(captures) => string`, see utils/triggers.ts).
 *
 * Scripts get text from the remote host (the Calculator trigger even evals it), so they
 * never run in the app's window, where they could reach Tauri commands. They run in a
 * Worker with no network APIs, and one that does not answer in time is killed.
 */

const WORKER_SOURCE = `
"use strict";
for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "Worker",
  "SharedWorker", "indexedDB", "caches", "BroadcastChannel", "WebTransport", "navigator"]) {
  for (let o = self; o; o = Object.getPrototypeOf(o)) {
    try { delete o[name]; } catch (e) {}
  }
  try { Object.defineProperty(self, name, { value: undefined, configurable: false, writable: false }); } catch (e) {}
}
const post = self.postMessage.bind(self);
const compiled = new Map();
self.onmessage = (e) => {
  const { id, source, captures } = e.data;
  try {
    let fn = compiled.get(source);
    if (!fn) {
      fn = (0, eval)("(" + source + "\\n)");
      if (typeof fn !== "function") throw new Error("not a function");
      compiled.set(source, fn);
    }
    const value = fn(Object.assign({}, captures));
    post({ id, value: value === undefined || value === null ? null : String(value) });
  } catch (err) {
    post({ id, value: null, error: String(err && err.message || err) });
  }
};
`;

const TIMEOUT_MS = 500;

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: string | null | undefined) => void; timer: number }>();

function getWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === "undefined") return null;
  const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
  try {
    worker = new Worker(url);
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
  worker.onmessage = (e: MessageEvent<{ id: number; value: string | null }>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    window.clearTimeout(p.timer);
    p.resolve(e.data.value);
  };
  worker.onerror = () => restart();
  return worker;
}

/**
 * Kill the worker (a script that loops forever). The script that took too long gets null;
 * the others queued behind it get undefined (not answered, ask again).
 */
function restart(culprit?: number): void {
  worker?.terminate();
  worker = null;
  for (const [id, p] of pending) {
    window.clearTimeout(p.timer);
    p.resolve(id === culprit ? null : undefined);
  }
  pending.clear();
}

/**
 * The script's result as text; null when it throws, returns nothing or takes too long;
 * undefined when another script's timeout stopped it first.
 */
export function runTriggerScript(source: string, captures: Record<string, string>): Promise<string | null | undefined> {
  const w = getWorker();
  if (!w) return Promise.resolve(null);
  const id = nextId++;
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      if (pending.has(id)) restart(id);
    }, TIMEOUT_MS);
    pending.set(id, { resolve, timer });
    w.postMessage({ id, source, captures });
  });
}
