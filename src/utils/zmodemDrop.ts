/**
 * Files dropped on a terminal, waiting for the remote `rz` that the drop typed. The
 * ZModem dialog takes them when the transfer request arrives; unanswered drops expire.
 */
interface Pending {
  files: File[];
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, Pending>();

export const zmodemDrop = {
  /** Queue `files` for the pane; `onExpire` runs if no transfer starts within `ms`. */
  queue(paneId: string, files: File[], onExpire: () => void, ms = 15000): void {
    this.clear(paneId);
    const timer = setTimeout(() => {
      if (pending.get(paneId)?.timer === timer) {
        pending.delete(paneId);
        onExpire();
      }
    }, ms);
    pending.set(paneId, { files, timer });
  },

  /** The files waiting for this pane's upload request, if any (and forget them). */
  take(paneId: string): File[] | null {
    const p = pending.get(paneId);
    if (!p) return null;
    clearTimeout(p.timer);
    pending.delete(paneId);
    return p.files;
  },

  has(paneId: string): boolean {
    return pending.has(paneId);
  },

  clear(paneId: string): void {
    const p = pending.get(paneId);
    if (p) clearTimeout(p.timer);
    pending.delete(paneId);
  },
};

/** Base64 of a string's UTF-8 bytes (file names travel in ASCII headers). */
export function utf8Base64(text: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
}
