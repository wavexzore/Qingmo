import { expect, test, type Page } from "@playwright/test";

import {
  BASE_FILES,
  NOTE_PATH,
  emitMenuAction,
  getLocaleCalls,
  modifier,
  openApp,
  openSeededFile,
  setLogFileCount,
} from "./helpers";

const BASE_URL = "http://127.0.0.1:4173";

function trackExternalRequests(page: Page): string[] {
  const external: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (/^https?:/.test(url) && !url.startsWith(BASE_URL)) {
      external.push(url);
    }
  });
  return external;
}

test("switches the untitled editor, palette and persisted language", async ({ page }) => {
  const external = trackExternalRequests(page);
  await openApp(page);

  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.locator(".cm-placeholder")).toHaveText("开始写作…");

  await emitMenuAction(page, "language.en");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator(".cm-placeholder")).toHaveText("Start writing…");

  const calls = await getLocaleCalls(page);
  expect(calls.at(-1)?.language).toBe("en");
  expect(calls.at(-1)?.labels.file).toBe("File");
  expect(calls.at(-1)?.labels.about).toContain("Qingmo");
  expect(calls.at(-1)?.labels.untitledFileName).toBe("Untitled.md");

  await page.keyboard.press(`${modifier()}+k`);
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();
  await expect(palette.getByRole("combobox")).toHaveAttribute("placeholder", "Search commands…");
  await expect(palette.getByRole("option", { name: /Open file/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();

  await page.reload();
  await page.waitForFunction(() => Boolean(window.__QINGMO_E2E__));
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator(".cm-placeholder")).toHaveText("Start writing…");

  await emitMenuAction(page, "language.zh-CN");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.locator(".cm-placeholder")).toHaveText("开始写作…");
  await emitMenuAction(page, "language.en");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");

  expect(external).toEqual([]);
});

test("keeps document and About windows in sync through storage", async ({ page, context }) => {
  await openApp(page);

  const about = await context.newPage();
  await about.goto("/about.html");
  await expect(about.getByRole("heading", { name: "青墨" })).toBeVisible();

  const documentPage = await context.newPage();
  await documentPage.addInitScript((seed) => {
    window.__QINGMO_E2E_SEED__ = seed;
  }, BASE_FILES);
  await documentPage.addInitScript((path) => {
    window.__QINGMO_E2E_PENDING__ = path;
  }, NOTE_PATH);
  await documentPage.goto("/?window=document");
  await documentPage.waitForFunction(() => Boolean(window.__QINGMO_E2E__));
  await expect(documentPage.getByTestId("document-session")).toBeVisible();
  await expect(documentPage.getByTestId("status-bar")).toContainText("第 1 行，第 1 列");

  await emitMenuAction(page, "language.en");

  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(documentPage.locator("html")).toHaveAttribute("lang", "en");
  await expect(documentPage.getByTestId("status-bar")).toContainText("Line 1, column 1");
  await expect(about.locator("html")).toHaveAttribute("lang", "en");
  await expect(about.getByRole("heading", { name: "Qingmo" })).toBeVisible();
  await expect(about.getByTestId("about-status")).toHaveText("You are up to date");

  const aboutKeys = await about.evaluate(() =>
    Object.keys(window.__QINGMO_ABOUT_E2E__ ?? {}).sort(),
  );
  expect(aboutKeys).toEqual(["about", "updates"]);

  await documentPage.close();
  await about.close();
});

test("falls back to zh-CN for an unsupported persisted language", async ({ context }) => {
  const page = await context.newPage();
  await page.addInitScript(() => {
    localStorage.setItem("qingmo.ui.language", "fr");
  });
  await openApp(page);

  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.locator(".cm-placeholder")).toHaveText("开始写作…");
  await page.close();
});

test("renames the untitled status bar without residue", async ({ page }) => {
  await openApp(page);
  await page.locator(".cm-content").click();
  await page.keyboard.type("x");

  await expect(page.getByTestId("status-bar")).toContainText("未命名");
  await emitMenuAction(page, "language.en");
  await expect(page.getByTestId("status-bar")).toContainText("Untitled");
  await emitMenuAction(page, "language.zh-CN");
  await expect(page.getByTestId("status-bar")).toContainText("未命名");
  await expect(page.getByTestId("status-bar")).not.toContainText("Untitled");
});

test("a named empty file never shows the untitled placeholder", async ({ page }) => {
  await openApp(page, [{ path: "/docs/empty.md", text: "" }]);
  await openSeededFile(page, "empty.md");

  await expect(page.locator(".cm-placeholder")).toHaveCount(0);
  await expect(page.getByTestId("status-bar")).toContainText("empty.md");

  await emitMenuAction(page, "language.en");
  await expect(page.locator(".cm-placeholder")).toHaveCount(0);
  await expect(page.getByTestId("status-bar")).toContainText("empty.md");
});

test("localizes log file counts and timestamps", async ({ page }) => {
  await openApp(page);
  await emitMenuAction(page, "app.openLogs");

  const chinese = page.getByRole("dialog", { name: "运行日志" });
  await expect(chinese).toBeVisible();
  await expect(chinese.getByTestId("logs-stats")).toContainText("1 个文件");

  await chinese.getByTestId("logs-close").click();
  await emitMenuAction(page, "language.en");

  await emitMenuAction(page, "app.openLogs");
  const english = page.getByRole("dialog", { name: "Runtime logs" });
  await expect(english).toBeVisible();
  await expect(english.getByTestId("logs-stats")).toContainText("1 file");

  await setLogFileCount(page, 2);
  await english.getByTestId("logs-close").click();
  await emitMenuAction(page, "app.openLogs");

  const logsDialog = page.getByRole("dialog", { name: "Runtime logs" });
  await expect(logsDialog.getByTestId("logs-stats")).toContainText("2 files");

  const expected = await page.evaluate(() => {
    return new Intl.DateTimeFormat("en", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date("2026-10-28T02:45:12.100000Z"));
  });
  await expect(logsDialog.getByTestId("logs-list")).toContainText(expected);
});
