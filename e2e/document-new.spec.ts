import { expect, test } from "@playwright/test";

import { NOTE_PATH, getFileText, modifier, openApp, openSeededFile, typeInEditor } from "./helpers";

test("Mod+N resets the harness window to a fresh untitled document", async ({ page }) => {
  await openApp(page);

  await typeInEditor(page, "# Draft\n\nold body");
  await expect(page.getByTestId("status-bar")).toContainText("未保存");

  await page.keyboard.press(`${modifier()}+n`);

  await expect(page.getByTestId("untitled-editor")).toBeVisible();
  await expect(page.locator(".cm-content")).toHaveText("开始写作…");
  await expect(page.getByTestId("status-bar")).toHaveCount(0);
  await expect(page.getByRole("textbox")).toHaveAttribute("aria-placeholder", "开始写作…");
});

test("New flushes unsaved harness edits and leaves an empty untitled editor", async ({ page }) => {
  await openApp(page);
  await openSeededFile(page, "note.md");
  await typeInEditor(page, "\nchanged before New");
  await expect(page.getByTestId("status-bar")).not.toContainText("已同步");

  // Press New inside the 800ms save debounce: the browser harness must
  // flush the named document because it reuses this window instead of
  // creating a second one.
  await page.keyboard.press(`${modifier()}+n`);

  await expect(page.getByTestId("untitled-editor")).toBeVisible();
  await expect(page.getByTestId("document-session")).toHaveCount(0);
  await expect(page.locator(".cm-content")).toHaveText("开始写作…");
  await expect.poll(() => getFileText(page, NOTE_PATH)).toContain("changed before New");
});

test("the palette exposes and runs New File", async ({ page }) => {
  await openApp(page);
  await openSeededFile(page, "note.md");
  await typeInEditor(page, "\nfrom palette");
  await expect(page.getByTestId("status-bar")).not.toContainText("已同步");

  await page.keyboard.press(`${modifier()}+k`);
  const palette = page.getByRole("dialog", { name: "命令面板" });
  await expect(palette).toBeVisible();
  await palette.getByRole("combobox").fill("新建");

  await expect(palette.getByRole("option")).toHaveCount(1);
  await expect(palette.getByRole("option")).toContainText("新建文件");

  await palette.getByRole("combobox").press("Enter");
  await expect(palette).toBeHidden();
  await expect(page.getByTestId("untitled-editor")).toBeVisible();
  await expect(page.locator(".cm-content")).toHaveText("开始写作…");
  await expect.poll(() => getFileText(page, NOTE_PATH)).toContain("from palette");

  // The next palette session starts from a cleared query.
  await page.keyboard.press(`${modifier()}+k`);
  const reopened = page.getByRole("dialog", { name: "命令面板" });
  await expect(reopened.getByRole("combobox")).toHaveValue("");
});
