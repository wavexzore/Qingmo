import { expect, test } from "@playwright/test";

import { getFileText, getOpenedLinks, modifier, openApp, openSeededFile } from "./helpers";

const TABLE_PATH = "/docs/table-edit.md";
const TABLE_DOC = "# 表格\n\n| 名称 | 数量 |\n| :--- | ---: |\n| 苹果 | 2 |\n\n结尾段落\n";

const LINK_TABLE_PATH = "/docs/table-links.md";
const LINK_TABLE_DOC = [
  "# 链接表格",
  "",
  "| 名称 | 链接 |",
  "| --- | --- |",
  "| 长链接 | https://www.liepin.com/job/1982639449.shtml ｜ https://www.liepin.com/job/1980694393.shtml ｜ https://www.quanzhi.com/job/6a749e07f87cf99210b41cc0 |",
  "",
  "结尾段落",
  "",
].join("\n");
const LINK_TABLE_VALUE =
  "https://www.liepin.com/job/1982639449.shtml ｜ https://www.liepin.com/job/1980694393.shtml ｜ https://www.quanzhi.com/job/6a749e07f87cf99210b41cc0";

const CODE_PATH = "/docs/code-badge.md";
const CODE_DOC =
  "# 代码\n\n```ts\nconst answer: number = 42;\nconsole.log(answer);\n```\n\n结尾段落\n";

test("edits a rendered table cell without revealing Markdown source", async ({ page }) => {
  await openApp(page, [{ path: TABLE_PATH, text: TABLE_DOC }]);
  await openSeededFile(page, "table-edit.md");

  const table = page.locator(".cm-md-table-block");
  await expect(table).toBeVisible();
  await expect(page.locator(".cm-md-table-header")).toHaveCount(0);

  const cell = table.locator('textarea[data-row="0"][data-col="1"]');
  await cell.click();
  await cell.fill("5");
  await page.keyboard.press("Enter");

  // The rendered table stays in place; only the cell text changed.
  await expect(table.locator("tbody tr").first().locator("td").nth(1)).toHaveText("5");
  await expect(page.locator(".cm-md-table-header")).toHaveCount(0);

  // Autosave serializes the edit back into the Markdown cell range while
  // preserving the surrounding padding and alignment row.
  await expect.poll(() => getFileText(page, TABLE_PATH)).toContain("| 苹果 | 5 |");
  await expect.poll(() => getFileText(page, TABLE_PATH)).toContain("| :--- | ---: |");
});

test("renders terminal chrome with a top-right language chip", async ({ page }) => {
  await openApp(page, [{ path: CODE_PATH, text: CODE_DOC }]);
  await openSeededFile(page, "code-badge.md");

  const block = page.locator(".cm-md-code-block-widget");
  await expect(block).toBeVisible();
  await expect(block).not.toContainText("```");

  const header = block.locator(".cm-md-code-header");
  await expect(header).toBeVisible();
  await expect(header.locator(".cm-md-code-dot")).toHaveCount(3);
  await expect(block.locator(".cm-md-code-copy")).toHaveAttribute("aria-label", "复制代码");
  await expect(block.locator(".cm-md-code-more")).toHaveAttribute("aria-label", "更多操作");

  const chip = header.locator("button.cm-md-code-language");
  await expect(chip).toHaveText("ts");

  const firstCodeLine = block.locator(".cm-line").filter({ hasText: "const answer" }).first();
  await expect(firstCodeLine).toBeVisible();
  const [chipBox, headerBox, copyBox, moreBox, blockBox, firstBox] = await Promise.all([
    chip.boundingBox(),
    header.boundingBox(),
    block.locator(".cm-md-code-copy").boundingBox(),
    block.locator(".cm-md-code-more").boundingBox(),
    block.boundingBox(),
    firstCodeLine.boundingBox(),
  ]);
  expect(chipBox).not.toBeNull();
  expect(headerBox).not.toBeNull();
  expect(copyBox).not.toBeNull();
  expect(moreBox).not.toBeNull();
  expect(blockBox).not.toBeNull();
  expect(firstBox).not.toBeNull();
  if (!chipBox || !headerBox || !copyBox || !moreBox || !blockBox || !firstBox) {
    return;
  }

  // The chrome bar sits above the code, and the language chip precedes the
  // copy/more actions inside it. The more button hugs the window's right inset.
  expect(headerBox.y).toBeLessThan(firstBox.y);
  expect(chipBox.y).toBeLessThan(firstBox.y);
  expect(chipBox.x).toBeGreaterThan(headerBox.x);
  expect(copyBox.x).toBeGreaterThan(chipBox.x + chipBox.width - 1);
  expect(moreBox.x).toBeGreaterThan(copyBox.x + copyBox.width - 1);
  const contentRight = blockBox.x + blockBox.width - 10;
  expect(Math.abs(moreBox.x + moreBox.width - contentRight)).toBeLessThan(20);

  // The nested TypeScript parser produces token spans with a different colour
  // from the surrounding code text.
  const keyword = block
    .locator(".cm-line span")
    .filter({ hasText: /^const$/ })
    .first();
  await expect(keyword).toBeVisible();
  const keywordColor = await keyword.evaluate((element) => getComputedStyle(element).color);
  const lineColor = await firstCodeLine.evaluate((element) => getComputedStyle(element).color);
  expect(keywordColor).not.toBe(lineColor);
});

test("undo inside the embedded editor stays within the code block", async ({ page }) => {
  await openApp(page, [{ path: CODE_PATH, text: CODE_DOC }]);
  await openSeededFile(page, "code-badge.md");

  const block = page.locator(".cm-md-code-block-widget");
  const line = block.locator(".cm-line").filter({ hasText: "const answer" }).first();
  await line.click();
  await page.keyboard.press("End");
  await page.keyboard.type("X");
  await expect.poll(() => getFileText(page, CODE_PATH)).toContain("42;X");

  await page.keyboard.press(`${modifier()}+z`);

  await expect.poll(() => getFileText(page, CODE_PATH)).toContain("const answer: number = 42;\n");
  await expect(block).toContainText("const answer: number = 42;");
  await expect(block).toContainText("console.log(answer);");
  await expect(block).toHaveCount(1);
});

test("edits code in place and updates the fence language", async ({ page }) => {
  await openApp(page, [{ path: CODE_PATH, text: CODE_DOC }]);
  await openSeededFile(page, "code-badge.md");

  const block = page.locator(".cm-md-code-block-widget");
  const secondLine = block.locator(".cm-line").filter({ hasText: "console.log(answer);" }).first();
  await secondLine.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" // ok");

  await expect.poll(() => getFileText(page, CODE_PATH)).toContain("console.log(answer); // ok");

  const chip = block.locator("button.cm-md-code-language");
  await chip.click();
  const search = block.locator(".cm-md-code-language-search");
  await expect(search).toBeVisible();
  await search.fill("js");
  await block.locator(".cm-md-code-language-option").filter({ hasText: "JavaScript" }).click();

  await expect.poll(() => getFileText(page, CODE_PATH)).toContain("```javascript\n");
  await expect(chip).toHaveText("javascript");
});

test("edits a long cell as wrapped raw Markdown instead of a clipped line", async ({ page }) => {
  await openApp(page, [{ path: LINK_TABLE_PATH, text: LINK_TABLE_DOC }]);
  await openSeededFile(page, "table-links.md");

  // Bare GFM URLs inside a cell render as links and keep their destination.
  await expect(
    page.locator(
      '.cm-md-table-block .cm-md-link[data-href="https://www.liepin.com/job/1980694393.shtml"]',
    ),
  ).toHaveCount(1);

  const cell = page.locator('.cm-md-table-cell-input[data-row="0"][data-col="1"]');
  await expect(cell).toHaveJSProperty("tagName", "TEXTAREA");
  await expect(cell).toHaveValue(LINK_TABLE_VALUE);

  await cell.focus();
  const metrics = await cell.evaluate((element) => {
    const textarea = element as HTMLTextAreaElement;
    const style = getComputedStyle(textarea);
    return {
      whiteSpace: style.whiteSpace,
      scrollWidth: textarea.scrollWidth,
      clientWidth: textarea.clientWidth,
      scrollHeight: textarea.scrollHeight,
      clientHeight: textarea.clientHeight,
    };
  });
  // The raw value wraps inside the cell: nothing is clipped horizontally and
  // the whole cell text stays visible without inner scrolling.
  expect(metrics.whiteSpace).toBe("pre-wrap");
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
  expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.clientHeight + 1);
});

test("opens a table link with the platform modifier and keeps a plain click editable", async ({
  page,
}) => {
  await openApp(page, [{ path: LINK_TABLE_PATH, text: LINK_TABLE_DOC }]);
  await openSeededFile(page, "table-links.md");

  const second = "https://www.liepin.com/job/1980694393.shtml";
  const link = page.locator(`.cm-md-table-block .cm-md-link[data-href="${second}"]`);
  await expect(link).toBeVisible();
  await link.click({ modifiers: [modifier()] });
  await expect.poll(() => getOpenedLinks(page)).toEqual([second]);

  // A plain click never opens the link; it focuses the cell editor so the raw
  // destination stays editable.
  const first = page.locator(
    '.cm-md-table-block .cm-md-link[data-href="https://www.liepin.com/job/1982639449.shtml"]',
  );
  await first.click();
  await expect(page.locator('.cm-md-table-cell-input[data-row="0"][data-col="1"]')).toBeFocused();
  expect(await getOpenedLinks(page)).toEqual([second]);
});

test("opens a table link on a plain click in a read-only document", async ({ page }) => {
  const path = "/docs/table-links.mdx";
  await openApp(page, [{ path, text: LINK_TABLE_DOC, readOnlyReason: "mdx" }]);
  await openSeededFile(page, "table-links.mdx");

  const target = "https://www.quanzhi.com/job/6a749e07f87cf99210b41cc0";
  const link = page.locator(`.cm-md-table-block .cm-md-link[data-href="${target}"]`);
  await expect(link).toBeVisible();
  await expect(page.locator(".cm-md-table-cell-input")).toHaveCount(0);
  await link.click();
  await expect.poll(() => getOpenedLinks(page)).toEqual([target]);
});
