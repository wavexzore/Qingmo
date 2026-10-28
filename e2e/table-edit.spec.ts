import { expect, test } from "@playwright/test";

import { getFileText, modifier, openApp, openSeededFile } from "./helpers";

const TABLE_PATH = "/docs/table-edit.md";
const TABLE_DOC = "# 表格\n\n| 名称 | 数量 |\n| :--- | ---: |\n| 苹果 | 2 |\n\n结尾段落\n";

const CODE_PATH = "/docs/code-badge.md";
const CODE_DOC =
  "# 代码\n\n```ts\nconst answer: number = 42;\nconsole.log(answer);\n```\n\n结尾段落\n";

test("edits a rendered table cell without revealing Markdown source", async ({ page }) => {
  await openApp(page, [{ path: TABLE_PATH, text: TABLE_DOC }]);
  await openSeededFile(page, "table-edit.md");

  const table = page.locator(".cm-md-table-block");
  await expect(table).toBeVisible();
  await expect(page.locator(".cm-md-table-header")).toHaveCount(0);

  const cell = table.locator('input[data-row="0"][data-col="1"]');
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

test("places the code language chip at the bottom-right and highlights code", async ({ page }) => {
  await openApp(page, [{ path: CODE_PATH, text: CODE_DOC }]);
  await openSeededFile(page, "code-badge.md");

  const block = page.locator(".cm-md-code-block-widget");
  await expect(block).toBeVisible();
  await expect(block).not.toContainText("```");

  const chip = block.locator("input.cm-md-code-language");
  await expect(chip).toHaveValue("ts");

  const firstCodeLine = block.locator(".cm-line").filter({ hasText: "const answer" }).first();
  await expect(firstCodeLine).toBeVisible();
  const [chipBox, blockBox, firstBox] = await Promise.all([
    chip.boundingBox(),
    block.boundingBox(),
    firstCodeLine.boundingBox(),
  ]);
  expect(chipBox).not.toBeNull();
  expect(blockBox).not.toBeNull();
  expect(firstBox).not.toBeNull();
  if (!chipBox || !blockBox || !firstBox) {
    return;
  }

  // The chip sits below the last code line and hugs the block's right inset.
  expect(chipBox.y).toBeGreaterThan(firstBox.y + firstBox.height);
  const contentRight = blockBox.x + blockBox.width - 10;
  expect(Math.abs(chipBox.x + chipBox.width - contentRight)).toBeLessThan(20);

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

  const chip = block.locator("input.cm-md-code-language");
  await chip.click();
  await chip.fill("js");
  await page.keyboard.press("Enter");

  await expect.poll(() => getFileText(page, CODE_PATH)).toContain("```js\n");
  await expect(chip).toHaveValue("js");
});
