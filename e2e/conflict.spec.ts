import { expect, test } from "@playwright/test";

import {
  CONFLICT_PATH,
  CONFLICT_TEXT,
  getFileText,
  modifier,
  openApp,
  openSeededFile,
  setDiskText,
  typeInEditor,
} from "./helpers";

const CONFLICT_FILES = [{ path: CONFLICT_PATH, text: CONFLICT_TEXT }];

async function triggerConflict(page: Parameters<typeof openApp>[0]): Promise<void> {
  await typeInEditor(page, "local");
  await setDiskText(page, CONFLICT_PATH, "external\n");
  await page.keyboard.press(`${modifier()}+s`);
  await expect(page.getByTestId("conflict-banner")).toBeVisible();
}

test("external change opens the banner and reload keeps the disk version", async ({ page }) => {
  await openApp(page, CONFLICT_FILES);
  await openSeededFile(page, "conflict.md");
  await triggerConflict(page);

  await page.getByTestId("conflict-reload").click();
  await expect(page.getByTestId("conflict-confirm")).toBeVisible();
  await page.getByTestId("conflict-confirm").getByRole("button", { name: "确认" }).click();

  await expect(page.getByTestId("conflict-banner")).toBeHidden();
  await expect.poll(() => getFileText(page, CONFLICT_PATH)).toBe("external\n");
  await expect(page.locator(".cm-content")).toContainText("external");
});

test("a second external change still conflicts before an exact overwrite succeeds", async ({
  page,
}) => {
  await openApp(page, CONFLICT_FILES);
  await openSeededFile(page, "conflict.md");
  await triggerConflict(page);

  await page.getByTestId("conflict-overwrite").click();
  await setDiskText(page, CONFLICT_PATH, "external-2\n");
  await page.getByTestId("conflict-confirm").getByRole("button", { name: "确认" }).click();

  // The confirmed hash belonged to external-1, so external-2 is still a
  // conflict. The banner must stay open and the disk must remain untouched.
  await expect(page.getByTestId("conflict-banner")).toBeVisible();
  await expect.poll(() => getFileText(page, CONFLICT_PATH)).toBe("external-2\n");

  await page.getByTestId("conflict-overwrite").click();
  await page.getByTestId("conflict-confirm").getByRole("button", { name: "确认" }).click();

  await expect(page.getByTestId("conflict-banner")).toBeHidden();
  await expect.poll(() => getFileText(page, CONFLICT_PATH)).toContain("local");
});
