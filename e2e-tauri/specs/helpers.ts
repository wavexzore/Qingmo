import { browser, $ } from "@wdio/globals";
import fs from "node:fs";
import type { Browser } from "webdriverio";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.dirname(fileURLToPath(import.meta.url));
export const fixture = path.join(root, "..", "fixtures", "note.md");

export const BASE_DOCUMENT = "# WDIO\n\nbase\n\n![pixel](assets/pixel.png)\n";

export interface TauriBrowser extends Browser {
  tauri: {
    listWindows(): Promise<string[]>;
    switchWindow(label: string): Promise<void>;
    execute<T>(script: () => T | Promise<T>, ...args: unknown[]): Promise<T>;
  };
}

export function tauri(): TauriBrowser["tauri"] {
  return (browser as TauriBrowser).tauri;
}

/** Closes the webview that currently owns the service label. */
export async function closeCurrentWindow(): Promise<void> {
  await (browser as TauriBrowser).tauri.execute(() => {
    const api = (
      window as unknown as {
        __TAURI__: { window: { getCurrentWindow(): { close(): Promise<void> } } };
      }
    ).__TAURI__;
    return api.window.getCurrentWindow().close();
  });
}

/** Waits until the app owns exactly `count` webviews and returns them. */
export async function waitForWindowCount(count: number, timeout = 30_000): Promise<string[]> {
  let handles: string[] = [];
  await browser.waitUntil(
    async () => {
      handles = await browser.getWindowHandles();
      return handles.length === count;
    },
    { timeout, interval: 100, timeoutMsg: `expected exactly ${count} windows` },
  );
  return handles;
}

/**
 * Points the service's execute/mocking surface at the real document window.
 *
 * The service defaults to `main`, but the pinned-document launch never creates
 * a blank main window. `getWindowHandles` is plain WebDriver, so it works
 * before any plugin command has been bound to a label.
 */
export async function ensureDocumentWindow(): Promise<string> {
  const handles = await browser.getWindowHandles();
  const label = handles.find((handle) => handle.startsWith("doc-")) ?? handles[0];
  if (!label) {
    throw new Error("no document window is available");
  }
  await tauri().switchWindow(label);
  return label;
}

/**
 * Canonical text used to compare the disk fixture with the rendered editor.
 *
 * The live-preview extension hides markdown syntax (image source, heading
 * markers) inside the editor DOM, so `getText` returns `WDIObase` for the
 * fixture's `# WDIO ... ![pixel](...)`. Strip the same syntax from the file
 * content before comparing; whitespace is not stable across renderers either.
 */
function canonicalDocument(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/#/g, "")
    .replace(/\s+/g, "");
}

/**
 * Writes the fixture and waits for the real file watcher to reload it.
 *
 * The app may launch before or after `before`, so a single write can race the
 * watcher registration; rewriting retriggers the event without changing the
 * desired bytes. The comparison must be exact: a previous run leaves the edit
 * token in the fixture, and a substring check would accept that stale buffer
 * before the reload lands.
 */
export async function resetFixture(content = BASE_DOCUMENT): Promise<void> {
  await ensureDocumentWindow();
  fs.writeFileSync(fixture, content);
  const expected = canonicalDocument(content);
  await browser.waitUntil(
    async () => {
      const text = await (await $(".cm-content")).getText();
      if (canonicalDocument(text) === expected) {
        return true;
      }
      fs.writeFileSync(fixture, content);
      return false;
    },
    { timeout: 30_000, interval: 500, timeoutMsg: "the fixture did not reload" },
  );
  // Park the cursor at the document start. The live preview reveals markdown
  // source on the cursor line; a reload restores the previous run's cursor on
  // the image line, which hides the rendered <img> the image spec asserts.
  await (await $(".cm-content")).click();
  await browser.keys(["Meta", "ArrowUp"]);
}

export function readFixture(): string {
  return fs.readFileSync(fixture, "utf8");
}

export async function typeIntoEditor(...keys: string[]): Promise<void> {
  await (await $(".cm-content")).click();
  await browser.keys(keys);
}
