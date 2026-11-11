import { expect, test } from "@playwright/test";

async function openAiSettings(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/settings.html?section=ai");
  await page.waitForFunction(() => Boolean(window.__QINGMO_SETTINGS_E2E__));
  await expect(page.getByTestId("settings-window")).toBeVisible();
}

test("the download banner fills the ASR gap serially and stops at the first failure", async ({
  page,
}) => {
  await openAiSettings(page);

  await expect(page.getByTestId("download-banner-asr")).toBeVisible();
  await expect(page.getByTestId("model-row-speaker-pack")).toHaveCount(1);
  await page.getByTestId("download-primary-asr").click();

  const first = page.getByTestId("model-state-paraformer-zh-en-int8");
  await expect(first).toContainText("下载中");

  await page.evaluate(() => window.__QINGMO_SETTINGS_E2E__!.settings.finishActiveDownload());
  await expect(first).toContainText("已就绪");
  await page.evaluate(() => window.__QINGMO_SETTINGS_E2E__!.settings.finishActiveDownload());
  await expect(page.getByTestId("model-cancel-speaker-pack")).toBeVisible();
});

test("a disk shortfall disables the primary button with free and required sizes", async ({
  page,
}) => {
  await openAiSettings(page);
  await page.evaluate(() => {
    window.__QINGMO_SETTINGS_E2E__!.settings.setDisk(10 * 1024 * 1024);
  });
  await page.getByTestId("nav-general").click();
  await page.getByTestId("nav-ai").click();

  const primary = page.getByTestId("download-primary-asr");
  await expect(primary).toBeDisabled();
  await expect(page.getByTestId("download-banner-asr")).toContainText("磁盘不足");
  await expect(page.getByTestId("download-banner-asr")).toContainText("10 MB");
});

test("removing a ready model needs a second confirmation", async ({ page }) => {
  await openAiSettings(page);
  await page.evaluate(() => {
    window.__QINGMO_SETTINGS_E2E__!.settings.setModelState("paraformer-zh-en-int8", "ready");
  });
  await page.getByTestId("nav-general").click();
  await page.getByTestId("nav-ai").click();

  await expect(page.getByTestId("model-state-paraformer-zh-en-int8")).toContainText("已就绪");
  await page.getByTestId("model-remove-paraformer-zh-en-int8").click();
  await expect(page.getByTestId("model-confirm-paraformer-zh-en-int8")).toBeVisible();
  await page.getByTestId("model-confirm-paraformer-zh-en-int8").click();
  await expect(page.getByTestId("model-state-paraformer-zh-en-int8")).toContainText("未下载");
});
