import type { SyncChannel, SyncInputScope } from "../types/domain";

/**
 * Panes that receive input typed into `sourcePaneId`.
 *
 * - `scopePanes`: the panes the current scope broadcasts among ("all" → every leaf,
 *   "visible" → the active tab of each group); ignored for "channels".
 * - `pausedAll`: the global pause, input stays in the source pane.
 * - `pausedPanes`: panes paused one by one. A paused pane neither sends its typing to the
 *   others nor receives theirs, the rest keep syncing.
 */
export function syncTargets(opts: {
  scope: SyncInputScope;
  pausedAll: boolean;
  pausedPanes: Record<string, boolean>;
  channels: Record<string, SyncChannel>;
  /** Every pane in the workspace, in order. */
  allPanes: string[];
  /** Panes of a "visible" scope. */
  visiblePanes: string[];
  sourcePaneId: string;
}): string[] {
  const { scope, pausedAll, pausedPanes, channels, allPanes, visiblePanes, sourcePaneId } = opts;
  const alone = [sourcePaneId];
  if (scope === "off" || pausedAll || pausedPanes[sourcePaneId]) return alone;
  let members: string[];
  if (scope === "all") members = allPanes;
  else if (scope === "visible") {
    if (!visiblePanes.includes(sourcePaneId)) return alone;
    members = visiblePanes;
  } else {
    const ch = channels[sourcePaneId];
    if (!ch) return alone;
    members = allPanes.filter((id) => channels[id] === ch);
  }
  return members.filter((id) => id === sourcePaneId || !pausedPanes[id]);
}
