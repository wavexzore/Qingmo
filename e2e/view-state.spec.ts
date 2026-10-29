import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { getViewState, openApp, openSeededFile } from "./helpers";

const LONG_PATH = "/docs/long.md";
const LONG_TEXT = readFileSync(path.join(__dirname, "fixtures", "long.md"), "utf8");
const TARGET_LINE = 120;
const TARGET_POS =
  LONG_TEXT.split("\n")
    .slice(0, TARGET_LINE - 1)
    .join("\n").length + 1;
const TARGET_COLUMN = 1;

test("restores cursor, scroll and the source preference before the first frame", async ({
  page,
}) => {
  await openApp(page, [{ path: LONG_PATH, text: LONG_TEXT }], {
    viewStates: [
      {
        path: LONG_PATH,
        state: {
          anchor: TARGET_POS,
          head: TARGET_POS,
          topPos: TARGET_POS,
          topOffset: 28,
          scrollLeft: 0,
          livePreviewPreferred: false,
          updatedAtMs: 1_700_000_000_000,
        },
      },
    ],
  });
  await openSeededFile(page, "long.md");

  await expect(page.getByTestId("status-bar")).toContainText(
    `第 ${TARGET_LINE} 行，第 ${TARGET_COLUMN} 列`,
  );
  await expect(page.getByTestId("status-bar")).toContainText("源码");
  await expect(page.locator(".cm-editor").first()).not.toHaveAttribute("data-live-preview");
  await expect
    .poll(async () => page.evaluate(() => document.querySelector(".cm-scroller")?.scrollTop ?? 0))
    .toBeGreaterThan(0);

  // Scrolling to the top must be recorded with the padding preserved as a
  // positive topOffset rather than folded into scrollTop.
  await page.evaluate(() => {
    const scroller = document.querySelector(".cm-scroller");
    if (scroller) {
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event("scroll"));
    }
  });
  await page.waitForTimeout(1_700);

  const persisted = await getViewState(page, LONG_PATH);
  expect(persisted?.topPos).toBe(0);
  expect(persisted?.topOffset).toBe(28);
  expect(persisted?.livePreviewPreferred).toBe(false);
});

test("keeps live preview when the persisted preference is true", async ({ page }) => {
  await openApp(page, [{ path: LONG_PATH, text: LONG_TEXT }], {
    viewStates: [
      {
        path: LONG_PATH,
        state: {
          anchor: 0,
          head: 0,
          topPos: 0,
          topOffset: 28,
          scrollLeft: 0,
          livePreviewPreferred: true,
          updatedAtMs: 1_700_000_000_000,
        },
      },
    ],
  });
  await openSeededFile(page, "long.md");

  await expect(page.getByTestId("status-bar")).toContainText("实时预览");
  await expect(page.locator(".cm-editor").first()).toHaveAttribute("data-live-preview", "true");
});
