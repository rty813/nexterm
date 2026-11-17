import type { ShareInfo, ShareOptions, ShareViewer } from "../services/backend";

/** Session shares (src-tauri/src/share.rs): pure helpers for the dialog, badge and banner. */

export const DEFAULT_SHARE_OPTIONS: ShareOptions = { expiresMinutes: 240, scrollback: false, approve: false, single: false };

/** Lifetimes offered in the dialog, in minutes (0: until stopped). */
export const SHARE_EXPIRY_CHOICES = [60, 240, 1440, 0] as const;

export function shareOfPane(shares: ShareInfo[], paneId: string): ShareInfo | undefined {
  return shares.find((s) => s.paneId === paneId);
}

export interface ShareSummary {
  /** Viewers let in. */
  watching: number;
  /** Who may type, if anyone. */
  controller: ShareViewer | null;
  /** Waiting to be let in, or asking for control. */
  requests: ShareViewer[];
}

export function summarizeShare(share: ShareInfo): ShareSummary {
  const inside = share.viewers.filter((v) => !v.pending);
  return {
    watching: inside.length,
    controller: inside.find((v) => v.control) ?? null,
    requests: share.viewers.filter((v) => v.pending || (v.asking && !v.control)),
  };
}

/** Time left before the link stops working; null: no limit. */
export function remaining(expiresAt: number | null, now: number): { hours: number; minutes: number } | null {
  if (expiresAt == null) return null;
  const mins = Math.max(0, Math.ceil((expiresAt - now) / 60_000));
  return { hours: Math.floor(mins / 60), minutes: mins % 60 };
}

/** i18n key of an error from share_start. */
export function shareErrorKey(error: unknown): string | null {
  const code = String(error instanceof Error ? error.message : error);
  switch (code) {
    case "no-relay":
      return "share.errNoRelay";
    case "no-pane":
      return "share.errNoPane";
    case "too-many":
      return "share.errTooMany";
    case "old-relay":
      return "share.errOldRelay";
    default:
      return null;
  }
}
