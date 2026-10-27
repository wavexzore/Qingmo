import { expect, test } from "@playwright/test";

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

test.describe("About window", () => {
  test("renders the Colophon edition and copies the version banner", async ({ page }) => {
    await page.goto("/about.html");

    await expect(page.getByRole("heading", { name: "青墨" })).toBeVisible();
    await expect(page.getByTestId("about-version")).toHaveText("0.1.0");
    await expect(page.getByTestId("about-build")).toHaveText("0.1.0 · arm64");
    await expect(page.getByTestId("about-platform")).toHaveText("macOS");
    await expect(page.getByTestId("about-license")).toHaveText("Apache-2.0");
    await expect(page.getByTestId("about-status")).toHaveText("已是最新版本");

    await page.getByTestId("about-copy").click();
    await expect(page.getByText("版本信息已复制")).toBeVisible();
  });

  test("routes links and close through the native port", async ({ page }) => {
    await page.goto("/about.html");

    await page.getByTestId("about-link-github").click();
    await expect
      .poll(() => page.evaluate(() => window.__QINGMO_ABOUT_E2E__?.about.openedLinks ?? []))
      .toContain("github");

    await page.getByTestId("about-close").click();
    await expect
      .poll(() => page.evaluate(() => window.__QINGMO_ABOUT_E2E__?.about.closed ?? false))
      .toBe(true);
  });

  test("checks for updates and turns the action into a changelog link", async ({ page }) => {
    await page.goto("/about.html");

    await page.evaluate(() => {
      window.__QINGMO_ABOUT_E2E__?.updates.setUpdate({
        version: "0.2.0",
        date: null,
        body: null,
      });
    });
    await page.getByTestId("about-check").click();

    await expect(page.getByTestId("about-status")).toContainText("发现新版本 0.2.0");
    await expect(page.getByTestId("about-check")).toHaveText("查看更新");

    await page.getByTestId("about-check").click();
    await expect
      .poll(() => page.evaluate(() => window.__QINGMO_ABOUT_E2E__?.about.openedLinks ?? []))
      .toContain("changelog");
  });
});
