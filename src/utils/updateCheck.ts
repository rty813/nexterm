import type { AppSettings, UpdateInfo } from "../types/domain";

/** Wait after startup before checking, so the first connections are not slowed down. */
export const UPDATE_CHECK_DELAY_MS = 5000;

/** The startup check is on unless switched off in settings. */
export function updateCheckEnabled(settings: Pick<AppSettings, "checkUpdates">): boolean {
  return settings.checkUpdates !== false;
}

/** Prompt at startup for a newer release the user has not chosen to skip. */
export function shouldPromptUpdate(info: UpdateInfo, settings: Pick<AppSettings, "skippedUpdateVersion">): boolean {
  return info.available && info.latest !== settings.skippedUpdateVersion;
}

/** Release notes for the dialog: markdown noise trimmed, at most `maxLines` lines. */
export function releaseNotesPreview(notes: string, maxLines = 12): string {
  const lines = notes
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/^#{1,6}\s+/, "").replace(/\*\*(.+?)\*\*/g, "$1").trimEnd())
    .filter((l, i, all) => l !== "" || (i > 0 && all[i - 1] !== ""));
  while (lines.length && lines[0] === "") lines.shift();
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (lines.length <= maxLines) return lines.join("\n");
  return [...lines.slice(0, maxLines), "…"].join("\n");
}
