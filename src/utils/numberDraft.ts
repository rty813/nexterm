// Number inputs keep the user's text while typing, so a field can be cleared and retyped
// ("14" → "" → "20") instead of snapping back to a default on every keystroke.

export interface NumberBounds {
  min?: number;
  max?: number;
  integer?: boolean;
}

/** The value to apply while typing: only complete, in-range numbers; otherwise null (keep the old value). */
export function parseNumberDraft(text: string, { min, max, integer }: NumberBounds = {}): number | null {
  if (text.trim() === "") return null;
  const n = Number(text);
  if (!Number.isFinite(n)) return null;
  if (integer && !Number.isInteger(n)) return null;
  if (min !== undefined && n < min) return null;
  if (max !== undefined && n > max) return null;
  return n;
}

/** The value to settle on when editing ends: clamp what was typed, or fall back when it is empty or invalid. */
export function commitNumberDraft(text: string, fallback: number, { min, max, integer }: NumberBounds = {}): number {
  if (text.trim() === "") return fallback;
  let n = Number(text);
  if (!Number.isFinite(n)) return fallback;
  if (integer) n = Math.round(n);
  if (min !== undefined) n = Math.max(min, n);
  if (max !== undefined) n = Math.min(max, n);
  return n;
}
