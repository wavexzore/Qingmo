import { browser, $, expect } from "@wdio/globals";
import fs from "node:fs";

import {
  BASE_DOCUMENT,
  closeCurrentWindow,
  ensureDocumentWindow,
  fixture,
  readFixture,
  resetFixture,
  tauri,
  waitForWindowCount,
} from "./helpers";

const iterations = Number.parseInt(process.env.QINGMO_SOAK_ITERATIONS ?? "5", 10);

async function openUntitledWindow(
  baseline: string[],
): Promise<{ created: string; alive: string[] }> {
  await browser.keys(["Meta", "n"]);
  const alive = await waitForWindowCount(baseline.length + 1);
  const created = alive.find((handle) => !baseline.includes(handle));
  if (!created) {
    throw new Error("New did not create a second document window");
  }
  await tauri().switchWindow(created);
  return { created, alive };
}

async function typeSoakToken(iteration: number): Promise<void> {
  const token = `soak${iteration}`;
  await (await $(".cm-content")).click();
  await browser.keys(token.split(""));
  await browser.waitUntil(async () => (await (await $(".cm-content")).getText()).includes(token), {
    timeout: 10_000,
    timeoutMsg: "the soak edit never reached the editor",
  });
  // A dirty untitled document must prompt before it can be closed.
  expect(await (await $('[data-testid="status-bar"]')).getText()).toContain("未保存");
}

/**
 * Closes a dirty untitled window twice: the first attempt is cancelled through
 * the real CloseGuard, the second is confirmed. That exercises cancel,
 * re-arm, flush and destroy on every iteration.
 */
async function waitForOverlay(visible: boolean): Promise<void> {
  await browser.waitUntil(
    async () => {
      // Re-query every time: the dialog unmounts and remounts, so a cached
      // element reference from the first prompt would be stale.
      const overlay = await $('[data-testid="close-confirm-overlay"]');
      return (await overlay.isDisplayed()) === visible;
    },
    {
      timeout: 15_000,
      interval: 100,
      timeoutMsg: `the close dialog never became ${visible ? "visible" : "hidden"}`,
    },
  );
}

async function cancelThenConfirmClose(initialCount: number): Promise<void> {
  await closeCurrentWindow();
  await waitForOverlay(true);
  await $('[data-testid="close-cancel"]').click();
  await waitForOverlay(false);
  await waitForWindowCount(initialCount + 1);

  // The guard must be re-armed after a cancellation.
  await closeCurrentWindow();
  await waitForOverlay(true);
  await $('[data-testid="close-confirm"]').click();
  await waitForWindowCount(initialCount);
}

describe("real Tauri P0 soak", () => {
  before(async () => {
    await resetFixture();
  });

  it(`cycles ${iterations} untitled windows through cancel, close and re-arm`, async () => {
    const document = await ensureDocumentWindow();
    const baseline = await waitForWindowCount(1);

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      await tauri().switchWindow(document);
      await openUntitledWindow(baseline);
      await typeSoakToken(iteration);
      await cancelThenConfirmClose(baseline.length);

      await tauri().switchWindow(document);
      const text = await (await $(".cm-content")).getText();
      expect(text).toContain("base");

      // Every tenth round also saves the pinned document through the real
      // AtomicWriter so the soak covers disk writes, not only windows.
      if (iteration % 10 === 9) {
        const token = `soak-save-${iteration}`;
        const line = await $('//*[contains(@class,"cm-line") and contains(.,"base")]');
        await line.click();
        await browser.keys(["End", "Enter", ...token.split("")]);
        await browser.keys(["Meta", "s"]);
        await browser.waitUntil(() => readFixture().includes(token), {
          timeout: 15_000,
          timeoutMsg: "the soak save never reached the disk",
        });
        expect(await (await $('[data-testid="conflict-banner"]')).isExisting()).toBe(false);
      }
    }

    const finalHandles = await browser.getWindowHandles();
    expect(finalHandles).toEqual(baseline);
    await tauri().switchWindow(document);
  });

  after(async () => {
    // Leave the shared fixture in its canonical state for later specs.
    fs.writeFileSync(fixture, BASE_DOCUMENT);
    await browser.waitUntil(
      async () => {
        const text = await (await $(".cm-content")).getText();
        return text.includes("WDIO") && !text.includes("soak-save-");
      },
      { timeout: 30_000, interval: 500, timeoutMsg: "the fixture did not reset" },
    );
  });
});
