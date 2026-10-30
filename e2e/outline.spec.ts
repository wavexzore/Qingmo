import { expect, test, type Page } from "@playwright/test";

import {
  OUTLINE_PATH,
  OUTLINE_SWITCHED_PATH,
  OUTLINE_SWITCHED_TEXT,
  OUTLINE_TEXT,
  editorContent,
  emitMenuAction,
  modifier,
  openApp,
  openSeededFile,
} from "./helpers";

test.use({ reducedMotion: "no-preference" });

function panel(page: Page) {
  return page.getByTestId("outline-panel");
}

function items(page: Page) {
  return panel(page).getByRole("list").getByRole("button");
}

function item(page: Page, text: string) {
  return panel(page).getByRole("button", { name: new RegExp(text) });
}

async function openOutlineFixture(page: Page): Promise<void> {
  await openApp(page, [{ path: OUTLINE_PATH, text: OUTLINE_TEXT }]);
  await openSeededFile(page, "outline.md");
}

async function openPanel(page: Page): Promise<void> {
  await emitMenuAction(page, "view.toggleOutline");
  await expect(panel(page)).toBeVisible();
  await expect(panel(page)).toHaveAttribute("data-outline-status", "complete");
}

test("E2E-001/002/010: the outline is hidden by default and toggles from the menu and palette", async ({
  page,
}) => {
  await openOutlineFixture(page);
  await expect(panel(page)).toHaveCount(0);

  await openPanel(page);
  await expect(items(page)).toHaveText([
    "Alpha",
    "Beta section",
    "Gamma section",
    "Gamma child",
    "Omega",
  ]);

  await panel(page).getByRole("button", { name: "关闭大纲" }).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(editorContent(page)).toBeFocused();

  await emitMenuAction(page, "view.toggleOutline");
  await expect(panel(page)).toBeVisible();

  await page.keyboard.press(`${modifier()}+k`);
  const palette = page.getByRole("dialog", { name: "命令面板" });
  await expect(palette).toBeVisible();
  await palette.getByRole("combobox").fill("切换大纲");
  await palette.getByRole("combobox").press("Enter");
  await expect(palette).toBeHidden();
  await expect(panel(page)).toHaveCount(0);
  await expect(editorContent(page)).toBeFocused();
});

type WidthSample = number | null;

async function startWidthSampler(page: Page): Promise<void> {
  await page.evaluate(() => {
    const samples: WidthSample[] = [];
    (window as unknown as { __OUTLINE_WIDTH_SAMPLES__: WidthSample[] }).__OUTLINE_WIDTH_SAMPLES__ =
      samples;
    const tick = () => {
      const element = document.querySelector<HTMLElement>('[data-testid="outline-panel"]');
      samples.push(element ? element.getBoundingClientRect().width : null);
      if (samples.length < 180) {
        requestAnimationFrame(tick);
      }
    };
    requestAnimationFrame(tick);
  });
}

async function readWidthSamples(page: Page): Promise<WidthSample[]> {
  return page.evaluate(
    () =>
      (window as unknown as { __OUTLINE_WIDTH_SAMPLES__: WidthSample[] }).__OUTLINE_WIDTH_SAMPLES__,
  );
}

function hasIntermediateWidth(samples: WidthSample[]): boolean {
  return samples.some((width) => width !== null && width > 1 && width < 239);
}

test("E2E-018: the panel animates open and closed without remounting the editor", async ({
  page,
}) => {
  await openOutlineFixture(page);
  await page.evaluate(() => {
    (window as unknown as { __OUTLINE_EDITOR__: Element | null }).__OUTLINE_EDITOR__ =
      document.querySelector(".cm-editor");
  });

  await startWidthSampler(page);
  await emitMenuAction(page, "view.toggleOutline");
  await expect(panel(page)).toHaveAttribute("data-outline-visible", "true");
  await page.waitForTimeout(300);

  const openSamples = await readWidthSamples(page);
  // Intermediate widths prove the panel grows instead of snapping to 240px.
  expect(hasIntermediateWidth(openSamples)).toBe(true);
  expect(openSamples.at(-1)).toBeCloseTo(240, 0);

  await startWidthSampler(page);
  await panel(page).getByRole("button", { name: "关闭大纲" }).click();
  await expect(panel(page)).toHaveCount(0);

  const closeSamples = await readWidthSamples(page);
  expect(hasIntermediateWidth(closeSamples)).toBe(true);
  expect(closeSamples.at(-1)).toBeNull();

  const sameEditor = await page.evaluate(
    () =>
      (window as unknown as { __OUTLINE_EDITOR__: Element | null }).__OUTLINE_EDITOR__ ===
      document.querySelector(".cm-editor"),
  );
  expect(sameEditor).toBe(true);
});

test("E2E-003: clicking an item moves the selection and puts the heading 10px from the top", async ({
  page,
}) => {
  await openOutlineFixture(page);
  await openPanel(page);

  await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>(".cm-scroller");
    const samples: number[] = [];
    (window as unknown as { __OUTLINE_SCROLL_SAMPLES__: number[] }).__OUTLINE_SCROLL_SAMPLES__ =
      samples;
    scroller?.addEventListener("scroll", () => {
      samples.push(scroller.scrollTop);
    });
  });

  await item(page, "Gamma section").click();
  await expect(page.getByTestId("status-bar")).toContainText("第 25 行");
  await expect(item(page, "Gamma section")).toHaveAttribute("aria-current", "location");

  const offset = () =>
    page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>(".cm-scroller");
      const line = [...document.querySelectorAll<HTMLElement>(".cm-line")].find((element) =>
        element.textContent?.includes("Gamma section"),
      );
      const heading = line?.firstElementChild;
      if (!scroller || !heading) {
        return Number.POSITIVE_INFINITY;
      }
      // The line box includes leading; the heading's own box starts at the
      // scroll target (10px).
      return Math.abs(
        heading.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 10,
      );
    });
  await expect.poll(offset).toBeLessThanOrEqual(2);

  const samples = await page.evaluate(
    () =>
      (window as unknown as { __OUTLINE_SCROLL_SAMPLES__: number[] }).__OUTLINE_SCROLL_SAMPLES__,
  );
  // Smooth navigation visits intermediate scroll positions instead of a single
  // hard cut. Scroll events coalesce, so two distinct steps is enough evidence.
  expect(new Set(samples).size).toBeGreaterThan(1);
});

test("E2E-004/012: one Tab stop, roving keys and Enter navigate the outline", async ({ page }) => {
  await openOutlineFixture(page);
  await openPanel(page);

  const list = panel(page).getByRole("list");
  const buttons = items(page);
  const close = panel(page).getByRole("button", { name: "关闭大纲" });
  await expect(close).toHaveAttribute("aria-label", "关闭大纲");
  await expect(list).toHaveAttribute("aria-label", "文档大纲");
  await expect(buttons.first()).toHaveAttribute("tabindex", "0");
  await expect(buttons.nth(1)).toHaveAttribute("tabindex", "-1");

  await editorContent(page).locator(".cm-line").filter({ hasText: "Alpha body." }).click();
  await page.keyboard.press("Shift+Tab");
  await expect(buttons.first()).toBeFocused();

  await page.keyboard.press("ArrowDown");
  await expect(buttons.nth(1)).toBeFocused();
  await page.keyboard.press("End");
  await expect(buttons.last()).toBeFocused();
  await page.keyboard.press("Home");
  await expect(buttons.first()).toBeFocused();

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("status-bar")).toContainText("第 10 行");

  // Enter hands focus back to the editor; Shift+Tab re-enters the list at the
  // single roving tab stop.
  await page.keyboard.press("Shift+Tab");
  await expect(buttons.nth(1)).toBeFocused();
  await page.keyboard.press("End");
  await expect(buttons.last()).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("status-bar")).toContainText("第 33 行");

  // The roving tabindex still exposes exactly one tab stop.
  const tabStops = await buttons.evaluateAll(
    (elements) => elements.filter((element) => element.getAttribute("tabindex") === "0").length,
  );
  expect(tabStops).toBe(1);
});

test("E2E-005: aria-current follows the editor cursor", async ({ page }) => {
  await openOutlineFixture(page);
  await openPanel(page);

  await editorContent(page).locator(".cm-line").filter({ hasText: "Gamma body." }).click();
  await expect(item(page, "Gamma section")).toHaveAttribute("aria-current", "location");
  await expect(item(page, "Alpha")).not.toHaveAttribute("aria-current");

  await page.keyboard.press(`${modifier()}+End`);
  await expect(item(page, "Omega")).toHaveAttribute("aria-current", "location");
  await expect(item(page, "Gamma section")).not.toHaveAttribute("aria-current");
});

test("E2E-006: source and live preview expose the same entries", async ({ page }) => {
  await openOutlineFixture(page);
  await openPanel(page);
  const previewLabels = await items(page).allTextContents();

  await emitMenuAction(page, "view.toggleLivePreview");
  await expect(page.locator(".cm-editor").first()).not.toHaveAttribute("data-live-preview");
  await expect(items(page)).toHaveText(previewLabels);

  await emitMenuAction(page, "view.toggleLivePreview");
  await expect(page.locator(".cm-editor").first()).toHaveAttribute("data-live-preview", "true");
  await expect(items(page)).toHaveText(previewLabels);
});

test("E2E-007: a clean external reload replaces headings within one notify window", async ({
  page,
}) => {
  await openOutlineFixture(page);
  await openPanel(page);
  await expect(items(page).first()).toHaveText("Alpha");

  const elapsed = await page.evaluate(
    ({ path, text }) =>
      new Promise<number>((resolve) => {
        const panelElement = document.querySelector<HTMLElement>('[data-testid="outline-panel"]');
        if (!panelElement) {
          resolve(-1);
          return;
        }
        const started = performance.now();
        const observer = new MutationObserver(() => {
          if (panelElement.textContent?.includes("Reloaded heading")) {
            observer.disconnect();
            resolve(performance.now() - started);
          }
        });
        observer.observe(panelElement, { subtree: true, childList: true, characterData: true });
        window.__QINGMO_E2E__?.setDiskText(path, text);
        window.setTimeout(() => {
          observer.disconnect();
          resolve(-1);
        }, 2_000);
      }),
    { path: OUTLINE_PATH, text: "# Reloaded heading\n\n## Fresh section\n" },
  );

  expect(elapsed).toBeGreaterThanOrEqual(0);
  expect(elapsed).toBeLessThan(300);
  await expect(items(page)).toHaveText(["Reloaded heading", "Fresh section"]);
  await expect(panel(page)).not.toContainText("Alpha");
});

test("E2E-008: switching documents never leaves old headings behind", async ({ page }) => {
  await openApp(page, [
    { path: OUTLINE_PATH, text: OUTLINE_TEXT },
    { path: OUTLINE_SWITCHED_PATH, text: OUTLINE_SWITCHED_TEXT },
  ]);
  await openSeededFile(page, "outline.md");
  await openPanel(page);
  await expect(items(page)).toContainText(["Alpha"]);

  await page.evaluate((path) => window.__QINGMO_E2E__?.setOpenFile(path), OUTLINE_SWITCHED_PATH);
  await emitMenuAction(page, "file.open");
  await expect(page.getByTestId("status-bar")).toContainText("outline-switched.md");

  await expect(items(page)).toHaveText(["Switched document", "Replacement heading"]);
  await expect(panel(page)).not.toContainText("Alpha");
  await expect(panel(page)).not.toContainText("Gamma");
});

test("E2E-009: front matter, closed details and fenced code stay out of the outline", async ({
  page,
}) => {
  await openOutlineFixture(page);
  await openPanel(page);

  await expect(panel(page)).not.toContainText("Inside details");
  await expect(panel(page)).not.toContainText("Inside fence");
  await expect(panel(page)).not.toContainText("Outline Fixture");
  await expect(panel(page)).toHaveAttribute("data-outline-count", "5");
});

test("E2E-011: a 210k document reports the size limit and stays editable", async ({ page }) => {
  const filler = "filler line for the large outline document\n".repeat(5_000);
  const text = `# Top\n\n## Early\n\n${filler}${"x".repeat(10_001)}# Beyond the scan window\n`;
  expect(text.length).toBeGreaterThan(200_000);

  await openApp(page, [{ path: "/docs/outline-large.md", text }]);
  await openSeededFile(page, "outline-large.md");
  await emitMenuAction(page, "view.toggleOutline");
  await expect(panel(page)).toBeVisible();
  await expect(panel(page)).toHaveAttribute("data-outline-limit", "size", { timeout: 15_000 });
  await expect(panel(page)).toHaveAttribute("data-outline-status", "partial");
  await expect(panel(page)).toContainText("200k");

  await editorContent(page).click();
  await page.keyboard.type("z");
  await expect(editorContent(page)).toContainText("z");
  await expect(panel(page)).toBeVisible();
});

test("E2E-013: the panel hides below 900px and never overflows horizontally", async ({ page }) => {
  await openOutlineFixture(page);
  await openPanel(page);

  for (const width of [1200, 900, 899, 800, 600]) {
    await page.setViewportSize({ width, height: 800 });
    if (width >= 900) {
      await expect(panel(page)).toBeVisible();
    } else {
      await expect(panel(page)).toBeHidden();
    }
    const overflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth - document.documentElement.clientWidth;
    });
    expect(overflow, `width ${width}`).toBeLessThanOrEqual(1);
  }
});

test("E2E-014: theme and language changes restyle and relabel the panel", async ({ page }) => {
  await openOutlineFixture(page);
  await openPanel(page);

  const background = () =>
    panel(page).evaluate((element) => getComputedStyle(element).backgroundColor);
  const before = await background();
  await emitMenuAction(page, "view.toggleTheme");
  await expect.poll(background).not.toBe(before);

  await emitMenuAction(page, "language.en");
  await expect(panel(page).getByRole("heading", { name: "Outline" })).toBeVisible();
  await expect(panel(page)).toHaveAttribute("aria-label", "Document outline");
  await expect(panel(page).getByRole("button", { name: "Level 1 heading: Alpha" })).toBeVisible();
  await expect(panel(page).getByRole("button", { name: "Close outline" })).toBeVisible();

  await emitMenuAction(page, "language.zh-CN");
  await expect(panel(page).getByRole("heading", { name: "大纲" })).toBeVisible();
  await expect(panel(page).getByRole("button", { name: "关闭大纲" })).toBeVisible();
});
