/** CSS font-family stacks ("'Cascadia Mono', Consolas, monospace") for the font picker. */

const GENERIC = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-monospace",
  "ui-serif",
  "ui-sans-serif",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong",
]);

/** Fallbacks put behind a font picked into an empty stack. */
const DEFAULT_FALLBACK = ["Consolas", "Microsoft YaHei UI", "monospace"];

/** Family names in order, quotes removed. */
export function parseFontStack(stack: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (const ch of stack) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean);
}

/** Quote every family name except the CSS generic keywords. */
export function formatFontStack(names: string[]): string {
  return names
    .map((n) => (GENERIC.has(n.toLowerCase()) ? n : `'${n.replace(/'/g, "\\'")}'`))
    .join(", ");
}

/** The family the terminal tries first. */
export function primaryFont(stack: string): string {
  return parseFontStack(stack)[0] ?? "";
}

/** Put `name` first, keeping the rest of the stack as fallbacks. */
export function setPrimaryFont(stack: string, name: string): string {
  const key = name.trim().toLowerCase();
  if (!key) return stack;
  const names = parseFontStack(stack);
  // Replace the old first choice (unless it's a generic keyword such as "monospace").
  const rest = names.length && !GENERIC.has(names[0].toLowerCase()) ? names.slice(1) : names;
  const fallback = rest.filter((n) => n.toLowerCase() !== key);
  return formatFontStack([name.trim(), ...(fallback.length ? fallback : DEFAULT_FALLBACK)]);
}
