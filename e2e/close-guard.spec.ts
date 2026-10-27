import { expect, test } from "@playwright/test";

import {
  CONFLICT_PATH,
  CONFLICT_TEXT,
  NOTE_PATH,
  SAVE_AS_PATH,
  emitClose,
  failSaveAlways,
  getCloseConfirms,
  getFileText,
  openApp,
  openSeededFile,
  setDiskText,
  typeInEditor,
} from "./helpers";

test("confirming an untitled dirty close discards and exits without Save As", async ({ page }) => {
  await openApp(page);
  await typeInEditor(page, "untitled-close");

  await emitClose(page);
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("有未保存的修改");
  await expect(dialog.getByRole("button")).toHaveCount(2);

  await page.getByTestId("close-confirm").click();

  await expect.poll(() => getCloseConfirms(page)).toEqual([{ allow: true }]);
  expect(await getFileText(page, SAVE_AS_PATH)).toBeNull();
});

test("cancelling the close prompt never opens Save As", async ({ page }) => {
  await openApp(page);
  await typeInEditor(page, "draft");

  await emitClose(page);
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("有未保存的修改");
  await page.getByTestId("close-cancel").click();

  await expect.poll(() => getCloseConfirms(page)).toEqual([{ allow: false }]);
  expect(await getFileText(page, SAVE_AS_PATH)).toBeNull();
  await expect(page.getByTestId("untitled-editor")).toBeVisible();
  await expect(page.getByTestId("status-bar")).toContainText("未保存");
});

test("a clean close is confirmed immediately without writing", async ({ page }) => {
  await openApp(page);
  await openSeededFile(page, "note.md");

  await emitClose(page);
  await expect.poll(() => getCloseConfirms(page)).toEqual([{ allow: true }]);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});

test("a native close flushes pending edits before confirming", async ({ page }) => {
  await openApp(page);
  await openSeededFile(page, "note.md");
  await typeInEditor(page, "\nclose-flush");

  await emitClose(page, "exit");
  await expect.poll(() => getFileText(page, NOTE_PATH)).toContain("close-flush");
  await expect.poll(() => getCloseConfirms(page)).toEqual([{ allow: true }]);
});

test("a conflicted close prompts, can cancel, and can close anyway", async ({ page }) => {
  await openApp(page, [{ path: CONFLICT_PATH, text: CONFLICT_TEXT }]);
  await openSeededFile(page, "conflict.md");
  await typeInEditor(page, "local");
  await setDiskText(page, CONFLICT_PATH, "external\n");

  await emitClose(page);
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("有未保存的修改");

  await page.getByTestId("close-cancel").click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => getCloseConfirms(page)).toEqual([{ allow: false }]);
  await expect.poll(() => getFileText(page, CONFLICT_PATH)).toBe("external\n");

  await emitClose(page);
  await expect(dialog).toBeVisible();
  await page.getByTestId("close-anyway").click();
  await expect.poll(() => getCloseConfirms(page)).toEqual([{ allow: false }, { allow: true }]);
});

test("a terminal save error prompts before closing", async ({ page }) => {
  await openApp(page);
  await openSeededFile(page, "note.md");
  await typeInEditor(page, "\nfail-close");
  await failSaveAlways(page, "PERMISSION_DENIED");

  await emitClose(page);
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("保存未完成");

  await page.getByTestId("close-cancel").click();
  await expect.poll(() => getCloseConfirms(page)).toEqual([{ allow: false }]);
});
