import { expect, test } from "@playwright/test";

import { getFileText, openApp, openSeededFile } from "./helpers";

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

test("places the code language badge at the bottom-right and highlights code", async ({ page }) => {
  await openApp(page, [{ path: CODE_PATH, text: CODE_DOC }]);
  await openSeededFile(page, "code-badge.md");

  const openingFence = page.locator(".cm-md-code-fence-hidden");
  await expect(openingFence).toHaveCount(1);
  await expect(openingFence).toHaveCSS("height", "0px");

  const badge = page.locator(".cm-md-code-language");
  await expect(badge).toHaveText("ts");

  const closingLine = page.locator(".cm-md-code-fence-close");
  const firstCodeLine = page
    .locator(".cm-line.cm-md-code-block")
    .filter({ hasText: "const answer" })
    .first();
  const [badgeBox, closingBox, firstBox] = await Promise.all([
    badge.boundingBox(),
    closingLine.boundingBox(),
    firstCodeLine.boundingBox(),
  ]);
  expect(badgeBox).not.toBeNull();
  expect(closingBox).not.toBeNull();
  expect(firstBox).not.toBeNull();
  if (!badgeBox || !closingBox || !firstBox) {
    return;
  }

  // The badge is on the final line, right-aligned inside the content inset.
  expect(badgeBox.y).toBeGreaterThan(firstBox.y + firstBox.height);
  const contentRight = closingBox.x + closingBox.width - 20;
  expect(Math.abs(badgeBox.x + badgeBox.width - contentRight)).toBeLessThan(6);

  // The nested TypeScript parser produces token spans with a different colour
  // from the surrounding code text.
  const keyword = page
    .locator(".cm-line.cm-md-code-block span")
    .filter({ hasText: /^const$/ })
    .first();
  await expect(keyword).toBeVisible();
  const keywordColor = await keyword.evaluate((element) => getComputedStyle(element).color);
  const lineColor = await firstCodeLine.evaluate((element) => getComputedStyle(element).color);
  expect(keywordColor).not.toBe(lineColor);
});
