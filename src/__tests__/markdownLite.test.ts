import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../utils/markdownLite";

describe("renderMarkdown", () => {
  it("renders blocks", () => {
    const html = renderMarkdown("# Title\n\nSome **bold** and `code`.\n\n- a\n- [x] done\n\n1. one\n2. two\n\n---\n\n> quoted *text*");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<p>Some <strong>bold</strong> and <code>code</code>.</p>");
    expect(html).toContain("<ul><li>a</li><li class=\"task\"><input type=\"checkbox\" disabled checked> done</li></ul>");
    expect(html).toContain("<ol><li>one</li><li>two</li></ol>");
    expect(html).toContain("<hr>");
    expect(html).toContain("<blockquote><p>quoted <em>text</em></p></blockquote>");
  });

  it("keeps code fences verbatim", () => {
    const html = renderMarkdown("```bash\necho **not bold** <b>\n```");
    expect(html).toBe('<pre><code class="lang-bash">echo **not bold** &lt;b&gt;</code></pre>');
  });

  it("renders tables with alignment", () => {
    const html = renderMarkdown("| a | b |\n|---|--:|\n| 1 | 2 |");
    expect(html).toContain("<th>a</th><th style=\"text-align:right\">b</th>");
    expect(html).toContain("<td>1</td><td style=\"text-align:right\">2</td>");
  });

  it("escapes markup and unsafe links", () => {
    const html = renderMarkdown('<script>alert(1)</script> [x](javascript:alert(1)) [ok](https://a.b/?q=1&r=2) <img src=x onerror=1>');
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('<a href="https://a.b/?q=1&amp;r=2" target="_blank" rel="noreferrer">ok</a>');
  });

  it("does not load remote images", () => {
    expect(renderMarkdown("![logo](https://x.y/a.png)")).toContain('<a href="https://x.y/a.png"');
  });
});
