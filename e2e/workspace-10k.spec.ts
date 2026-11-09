import { expect, test } from "@playwright/test";

import { openWorkspaceApp, workspaceRow } from "./helpers";

const ROWS = 10_000;

const WORKSPACE_10K = {
  root: "/work",
  name: "work",
  files: Array.from({ length: ROWS }, (_, index) => ({
    path: `/work/tree/file-${String(index).padStart(4, "0")}.md`,
    text: "",
  })),
};

test("renders a bounded virtual window for a 10k directory", async ({ page }) => {
  await openWorkspaceApp(page, WORKSPACE_10K);
  await workspaceRow(page, "tree").click();
  await expect(workspaceRow(page, "tree/file-0000.md")).toBeVisible();

  const firstFrame = await page.locator('[role="treeitem"]').count();
  expect(firstFrame).toBeGreaterThan(0);
  expect(firstFrame).toBeLessThanOrEqual(40);

  test.info().annotations.push({
    type: "workspace-10k-first-frame-rows",
    description: String(firstFrame),
  });

  // End/Home must reach rows that were never in the first frame.
  await workspaceRow(page, "tree/file-0000.md").focus();
  await page.keyboard.press("End");
  await expect(workspaceRow(page, "tree/file-9999.md")).toBeFocused();
  expect(await page.locator('[role="treeitem"]').count()).toBeLessThanOrEqual(40);

  // Home goes to the first logical row: the `tree` directory itself.
  await page.keyboard.press("Home");
  await expect(workspaceRow(page, "tree")).toBeFocused();
  expect(await page.locator('[role="treeitem"]').count()).toBeLessThanOrEqual(40);

  // The scroll container really moved instead of merely changing focus.
  const scrollTop = await page
    .getByTestId("workspace-tree")
    .evaluate((element) => element.scrollTop);
  expect(scrollTop).toBe(0);
});
