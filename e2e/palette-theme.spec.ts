import { expect, test } from "@playwright/test";

import { NOTE_PATH, getFileText, modifier, openApp, openSeededFile, typeInEditor } from "./helpers";

async function currentTheme(page: Parameters<typeof openApp>[0]): Promise<string | null> {
  return page.evaluate(() => document.documentElement.getAttribute("data-theme"));
}

test("palette toggles the theme without rebuilding the editor or losing undo", async ({ page }) => {
  await openApp(page);
  await openSeededFile(page, "note.md");

  await typeInEditor(page, "\nundo-me");
  await expect.poll(() => getFileText(page, NOTE_PATH)).toContain("undo-me");

  const before = await currentTheme(page);
  await page.keyboard.press(`${modifier()}+k`);
  const palette = page.getByRole("dialog", { name: "命令面板" });
  await expect(palette).toBeVisible();
  await palette.getByRole("combobox").fill("主题");
  await palette.getByRole("combobox").press("Enter");

  await expect(palette).toBeHidden();
  await expect.poll(() => currentTheme(page)).not.toBe(before);
  await expect(page.locator(".cm-content")).toBeVisible();

  // Theme changes only reconfigure a Compartment; the undo history survives.
  await page.locator(".cm-content").click();
  await page.keyboard.press(`${modifier()}+z`);
  await expect.poll(() => getFileText(page, NOTE_PATH)).not.toContain("undo-me");
});

test("palette commands restore editor focus and keep working after a reload", async ({ page }) => {
  await openApp(page);
  await openSeededFile(page, "note.md");
  // The palette restores the element that was focused before it opened; focus
  // the editor explicitly so this test exercises that contract.
  await page.locator(".cm-content").click();

  await page.keyboard.press(`${modifier()}+k`);
  const palette = page.getByRole("dialog", { name: "命令面板" });
  await palette.getByRole("combobox").fill("保存");
  await palette.getByRole("combobox").press("Enter");
  await expect(palette).toBeHidden();

  await page.keyboard.type("Q");
  await expect.poll(() => getFileText(page, NOTE_PATH)).toContain("Q");
  await expect(page.locator(".cm-content")).toBeFocused();

  const persisted = await page.evaluate(() => localStorage.getItem("qingmo.ui.theme"));
  expect(persisted).toBeNull();

  await page.keyboard.press(`${modifier()}+k`);
  await expect(palette).toBeVisible();
  await palette.getByRole("combobox").fill("主题");
  await palette.getByRole("combobox").press("Enter");
  await expect(palette).toBeHidden();

  const theme = await currentTheme(page);
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("qingmo.ui.theme")))
    .not.toBeNull();
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__QINGMO_E2E__));
  await expect.poll(() => currentTheme(page)).toBe(theme);

  // The registry and global keybinding still work after a reload.
  await page.keyboard.press(`${modifier()}+k`);
  await expect(palette).toBeVisible();
  await palette.getByRole("combobox").press("Escape");
  await expect(palette).toBeHidden();
});
