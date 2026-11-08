import { browser, $, expect } from "@wdio/globals";
import fs from "node:fs";

import { fixture, readFixture, resetFixture } from "./helpers";

describe("real Tauri open -> edit -> save -> conflict", () => {
  before(async () => {
    await resetFixture();
  });

  it("opens the pinned document without a blank main window", async () => {
    const content = await $(".cm-content");
    await content.waitForDisplayed({ timeout: 30_000 });
    expect(await content.getText()).toContain("base");
  });

  it("saves through the real AtomicWriter and updates the disk bytes", async () => {
    const line = await $('//*[contains(@class,"cm-line") and contains(.,"base")]');
    await line.click();
    await browser.keys(["End", "Enter", "l", "o", "c", "a", "l"]);
    await browser.keys(["Meta", "s"]);

    await browser.waitUntil(() => readFixture().includes("local"), {
      timeout: 15_000,
      timeoutMsg: "the saved bytes never reached the fixture",
    });
    expect(readFixture()).toContain("![pixel](assets/pixel.png)");
  });

  it("keeps a dirty document, shows the conflict banner and overwrites on confirm", async () => {
    const line = await $('//*[contains(@class,"cm-line") and contains(.,"local")]');
    await line.click();
    await browser.keys(["End", "Enter", "m", "o", "r", "e"]);

    fs.writeFileSync(fixture, "external\n");

    const banner = await $('[data-testid="conflict-banner"]');
    await banner.waitForDisplayed({ timeout: 15_000 });
    expect(await banner.getText()).toContain("磁盘");

    await $('[data-testid="conflict-overwrite"]').click();
    const confirm = await $('[data-testid="conflict-confirm"]');
    await confirm.$('//button[normalize-space(.)="确认"]').click();

    await banner.waitForDisplayed({ reverse: true, timeout: 15_000 });
    await browser.waitUntil(() => readFixture().includes("more"), {
      timeout: 15_000,
      timeoutMsg: "the confirmed overwrite did not reach the disk",
    });
  });
});
