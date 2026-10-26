import { afterEach, describe, expect, it } from "vitest";

import { FakeIpc } from "../lib/ipc/fake";
import { FakePlatform } from "../lib/platform/fake";
import { isTauriRuntime } from "../lib/platform/runtime";
import { createAppServices } from "./AppServices";

afterEach(() => {
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("runtime service selection", () => {
  it("uses the fake adapters in a plain browser", () => {
    expect(isTauriRuntime()).toBe(false);
    const services = createAppServices();
    expect(services.ipc).toBeInstanceOf(FakeIpc);
    expect(services.platform).toBeInstanceOf(FakePlatform);
  });

  it("selects the Tauri adapters when the internals bridge is present", () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });

    expect(isTauriRuntime()).toBe(true);
    const services = createAppServices();
    expect(services.ipc).not.toBeInstanceOf(FakeIpc);
    expect(services.platform).not.toBeInstanceOf(FakePlatform);
    expect(typeof services.ipc.documentOpen).toBe("function");
    expect(typeof services.platform.onCloseRequested).toBe("function");
  });
});
