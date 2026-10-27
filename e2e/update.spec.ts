import { expect, test } from "@playwright/test";

import {
  CONFLICT_PATH,
  CONFLICT_TEXT,
  NOTE_PATH,
  emitUpdateProgress,
  getFileText,
  getUpdateCalls,
  holdUpdateDownload,
  openApp,
  openSeededFile,
  releaseUpdateDownload,
  runUpdateCheck,
  setDiskText,
  setUpdateAvailable,
  setUpdateError,
  typeInEditor,
} from "./helpers";

const UPDATE = {
  version: "0.2.0",
  date: "2026-10-27T12:00:00Z",
  body: "Plain **notes**\n\n- no HTML",
};

function trackExternalRequests(page: Parameters<typeof openApp>[0]): string[] {
  const external: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (!url.startsWith("http://127.0.0.1:4173") && !url.startsWith("data:")) {
      external.push(url);
    }
  });
  return external;
}

test("manual check shows plain-text notes, progress, then installs", async ({ page }) => {
  const external = trackExternalRequests(page);
  await openApp(page);
  await setUpdateAvailable(page, UPDATE);
  await holdUpdateDownload(page);

  await runUpdateCheck(page);
  const dialog = page.getByRole("dialog", { name: "更新青墨" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("v0.2.0");
  await expect(dialog).toContainText("Plain **notes**");

  await dialog.getByTestId("update-download").click();
  await expect(dialog.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
  await emitUpdateProgress(page, 40, 100);
  await expect(dialog.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "40");
  await expect(dialog).toContainText("正在下载… 40%");

  await releaseUpdateDownload(page);
  await expect(dialog.getByTestId("update-install")).toBeVisible();
  await dialog.getByTestId("update-install").click();

  await expect(dialog).toContainText("正在安装更新，请不要关闭青墨。");
  await expect
    .poll(() => getUpdateCalls(page))
    .toMatchObject({
      check: 1,
      download: 1,
      install: 1,
    });
  expect(external).toEqual([]);
});

test("install waits for a dirty document to flush", async ({ page }) => {
  await openApp(page);
  await openSeededFile(page, "note.md");
  await typeInEditor(page, "\nbefore-update");
  await setUpdateAvailable(page, UPDATE);

  await runUpdateCheck(page);
  const dialog = page.getByRole("dialog", { name: "更新青墨" });
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("update-download").click();
  await dialog.getByTestId("update-install").click();

  await expect.poll(() => getFileText(page, NOTE_PATH)).toContain("before-update");
  await expect.poll(() => getUpdateCalls(page)).toMatchObject({ install: 1 });
  await expect(dialog).toContainText("正在安装更新，请不要关闭青墨。");
});

test("a save conflict blocks the install", async ({ page }) => {
  await openApp(page, [{ path: CONFLICT_PATH, text: CONFLICT_TEXT }]);
  await openSeededFile(page, "conflict.md");
  await typeInEditor(page, "local");
  await setDiskText(page, CONFLICT_PATH, "external\n");
  await setUpdateAvailable(page, UPDATE);

  await runUpdateCheck(page);
  const dialog = page.getByRole("dialog", { name: "更新青墨" });
  await dialog.getByTestId("update-download").click();
  await dialog.getByTestId("update-install").click();

  await expect(dialog.getByTestId("update-error")).toContainText(
    "文件已被外部修改，请先确认版本。",
  );
  expect((await getUpdateCalls(page)).install).toBe(0);
  await expect.poll(() => getFileText(page, CONFLICT_PATH)).toBe("external\n");

  await dialog.getByTestId("update-later").click();
  await expect(dialog).toBeHidden();
});

test("a failed manual check shows an error toast", async ({ page }) => {
  await openApp(page);
  await setUpdateError(page, "check", "UPDATE_CHECK_FAILED");

  await runUpdateCheck(page);

  await expect(page.getByText("检查更新失败，请稍后重试。")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "更新青墨" })).toHaveCount(0);
  await expect.poll(() => getUpdateCalls(page)).toMatchObject({ check: 1 });
});

test("an up-to-date manual check only shows a toast", async ({ page }) => {
  await openApp(page);
  await setUpdateAvailable(page, null);

  await runUpdateCheck(page);

  await expect(page.getByText("已是最新版本。")).toBeVisible();
  await expect(page.getByTestId("update-banner")).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "更新青墨" })).toHaveCount(0);
});

test("startup does not run a silent network check in the E2E build", async ({ page }) => {
  const external = trackExternalRequests(page);
  await openApp(page);
  await setUpdateAvailable(page, UPDATE);

  await page.waitForTimeout(1_000);
  expect((await getUpdateCalls(page)).check).toBe(0);
  await expect(page.getByTestId("update-banner")).toHaveCount(0);
  expect(external).toEqual([]);
});
