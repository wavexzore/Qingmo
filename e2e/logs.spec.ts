import { expect, test } from "@playwright/test";

import { emitMenuAction, openApp } from "./helpers";

test("the menu opens the log viewer, filters and exports entries", async ({ page }) => {
  await openApp(page);
  await emitMenuAction(page, "app.openLogs");

  const dialog = page.getByRole("dialog", { name: "运行日志" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("logs-list")).toContainText("failed to emit update state");
  await expect(dialog.getByTestId("logs-stats")).toContainText("3 条");

  await dialog.getByTestId("logs-filter-warn").click();
  await expect(dialog.getByTestId("logs-list")).not.toContainText("arming close request");
  await expect(dialog.getByTestId("logs-list")).toContainText("failed to emit update state");

  await dialog.getByTestId("logs-export").click();
  await expect(page.getByText(/日志已导出到/)).toBeVisible();

  await dialog.getByTestId("logs-clear").click();
  await expect(dialog.getByTestId("logs-confirm")).toContainText("删除 7 天前的日志？");
  await dialog.getByTestId("logs-clear-cancel").click();
  await expect(dialog.getByTestId("logs-confirm")).toBeHidden();

  await dialog.getByTestId("logs-close").click();
  await expect(dialog).toBeHidden();
});

test("the palette command opens the same viewer", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Meta+k");
  const palette = page.getByRole("dialog", { name: "命令面板" });
  await palette.getByRole("combobox").fill("运行日志");
  await palette.getByRole("combobox").press("Enter");

  await expect(page.getByRole("dialog", { name: "运行日志" })).toBeVisible();
});
