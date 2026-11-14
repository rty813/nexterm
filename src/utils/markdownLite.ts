/**
 * Small Markdown to HTML renderer for the read-only file preview. Everything is escaped
 * first, so remote files cannot inject markup; links only keep http(s) / mailto targets.
 * Covers headings, paragraphs, lists, task lists, quotes, fenced code, tables, rules,
 * emphasis, inline code, links and images (shown as links: no remote fetches).
 */

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function safeUrl(url: string): string | null {
  const u = url.trim().replace(/&amp;/g, "&");
  return /^(https?:|mailto:)/i.test(u) ? escapeHtml(u) : null;
}

/** Inline markup of already escaped text. */
function inline(text: string): string {
  const codes: string[] = [];
  let s = text.replace(/`([^`]+)`/g, (_, c: string) => {
    codes.push(`<code>${c}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, alt: string, url: string) => {
    const u = safeUrl(url);
    return u ? `<a href="${u}" target="_blank" rel="noreferrer">🖼 ${alt || u}</a>` : alt;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, label: string, url: string) => {
    const u = safeUrl(url);
    return u ? `<a href="${u}" target="_blank" rel="noreferrer">${label}</a>` : label;
  });
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre: string, url: string) => `${pre}<a href="${url}" target="_blank" rel="noreferrer">${url}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a?: string, b?: string) => `<strong>${a ?? b}</strong>`);
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\*)|(^|[^_\w])_([^_\s][^_]*)_(?!\w)/g, (_, p1?: string, a?: string, p2?: string, b?: string) =>
    `${p1 ?? p2 ?? ""}<em>${a ?? b}</em>`
  );
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)]);
}

const splitRow = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

export function renderMarkdown(source: string): string {
  const lines = escapeHtml(source.replace(/\r\n?/g, "\n")).split("\n");
  const out: string[] = [];
  let i = 0;
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*(```|~~~)\s*([\w+-]*)/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      out.push(`<pre><code${fence[2] ? ` class="lang-${fence[2]}"` : ""}>${body.join("\n")}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.push("<hr>");
      i++;
      continue;
    }
    if (/^\s*&gt;/.test(line)) {
      flush();
      const body: string[] = [];
      while (i < lines.length && /^\s*&gt;/.test(lines[i])) body.push(lines[i++].replace(/^\s*&gt;\s?/, ""));
      out.push(`<blockquote>${renderMarkdownEscaped(body)}</blockquote>`);
      continue;
    }
    // Table: header row, then a |---|:---:| separator.
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      flush();
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : ""));
      const cell = (tag: string, c: string, k: number) => `<${tag}${aligns[k] ? ` style="text-align:${aligns[k]}"` : ""}>${inline(c)}</${tag}>`;
      i += 2;
      const rows: string[] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(`<tr>${splitRow(lines[i]).map((c, k) => cell("td", c, k)).join("")}</tr>`);
        i++;
      }
      out.push(`<table><thead><tr>${head.map((c, k) => cell("th", c, k)).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`);
      continue;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const ordered = /\d/.test(item[2]);
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (m) {
          items.push(m[3]);
          i++;
        } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
          items[items.length - 1] += ` ${lines[i].trim()}`;
          i++;
        } else break;
      }
      const lis = items.map((t) => {
        const task = /^\[([ xX])\]\s+(.*)$/.exec(t);
        return task
          ? `<li class="task"><input type="checkbox" disabled${task[1] === " " ? "" : " checked"}> ${inline(task[2])}</li>`
          : `<li>${inline(t)}</li>`;
      });
      out.push(ordered ? `<ol>${lis.join("")}</ol>` : `<ul>${lis.join("")}</ul>`);
      continue;
    }
    if (!line.trim()) {
      flush();
      i++;
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flush();
  return out.join("\n");
}

/** Nested blocks (quotes) of lines that are escaped already. */
function renderMarkdownEscaped(lines: string[]): string {
  const unescaped = lines.join("\n").replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
  return renderMarkdown(unescaped);
}
