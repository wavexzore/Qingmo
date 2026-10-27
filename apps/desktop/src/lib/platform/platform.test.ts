import { beforeEach, describe, expect, it, vi } from "vitest";
const tauriMocks = vi.hoisted(() => ({
  listen: vi.fn(),
  windowLabel: "main",
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: tauriMocks.listen,
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: tauriMocks.windowLabel }),
}));

import { getCompositionTracker } from "./composition";
import { FakePlatform } from "./fake";
import { createTauriPlatform } from "./tauri";

beforeEach(() => {
  tauriMocks.listen.mockReset();
  window.dispatchEvent(new Event("compositionend"));
});

describe("FakePlatform", () => {
  it("delivers close reasons and stops after unsubscribe", () => {
    const platform = new FakePlatform();
    const received: string[] = [];
    const stop = platform.onCloseRequested((reason) => received.push(reason));

    platform.emitCloseRequested("exit");
    stop();
    platform.emitCloseRequested("window");

    expect(received).toEqual(["exit"]);
    expect(platform.listenerCounts.close).toBe(0);
  });

  it("delivers blur events and exposes controlled composition state", () => {
    const platform = new FakePlatform();
    let blurred = 0;
    const stop = platform.onBlur(() => {
      blurred += 1;
    });

    platform.emitBlur();
    stop();
    platform.emitBlur();
    expect(blurred).toBe(1);
    expect(platform.listenerCounts.blur).toBe(0);

    expect(platform.isComposing()).toBe(false);
    platform.setComposing(true);
    expect(platform.isComposing()).toBe(true);
  });

  it("delivers menu actions until unsubscribed", () => {
    const platform = new FakePlatform();
    const received: string[] = [];
    const stop = platform.onMenuAction((action) => received.push(action));

    platform.emitMenuAction("file.open");
    platform.emitMenuAction("theme.dark");
    stop();
    platform.emitMenuAction("file.save");

    expect(received).toEqual(["file.open", "theme.dark"]);
    expect(platform.listenerCounts.menu).toBe(0);
  });
});

describe("composition tracker", () => {
  it("tracks compositionstart/compositionend from the window", () => {
    const tracker = getCompositionTracker();
    expect(tracker.isComposing()).toBe(false);

    window.dispatchEvent(new Event("compositionstart"));
    expect(tracker.isComposing()).toBe(true);

    window.dispatchEvent(new Event("compositionend"));
    expect(tracker.isComposing()).toBe(false);
  });
});

describe("Tauri PlatformPort adapter", () => {
  it("maps app://close-requested and unsubscribes the Tauri listener", async () => {
    let handler:
      ((event: { payload: { reason: "window" | "exit"; target: string } }) => void) | undefined;
    const unlisten = vi.fn<() => void>();
    tauriMocks.listen.mockImplementation(async (_event: string, callback: typeof handler) => {
      handler = callback;
      return unlisten;
    });

    const platform = createTauriPlatform();
    const received: string[] = [];
    const stop = platform.onCloseRequested((reason) => received.push(reason));

    await vi.waitFor(() => {
      expect(tauriMocks.listen).toHaveBeenCalledWith(
        "app://close-requested",
        expect.any(Function),
        { target: { kind: "WebviewWindow", label: "main" } },
      );
      expect(handler).toBeTypeOf("function");
    });

    handler?.({ payload: { reason: "exit", target: "main" } });
    handler?.({ payload: { reason: "window", target: "doc-1" } });
    expect(received).toEqual(["exit"]);

    stop();
    expect(unlisten).toHaveBeenCalledTimes(1);

    handler?.({ payload: { reason: "window", target: "main" } });
    expect(received).toEqual(["exit"]);
  });

  it("unlistens if the caller unsubscribes before listen resolves", async () => {
    let resolveListen: ((stop: () => void) => void) | undefined;
    const unlisten = vi.fn<() => void>();
    tauriMocks.listen.mockReturnValue(
      new Promise<() => void>((resolve) => {
        resolveListen = resolve;
      }),
    );

    const platform = createTauriPlatform();
    const stop = platform.onCloseRequested(() => undefined);
    stop();
    resolveListen?.(unlisten);
    await Promise.resolve();

    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("maps app://menu-action, ignores unknown ids, and unsubscribes", async () => {
    let handler: ((event: { payload: { action: string; target: string } }) => void) | undefined;
    const unlisten = vi.fn<() => void>();
    tauriMocks.listen.mockImplementation(async (_event: string, callback: typeof handler) => {
      handler = callback;
      return unlisten;
    });

    const platform = createTauriPlatform();
    const received: string[] = [];
    const stop = platform.onMenuAction((action) => received.push(action));

    await vi.waitFor(() => {
      expect(tauriMocks.listen).toHaveBeenCalledWith("app://menu-action", expect.any(Function), {
        target: { kind: "WebviewWindow", label: "main" },
      });
      expect(handler).toBeTypeOf("function");
    });

    handler?.({ payload: { action: "theme.dark", target: "main" } });
    handler?.({ payload: { action: "unknown.action", target: "main" } });
    handler?.({ payload: { action: "file.open", target: "doc-1" } });
    expect(received).toEqual(["theme.dark"]);

    stop();
    expect(unlisten).toHaveBeenCalledTimes(1);
    handler?.({ payload: { action: "file.open", target: "main" } });
    expect(received).toEqual(["theme.dark"]);
  });

  it("delivers window blur and reports composition state", () => {
    const platform = createTauriPlatform();
    let blurred = 0;
    const stop = platform.onBlur(() => {
      blurred += 1;
    });

    window.dispatchEvent(new Event("blur"));
    stop();
    window.dispatchEvent(new Event("blur"));
    expect(blurred).toBe(1);

    expect(platform.isComposing()).toBe(false);
    window.dispatchEvent(new Event("compositionstart"));
    expect(platform.isComposing()).toBe(true);
    window.dispatchEvent(new Event("compositionend"));
    expect(platform.isComposing()).toBe(false);
  });
});
