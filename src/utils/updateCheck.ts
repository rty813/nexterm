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

export interface NoteBlock {
  kind: "h2" | "h3" | "li" | "p";
  /** Lines of the block (a list item may span several, e.g. Chinese then English). */
  lines: string[];
}

export interface NoteSpan {
  text: string;
  bold?: boolean;
  code?: boolean;
}

const CJK = /[㐀-鿿豈-﫿]/;

/** Keeps the half of a "中文 / English" pair that matches the UI language. */
function pickLanguage(parts: string[], zh: boolean): string[] {
  if (parts.length !== 2) return parts;
  const [a, b] = parts.map((p) => CJK.test(p));
  if (a === b) return parts;
  return [zh === a ? parts[0] : parts[1]];
}

/**
 * Release notes (GitHub markdown) -> blocks for the update dialog.
 * Images, link targets and the "Full Changelog" line are dropped. With `lang`, bilingual
 * pairs (a Chinese line followed by its English line, or "标题 / Title") keep one side.
 */
export function parseReleaseNotes(notes: string, lang?: string): NoteBlock[] {
  const text = notes
    .replace(/\r\n?/g, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "");
  const blocks: NoteBlock[] = [];
  let open: NoteBlock | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) {
      open = null;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const item = /^[-*+]\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: heading[1].length <= 2 ? "h2" : "h3", lines: [heading[2]] });
      open = null;
    } else if (item) {
      open = { kind: "li", lines: [item[1]] };
      blocks.push(open);
    } else if (open) {
      open.lines.push(line);
    } else {
      open = { kind: "p", lines: [line] };
      blocks.push(open);
    }
  }
  const kept = blocks.filter((b) => !/^(\*\*)?Full Changelog\b/i.test(b.lines[0]));
  if (!lang) return kept;
  const zh = lang.toLowerCase().startsWith("zh");
  return kept.map((b) => {
    if (b.kind === "h2" || b.kind === "h3") {
      return { ...b, lines: [pickLanguage(b.lines[0].split(/\s+\/\s+/), zh).join(" / ")] };
    }
    return { ...b, lines: pickLanguage(b.lines, zh) };
  });
}

/** `**bold**` and `` `code` `` spans of one line. */
export function parseNoteInline(line: string): NoteSpan[] {
  const spans: NoteSpan[] = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`/g;
  let last = 0;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (m.index > last) spans.push({ text: line.slice(last, m.index) });
    spans.push(m[1] !== undefined ? { text: m[1], bold: true } : { text: m[2], code: true });
    last = re.lastIndex;
  }
  if (last < line.length) spans.push({ text: line.slice(last) });
  return spans;
}
