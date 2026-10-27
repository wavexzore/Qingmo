import { expect, test } from "@playwright/test";

import {
  NOTE_PATH,
  READONLY_PATH,
  READONLY_TEXT,
  SAVE_AS_PATH,
  emitBlur,
  endComposition,
  getFileSize,
  getFileText,
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
  await expect(page.getByRole("heading", { name: "untitled.md" })).toBeVisible();
  await expect(page.getByTestId("status-bar")).toContainText("已同步");
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
  await page.getByRole("button", { name: "打开 Markdown 文件" }).click();

  await expect(page.getByRole("button", { name: "打开 Markdown 文件" })).toBeEnabled();
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
