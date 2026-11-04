import { expect, test } from "@playwright/test";

import { openApp, openSeededFile } from "./helpers";

const CODE_DOC = "# Note\n\nhello e2e\n\n```js\nconst answer = 42;\n```\n";

test("edits typography in settings and persists the JSON preference", async ({ page }) => {
  await page.goto("/settings.html");
  await page.waitForFunction(() => Boolean(window.__QINGMO_SETTINGS_E2E__));

  const range = page.getByTestId("settings-font-size");
  await expect(range).toHaveValue("15");
  await expect(page.getByTestId("settings-font-size-value")).toHaveText("15px");
  await expect(page.getByTestId("settings-font-mono")).toBeChecked();

  await range.fill("22");
  await page.getByTestId("settings-font-option-serif").click();

  await expect(page.getByTestId("settings-font-size-value")).toHaveText("22px");
  await expect(page.getByTestId("settings-font-serif")).toBeChecked();
  await expect(page.getByTestId("settings-font-option-serif")).toHaveAttribute(
    "data-checked",
    "true",
  );
  await expect(page.getByTestId("settings-typography-preview").locator("p")).toHaveCSS(
    "font-size",
    "22px",
  );

  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("qingmo.ui.editorTypography") ?? "{}"),
    ),
  ).toEqual({ version: 1, fontSize: 22, fontFamily: "serif" });

  await page.reload();
  await page.waitForFunction(() => Boolean(window.__QINGMO_SETTINGS_E2E__));
  await expect(page.getByTestId("settings-font-size")).toHaveValue("22");
  await expect(page.getByTestId("settings-font-serif")).toBeChecked();
});

test("projects typography to open editors and keeps code blocks mono", async ({
  page,
  context,
}) => {
  await openApp(page, [{ path: "/docs/note.md", text: CODE_DOC }]);
  await openSeededFile(page, "note.md");

  const settings = await context.newPage();
  await settings.goto("/settings.html");
  await settings.waitForFunction(() => Boolean(window.__QINGMO_SETTINGS_E2E__));

  await settings.getByTestId("settings-font-size").fill("24");
  await settings.getByTestId("settings-font-option-serif").click();

  const scroller = page.locator(".cm-editor").first().locator("> .cm-scroller");
  await expect
    .poll(() => scroller.evaluate((element) => getComputedStyle(element).fontSize))
    .toBe("24px");
  const proseFamily = await scroller.evaluate((element) => getComputedStyle(element).fontFamily);
  expect(proseFamily).toContain("Iowan Old Style");
  expect(proseFamily).not.toContain("SF Mono");

  const codeScroller = page.locator(".cm-md-code-block-widget .cm-scroller").first();
  await expect(codeScroller).toContainText("const answer = 42;");
  const codeFamily = await codeScroller.evaluate((element) => getComputedStyle(element).fontFamily);
  expect(codeFamily).toContain("SF Mono");

  await settings.close();
});

test("restores the defaults from settings", async ({ page }) => {
  await page.goto("/settings.html");
  await page.waitForFunction(() => Boolean(window.__QINGMO_SETTINGS_E2E__));

  await page.getByTestId("settings-font-size").fill("28");
  await page.getByTestId("settings-font-option-sans").click();
  await expect(page.getByTestId("settings-typography-reset")).toBeEnabled();

  await page.getByTestId("settings-typography-reset").click();

  await expect(page.getByTestId("settings-font-size")).toHaveValue("15");
  await expect(page.getByTestId("settings-font-mono")).toBeChecked();
  await expect(page.getByTestId("settings-typography-reset")).toBeDisabled();
  await expect(page.getByRole("status")).toHaveText("编辑器排版已恢复默认。");
});

test("applies persistence across a reload of the editor", async ({ page }) => {
  await page.goto("/settings.html");
  await page.waitForFunction(() => Boolean(window.__QINGMO_SETTINGS_E2E__));
  await page.getByTestId("settings-font-size").fill("20");
  await page.getByTestId("settings-font-option-sans").click();
  await expect(page.getByTestId("settings-font-sans")).toBeChecked();

  await openApp(page);
  const scroller = page.locator(".cm-editor").first().locator("> .cm-scroller");
  await expect
    .poll(() => scroller.evaluate((element) => getComputedStyle(element).fontSize))
    .toBe("20px");
  const family = await scroller.evaluate((element) => getComputedStyle(element).fontFamily);
  expect(family).toContain("Avenir Next");

  await page.reload();
  await page.waitForFunction(() => Boolean(window.__QINGMO_E2E__));
  const reloaded = page.locator(".cm-editor").first().locator("> .cm-scroller");
  await expect
    .poll(() => reloaded.evaluate((element) => getComputedStyle(element).fontSize))
    .toBe("20px");
});
