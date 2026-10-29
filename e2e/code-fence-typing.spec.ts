import { expect, test } from "@playwright/test";

import {
  editorContent,
  editorLines,
  getFileText,
  modifier,
  openApp,
  openSeededFile,
} from "./helpers";

const PATH = "/docs/fence-typing.md";
const DOC = `# 标题

\`\`\`markdown
[其他文档](./OTHER.md)
\`\`\`
`;

test("typing a fence above an existing block keeps both blocks separate", async ({ page }) => {
  await openApp(page, [{ path: PATH, text: DOC }]);
  await openSeededFile(page, "fence-typing.md");
  await editorContent(page).focus();

  // Put the caret on the blank line above the existing Markdown block.
  await editorLines(page).nth(1).click();
  await page.keyboard.press("End");
  await expect(page.getByTestId("status-bar")).toContainText("第 2 行");

  await page.keyboard.type("```");

  // While the opening fence is still being typed, its source stays visible:
  // the existing block below must not be pulled into a rendered widget.
  await expect(page.locator(".cm-md-code-block-widget")).toHaveCount(0);
  await expect(editorLines(page).filter({ hasText: "```markdown" })).toBeVisible();
  await expect(editorLines(page).filter({ hasText: "[其他文档](./OTHER.md)" })).toBeVisible();

  await page.keyboard.press("Enter");
  await expect(page.getByTestId("status-bar")).toContainText("第 3 行");

  // The new fence receives its own closing marker, so leaving it renders two
  // fixed blocks instead of one block that swallowed the original.
  await page.keyboard.press(`${modifier()}+Home`);
  const blocks = page.locator(".cm-md-code-block-widget");
  await expect(blocks).toHaveCount(2);
  await expect(blocks.first().locator(".cm-md-code-language-label")).toHaveText("text");
  await expect(blocks.first()).not.toContainText("[其他文档](./OTHER.md)");
  await expect(blocks.nth(1).locator(".cm-md-code-language-label")).toHaveText("markdown");
  await expect(blocks.nth(1)).toContainText("[其他文档](./OTHER.md)");

  await expect
    .poll(() => getFileText(page, PATH))
    .toContain("```\n\n```\n```markdown\n[其他文档](./OTHER.md)\n```");
});

test("leaving a freshly typed fence completes it in place", async ({ page }) => {
  await openApp(page, [{ path: PATH, text: DOC }]);
  await openSeededFile(page, "fence-typing.md");
  await editorContent(page).focus();

  await editorLines(page).nth(1).click();
  await page.keyboard.press("End");
  await page.keyboard.type("```");
  await expect(page.locator(".cm-md-code-block-widget")).toHaveCount(0);

  // Moving away without Enter commits the fence as well; otherwise the
  // unclosed marker would pair with the closing fence of the block below.
  await page.keyboard.press(`${modifier()}+Home`);
  await expect(page.locator(".cm-md-code-block-widget")).toHaveCount(2);
  await expect
    .poll(() => getFileText(page, PATH))
    .toContain("```\n\n```\n```markdown\n[其他文档](./OTHER.md)\n```");
});
