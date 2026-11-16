import type { TerminalLeafNode } from "../types/domain";

/** "Duplicate Session (Reuse SSH Connection)" needs a live SSH connection to open a new channel on. */
export function canReuseSsh(leaf: Pick<TerminalLeafNode, "session" | "status">): boolean {
  return leaf.session.protocol === "ssh" && leaf.status === "connected";
}

/**
 * Whether the duplicate shortcut / tab mouse action reuses the SSH connection.
 * The two menu items are explicit; only these follow the reuseSshConnection setting (default on).
 */
export function duplicateReusesSsh(reuseSetting: boolean | undefined, leaf: Pick<TerminalLeafNode, "session" | "status">): boolean {
  return reuseSetting !== false && canReuseSsh(leaf);
}
