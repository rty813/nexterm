import type { LayoutNode } from "../types/domain";
import { groupRects, type DropZone } from "./layout";

export interface DropHint {
  zone: DropZone;
  /** Preview box, in px relative to the drop stage. */
  rect: { left: number; top: number; width: number; height: number };
}

/** Outer band of the workspace that splits the whole workspace instead of one group. */
const ROOT_EDGE = 16;

/**
 * Drop zone under a point (client px) of the workspace stage.
 * - "tab": a dragged tab. Tab bar or the middle of a group joins its tabs; the outer
 *   quarter of a group splits it on that side.
 * - "window": a whole window dragged by its title bar. Only a group's tab bar or a
 *   band along its edges docks, so moving a window across this one does nothing.
 */
export function dropZoneAt(
  stage: HTMLElement | null,
  root: LayoutNode | null,
  zoomedGroupId: string | null,
  clientX: number,
  clientY: number,
  mode: "tab" | "window",
  tabbarH: number
): DropHint | null {
  if (!stage) return null;
  const box = stage.getBoundingClientRect();
  const x = clientX - box.left;
  const y = clientY - box.top;
  if (x < 0 || y < 0 || x > box.width || y > box.height) return null;
  const whole = { left: 0, top: 0, width: box.width, height: box.height };
  if (!root) return { zone: { groupId: null, side: "center" }, rect: whole };

  const half = (r: typeof whole, side: DropZone["side"]) =>
    side === "left"
      ? { ...r, width: r.width / 2 }
      : side === "right"
      ? { ...r, left: r.left + r.width / 2, width: r.width / 2 }
      : side === "top"
      ? { ...r, height: r.height / 2 }
      : side === "bottom"
      ? { ...r, top: r.top + r.height / 2, height: r.height / 2 }
      : r;

  let rects = groupRects(root);
  if (zoomedGroupId && rects.some((r) => r.id === zoomedGroupId)) {
    rects = [{ id: zoomedGroupId, x: 0, y: 0, w: 100, h: 100 }];
  }

  // Workspace edges (only meaningful with several groups).
  if (rects.length > 1) {
    const side = x < ROOT_EDGE ? "left" : x > box.width - ROOT_EDGE ? "right" : y < ROOT_EDGE ? "top" : y > box.height - ROOT_EDGE ? "bottom" : null;
    if (side) return { zone: { groupId: null, side }, rect: half(whole, side) };
  }

  for (const r of rects) {
    const g = { left: (r.x / 100) * box.width, top: (r.y / 100) * box.height, width: (r.w / 100) * box.width, height: (r.h / 100) * box.height };
    if (x < g.left || x > g.left + g.width || y < g.top || y > g.top + g.height) continue;
    if (y - g.top < tabbarH) return { zone: { groupId: r.id, side: "center" }, rect: g };
    const body = { left: g.left, top: g.top + tabbarH, width: g.width, height: g.height - tabbarH };
    const d = { left: x - body.left, right: body.left + body.width - x, top: y - body.top, bottom: body.top + body.height - y };
    const nearest = (Object.keys(d) as (keyof typeof d)[]).reduce((a, b) => (d[a] <= d[b] ? a : b));
    if (mode === "tab") {
      const frac = nearest === "left" || nearest === "right" ? d[nearest] / body.width : d[nearest] / body.height;
      if (frac < 0.25) return { zone: { groupId: r.id, side: nearest }, rect: half(g, nearest) };
      return { zone: { groupId: r.id, side: "center" }, rect: g };
    }
    const band = Math.max(40, Math.min(120, Math.min(body.width, body.height) * 0.2));
    if (d[nearest] < band) return { zone: { groupId: r.id, side: nearest }, rect: half(g, nearest) };
    return null;
  }
  return null;
}
