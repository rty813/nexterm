import { backend } from "./backend";
import { computeServerStats, parseServerSample, type RawSample, type ServerStats } from "../utils/serverStats";

/** Seconds between samples of one pane. */
export const MONITOR_INTERVAL_MS = 3000;

export type MonitorState =
  | { status: "loading" }
  | { status: "ok"; stats: ServerStats; updatedAt: number; stale: boolean }
  | { status: "unsupported"; os: string };

type Listener = (s: MonitorState) => void;

/** Failures before the first good sample after which the host counts as unsupported. */
const FAILS_BEFORE_UNSUPPORTED = 2;

/**
 * One poller per pane, shared by everything showing it (the side panel). It runs
 * only while someone listens and the window is visible; the last listener leaving drops it.
 */
class Poller {
  listeners = new Set<Listener>();
  state: MonitorState = { status: "loading" };
  private prev: RawSample | null = null;
  private timer: number | null = null;
  private inFlight = false;
  private everOk = false;
  private failures = 0;
  private stopped = false;

  constructor(private readonly paneId: string) {}

  start() {
    document.addEventListener("visibilitychange", this.onVisibility);
    void this.tick();
  }

  stop() {
    this.stopped = true;
    document.removeEventListener("visibilitychange", this.onVisibility);
    if (this.timer != null) window.clearTimeout(this.timer);
    this.timer = null;
  }

  private onVisibility = () => {
    if (!document.hidden && this.timer == null && !this.inFlight && this.state.status !== "unsupported") void this.tick();
  };

  private set(s: MonitorState) {
    this.state = s;
    for (const l of this.listeners) l(s);
  }

  private schedule() {
    if (this.stopped || this.state.status === "unsupported") return;
    // Hidden window: wait for visibilitychange instead of polling.
    if (document.hidden) return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, MONITOR_INTERVAL_MS);
  }

  private async tick() {
    if (this.stopped || this.inFlight || document.hidden) return;
    this.inFlight = true;
    try {
      const text = await backend.serverStatsSample(this.paneId);
      if (this.stopped) return;
      const parsed = parseServerSample(text, Date.now());
      if (!parsed.supported) {
        this.set({ status: "unsupported", os: parsed.os });
        return;
      }
      const stats = computeServerStats(this.prev, parsed.sample);
      this.prev = parsed.sample;
      this.everOk = true;
      this.failures = 0;
      this.set({ status: "ok", stats, updatedAt: Date.now(), stale: false });
    } catch {
      if (this.stopped) return;
      this.failures++;
      if (!this.everOk) {
        // No sh / base64 / exec (Windows OpenSSH, network gear ...): not supported, quietly.
        if (this.failures >= FAILS_BEFORE_UNSUPPORTED) this.set({ status: "unsupported", os: "" });
      } else if (this.state.status === "ok") {
        this.set({ ...this.state, stale: true });
      }
    } finally {
      this.inFlight = false;
      this.schedule();
    }
  }
}

const pollers = new Map<string, Poller>();

/** Follow the resources of the SSH host behind `paneId`; call the returned function to stop. */
export function subscribeServerMonitor(paneId: string, listener: Listener): () => void {
  let p = pollers.get(paneId);
  const fresh = !p;
  if (!p) {
    p = new Poller(paneId);
    pollers.set(paneId, p);
  }
  p.listeners.add(listener);
  listener(p.state);
  if (fresh) p.start();
  const poller = p;
  return () => {
    poller.listeners.delete(listener);
    if (poller.listeners.size === 0) {
      poller.stop();
      if (pollers.get(paneId) === poller) pollers.delete(paneId);
    }
  };
}
