import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { modifier, openApp, openSeededFile, typeInEditor } from "./helpers";

const DOC_PATH = "/docs/MARKDOWN-SYNTAX.md";
const DOC_TEXT = readFileSync(path.join(__dirname, "../docs/MARKDOWN-SYNTAX.md"), "utf8");
const SECTION_HEADING = "## 4. 删除线、高亮、上下标";
const SECTION_LINE = DOC_TEXT.slice(0, DOC_TEXT.indexOf(SECTION_HEADING)).split("\n").length;

/** Extracts top-level fenced blocks, ignoring examples nested in longer fences. */
function topLevelFences(markdown: string, language: string): string[] {
  const lines = markdown.split("\n");
  const fences: string[] = [];
  let open: { char: string; length: number; language: string } | null = null;
  let body: string[] = [];

  for (const line of lines) {
    const match = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(line);
    if (!open) {
      if (match) {
        const marker = match[2] ?? "";
        open = {
          char: marker[0] ?? "`",
          length: marker.length,
          language: (match[3] ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "",
        };
        body = [];
      }
      continue;
    }

    if (
      match &&
      match[2]?.[0] === open.char &&
      (match[2]?.length ?? 0) >= open.length &&
      (match[3] ?? "").trim() === ""
    ) {
      if (open.language === language) {
        fences.push(body.join("\n").trim());
      }
      open = null;
      body = [];
      continue;
    }
    body.push(line);
  }

  return fences.filter(Boolean);
}

test("renders highlight, sub/sup and inline HTML in the syntax guide table", async ({ page }) => {
  expect(DOC_TEXT).toContain(SECTION_HEADING);
  await openApp(page, [{ path: DOC_PATH, text: DOC_TEXT }]);
  await openSeededFile(page, "MARKDOWN-SYNTAX.md");

  // Jump to the section-4 heading with CodeMirror's go-to-line dialog. The
  // caret ends on the heading, outside the table, so the table renders as a
  // block widget exactly as it does while reading the guide.
  await page.locator(".cm-content").focus();
  await page.keyboard.press(`${modifier()}+Alt+g`);
  await page.keyboard.type(String(SECTION_LINE));
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("status-bar")).toContainText(`第 ${SECTION_LINE} 行`);
  // Lazy block widgets change the document height; re-anchor the target line
  // so the Live Preview viewport actually decorates it.
  await page.locator(".cm-line.cm-activeLine").scrollIntoViewIfNeeded();

  const table = page.locator(".cm-md-table-block").filter({ hasText: "删除线" });
  await expect(table).toBeVisible();

  const row = (label: string) =>
    table.locator("tbody tr").filter({
      has: page.locator(`td:first-child > .cm-md-table-cell-view:text-is("${label}")`),
    });

  await expect(row("删除线").locator(".cm-md-strike")).toHaveText("文本");
  await expect(row("删除线").locator(".cm-md-strike")).toHaveCSS(
    "text-decoration-line",
    "line-through",
  );
  await expect(row("高亮").locator("mark.cm-md-highlight")).toHaveText("文本");
  await expect(row("下标").locator("sub")).toHaveText("2");
  await expect(row("上标").locator("sup")).toHaveText("2");
  await expect(row("下标（HTML）").locator("sub")).toHaveText("2");
  await expect(row("下划线").locator("u")).toHaveText("文本");
  await expect(row("标记").locator("mark")).toHaveText("文本");
  await expect(row("插入").locator("ins")).toHaveText("文本");
});

test("renders highlight markers in live preview text", async ({ page }) => {
  await openApp(page);
  await typeInEditor(page, "这是 ==hi== 内容");

  await expect(page.locator(".cm-md-highlight")).toHaveText("hi");
  await expect(page.locator(".cm-line").last()).not.toContainText("==");
});

test("renders inline HTML, alerts, emoji and footnotes from the guide", async ({ page }) => {
  await openApp(page, [{ path: DOC_PATH, text: DOC_TEXT }]);
  await openSeededFile(page, "MARKDOWN-SYNTAX.md");
  await page.locator(".cm-content").focus();

  const go = async (needle: string, from = 0) => {
    const line = DOC_TEXT.slice(0, DOC_TEXT.indexOf(needle, from)).split("\n").length;
    await page.keyboard.press(`${modifier()}+Alt+g`);
    await page.keyboard.type(String(line));
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("status-bar")).toContainText(`第 ${line} 行`);
    // Lazy block widgets change the document height; re-anchor the target line
    // so the Live Preview viewport actually decorates it.
    await page.locator(".cm-line.cm-activeLine").scrollIntoViewIfNeeded();
  };

  await go("渲染效果：<kbd>Ctrl</kbd>");
  await expect(page.locator("kbd")).toHaveCount(3);
  await expect(page.locator("kbd").first()).toHaveText("Ctrl");

  await go("渲染效果：", DOC_TEXT.indexOf("## 15."));
  await expect(page.locator(".cm-md-footnote-ref").first()).toHaveText("1");
  await expect(page.locator(".cm-md-footnote-def-label").first()).toHaveText("1.");

  await go("渲染效果：", DOC_TEXT.indexOf("## 19."));
  await expect(page.locator(".cm-md-alert-label").first()).toHaveText("NOTE");
  await expect(page.locator(".cm-md-alert").first()).toHaveCSS("font-style", "normal");

  await go("渲染效果：:smile:");
  await expect(page.locator(".cm-md-emoji")).toHaveCount(8);
});

test("renders inline and block math with KaTeX from the guide", async ({ page }) => {
  await openApp(page, [{ path: DOC_PATH, text: DOC_TEXT }]);
  await openSeededFile(page, "MARKDOWN-SYNTAX.md");
  await page.locator(".cm-content").focus();

  const go = async (needle: string, from = 0) => {
    const line = DOC_TEXT.slice(0, DOC_TEXT.indexOf(needle, from)).split("\n").length;
    await page.keyboard.press(`${modifier()}+Alt+g`);
    await page.keyboard.type(String(line));
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("status-bar")).toContainText(`第 ${line} 行`);
    // Lazy block widgets change the document height; keep re-anchoring the
    // target line until it settles inside the decorated viewport.
    const active = page.locator(".cm-line.cm-activeLine");
    await expect
      .poll(
        async () => {
          await active.scrollIntoViewIfNeeded();
          return active.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return rect.top >= 0 && rect.bottom <= window.innerHeight;
          });
        },
        { timeout: 15_000 },
      )
      .toBe(true);
  };

  await go("渲染效果：质能方程");
  const mathLine = page.locator(".cm-line").filter({ hasText: "渲染效果：质能方程" });
  await expect
    .poll(
      async () => {
        await mathLine.scrollIntoViewIfNeeded();
        return mathLine.locator(".cm-md-math-inline .katex").count();
      },
      { timeout: 20_000 },
    )
    .toBe(3);

  await go("渲染效果：", DOC_TEXT.indexOf("### 18.2"));
  // The document header was removed, so the taller viewport may expose the
  // neighbouring math block too; assert the first block renders KaTeX.
  const block = page.locator(".cm-md-math-block").first();
  await expect
    .poll(
      async () => {
        await block.scrollIntoViewIfNeeded();
        return block.locator(".katex").count();
      },
      { timeout: 20_000 },
    )
    .toBe(1);
  await expect(block).toBeVisible();
});

const FENCED_MATH_DOC = `\`\`\`math
\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}
\`\`\`

结尾段落
`;

test("renders a fenced math block with KaTeX", async ({ page }) => {
  await openApp(page, [{ path: "/docs/fenced-math.md", text: FENCED_MATH_DOC }]);
  await openSeededFile(page, "fenced-math.md");
  await page.locator(".cm-line").filter({ hasText: "结尾段落" }).click();

  const block = page.locator(".cm-md-math-block");
  await expect(block.locator(".katex")).toHaveCount(1);
  await expect(block).toBeVisible();
  await expect(page.locator(".cm-md-code-language")).toHaveCount(0);

  await block.dispatchEvent("mousedown", { button: 0 });
  await expect(page.getByTestId("status-bar")).toContainText("第 1 行");
  await expect(page.locator(".cm-content")).toContainText("```math");
});

test("renders Mermaid diagrams from the guide in a sandboxed frame", async ({ page }) => {
  await openApp(page, [{ path: DOC_PATH, text: DOC_TEXT }]);
  await openSeededFile(page, "MARKDOWN-SYNTAX.md");
  await page.locator(".cm-content").focus();

  const go = async (needle: string, from = 0) => {
    const line = DOC_TEXT.slice(0, DOC_TEXT.indexOf(needle, from)).split("\n").length;
    await page.keyboard.press(`${modifier()}+Alt+g`);
    await page.keyboard.type(String(line));
    await page.keyboard.press("Enter");
  };

  await go("渲染效果：", DOC_TEXT.indexOf("## 23."));
  const diagram = page.locator(".cm-md-mermaid").first();
  await expect(diagram.locator("svg")).toBeVisible({ timeout: 30_000 });
  await expect(diagram).toHaveAttribute("role", "group");
  await expect(diagram.locator("svg")).toHaveAttribute("role", "img");

  // The renderer page itself lives in an off-screen sandbox iframe.
  const sandbox = page.locator("iframe.cm-md-mermaid-sandbox");
  await expect(sandbox).toHaveCount(1);
  await expect(sandbox).toHaveAttribute("sandbox", "allow-scripts allow-same-origin");

  // Only the explicit source tool returns the caret to the fence; clicking
  // the rendered plate itself must keep it visible (scrollbars stay usable).
  const clicked = await diagram.elementHandle();
  expect(clicked).not.toBeNull();
  await diagram.hover();
  await diagram.getByRole("button", { name: "编辑 Mermaid 源码" }).click();
  await expect.poll(async () => clicked?.evaluate((element) => element.isConnected)).toBe(false);
  await expect(page.locator(".cm-line").filter({ hasText: "flowchart LR" }).first()).toBeVisible();
});

test("re-renders Mermaid diagrams when the theme changes", async ({ page }) => {
  await openApp(page, [{ path: DOC_PATH, text: DOC_TEXT }]);
  await openSeededFile(page, "MARKDOWN-SYNTAX.md");
  await page.locator(".cm-content").focus();

  const line = DOC_TEXT.slice(0, DOC_TEXT.indexOf("渲染效果：", DOC_TEXT.indexOf("## 23."))).split(
    "\n",
  ).length;
  await page.keyboard.press(`${modifier()}+Alt+g`);
  await page.keyboard.type(String(line));
  await page.keyboard.press("Enter");

  const diagram = page.locator(".cm-md-mermaid").first();
  await expect(diagram).toHaveAttribute("data-mermaid-theme", "default", {
    timeout: 30_000,
  });

  await page.evaluate(() => {
    document.documentElement.setAttribute("data-theme", "dark");
  });
  await expect(diagram).toHaveAttribute("data-mermaid-theme", "dark", {
    timeout: 30_000,
  });
});

const PRODUCTION_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self' data:; " +
  "connect-src 'self' ipc: http://ipc.localhost; frame-src 'self'; " +
  "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

test("renders Mermaid under the production CSP", async ({ page }) => {
  await page.route("**/*", async (route) => {
    const response = await route.fetch();
    const headers = { ...response.headers() };
    if ((headers["content-type"] ?? "").includes("text/html")) {
      headers["content-security-policy"] = PRODUCTION_CSP;
    }
    await route.fulfill({ response, headers });
  });

  await openApp(page, [{ path: DOC_PATH, text: DOC_TEXT }]);
  await openSeededFile(page, "MARKDOWN-SYNTAX.md");
  await page.locator(".cm-content").focus();

  const line = DOC_TEXT.slice(0, DOC_TEXT.indexOf("渲染效果：", DOC_TEXT.indexOf("## 23."))).split(
    "\n",
  ).length;
  await page.keyboard.press(`${modifier()}+Alt+g`);
  await page.keyboard.type(String(line));
  await page.keyboard.press("Enter");

  await expect(page.locator(".cm-md-mermaid svg").first()).toBeVisible({
    timeout: 30_000,
  });
});

test("renders every top-level Mermaid diagram in the guide", async ({ page }) => {
  test.setTimeout(180_000);
  const diagrams = topLevelFences(DOC_TEXT, "mermaid");
  expect(diagrams).toHaveLength(35);

  await page.addInitScript(() => {
    (window as unknown as { __mermaidReady?: boolean }).__mermaidReady = false;
    window.addEventListener("message", (event) => {
      if ((event.data as { type?: string } | null)?.type === "qingmo:mermaid:ready") {
        (window as unknown as { __mermaidReady?: boolean }).__mermaidReady = true;
      }
    });
  });
  await page.goto("/mermaid-renderer.html");
  await page.waitForFunction(
    () => (window as unknown as { __mermaidReady?: boolean }).__mermaidReady === true,
    undefined,
    { timeout: 20_000 },
  );

  const failures = await page.evaluate(async (codes: string[]) => {
    const failed: Array<{ index: number; error: string }> = [];
    for (let index = 0; index < codes.length; index += 1) {
      const requestId = index + 1;
      const result = await new Promise<{ error: string | null }>((resolve) => {
        const timer = window.setTimeout(() => {
          window.removeEventListener("message", onMessage);
          resolve({ error: "timeout" });
        }, 25_000);
        function onMessage(event: MessageEvent): void {
          const data = event.data as {
            type?: string;
            requestId?: number;
            error?: unknown;
          } | null;
          if (data?.type !== "qingmo:mermaid:result" || data.requestId !== requestId) {
            return;
          }
          window.clearTimeout(timer);
          window.removeEventListener("message", onMessage);
          resolve({ error: typeof data.error === "string" ? data.error : null });
        }
        window.addEventListener("message", onMessage);
        window.postMessage(
          { type: "qingmo:mermaid:render", requestId, code: codes[index], theme: "default" },
          "*",
        );
      });
      if (result.error) {
        failed.push({ index: index + 1, error: result.error });
      }
    }
    return failed;
  }, diagrams);

  expect(failures).toEqual([]);
});

test("renders a collapsible details block from the guide", async ({ page }) => {
  await openApp(page, [{ path: DOC_PATH, text: DOC_TEXT }]);
  await openSeededFile(page, "MARKDOWN-SYNTAX.md");
  await page.locator(".cm-content").focus();

  const line = DOC_TEXT.slice(0, DOC_TEXT.indexOf("渲染效果：", DOC_TEXT.indexOf("## 20."))).split(
    "\n",
  ).length;
  await page.keyboard.press(`${modifier()}+Alt+g`);
  await page.keyboard.type(String(line));
  await page.keyboard.press("Enter");

  const details = page.locator(".cm-md-details").first();
  await expect(details).toBeVisible();
  await expect(details.locator(".cm-md-details-label")).toHaveText("点击查看完整日志");
  const content = details.locator(".cm-md-details-content");
  await expect(content).toBeHidden();

  await details.locator(".cm-md-details-summary").click();
  await expect(content).toBeVisible();
  await expect(content).toContainText("server started");

  await details.locator(".cm-md-details-edit").dispatchEvent("mousedown", { button: 0 });
  await expect(page.locator(".cm-md-details")).toHaveCount(0);
  await expect(page.locator(".cm-line").filter({ hasText: "<details>" }).first()).toBeVisible();
});

test("renders definition lists from the guide", async ({ page }) => {
  await openApp(page, [{ path: DOC_PATH, text: DOC_TEXT }]);
  await openSeededFile(page, "MARKDOWN-SYNTAX.md");
  await page.locator(".cm-content").focus();

  const line = DOC_TEXT.slice(0, DOC_TEXT.indexOf("渲染效果（需渲染器支持）：")).split("\n").length;
  await page.keyboard.press(`${modifier()}+Alt+g`);
  await page.keyboard.type(String(line));
  await page.keyboard.press("Enter");

  const lists = page.locator(".cm-md-definition-list");
  await expect(lists).toHaveCount(2);
  await expect(lists.first()).toContainText("Markdown");
  await expect(lists.first()).toContainText("一种轻量级标记语言");
});

const STRUCTURED_DOC = `---
title: 结构化文档
tags:
  - markdown
  - toc
draft: false
---

[TOC]

# 第一节

Markdown
: 一种轻量级标记语言。

## 子节

正文。
`;

test("renders front matter, a generated TOC and definition lists", async ({ page }) => {
  await openApp(page, [{ path: "/docs/structured.md", text: STRUCTURED_DOC }]);
  await openSeededFile(page, "structured.md");
  await page.locator(".cm-content").focus();
  await page.keyboard.press(`${modifier()}+End`);

  const frontMatter = page.locator(".cm-md-frontmatter");
  await expect(frontMatter).toBeVisible();
  await expect(frontMatter).toContainText("title");
  await expect(frontMatter).toContainText("结构化文档");

  const tocItems = page.locator(".cm-md-toc-item");
  await expect(tocItems).toHaveCount(2);
  await expect(page.locator(".cm-md-definition-list")).toContainText("一种轻量级标记语言");

  await tocItems.filter({ hasText: "子节" }).click();
  await expect(page.locator(".cm-line").filter({ hasText: "## 子节" })).toBeVisible();

  await frontMatter.click();
  await expect(page.locator(".cm-md-frontmatter")).toHaveCount(0);
  await expect(page.locator(".cm-line").filter({ hasText: "title: 结构化文档" })).toBeVisible();
});

const EXTENSIONS_DOC = `*[HTML]: HyperText Markup Language

HTML is a markup language. HTML5 stays unchanged.

See [[笔记名称]] and [[笔记名称|显示文字]] and [[笔记名称#标题]] and ![[图片.png]] and ![[笔记名称]].

<details>
  <summary>无空行折叠</summary>
  隐藏内容
</details>

<details>
<summary>外层</summary>

外层内容

<details open>
<summary>内层</summary>

内层内容

</details>

</details>
`;

test("renders abbreviations, wiki links and nested details", async ({ page }) => {
  await openApp(page, [{ path: "/docs/extensions.md", text: EXTENSIONS_DOC }]);
  await openSeededFile(page, "extensions.md");
  await page.locator(".cm-line").filter({ hasText: "HTML is a markup language" }).click();

  await expect(page.locator(".cm-md-abbr-def")).toContainText("HyperText Markup Language");
  const marks = page.locator(".cm-md-abbr");
  await expect(marks).toHaveCount(1);
  await expect(marks).toHaveText("HTML");

  const wikiLinks = page.locator(".cm-md-wiki-link");
  await expect(wikiLinks).toHaveCount(4);
  await expect(wikiLinks.nth(1)).toContainText("显示文字");
  await expect(page.locator(".cm-md-wiki-embed")).toContainText("笔记名称");
  await expect(page.locator(".cm-md-image")).toHaveCount(1);
  await expect(page.locator(".cm-md-image")).toContainText("图片.png");

  const topLevel = page.locator(".cm-md-details:not(.cm-md-details-nested)");
  await expect(topLevel).toHaveCount(2);
  const inlineDetails = topLevel.first();
  await expect(inlineDetails.locator(".cm-md-details-label")).toHaveText("无空行折叠");
  await expect(inlineDetails.locator(".cm-md-details-content")).toBeHidden();
  await inlineDetails.locator(".cm-md-details-summary").click();
  await expect(inlineDetails.locator(".cm-md-details-content")).toBeVisible();
  await expect(inlineDetails.locator(".cm-md-details-content")).toContainText("隐藏内容");

  const outer = topLevel.nth(1);
  await outer.locator(":scope > .cm-md-details-header .cm-md-details-summary").click();
  const nested = outer.locator(".cm-md-details-nested");
  await expect(nested).toBeVisible();
  await expect(nested.locator(":scope > .cm-md-details-header .cm-md-details-label")).toHaveText(
    "内层",
  );
  const nestedContent = nested.locator(":scope > .cm-md-details-content");
  await expect(nestedContent).toBeVisible();
  await expect(nestedContent).toContainText("内层内容");

  await nested.locator(":scope > .cm-md-details-header .cm-md-details-summary").click();
  await expect(nestedContent).toBeHidden();
});

const JSON_FRONTMATTER_DOC = `{
  "title": "JSON 文档",
  "tags": ["markdown", "json"],
  "draft": false
}

# 标题
`;

test("renders JSON front matter", async ({ page }) => {
  await openApp(page, [{ path: "/docs/json-frontmatter.md", text: JSON_FRONTMATTER_DOC }]);
  await openSeededFile(page, "json-frontmatter.md");
  await page.locator(".cm-content").focus();
  await page.keyboard.press(`${modifier()}+End`);

  const frontMatter = page.locator(".cm-md-frontmatter");
  await expect(frontMatter).toBeVisible();
  await expect(frontMatter).toContainText("JSON");
  await expect(frontMatter).toContainText("JSON 文档");
  await expect(frontMatter).toContainText("markdown, json");

  await frontMatter.click();
  await expect(page.locator(".cm-md-frontmatter")).toHaveCount(0);
  await expect(page.locator(".cm-line").filter({ hasText: '"title": "JSON 文档"' })).toBeVisible();
});

const CODE_INFO_DOC = `\`\`\`js title="app.js" {2,4-5}
const a = 1;
console.log(a); // 高亮
const b = 2;
console.log(b); // 高亮
console.log(a + b); // 高亮
\`\`\`
`;

test("renders code block titles and highlighted lines", async ({ page }) => {
  await openApp(page, [{ path: "/docs/code-info.md", text: CODE_INFO_DOC }]);
  await openSeededFile(page, "code-info.md");
  await page.locator(".cm-content").focus();
  await page.keyboard.press(`${modifier()}+End`);

  const info = page.locator(".cm-md-code-info");
  await expect(info).toBeVisible();
  await expect(info.locator(".cm-md-code-language")).toHaveText("js");
  await expect(info.locator(".cm-md-code-title")).toHaveText("app.js");

  const highlighted = page.locator(".cm-line.cm-md-code-highlight");
  await expect(highlighted).toHaveCount(3);
  await expect(highlighted.nth(0)).toContainText("console.log(a);");
  await expect(highlighted.nth(1)).toContainText("console.log(b);");
  await expect(highlighted.nth(2)).toContainText("console.log(a + b);");

  await page.keyboard.press(`${modifier()}+Home`);
  await expect(page.locator(".cm-md-code-info")).toHaveCount(0);
  await expect(page.locator(".cm-line").first()).toContainText('```js title="app.js"');
});

const DIFF_DOC = `\`\`\`diff
- const port = 3000;
+ const port = 8080;
  const host = "localhost";
\`\`\`
`;

test("colors added and removed diff code lines", async ({ page }) => {
  await openApp(page, [{ path: "/docs/diff.md", text: DIFF_DOC }]);
  await openSeededFile(page, "diff.md");
  await page.locator(".cm-content").focus();
  await page.keyboard.press(`${modifier()}+End`);

  const added = page.locator(".cm-line.cm-md-code-diff-add");
  const removed = page.locator(".cm-line.cm-md-code-diff-del");
  await expect(added).toHaveCount(1);
  await expect(removed).toHaveCount(1);
  await expect(added).toContainText("+ const port = 8080;");
  await expect(removed).toContainText("- const port = 3000;");
  await expect(page.locator(".cm-md-code-language")).toHaveText("diff");
});

const MEDIA_DOC = `<video src="./demo.mp4" controls width="480"></video>

<audio src="./demo.mp3" controls></audio>

<picture>
<source srcset="./dark.png" media="(prefers-color-scheme: dark)" />
<img src="./light.png" alt="Logo" />
</picture>

<iframe src="https://example.com/demo" width="480" height="270"></iframe>
`;

test("renders video, audio and picture blocks", async ({ page }) => {
  await openApp(page, [{ path: "/docs/media.md", text: MEDIA_DOC }]);
  await openSeededFile(page, "media.md");
  await page.locator(".cm-content").focus();
  await page.keyboard.press(`${modifier()}+End`);

  const video = page.locator(".cm-md-media-video");
  await expect(video).toBeVisible();
  await expect(video.locator(".cm-md-media-badge")).toHaveText("视频");
  await expect(video.locator(".cm-md-media-name")).toHaveText("demo.mp4");

  const audio = page.locator(".cm-md-media-audio");
  await expect(audio).toBeVisible();
  await expect(audio.locator(".cm-md-media-name")).toHaveText("demo.mp3");

  const picture = page.locator(".cm-md-media-picture");
  await expect(picture).toBeVisible();
  await expect(picture.locator(".cm-md-media-badge")).toHaveText("图片组");

  const embed = page.locator(".cm-md-media-iframe");
  await expect(embed).toBeVisible();
  await expect(embed.locator(".cm-md-media-badge")).toHaveText("外部嵌入");
  await expect(embed).toContainText("example.com/demo");
  await expect(embed).toContainText("不会在编辑器中加载");
  await expect(embed.locator("iframe")).toHaveCount(0);

  await video.locator(".cm-md-media-edit").dispatchEvent("mousedown", { button: 0 });
  await expect(page.locator(".cm-md-media-video")).toHaveCount(0);
  await expect(page.locator(".cm-line").filter({ hasText: "<video src=" })).toBeVisible();
  await expect(page.locator(".cm-md-media-audio")).toBeVisible();
});

const HTML_IMAGE_DOC = `<figure>
<img src="./arch.png" alt="架构图" width="400" />
<figcaption>图 1：**系统**架构示意</figcaption>
</figure>

<img src="./pic.png" alt="示例" width="50%" />

<div align="center">
<img src="./center.png" alt="居中图片" width="320" />
</div>

普通段落
`;

test("renders HTML figures, standalone images and centered containers", async ({ page }) => {
  await openApp(page, [{ path: "/docs/html-images.md", text: HTML_IMAGE_DOC }]);
  await openSeededFile(page, "html-images.md");
  await page.locator(".cm-line").filter({ hasText: "普通段落" }).click();

  const figure = page.locator(".cm-md-media-figure");
  await expect(figure).toHaveCount(1);
  await expect(figure.locator(".cm-md-media-badge")).toHaveText("图片配文");
  await expect(figure.locator("figcaption")).toHaveText("图 1：系统架构示意");
  await expect(figure.locator("figcaption strong")).toHaveText("系统");
  await expect(page.locator(".cm-content")).not.toContainText("<figure>");

  const image = page.locator(".cm-md-media-img");
  await expect(image).toHaveCount(1);
  await expect(image.locator(".cm-md-media-badge")).toHaveText("图片");
  await expect(image).toContainText("示例");

  const center = page.locator(".cm-md-media-center");
  await expect(center).toHaveCount(1);
  await expect(center.locator(".cm-md-media-badge")).toHaveText("居中图片");
  await expect(center).toContainText("居中图片");
  await expect(page.locator(".cm-content")).not.toContainText('<div align="center">');
});

const COMMENT_DOC = `<!--
多行注释
也不会渲染
-->

%% Obsidian 注释 %%

正文 %% 行内注释 %% 结束

最后一段
`;

test("collapses HTML and Obsidian comments", async ({ page }) => {
  await openApp(page, [{ path: "/docs/comments.md", text: COMMENT_DOC }]);
  await openSeededFile(page, "comments.md");
  await page.locator(".cm-line").filter({ hasText: "最后一段" }).click();

  const comments = page.locator(".cm-md-comment");
  await expect(comments).toHaveCount(2);
  await expect(comments.first()).toContainText("HTML 注释");
  await expect(comments.nth(1)).toContainText("Obsidian 注释");
  await expect(page.locator(".cm-content")).not.toContainText("多行注释");
  await expect(page.locator(".cm-content")).not.toContainText("行内注释");
  await expect(page.locator(".cm-content")).toContainText("正文");
  await expect(page.locator(".cm-content")).toContainText("结束");

  await comments.first().locator(".cm-md-comment-edit").dispatchEvent("mousedown", { button: 0 });
  await expect(page.locator(".cm-md-comment")).toHaveCount(1);
  await expect(page.locator(".cm-line").filter({ hasText: "多行注释" })).toBeVisible();
});

const MANUAL_TOC_DOC =
  "# 第一节\n" +
  "\n" +
  "- [第一节](#第一节)\n" +
  "- [第二节](#第二节)\n" +
  "\n" +
  "填充段落。\n\n".repeat(14) +
  "# 第二节\n";

test("jumps from a manual table of contents link", async ({ page }) => {
  await openApp(page, [{ path: "/docs/manual-toc.md", text: MANUAL_TOC_DOC }]);
  await openSeededFile(page, "manual-toc.md");

  const links = page.locator(".cm-md-anchor-link");
  await expect(links).toHaveCount(2);
  await expect(links.nth(1)).toHaveText("第二节");

  const targetLine = MANUAL_TOC_DOC.slice(0, MANUAL_TOC_DOC.indexOf("# 第二节")).split("\n").length;
  await links.nth(1).dispatchEvent("mousedown", { button: 0 });
  await expect(page.getByTestId("status-bar")).toContainText(`第 ${targetLine} 行`);
  await expect(page.locator(".cm-line").filter({ hasText: "# 第二节" })).toBeVisible();
});

const ATTRIBUTE_DOC = `![图片](logo.png){width=200 height=100}

一段文字
{: .warning #custom-id}
`;

test("hides image and paragraph attribute blocks", async ({ page }) => {
  await openApp(page, [{ path: "/docs/attributes.md", text: ATTRIBUTE_DOC }]);
  await openSeededFile(page, "attributes.md");
  await page.locator(".cm-line").filter({ hasText: "一段文字" }).click();

  await expect(page.locator(".cm-md-image")).toHaveCount(1);
  const badge = page.locator(".cm-md-attr-badge");
  await expect(badge).toBeVisible();
  await expect(badge).toContainText("属性");
  await expect(badge).toContainText(".warning #custom-id");
  await expect(page.locator(".cm-line.cm-md-attr-warning")).toHaveCount(1);
  await expect(page.locator(".cm-content")).not.toContainText("{width=200");
  await expect(page.locator(".cm-content")).not.toContainText("{: .warning");
});

const LINK_DOC = `[带标题](https://example.com "悬停提示") and [参考][ref] and https://bare.example

[ref]: https://openai.com "OpenAI"

结尾段落
`;

test("renders inline, reference and bare links with titles", async ({ page }) => {
  await openApp(page, [{ path: "/docs/links.md", text: LINK_DOC }]);
  await openSeededFile(page, "links.md");
  await page.locator(".cm-line").filter({ hasText: "结尾段落" }).click();

  await expect(page.locator('.cm-md-link[title="悬停提示"]')).toHaveText("带标题");
  await expect(page.locator('.cm-md-link[title="OpenAI"]')).toHaveText("参考");
  await expect(page.locator('.cm-md-link[title="https://bare.example"]')).toHaveText(
    "https://bare.example",
  );
  await expect(page.locator(".cm-line").first()).not.toContainText("[ref]");
});

const HTML_ANCHOR_DOC = `<a id="install"></a>
## 安装

跳转 [安装](#install)

结尾段落
`;

test("renders an explicit HTML anchor and jumps to its heading", async ({ page }) => {
  await openApp(page, [{ path: "/docs/html-anchor.md", text: HTML_ANCHOR_DOC }]);
  await openSeededFile(page, "html-anchor.md");
  await page.locator(".cm-line").filter({ hasText: "结尾段落" }).click();

  const badge = page.locator(".cm-md-html-anchor");
  await expect(badge).toHaveCount(1);
  await expect(badge).toContainText("#install");
  await expect(page.locator(".cm-content")).not.toContainText('<a id="install">');

  const link = page.locator(".cm-md-anchor-link");
  await expect(link).toHaveText("安装");
  await link.dispatchEvent("mousedown", { button: 0 });
  await expect(page.getByTestId("status-bar")).toContainText("第 2 行");
});

const HTML_TABLE_DOC = `<table>
  <caption>**系统** 架构</caption>
  <thead>
    <tr><th rowspan="2">模块</th><th colspan="2">状态</th></tr>

    <tr><th>CPU</th><th>内存</th></tr>
  </thead>
  <tbody>
    <tr><td rowspan="2" onclick="alert(1)">API</td><td>10%</td><td>20%</td></tr>
    <tr><td colspan="3">**合并**</td></tr>
  </tbody>
</table>

<table><tr><td><script>alert(1)</script></td><td><img src=x onerror=alert(1)></td></tr></table>

结尾段落
`;

test("renders HTML tables with spans and keeps dangerous HTML inert", async ({ page }) => {
  await openApp(page, [{ path: "/docs/html-table.md", text: HTML_TABLE_DOC }]);
  await openSeededFile(page, "html-table.md");
  await page.locator(".cm-line").filter({ hasText: "结尾段落" }).click();

  const blocks = page.locator(".cm-md-html-table-block");
  await expect(blocks).toHaveCount(2);

  const table = blocks.first();
  await expect(table.locator("caption strong")).toHaveText("系统");
  await expect(table.locator('th[rowspan="2"]')).toHaveText("模块");
  await expect(table.locator('th[colspan="2"]')).toHaveText("状态");
  await expect(table.locator('td[rowspan="2"]')).toContainText("API");
  await expect(table.locator("tbody tr").nth(1).locator("strong")).toHaveText("合并");
  await expect(table.locator("[onclick]")).toHaveCount(0);

  const dangerous = blocks.nth(1);
  await expect(dangerous.locator("script")).toHaveCount(0);
  await expect(dangerous.locator("img")).toHaveCount(0);
  await expect(dangerous).toContainText("alert(1)");

  await table.locator("td").first().dispatchEvent("mousedown", { button: 0 });
  await expect(page.getByTestId("status-bar")).toContainText("第 1 行");
  await expect(page.locator(".cm-content")).toContainText("<table>");
  await expect(page.locator(".cm-md-html-table-block")).toHaveCount(1);
});

const DEGRADED_DOC = `![[笔记名称]]

\`\`\`plantuml
@startuml
Alice -> Bob: Hello
@enduml
\`\`\`

结尾段落
`;

test("labels unsupported note embeds and external diagrams", async ({ page }) => {
  await openApp(page, [{ path: "/docs/degraded.md", text: DEGRADED_DOC }]);
  await openSeededFile(page, "degraded.md");
  await page.locator(".cm-line").filter({ hasText: "结尾段落" }).click();

  const embed = page.locator(".cm-md-wiki-embed");
  await expect(embed).toContainText("笔记名称");
  await expect(embed).toHaveAttribute("title", /不展开笔记内容/);

  const hint = page.locator(".cm-md-code-external");
  await expect(hint).toHaveText("需外部渲染");
  await expect(hint).toHaveAttribute("title", /PlantUML 需要外部渲染器/);
  await expect(page.locator(".cm-md-code-language")).toHaveText("plantuml");
  await expect(page.locator(".cm-content")).toContainText("@startuml");
});

const ATTRIBUTE_ANCHOR_DOC = `# 前言

目标段落
{: .warning #target}

跳转 [目标](#target)

结尾段落
`;

test("jumps to a paragraph attribute id", async ({ page }) => {
  await openApp(page, [{ path: "/docs/attribute-anchor.md", text: ATTRIBUTE_ANCHOR_DOC }]);
  await openSeededFile(page, "attribute-anchor.md");
  await page.locator(".cm-line").filter({ hasText: "结尾段落" }).click();

  const link = page.locator(".cm-md-anchor-link");
  await expect(link).toHaveText("目标");
  await expect(page.locator(".cm-md-attr-badge")).toBeVisible();

  const targetLine = ATTRIBUTE_ANCHOR_DOC.slice(0, ATTRIBUTE_ANCHOR_DOC.indexOf("目标段落")).split(
    "\n",
  ).length;
  await link.dispatchEvent("mousedown", { button: 0 });
  await expect(page.getByTestId("status-bar")).toContainText(`第 ${targetLine} 行`);
  await expect(page.locator(".cm-line").filter({ hasText: "目标段落" })).toBeVisible();
});

const FOOTNOTE_DOC = "Text[^1].\n\n" + "填充段落。\n\n".repeat(12) + "[^1]: Footnote text.\n";

test("jumps from a footnote reference to its definition", async ({ page }) => {
  await openApp(page, [{ path: "/docs/footnotes.md", text: FOOTNOTE_DOC }]);
  await openSeededFile(page, "footnotes.md");

  const reference = page.locator(".cm-md-footnote-jump");
  await expect(reference).toHaveCount(1);
  await expect(reference).toHaveText("1");

  const targetLine = FOOTNOTE_DOC.slice(0, FOOTNOTE_DOC.indexOf("[^1]:")).split("\n").length;
  await reference.dispatchEvent("mousedown", { button: 0 });
  await expect(page.getByTestId("status-bar")).toContainText(`第 ${targetLine} 行`);
  await expect(page.locator(".cm-content")).toContainText("Footnote text.");
});

const INLINE_FOOTNOTE_DOC = `行内脚注^[脚注内容直接写在正文中。] 结束。

普通段落
`;

test("renders inline footnotes with a content tooltip", async ({ page }) => {
  await openApp(page, [{ path: "/docs/inline-footnotes.md", text: INLINE_FOOTNOTE_DOC }]);
  await openSeededFile(page, "inline-footnotes.md");
  await page.locator(".cm-line").filter({ hasText: "普通段落" }).click();

  const note = page.locator(".cm-md-footnote-inline");
  await expect(note).toHaveCount(1);
  await expect(note).toHaveText("注1");
  await expect(note).toHaveAttribute("title", "脚注内容直接写在正文中。");
  await expect(page.locator(".cm-content")).not.toContainText("^[");
});
