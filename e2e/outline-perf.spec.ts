import { expect, test, type Page } from "@playwright/test";

import { editorContent, emitMenuAction, openApp, openSeededFile } from "./helpers";

const PERF_PATH = "/docs/outline-perf.md";
const HEADING_COUNT = 500;
const WARMUP = 2;
const ITERATIONS = 16;

function percentile(samples: readonly number[], fraction: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

/** Exactly 200k UTF-16 units, so the field reports `complete` once parsed. */
function largeDocument(): string {
  const headings = Array.from({ length: HEADING_COUNT }, (_, index) => `## Section ${index}`).join(
    "\n\n",
  );
  const tail = `\n\n${headings}\n\n`;
  const paragraph = "bounded outline performance paragraph line";
  let text = tail;
  let index = 0;
  while (text.length + paragraph.length + 2 <= 200_000) {
    text += `${paragraph} ${index}\n\n`;
    index += 1;
  }
  if (text.length < 200_000) {
    text += "x".repeat(200_000 - text.length);
  }
  return text;
}

function anchoredDocument(): string {
  const headings = Array.from({ length: 1_200 }, (_, index) => `# H${index}`).join("\n\n");
  return `[go to 501](#h500)\n\n${headings}\n`;
}

function panel(page: Page) {
  return page.getByTestId("outline-panel");
}

async function openPanel(page: Page): Promise<void> {
  await emitMenuAction(page, "view.toggleOutline");
  await expect(panel(page)).toBeVisible();
  await expect(panel(page)).toHaveAttribute("data-outline-status", "complete");
}

test.describe("outline performance", () => {
  test.skip(!process.env.OUTLINE_PERF, "set OUTLINE_PERF=1 to run the outline perf sample");
  test.describe.configure({ timeout: 240_000 });

  test("E2E-015: menu-to-complete latency for a 200k document", async ({ page }) => {
    const text = largeDocument();
    await openApp(page, [{ path: PERF_PATH, text }]);

    const samples: number[] = [];
    for (let index = 0; index < WARMUP + ITERATIONS; index += 1) {
      await page.reload();
      await page.waitForFunction(() => Boolean(window.__QINGMO_E2E__));
      await expect(page.getByTestId("untitled-editor")).toBeVisible();
      await openSeededFile(page, "outline-perf.md");

      const elapsed = await page.evaluate(
        () =>
          new Promise<number>((resolve) => {
            const started = performance.now();
            window.__QINGMO_E2E__?.emitMenuAction("view.toggleOutline");
            const check = () => {
              const element = document.querySelector<HTMLElement>('[data-testid="outline-panel"]');
              if (element?.getAttribute("data-outline-status") === "complete") {
                resolve(performance.now() - started);
                return;
              }
              requestAnimationFrame(check);
            };
            requestAnimationFrame(check);
          }),
      );
      if (index >= WARMUP) {
        samples.push(elapsed);
      }
      await expect(panel(page)).toHaveAttribute("data-outline-count", "500");
    }

    const p50 = percentile(samples, 0.5);
    const p95 = percentile(samples, 0.95);
    console.log(
      `outline 200k open: p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms ` +
        `samples=${samples.map((value) => value.toFixed(1)).join(", ")}`,
    );
    expect(samples).toHaveLength(ITERATIONS);
    expect(p95).toBeLessThanOrEqual(300);
  });

  test("E2E-016: typing 20 characters creates no long task over 50ms", async ({ page }) => {
    await openApp(page, [{ path: PERF_PATH, text: largeDocument() }]);
    await openSeededFile(page, "outline-perf.md");
    await openPanel(page);

    await page.evaluate(() => {
      const state = {
        longTasks: [] as Array<{ startTime: number; duration: number }>,
        maxFrameGap: 0,
        stop: false,
      };
      (
        window as unknown as {
          __OUTLINE_INPUT_PERF__: typeof state & { observer: PerformanceObserver | null };
        }
      ).__OUTLINE_INPUT_PERF__ = { ...state, observer: null };
      const perf = (
        window as unknown as {
          __OUTLINE_INPUT_PERF__: typeof state & { observer: PerformanceObserver | null };
        }
      ).__OUTLINE_INPUT_PERF__;
      if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
        perf.observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            perf.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
          }
        });
        perf.observer.observe({ entryTypes: ["longtask"] });
      }
      let last = performance.now();
      const tick = (now: number) => {
        if (perf.stop) {
          return;
        }
        perf.maxFrameGap = Math.max(perf.maxFrameGap, now - last);
        last = now;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    await editorContent(page).click();
    await page.keyboard.type("abcdefghijklmnopqrst", { delay: 15 });
    await page.waitForTimeout(700);

    const result = await page.evaluate(() => {
      const perf = (
        window as unknown as {
          __OUTLINE_INPUT_PERF__: {
            longTasks: Array<{ startTime: number; duration: number }>;
            maxFrameGap: number;
            stop: boolean;
            observer: PerformanceObserver | null;
          };
        }
      ).__OUTLINE_INPUT_PERF__;
      perf.stop = true;
      perf.observer?.disconnect();
      return { longTasks: perf.longTasks, maxFrameGap: perf.maxFrameGap };
    });

    console.log(
      `outline input: longTasks=${result.longTasks.length} ` +
        `maxLongTask=${Math.max(0, ...result.longTasks.map((entry) => entry.duration)).toFixed(1)}ms ` +
        `maxFrameGap=${result.maxFrameGap.toFixed(1)}ms`,
    );
    expect(result.longTasks.filter((entry) => entry.duration > 50)).toEqual([]);
    expect(result.maxFrameGap).toBeLessThan(250);
    await expect(panel(page)).toHaveAttribute("data-outline-total", "500");
  });

  test("E2E-017: 1200 headings render 500 rows and the 501st anchor still resolves", async ({
    page,
  }) => {
    await openApp(page, [{ path: "/docs/outline-anchored.md", text: anchoredDocument() }]);
    await openSeededFile(page, "outline-anchored.md");

    const firstVisible = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          const started = performance.now();
          window.__QINGMO_E2E__?.emitMenuAction("view.toggleOutline");
          const check = () => {
            const element = document.querySelector<HTMLElement>('[data-testid="outline-panel"]');
            if (element?.getAttribute("data-outline-count") === "500") {
              resolve(performance.now() - started);
              return;
            }
            requestAnimationFrame(check);
          };
          requestAnimationFrame(check);
        }),
    );

    await expect(panel(page)).toHaveAttribute("data-outline-count", "500");
    await expect(panel(page)).toHaveAttribute("data-outline-total", "1200");
    const panelNodes = await panel(page).evaluate(
      (element) => element.querySelectorAll("*").length,
    );
    console.log(
      `outline 1200 headings: firstVisible=${firstVisible.toFixed(1)}ms panelNodes=${panelNodes}`,
    );
    expect(firstVisible).toBeLessThan(2_000);
    expect(panelNodes).toBeLessThanOrEqual(2_500);

    // Move the cursor off the link line so Live Preview renders the anchor
    // widget, then activate the link to the 501st heading (index 500).
    await editorContent(page).locator(".cm-line").filter({ hasText: "H0" }).first().click();
    const link = page.locator(".cm-md-anchor-link").filter({ hasText: "go to 501" });
    await expect(link).toBeVisible();
    await link.click();
    await expect(page.getByTestId("status-bar")).toContainText("第 1003 行");
  });
});
