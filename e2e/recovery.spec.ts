import { expect, test } from "@playwright/test";

import type { SeedDraft } from "./types";
import { openApp, typeInEditor } from "./helpers";

function draft(overrides: Partial<SeedDraft> = {}): SeedDraft {
  const text = overrides.text ?? "恢复的正文\n";
  return {
    schemaVersion: 1,
    id: "00000000-0000-4000-8000-0000000000aa",
    kind: "untitled",
    path: null,
    title: "恢复稿",
    text,
    textUnits: text.length,
    sizeBytes: new TextEncoder().encode(text).length,
    anchor: 0,
    head: 0,
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_100_000,
    appVersion: "e2e",
    ...overrides,
  };
}

test("restores a seeded draft as a new dirty untitled document", async ({ page }) => {
  await openApp(page, [], { drafts: [draft({ text: "恢复的正文\n第二行\n" })] });

  const banner = page.getByTestId("recovery-banner");
  await expect(banner).toContainText("发现 1 个未保存草稿");
  await page.getByTestId("recovery-open").click();
  await expect(page.getByTestId("recovery-list")).toContainText("恢复稿");

  await page.getByTestId("recovery-restore-00000000-0000-4000-8000-0000000000aa").click();

  await expect(page.locator(".cm-content").first()).toContainText("恢复的正文");
  await expect(page.getByTestId("status-bar")).toContainText("未保存");
  await expect(banner).toBeHidden();
});

test("discards a seeded draft from the dialog", async ({ page }) => {
  await openApp(page, [], { drafts: [draft()] });

  await page.getByTestId("recovery-open").click();
  await page.getByTestId("recovery-discard-00000000-0000-4000-8000-0000000000aa").click();

  await expect(page.getByTestId("recovery-banner")).toBeHidden();
  await expect(page.getByTestId("recovery-list")).toContainText("没有可恢复的草稿");
});

test("blocks restore while the current untitled document has content", async ({ page }) => {
  await openApp(page, [], { drafts: [draft()] });
  await typeInEditor(page, "mine");

  await page.getByTestId("recovery-open").click();
  await expect(page.getByTestId("recovery-blocked")).toBeVisible();
  await expect(
    page.getByTestId("recovery-restore-00000000-0000-4000-8000-0000000000aa"),
  ).toBeDisabled();
});
