import { browser, $ } from "@wdio/globals";

import { readFixture, resetFixture } from "./helpers";

async function openSearchPanel(): Promise<void> {
  await browser.keys(["Meta", "Shift", "f"]);
  const panel = await $('[data-testid="search-panel"]');
  if (!(await panel.isDisplayed())) {
    await (await $("#sidebar-dock-tab-search")).click();
  }
  await panel.waitForDisplayed({ timeout: 10_000 });
}

async function searchUntilResult(token: string): Promise<void> {
  await browser.waitUntil(
    async () => {
      const input = await $('[role="searchbox"]');
      await input.setValue(token);
      await browser.pause(600);
      return (await $('[role="option"]')).isExisting();
    },
    { timeout: 30_000, interval: 200, timeoutMsg: `no result for ${token}` },
  );
}

async function openResult(fileName: string, expectedText: string): Promise<void> {
  const option = await $(`//li[@role="option"]//*[contains(text(),"${fileName}")]`);
  await option.click();
  // Opening from the dock is asynchronous. Wait for text that only exists in
  // the target document, otherwise a follow-up edit can race the session swap
  // and land in the view that is about to be replaced.
  await browser.waitUntil(
    async () => (await (await $(".cm-content")).getText()).includes(expectedText),
    { timeout: 10_000, timeoutMsg: `the search result did not open ${fileName}` },
  );
}

describe("real Tauri workspace search", () => {
  before(async () => {
    await resetFixture();
  });

  it("searches the open workspace and opens the matching file", async () => {
    await openSearchPanel();
    await searchUntilResult("Image");

    await openResult("image.md", "Image");
  });

  it("reindexes a saved edit and finds the new token", async () => {
    // The previous test switched to image.md, so opening note.md here is
    // observable and guarantees the adoption finished before typing.
    await openSearchPanel();
    await searchUntilResult("base");
    await openResult("note.md", "base");

    const line = await $('//*[contains(@class,"cm-line") and contains(.,"base")]');
    await line.click();
    await browser.keys([
      "End",
      "Enter",
      "s",
      "e",
      "a",
      "r",
      "c",
      "h",
      "n",
      "e",
      "e",
      "d",
      "l",
      "e",
    ]);
    await browser.keys(["Meta", "s"]);

    await browser.waitUntil(() => readFixture().includes("searchneedle"), {
      timeout: 15_000,
      timeoutMsg: "the edited token never reached the disk",
    });

    await openSearchPanel();
    await searchUntilResult("searchneedle");
  });
});
