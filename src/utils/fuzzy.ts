/**
 * Subsequence match for the command palette: every query character must appear in
 * order. Higher is better; null when it does not match. Consecutive hits, hits at the
 * start of a word and an exact prefix score extra. Case-insensitive; spaces in the
 * query are ignored so "new ps" finds "New PowerShell tab".
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return 0;
  const s = text.toLowerCase();
  let score = 0;
  let from = 0;
  let prev = -2;
  for (const ch of q) {
    const i = s.indexOf(ch, from);
    if (i < 0) return null;
    score += 1;
    if (i === prev + 1) score += 3;
    if (i === 0 || /[\s\-_./@:>()（）]/.test(s[i - 1])) score += 2;
    prev = i;
    from = i + 1;
  }
  if (s.startsWith(query.toLowerCase().trim())) score += 6;
  // Shorter texts win ties.
  return score - s.length / 100;
}

/** Best score over several fields of an item (label first, then details). */
export function bestScore(query: string, fields: (string | undefined | null)[]): number | null {
  let best: number | null = null;
  fields.forEach((f, i) => {
    if (!f) return;
    const sc = fuzzyScore(query, f);
    if (sc === null) return;
    const weighted = i === 0 ? sc : sc - 1;
    if (best === null || weighted > best) best = weighted;
  });
  return best;
}
