import { expect, test } from "@playwright/test";

import { emitMenuAction, openApp } from "./helpers";

test("switches the interface language inside the settings window", async ({ page }) => {
  await page.goto("/settings.html");
  await page.waitForFunction(() => Boolean(window.__QINGMO_SETTINGS_E2E__));

  await expect(page.getByRole("heading", { name: "通用设置" })).toBeVisible();
  await expect(page.getByTestId("settings-language")).toContainText("简体中文");

  await page.getByTestId("settings-language").click();
  await page.getByRole("option", { name: /English/ }).click();

  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { name: "General settings" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Interface language set to English.");
  expect(await page.evaluate(() => localStorage.getItem("qingmo.ui.language"))).toBe("en");

  await page.getByTestId("settings-close").click();
  await expect
    .poll(() => page.evaluate(() => window.__QINGMO_SETTINGS_E2E__?.settings.closed ?? false))
    .toBe(true);
});

test("keeps the editor and settings windows in sync through storage", async ({ page, context }) => {
  await openApp(page);

  const settings = await context.newPage();
  await settings.goto("/settings.html");
  await settings.waitForFunction(() => Boolean(window.__QINGMO_SETTINGS_E2E__));
  await expect(settings.getByRole("heading", { name: "通用设置" })).toBeVisible();

  await emitMenuAction(page, "language.en");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(settings.locator("html")).toHaveAttribute("lang", "en");
  await expect(settings.getByRole("heading", { name: "General settings" })).toBeVisible();

  await settings.getByTestId("settings-language").click();
  await settings.getByRole("option", { name: /简体中文/ }).click();

  await expect(settings.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.locator(".cm-placeholder")).toHaveText("开始写作…");

  await settings.close();
});

test("closes the settings window on Escape", async ({ page }) => {
  await page.goto("/settings.html");
  await page.waitForFunction(() => Boolean(window.__QINGMO_SETTINGS_E2E__));

  await page.keyboard.press("Escape");

  await expect
    .poll(() => page.evaluate(() => window.__QINGMO_SETTINGS_E2E__?.settings.closed ?? false))
    .toBe(true);
});
