import { beforeEach, describe, expect, it, vi } from "vitest";
const tauriMocks = vi.hoisted(() => ({
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: tauriMocks.listen,
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
    let handler: ((event: { payload: { reason: "window" | "exit" } }) => void) | undefined;
    const unlisten = vi.fn<() => void>();
    tauriMocks.listen.mockImplementation(async (_event: string, callback: typeof handler) => {
      handler = callback;
      return unlisten;
    });

    const platform = createTauriPlatform();
    const received: string[] = [];
    const stop = platform.onCloseRequested((reason) => received.push(reason));

    await vi.waitFor(() => {
      expect(tauriMocks.listen).toHaveBeenCalledWith("app://close-requested", expect.any(Function));
      expect(handler).toBeTypeOf("function");
    });

    handler?.({ payload: { reason: "exit" } });
    expect(received).toEqual(["exit"]);

    stop();
    expect(unlisten).toHaveBeenCalledTimes(1);

    handler?.({ payload: { reason: "window" } });
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
