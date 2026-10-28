import { expect, test } from "@playwright/test";

import {
  NOTE_PATH,
  READONLY_PATH,
  READONLY_TEXT,
  SAVE_AS_PATH,
  emitBlur,
  emitMenuAction,
  endComposition,
  getFileSize,
  getFileText,
  getLivePreviewMenuCalls,
  modifier,
  openApp,
  openSeededFile,
  setComposing,
  setOpenFile,
  setSaveAsFile,
  typeInEditor,
} from "./helpers";

test("types directly into the untitled editor and Save As binds a real path", async ({ page }) => {
  await openApp(page);

  const editor = page.getByRole("textbox");
  await expect(page.getByTestId("untitled-editor")).toBeVisible();
  await expect(editor).toHaveAttribute("aria-placeholder", "开始写作…");
  await expect(page.getByTestId("status-bar")).toHaveCount(0);

  await typeInEditor(page, "# Fresh\n\nhello");
  await expect(page.getByTestId("status-bar")).toContainText("未保存");
  expect(await getFileText(page, SAVE_AS_PATH)).toBeNull();

  await page.keyboard.press(`${modifier()}+s`);

  await expect.poll(() => getFileText(page, SAVE_AS_PATH)).toBe("# Fresh\n\nhello");
  await expect(page.getByTestId("document-session")).toBeVisible();
  await expect(page.getByTestId("status-bar")).toContainText("untitled.md");
  await expect(page.getByTestId("status-bar")).toContainText("已同步");
});

test("line numbers follow the Live Preview mode and the menu tracks it", async ({ page }) => {
  await openApp(page);

  const untitled = page.getByTestId("untitled-editor");
  const gutter = untitled.locator(".cm-gutters");

  // Live Preview renders the document and hides the code gutter.
  await expect(gutter).toBeHidden();
  await expect.poll(() => getLivePreviewMenuCalls(page)).toEqual([true]);

  await typeInEditor(page, "\n\nthird");

  const textX = () =>
    page.evaluate(() => {
      const line = document.querySelector('[data-testid="untitled-editor"] .cm-line:last-child');
      const range = document.createRange();
      range.selectNodeContents(line?.firstChild ?? line!);
      return range.getBoundingClientRect().x;
    });
  const previewX = await textX();

  // Source mode shows line numbers without moving the text column.
  await emitMenuAction(page, "view.toggleLivePreview");
  await expect(gutter).toBeVisible();
  await expect(gutter.locator(".cm-lineNumbers")).toContainText("3");
  await expect.poll(() => getLivePreviewMenuCalls(page)).toEqual([true, false]);

  const sourceX = await textX();
  expect(Math.abs(sourceX - previewX)).toBeLessThanOrEqual(1);
  const gutterBox = await gutter.boundingBox();
  expect(gutterBox!.x + gutterBox!.width).toBeLessThanOrEqual(sourceX + 1);

  // Returning to Live Preview hides them again.
  await emitMenuAction(page, "view.toggleLivePreview");
  await expect(gutter).toBeHidden();
  await expect.poll(() => getLivePreviewMenuCalls(page)).toEqual([true, false, true]);
});

test("a lone dash leaves the paragraph above in plain text", async ({ page }) => {
  await openApp(page);
  await typeInEditor(page, "ascii path\n-");

  const paragraphLine = page.locator('[data-testid="untitled-editor"] .cm-line').first();
  await expect(paragraphLine).not.toHaveClass(/cm-md-h2/);

  // Typora needs a two-character underline before it promotes the paragraph.
  await typeInEditor(page, "-");
  await expect(paragraphLine).toHaveClass(/cm-md-h2/);
});

test("saved documents keep the same writing margins as the untitled buffer", async ({ page }) => {
  await openApp(page);

  const margins = () =>
    page.evaluate(() => {
      const editor = document.querySelector(".cm-editor")!.getBoundingClientRect();
      const content = document.querySelector(".cm-content")!;
      const line = document.querySelector(".cm-line")!;
      return {
        editorLeft: editor.left,
        editorWidth: editor.width,
        viewport: window.innerWidth,
        contentInset: Number.parseFloat(getComputedStyle(content).paddingLeft),
        lineInset: Number.parseFloat(getComputedStyle(line).paddingLeft),
      };
    });

  const untitled = await margins();
  await openSeededFile(page, "note.md");
  const saved = await margins();

  // The scroller spans the window so the vertical scrollbar sits on the
  // border; the page gutter and writing inset live inside the content instead.
  expect(untitled.editorLeft).toBe(0);
  expect(untitled.editorWidth).toBe(untitled.viewport);
  expect(untitled.contentInset).toBe(20);
  expect(untitled.lineInset).toBe(20);
  expect(saved).toEqual(untitled);
});

test("cancelling Save As keeps the untitled document dirty", async ({ page }) => {
  await openApp(page);
  await typeInEditor(page, "draft");
  await setSaveAsFile(page, null);

  await page.keyboard.press(`${modifier()}+s`);

  await expect(page.getByTestId("untitled-editor")).toBeVisible();
  await expect(page.getByTestId("status-bar")).toContainText("未保存");
  expect(await getFileText(page, SAVE_AS_PATH)).toBeNull();
});

test("renders a GFM table and returns to its source when clicked", async ({ page }) => {
  await openApp(page);
  await typeInEditor(page, "| A | B |\n|---|---|\n| 1 | 2 |\n");

  const block = page.locator(".cm-md-table-block");
  await expect(block.locator("table")).toBeVisible();
  await expect(block.locator("th").first()).toHaveText("A");
  await expect(page.locator(".cm-content")).not.toContainText("|---|---|");

  await block.click();

  await expect(page.locator(".cm-content")).toContainText("|---|---|");
  await expect(page.locator(".cm-md-table-block")).toHaveCount(0);
});

test("opens a seeded file, edits it and auto-saves to clean", async ({ page }) => {
  await openApp(page);
  await openSeededFile(page, "note.md");
  await expect(page.getByTestId("status-bar")).toContainText("已同步");

  const before = await getFileSize(page, NOTE_PATH);
  await typeInEditor(page, "\nE2E body");

  await expect.poll(() => getFileText(page, NOTE_PATH)).toContain("E2E body");
  await expect(page.getByTestId("status-bar")).toContainText("已同步");
  const after = await getFileSize(page, NOTE_PATH);
  expect(after).not.toBe(before);
});

test("cancelling the fake dialog leaves the blank editor intact", async ({ page }) => {
  await openApp(page);
  await setOpenFile(page, null);
  await emitMenuAction(page, "file.open");

  await expect(page.getByTestId("untitled-editor")).toBeVisible();
  await expect(page.getByTestId("document-session")).toHaveCount(0);
});

test("MDX stays read-only and does not accept typing", async ({ page }) => {
  await openApp(page, [
    {
      path: READONLY_PATH,
      text: READONLY_TEXT,
      readOnlyReason: "mdx",
    },
  ]);
  await openSeededFile(page, "readonly.mdx");

  await expect(page.getByTestId("read-only-badge")).toBeVisible();
  await expect(page.locator(".cm-content")).toHaveAttribute("contenteditable", "false");

  await page.locator(".cm-content").click();
  await page.keyboard.type("x");
  await expect.poll(() => getFileText(page, READONLY_PATH)).toBe(READONLY_TEXT);
});

test("blur during IME composition defers the flush until compositionend", async ({ page }) => {
  await openApp(page);
  await openSeededFile(page, "note.md");
  const original = await getFileText(page, NOTE_PATH);

  await typeInEditor(page, "\nime-blur");
  await setComposing(page, true);
  await emitBlur(page);
  await page.waitForTimeout(300);
  expect(await getFileText(page, NOTE_PATH)).toBe(original);

  await endComposition(page);
  await expect.poll(() => getFileText(page, NOTE_PATH)).toContain("ime-blur");
  await expect(page.getByTestId("status-bar")).toContainText("已同步");
});

test("the command palette saves the current document", async ({ page }) => {
  await openApp(page);
  await openSeededFile(page, "note.md");
  await typeInEditor(page, "\nvia palette");

  await page.keyboard.press(`${modifier()}+k`);
  const palette = page.getByRole("dialog", { name: "命令面板" });
  await expect(palette).toBeVisible();
  await palette.getByRole("combobox").fill("保存");
  await palette.getByRole("combobox").press("Enter");

  await expect(palette).toBeHidden();
  await expect.poll(() => getFileText(page, NOTE_PATH)).toContain("via palette");
  await expect(page.getByTestId("status-bar")).toContainText("已同步");
});
