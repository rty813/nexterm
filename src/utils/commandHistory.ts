import { backend, currentWindowLabel } from "../services/backend";
import type { HistoryEntry, HistorySettings, SessionConfig } from "../types/domain";
import { DEFAULT_HISTORY } from "./settingsDefaults";

/** Longest command kept (long pastes are not "commands"). */
const MAX_COMMAND_LENGTH = 2000;

type Change = { op: "add"; entry: HistoryEntry } | { op: "remove"; command: string; key?: string } | { op: "clear" };

/**
 * Which session a command belongs to: the connection target, so the same server keeps its
 * history whether it is opened from a saved session or the quick connect bar.
 */
export function historyKeyOf(s: SessionConfig): string {
  switch (s.protocol) {
    case "ssh":
    case "telnet":
    case "tcp":
      return `${s.protocol}://${(s.username || "").trim()}@${s.host.trim().toLowerCase()}:${s.port}`;
    case "serial":
      return `serial://${s.host.trim()}`;
    default:
      return `${s.protocol}:${(s.shellCommand || "").trim()}`;
  }
}

/**
 * Entries recorded before right-hand prompts were recognised can end with the prompt
 * (e.g. "ls   Thu Nov 12 17:37:33 2026"): drop text after a long run of blanks.
 */
export function cleanLegacyCommand(command: string): string {
  return command.replace(/\s{6,}\S.*$/, "").replace(/\s+$/, "");
}

const sameEntry = (e: HistoryEntry, command: string, key?: string) => e.command === command && (e.key ?? "") === (key ?? "");

/**
 * Command history shared by every terminal of the app (WindTerm: terminal.commandHistory.*).
 *
 * Each window keeps a copy in memory; changes are broadcast to the other windows and the
 * main window (which lives as long as the app) writes command_history.json.
 */
class CommandHistoryStore {
  private entries: HistoryEntry[] = [];
  private settings: HistorySettings = DEFAULT_HISTORY;
  private listeners = new Set<() => void>();
  private saveTimer = 0;
  private loaded = false;
  private readonly owner = currentWindowLabel() === "main";

  constructor() {
    void backend.onBroadcast<{ from: string; change: Change }>("command-history", (p) => {
      if (p.from === currentWindowLabel()) return;
      this.apply(p.change, false);
    });
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const saved = await backend.loadDataFile<HistoryEntry[]>("command_history");
    if (Array.isArray(saved)) {
      const cleaned: HistoryEntry[] = [];
      for (const e of saved) {
        if (!e || typeof e.command !== "string") continue;
        const command = e.key ? e.command : cleanLegacyCommand(e.command);
        if (!command.trim() || cleaned.some((x) => sameEntry(x, command, e.key))) continue;
        cleaned.push({ ...e, command });
      }
      // Keep what was added before the file finished loading.
      const known = new Set(this.entries.map((e) => `${e.key ?? ""}\u0000${e.command}`));
      this.entries = [...cleaned.filter((e) => !known.has(`${e.key ?? ""}\u0000${e.command}`)), ...this.entries];
      this.prune();
      this.emit();
    }
  }

  /** Read the file again (an import or sync replaced it). */
  async reload(): Promise<void> {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    this.loaded = false;
    this.entries = [];
    await this.load();
    this.emit();
  }

    configure(settings: HistorySettings): void {
    this.settings = settings;
    if (this.prune()) {
      this.emit();
      this.scheduleSave();
    }
  }

  get enabled(): boolean {
    return this.settings.enabled;
  }

  /** Oldest first. */
  all(): readonly HistoryEntry[] {
    return this.entries;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  add(command: string, session?: string, key?: string): void {
    const text = command.replace(/\s+$/, "");
    if (!this.settings.enabled || !text.trim() || text.length > MAX_COMMAND_LENGTH) return;
    // A leading space hides a command from history, like bash HISTCONTROL=ignorespace.
    if (/^\s/.test(command)) return;
    const prev = this.entries.find((e) => sameEntry(e, text, key));
    const entry: HistoryEntry = { command: text, time: Date.now(), count: (prev?.count ?? 0) + 1, session, key };
    this.apply({ op: "add", entry }, true);
  }

  remove(command: string, key?: string): void {
    this.apply({ op: "remove", command, key }, true);
  }

  clear(): void {
    this.apply({ op: "clear" }, true);
  }

  /**
   * Commands starting with `prefix` (the most used and recent first). With an empty
   * prefix: the most recent ones.
   */
  search(prefix: string, limit = 50, key?: string): HistoryEntry[] {
    const out: HistoryEntry[] = [];
    const seen = new Set<string>();
    for (let i = this.entries.length - 1; i >= 0 && out.length < limit * 4; i--) {
      const e = this.entries[i];
      if (key !== undefined && e.key !== key) continue;
      if (!e.command.startsWith(prefix) || e.command === prefix || seen.has(e.command)) continue;
      seen.add(e.command);
      out.push(e);
    }
    const now = Date.now();
    // Frequency with a recency boost (a day old counts half).
    const score = (e: HistoryEntry) => Math.log2(1 + e.count) + 2 / (1 + (now - e.time) / 86_400_000);
    return out.sort((a, b) => score(b) - score(a)).slice(0, limit);
  }

  private apply(change: Change, local: boolean): void {
    if (change.op === "add") {
      const { command, key } = change.entry;
      this.entries = this.entries.filter((e) => !sameEntry(e, command, key));
      this.entries.push(change.entry);
      this.prune();
    } else if (change.op === "remove") {
      this.entries = this.entries.filter((e) => !sameEntry(e, change.command, change.key));
    } else {
      this.entries = [];
    }
    if (local) void backend.broadcast("command-history", { from: currentWindowLabel(), change });
    this.emit();
    this.scheduleSave();
  }

  /** Drop entries past the age / count limits. True when something was removed. */
  private prune(): boolean {
    const before = this.entries.length;
    const minTime = this.settings.days > 0 ? Date.now() - this.settings.days * 86_400_000 : 0;
    this.entries = this.entries.filter((e) => e.time >= minTime);
    const max = Math.max(1, this.settings.size || DEFAULT_HISTORY.size);
    if (this.entries.length > max) this.entries = this.entries.slice(this.entries.length - max);
    return this.entries.length !== before;
  }

  private emit(): void {
    this.listeners.forEach((fn) => fn());
  }

  private scheduleSave(): void {
    if (!this.owner) return;
    window.clearTimeout(this.saveTimer);
    // WindTerm: application.autoSaveHistoryInterval (5 s).
    this.saveTimer = window.setTimeout(() => {
      void backend.saveDataFile("command_history", this.settings.enabled ? this.entries : []);
    }, 5000);
  }

  /** Write pending changes now (before quitting). */
  flush(): void {
    if (!this.owner || !this.saveTimer) return;
    window.clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    void backend.saveDataFile("command_history", this.settings.enabled ? this.entries : []);
  }
}

export const commandHistory = new CommandHistoryStore();
