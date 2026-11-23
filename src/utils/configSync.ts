import type { SyncSettings } from "../types/domain";

/** Error codes the backend returns for known failures (Rust `sync::code` and `local_secrets`, plus "busy"). */
const ERROR_CODES = ["passwordRequired", "exportPasswordRequired", "localDataUnreadable", "localDataInvalid", "badPassword", "badFormat", "newerVersion", "remoteEmpty", "noProvider", "busy"];

/** i18n key of a backend error, or null when it is a plain message (network, HTTP ...). */
export function syncErrorKey(err: unknown): string | null {
  const text = String(err ?? "").trim();
  return ERROR_CODES.includes(text) ? `cfgSync.err.${text}` : null;
}

/** Whether the target has everything needed to try a sync. */
export function syncReady(s: SyncSettings): boolean {
  switch (s.provider) {
    case "s3":
      return Boolean(s.s3.bucket.trim() && s.s3.accessKeyId.trim() && s.s3.secretAccessKey);
    case "webdav":
      return /^https?:\/\/\S+/i.test(s.webdav.url.trim());
    case "gist":
      return Boolean(s.gist.token.trim());
    case "folder":
      return Boolean(s.folder.path.trim());
    default:
      return false;
  }
}

/** Longest delay `setInterval` takes (a longer one fires at once). */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Milliseconds between automatic syncs (null: startup only). */
export function autoSyncInterval(s: SyncSettings): number | null {
  if (!s.autoSync || !syncReady(s)) return null;
  const min = Math.floor(Number(s.intervalMin) || 0);
  return min > 0 ? Math.min(Math.max(min, 5) * 60_000, MAX_TIMER_MS) : null;
}

export type IntervalUnit = "day" | "hour" | "minute";

/** Minutes in one unit. */
export const INTERVAL_UNITS: Record<IntervalUnit, number> = { day: 1440, hour: 60, minute: 1 };

/** Minutes as a number of the largest unit that divides them (0 shows as days). */
export function splitInterval(minutes: number): { value: number; unit: IntervalUnit } {
  const min = Math.max(0, Math.floor(Number(minutes) || 0));
  if (min === 0) return { value: 0, unit: "day" };
  const unit = (["day", "hour", "minute"] as const).find((u) => min % INTERVAL_UNITS[u] === 0) ?? "minute";
  return { value: min / INTERVAL_UNITS[unit], unit };
}

/** Default export file name, e.g. nexterm-config-20261115-0930.json. */
export function exportFileName(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `nexterm-config-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.json`;
}
