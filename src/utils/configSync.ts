import type { SyncSettings } from "../types/domain";

/** Error codes the backend returns for known failures (Rust `sync::code`, plus "busy"). */
const ERROR_CODES = ["passwordRequired", "badPassword", "badFormat", "newerVersion", "remoteEmpty", "noProvider", "busy"];

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

/** Milliseconds between automatic syncs (null: startup only). */
export function autoSyncInterval(s: SyncSettings): number | null {
  if (!s.autoSync || !syncReady(s)) return null;
  const min = Math.floor(Number(s.intervalMin) || 0);
  return min > 0 ? Math.max(min, 5) * 60_000 : null;
}

/** Default export file name, e.g. nexterm-config-20261115-0930.json. */
export function exportFileName(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `nexterm-config-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.json`;
}
