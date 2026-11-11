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
    execute<T>(script: (...args: never[]) => T | Promise<T>, ...args: unknown[]): Promise<T>;
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
let pinnedDocument = "";

/** Remembers the launch document so meeting windows are never mistaken for it. */
export async function rememberPinnedDocument(): Promise<string> {
  pinnedDocument = await ensureDocumentWindow();
  return pinnedDocument;
}

export async function ensureDocumentWindow(): Promise<string> {
  if (pinnedDocument && (await browser.getWindowHandles()).includes(pinnedDocument)) {
    await browser.switchToWindow(pinnedDocument);
    await tauri().switchWindow(pinnedDocument);
    return pinnedDocument;
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    for (const handle of await browser.getWindowHandles()) {
      try {
        await browser.switchToWindow(handle);
        if (!(await browser.getUrl()).includes("meeting=")) {
          await tauri().switchWindow(handle);
          return handle;
        }
      } catch {
        // A window may disappear between the handle and URL reads.
      }
    }
    await browser.pause(100);
  }
  throw new Error("no document window is available");
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

const MEETING_ENV = [
  "MEETING_E2E_AUDIO",
  "MEETING_E2E_MODELS",
  "MEETING_E2E_PROFILE",
  "MEETING_E2E_FREE_SPACE",
  "MEETING_E2E_DOWNLOAD_BASE",
  "MEETING_E2E_SAVE_AS",
  "MEETING_E2E_SAVE_CANCEL",
] as const;

export const e2eEnvFile =
  process.env.QINGMO_E2E_ENV ?? path.join(root, "..", "fixtures", "meeting", "e2e-env.json");

/**
 * Writes the per-spec hooks the running app reads on next use.
 *
 * The embedded provider cannot relaunch the process, so this file replaces
 * environment variables; `MEETING_E2E_MODELS` stays launch-fixed.
 */
export async function applyMeetingEnv(env: Partial<Record<(typeof MEETING_ENV)[number], string>>) {
  for (const key of MEETING_ENV) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  fs.mkdirSync(path.dirname(e2eEnvFile), { recursive: true });
  fs.writeFileSync(e2eEnvFile, JSON.stringify(env, null, 2));
  await ensureDocumentWindow();
}

/**
 * Invokes a command from the current page with the page's own bridge.
 *
 * Function-form scripts wait for `__wdio_original_core__`, which only the
 * document entry installs. The settings page has just `__TAURI__`, so these
 * helpers use string scripts (which use `__TAURI__` directly).
 */
export async function invokeHere<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const result = await browser.execute(
    "return window.__TAURI__.core.invoke(arguments[0], arguments[1])",
    command,
    args,
  );
  return result as T;
}

/** Closes the current page through its own Tauri bridge. */
export async function closeHere(): Promise<void> {
  await browser.execute("return window.__TAURI__.window.getCurrentWindow().close()");
}

/** Waits until the page exposes the Tauri IPC bridge. */
async function waitForTauri(): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(
        "return Boolean(window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)",
      ),
    { timeout: 20_000, interval: 100, timeoutMsg: "the Tauri bridge did not become ready" },
  );
}

/** Removes the per-spec override file so the next run starts clean. */
export function clearMeetingEnv(): void {
  fs.rmSync(e2eEnvFile, { force: true });
}

/**
 * Starts a meeting and switches to its window.
 *
 * The invoke is not awaited in the document webview: creating a native window
 * can pause that script. Identity is tracked through the window handle because
 * Tauri drops the `meeting=` query once the document is inserted.
 */
export async function startMeeting(): Promise<string> {
  await ensureDocumentWindow();
  const before = await browser.getWindowHandles();
  await tauri().execute(() => {
    void (
      window as unknown as { __TAURI__: { core: { invoke(command: string): Promise<unknown> } } }
    ).__TAURI__.core.invoke("meeting_start");
    return true;
  });
  let target = "";
  await browser.waitUntil(
    async () => {
      const fresh = meetingHandles(await browser.getWindowHandles()).filter(
        (handle) => !before.includes(handle),
      );
      if (fresh.length === 0) {
        return false;
      }
      target = fresh[fresh.length - 1];
      return true;
    },
    { timeout: 60_000, interval: 200, timeoutMsg: "the meeting window did not open" },
  );
  activeMeeting = target;
  await browser.switchToWindow(target);
  // Read the request id now: Tauri drops the `meeting=` query once the
  // document is inserted and restored documents never get it back.
  activeRequest = /meeting=([0-9a-f-]{36})/i.exec(await browser.getUrl())?.[1] ?? "";
  await tauri().switchWindow(target);
  await raiseCurrentWindow();
  return target;
}

let activeMeeting = "";
let activeRequest = "";

/** Request id of the meeting started by the last `startMeeting`. */
export function meetingRequestId(): string {
  return activeRequest;
}

/**
 * Raises the current webview to OS focus.
 *
 * WebKit throttles timer-driven IPC polling to roughly once a minute while a
 * window is occluded, which turns a 30 s meeting into minutes. The WebDriver
 * window switch alone does not raise the native window.
 */
async function raiseCurrentWindow(): Promise<void> {
  await tauri()
    .execute(() => {
      const api = window as unknown as {
        __TAURI__?: { window: { getCurrentWindow(): { setFocus(): Promise<void> } } };
      };
      return api.__TAURI__?.window.getCurrentWindow().setFocus();
    })
    .catch(() => undefined);
}

/** Any open window that is not the pinned launch document. */
function meetingHandles(handles: string[]): string[] {
  return handles.filter((handle) => handle !== pinnedDocument);
}

export function meetingEditor() {
  return $(".cm-content");
}

/** Full editor text, including lines CodeMirror has not painted yet. */
export function editorText(): Promise<string> {
  return tauri().execute(() => {
    const content = document.querySelector(".cm-content") as
      | (Element & {
          cmTile?: { root?: { view?: { state: { doc: { toString(): string } } } } };
        })
      | null;
    const view = content?.cmTile?.root?.view;
    return view ? view.state.doc.toString() : (content?.textContent ?? "");
  });
}

/** Waits for the meeting to insert its document or show a failure. */
export async function waitForMeetingResult(timeout = 180_000): Promise<string> {
  let lastStage = "";
  let tick = 0;
  await browser.waitUntil(
    async () => {
      try {
        await focusMeetingWindow();
      } catch {
        return false;
      }
      const stage = await $('[data-testid="meeting-stage"]');
      const label = (await stage.isExisting()) ? await stage.getText() : "";
      tick += 1;
      if (label && (label !== lastStage || tick % 20 === 0)) {
        lastStage = label;
        const url = await browser.getUrl();
        const match = /meeting=([0-9a-f-]{36})/i.exec(url);
        const status = match
          ? await invoke<{
              running?: { window?: { index: number; total: number; doneSegments: number } };
            }>("meeting_status", { requestId: match[1] }).catch(() => null)
          : null;
        const running =
          typeof status === "object" && status && "running" in status
            ? status.running?.window
            : null;
        console.log(
          "MEETING-E2E stage",
          label,
          running ? `${running.index + 1}/${running.total}+${running.doneSegments}` : "",
        );
      }
      if (await $('[data-testid="meeting-insert-failed"]').isExisting()) {
        return true;
      }
      if (await $('[data-testid="meeting-failed"]').isExisting()) {
        return true;
      }
      // The boot surface unmounts as soon as the result is inserted; the
      // viewport text alone may omit the transcript below the fold.
      return !(await $('[data-testid="meeting-boot"]').isExisting());
    },
    { timeout, interval: 500, timeoutMsg: "the meeting did not finish" },
  );
  await focusMeetingWindow();
  return editorText();
}

/** Switches the driver and the plugin to the open meeting window. */
export async function focusMeetingWindow(): Promise<string> {
  const handles = meetingHandles(await browser.getWindowHandles());
  const target = handles.includes(activeMeeting) ? activeMeeting : handles[handles.length - 1];
  if (!target) {
    throw new Error("the meeting window is not open");
  }
  activeMeeting = target;
  await browser.switchToWindow(target);
  await tauri().switchWindow(target);
  await raiseCurrentWindow();
  return target;
}

/** Closes every window carrying a meeting request and returns to the pinned document. */
export function pinnedLabel(): string {
  return pinnedDocument;
}

export async function closeMeetingWindow(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const handles = await browser.getWindowHandles();
    const target = pinnedDocument ? handles.find((handle) => handle !== pinnedDocument) : undefined;
    if (!target) {
      break;
    }
    try {
      await browser.switchToWindow(target);
      if (target === "settings") {
        // The settings entry has no `__wdio_original_core__`; close it through
        // its own bridge and skip the plugin's validation round-trip.
        await closeHere().catch(() => undefined);
        await browser
          .waitUntil(async () => !(await browser.getWindowHandles()).includes(target), {
            timeout: 10_000,
            interval: 100,
          })
          .catch(() => undefined);
        continue;
      }
      await tauri().switchWindow(target);
      await closeCurrentWindow();
      // A dirty meeting document raises the close prompt; discard it so the
      // next spec starts with exactly the pinned window. A failed save shows
      // the "close anyway" variant instead.
      for (const testId of ["close-confirm", "close-anyway"]) {
        const confirm = await $(`[data-testid="${testId}"]`);
        if (await confirm.waitForDisplayed({ timeout: 3_000 }).catch(() => false)) {
          await confirm.click();
          break;
        }
      }
      await browser.pause(200);
    } catch {
      // Already gone.
    }
  }
  activeMeeting = "";
  await ensureDocumentWindow();
}

/** Invokes a command from the current webview. */
export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return tauri().execute(
    (
      tauriApi: { core: { invoke<T>(command: string, args?: unknown): Promise<T> } },
      payload: { command: string; args?: Record<string, unknown> },
    ) => tauriApi.core.invoke<T>(payload.command, payload.args),
    { command, args },
  );
}

/** Invokes and returns the rejection value instead of throwing. */
export async function invokeError<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T | null> {
  return tauri().execute(
    (
      tauriApi: { core: { invoke<T>(command: string, args?: unknown): Promise<T> } },
      payload: { command: string; args?: Record<string, unknown> },
    ) =>
      tauriApi.core.invoke<T>(payload.command, payload.args).then(
        () => null,
        (cause: T) => cause,
      ),
    { command, args },
  );
}

/**
 * Rewrites the in-memory config to factory defaults.
 *
 * The app reads `config.json` once at startup, so deleting the file alone
 * would leave the running store on the old values.
 */
export async function resetMeetingConfig(): Promise<void> {
  await openSettings("ai");
  const current = await invokeHere<{ config: { revision: number } }>("meeting_config_get");
  await invokeHere("meeting_config_set", {
    patch: {
      runtimeMode: "auto",
      asrMode: "local",
      // `null` means "omitted"; an empty string clears an explicit pin.
      asrLocalModel: "",
      asrProvider: "openai",
      asrModel: "",
      asrApiKeyRef: "",
      llmMode: "local",
      llmLocalModel: "",
      llmBaseUrl: "",
      llmModel: "",
      llmApiKeyRef: "",
      keepTranscript: true,
      maxMinutes: 180,
    },
    expectedRevision: current.config.revision,
  });
  const handle = await browser.getWindowHandle();
  // Closing can tear the reply channel down before the response arrives.
  await closeHere().catch(() => undefined);
  await browser
    .waitUntil(async () => !(await browser.getWindowHandles()).includes(handle), {
      timeout: 10_000,
      interval: 100,
    })
    .catch(() => undefined);
  await ensureDocumentWindow();
}

/** Opens the settings window and switches the driver to it. */
export async function openSettings(section = "ai"): Promise<void> {
  const before = (await browser.getWindowHandles()).length;
  await invoke("app_settings_open", { section });
  await waitForWindowCount(before + 1, 30_000);
  let target = "";
  await browser.waitUntil(
    async () => {
      for (const handle of await browser.getWindowHandles()) {
        await browser.switchToWindow(handle);
        if ((await browser.getUrl()).includes("settings.html")) {
          target = handle;
          return true;
        }
      }
      return false;
    },
    { timeout: 30_000, interval: 200, timeoutMsg: "the settings window did not open" },
  );
  await waitForTauri();
  await tauri().switchWindow(target);
}
