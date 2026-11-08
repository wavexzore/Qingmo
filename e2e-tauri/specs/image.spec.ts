import { browser, $, expect } from "@wdio/globals";

import { resetFixture } from "./helpers";

describe("real Tauri image rendering", () => {
  before(async () => {
    await resetFixture();
  });

  it("loads a workspace image through the asset protocol", async () => {
    await (await $('img[alt="pixel"]')).waitForExist({ timeout: 30_000 });
    await browser.waitUntil(
      async () => {
        const width = await browser.execute(
          () =>
            (document.querySelector('img[alt="pixel"]') as HTMLImageElement | null)?.naturalWidth ??
            0,
        );
        return width > 0;
      },
      { timeout: 30_000, timeoutMsg: "the image never decoded" },
    );
    expect(
      await browser.execute(
        () =>
          (document.querySelector('img[alt="pixel"]') as HTMLImageElement | null)?.naturalWidth ??
          0,
      ),
    ).toBeGreaterThan(0);
  });
});
