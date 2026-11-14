/**
 * The host a terminal is on right now, as the shell reports it: OSC 7 (`file://host/cwd`),
 * a window title like `user@host: ~` (OSC 0 / 2), or a prompt like `user@host:~$`.
 * Follows nested ssh / su because the latest report wins.
 */

const HOST = "[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?";

/** `file://myhost/home/me` -> "myhost"; empty host (`file:///tmp`) -> null. */
export function hostFromOsc7(data: string): string | null {
  const m = /^file:\/\/([^/]*)/i.exec(data.trim());
  if (!m) return null;
  let host = m[1];
  try {
    host = decodeURIComponent(host);
  } catch {
    // keep as is
  }
  host = host.replace(/:\d+$/, "");
  return new RegExp(`^${HOST}$`).test(host) ? host : null;
}

/** `user@host: ~/src`, `[user@host ~]`, `user@host ~`, `ssh: user@host` -> "host". */
export function hostFromTitle(title: string): string | null {
  const m = new RegExp(`(?:^|[\\s\\[(:])[A-Za-z0-9._-]+@(${HOST})(?=$|[\\s:\\])~/])`).exec(title.trim());
  return m ? m[1] : null;
}

/**
 * Host from the prompt text before the cursor: `root@web1:~# `, `[root@db ~]$ `,
 * `(venv) me@box ~/src % `. Only the start of the line counts, so output and typed
 * commands (`ssh git@github.com`) never match.
 */
export function hostFromPrompt(beforeCursor: string): string | null {
  const s = beforeCursor.replace(/\s+$/, "");
  if (!/[$#%>❯➜»λ]$/.test(s) || s.length > 200) return null;
  const m = new RegExp(`^\\s*(?:\\([^)]*\\)\\s*)*\\[?[A-Za-z0-9._-]+@(${HOST})(?=[\\s:\\]~/$#%>])`).exec(s);
  return m ? m[1] : null;
}

/** Whether the tab title already says the host (no need to repeat it). */
export function titleShowsHost(title: string, host: string): boolean {
  const lc = title.toLowerCase();
  const h = host.toLowerCase();
  if (lc === h) return true;
  return new RegExp(`(^|[^a-z0-9-])${h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9-])`).test(lc);
}
