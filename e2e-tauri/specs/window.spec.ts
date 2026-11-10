import { browser, expect } from "@wdio/globals";

import { closeCurrentWindow, ensureDocumentWindow, resetFixture, tauri } from "./helpers";

describe("real Tauri window lifecycle", () => {
  before(async () => {
    await resetFixture();
  });

  it("uses the pinned document as the first window and closes a second window cleanly", async () => {
    const first = await ensureDocumentWindow();
    const initial = await tauri().listWindows();
    expect(initial).not.toContain("main");
    expect(initial).toContain(first);

    await browser.keys(["Meta", "n"]);
    await browser.waitUntil(
      async () => (await browser.getWindowHandles()).length === initial.length + 1,
      { timeout: 30_000, timeoutMsg: "New did not create a second window" },
    );

    const handles = await browser.getWindowHandles();
    const created = handles.find((handle) => handle !== first);
    expect(created).toBeDefined();
    await tauri().switchWindow(created!);
    // A freshly created webview can be listed before its document is ready;
    // closing in that window race leaves the native window alive.
    await browser.waitUntil(
      async () => (await browser.execute(() => document.readyState)) === "complete",
      { timeout: 30_000, timeoutMsg: "the second window never became ready" },
    );

    // The new window is clean, so the real CloseGuard confirms immediately
    // and destroys only that window. Use the window API because Cmd+W is a
    // native menu accelerator that synthesized WebDriver keys do not reach.
    await closeCurrentWindow();
    await browser.waitUntil(
      async () => (await browser.getWindowHandles()).length === initial.length,
      { timeout: 60_000, timeoutMsg: "closing the second window left it alive" },
    );

    await tauri().switchWindow(first);
    expect(await tauri().listWindows()).toEqual(initial);
  });
});
