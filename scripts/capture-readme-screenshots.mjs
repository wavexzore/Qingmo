/* global window, document */
/**
 * Regenerates the README screenshots from the real UI.
 *
 * Usage:
 *   pnpm build:e2e
 *   pnpm --filter @qingmo/desktop preview:e2e &
 *   node scripts/capture-readme-screenshots.mjs
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const OUT = "assets/screenshots";
mkdirSync(OUT, { recursive: true });

const NOTE = `# 在湖边

> 好的工具应该退到文字后面，而不是站在文字前面。

清晨六点，湖面像一张还没有写字的纸。风从芦苇丛里穿过去，水面只动了一下，又很快恢复平静。

\`\`\`mermaid
flowchart LR
  A[打开文件] --> B[编辑]
  B --> C{保存}
  C -->|自动| D[原子写]
  C -->|冲突| E[暂停并提示]
\`\`\`

## 一 · 清晨

写作不是把想法倒出来，而是把它放到一个可以反复看见的地方。

- 打开即写，不等待
- 文件始终在自己的硬盘上
- 断网也能工作

| 场景 | 旧习惯 | 现在 |
| --- | --- | --- |
| 灵感 | 先找应用 | 打开就写 |
| 归档 | 上传云端 | 留在本地 |

行内公式 $E = mc^2$ 与代码 \`SaveCoordinator.flush()\` 都可以直接写。

\`\`\`ts
const note = "Markdown 是唯一的事实来源";
\`\`\`

### 继续写

脚注也可以[^1]。

[^1]: 纯文本，永远可被其他编辑器打开。
`;

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: "light",
});

await page.addInitScript(
  (seed) => {
    window.__QINGMO_E2E_SEED__ = seed;
    if (!localStorage.getItem("qingmo.ui.theme")) {
      localStorage.setItem("qingmo.ui.theme", "light");
    }
  },
  [{ path: "/docs/在湖边.md", text: NOTE }],
);

await page.goto("http://127.0.0.1:4173/");
await page.waitForFunction(() => Boolean(window.__QINGMO_E2E__));
await page.evaluate(() => window.__QINGMO_E2E__.emitMenuAction("file.open"));
await page.getByTestId("status-bar").waitFor();
await page.waitForTimeout(1200);

await page.addStyleTag({ content: ".cm-cursor, .cm-dropCursor { display: none !important; }" });
await page.locator(".cm-content").click();
await page.locator(".cm-line").last().click();
await page.waitForTimeout(600);
await page.getByTestId("status-bar").click();
await page.evaluate(() => {
  const scroller = document.querySelector(".cm-scroller");
  if (scroller) scroller.scrollTop = 0;
});
await page.waitForTimeout(2000);
await page.screenshot({ path: `${OUT}/editor-light.png` });

await page.evaluate(() => window.__QINGMO_E2E__.emitMenuAction("theme.dark"));
await page.waitForTimeout(1800);
await page.screenshot({ path: `${OUT}/editor-dark.png` });

await page.keyboard.press("Meta+k");
await page.getByRole("dialog").waitFor();
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/command-palette.png` });

await browser.close();
console.log("screenshots written to", OUT);
