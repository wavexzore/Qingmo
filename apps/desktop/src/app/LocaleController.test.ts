import type { ApplyLocaleRequest, NativeShellLabels } from "@qingmo/shared";
import { describe, expect, it, vi } from "vitest";

import type { SupportedLanguage } from "../i18n/language";
import {
  LocaleController,
  type LocaleI18n,
  type LocaleNativePort,
  type LocaleStore,
} from "./LocaleController";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

class FakeStore implements LocaleStore {
  private snapshot: { language: SupportedLanguage };
  private readonly listeners = new Set<() => void>();
  persisted: SupportedLanguage | null;
  syncCalls = 0;

  constructor(language: SupportedLanguage, persisted: SupportedLanguage | null = language) {
    this.snapshot = { language };
    this.persisted = persisted;
  }

  getSnapshot(): { language: SupportedLanguage } {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  readPersistedLanguage(): SupportedLanguage | null {
    return this.persisted;
  }

  syncFromStorage(): void {
    this.syncCalls += 1;
    if (this.persisted !== null) {
      this.snapshot = { language: this.persisted };
    }
    this.emit();
  }

  setLanguage(language: SupportedLanguage, persisted: SupportedLanguage | null = language): void {
    this.snapshot = { language };
    this.persisted = persisted;
    this.emit();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

class FakeI18n implements LocaleI18n {
  language = "zh-CN";
  changes: string[] = [];
  gate: Promise<void> | null = null;
  fail = false;
  stick = false;

  async changeLanguage(language: string): Promise<void> {
    this.changes.push(language);
    if (this.gate) {
      await this.gate;
    }
    if (this.fail) {
      throw new Error("i18n failed");
    }
    if (!this.stick) {
      this.language = language;
    }
  }
}

class FakeNative implements LocaleNativePort {
  readonly calls: ApplyLocaleRequest[] = [];
  gate: Promise<void> | null = null;
  failures = 0;

  async appApplyLocale(request: ApplyLocaleRequest): Promise<void> {
    this.calls.push(request);
    if (this.gate) {
      await this.gate;
    }
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("native projection failed");
    }
  }
}

function labels(language: SupportedLanguage): NativeShellLabels {
  return { appName: language } as unknown as NativeShellLabels;
}

function createController(store: FakeStore, i18n: FakeI18n, native: LocaleNativePort | null) {
  const logger = { error: vi.fn(), warn: vi.fn() };
  const controller = new LocaleController({
    store,
    i18n,
    native,
    buildLabels: labels,
    logger,
  });
  return { controller, logger };
}

async function waitFor(assertion: () => void): Promise<void> {
  await vi.waitFor(assertion);
}

describe("LocaleController", () => {
  it("coalesces A -> B -> A and never projects the stale middle language", async () => {
    const store = new FakeStore("zh-CN");
    const i18n = new FakeI18n();
    const native = new FakeNative();
    const { controller } = createController(store, i18n, native);

    controller.start();
    await waitFor(() => expect(native.calls.map((call) => call.language)).toEqual(["zh-CN"]));

    const gate = deferred();
    i18n.gate = gate.promise;
    store.setLanguage("en");
    await waitFor(() => expect(i18n.changes).toContain("en"));
    store.setLanguage("zh-CN");
    gate.resolve();

    await waitFor(() => expect(i18n.language).toBe("zh-CN"));
    await waitFor(() =>
      expect(native.calls.map((call) => call.language)).toEqual(["zh-CN", "zh-CN"]),
    );
    controller.stop();
  });

  it("treats a resolved changeLanguage that did not switch as a failure", async () => {
    const store = new FakeStore("en");
    const i18n = new FakeI18n();
    i18n.stick = true;
    const native = new FakeNative();
    const { controller, logger } = createController(store, i18n, native);

    controller.start();
    await waitFor(() => expect(logger.error).toHaveBeenCalled());
    expect(native.calls).toEqual([]);
    expect(store.syncCalls).toBe(0);
    controller.stop();
  });

  it("retries after a native failure without blocking later changes", async () => {
    const store = new FakeStore("zh-CN");
    const i18n = new FakeI18n();
    const native = new FakeNative();
    native.failures = 1;
    const { controller, logger } = createController(store, i18n, native);

    controller.start();
    await waitFor(() => expect(logger.error).toHaveBeenCalled());
    store.setLanguage("en");
    await waitFor(() => expect(native.calls.map((call) => call.language)).toEqual(["zh-CN", "en"]));
    expect(logger.error).toHaveBeenCalledTimes(1);
    controller.stop();
  });

  it("does not project a language after stop() invalidates an in-flight switch", async () => {
    const store = new FakeStore("zh-CN");
    const i18n = new FakeI18n();
    const native = new FakeNative();
    const { controller } = createController(store, i18n, native);

    controller.start();
    await waitFor(() => expect(native.calls).toHaveLength(1));

    const gate = deferred();
    i18n.gate = gate.promise;
    store.setLanguage("en");
    await waitFor(() => expect(i18n.changes).toContain("en"));
    controller.stop();
    gate.resolve();

    await Promise.resolve();
    await Promise.resolve();
    expect(native.calls.map((call) => call.language)).toEqual(["zh-CN"]);
  });

  it("trusts the in-memory language when storage is untrusted", async () => {
    const store = new FakeStore("en", null);
    const i18n = new FakeI18n();
    const native = new FakeNative();
    const { controller } = createController(store, i18n, native);

    controller.start();
    await waitFor(() => expect(native.calls.map((call) => call.language)).toEqual(["en"]));
    expect(store.syncCalls).toBe(0);
    expect(i18n.language).toBe("en");
    controller.stop();
  });

  it("syncs storage before projecting a stale snapshot", async () => {
    const store = new FakeStore("en", "zh-CN");
    const i18n = new FakeI18n();
    const native = new FakeNative();
    const { controller } = createController(store, i18n, native);

    controller.start();
    await waitFor(() => expect(native.calls.map((call) => call.language)).toEqual(["zh-CN"]));
    expect(store.syncCalls).toBe(1);
    expect(i18n.language).toBe("zh-CN");
    controller.stop();
  });

  it("re-checks storage after a successful native call and converges", async () => {
    const store = new FakeStore("en", "en");
    const i18n = new FakeI18n();
    const native = new FakeNative();
    const gate = deferred();
    native.gate = gate.promise;
    const { controller } = createController(store, i18n, native);

    controller.start();
    await waitFor(() => expect(native.calls.map((call) => call.language)).toEqual(["en"]));

    store.setLanguage("zh-CN");
    gate.resolve();

    await waitFor(() => expect(native.calls.map((call) => call.language)).toEqual(["en", "zh-CN"]));
    expect(i18n.language).toBe("zh-CN");
    controller.stop();
  });

  it("does not re-apply when only the theme changes (native: null)", async () => {
    const store = new FakeStore("zh-CN");
    const i18n = new FakeI18n();
    const { controller, logger } = createController(store, i18n, null);

    controller.start();
    await waitFor(() => expect(i18n.language).toBe("zh-CN"));
    const changes = i18n.changes.length;

    store.syncFromStorage();
    store.syncFromStorage();

    await Promise.resolve();
    expect(i18n.changes).toHaveLength(changes);
    expect(logger.error).not.toHaveBeenCalled();
    controller.stop();
  });

  it("keeps a stopped StrictMode instance from projecting after its replacement", async () => {
    const store = new FakeStore("zh-CN");
    const i18n = new FakeI18n();
    const native = new FakeNative();
    const first = createController(store, i18n, native).controller;
    first.start();
    await waitFor(() => expect(native.calls).toHaveLength(1));

    const gate = deferred();
    i18n.gate = gate.promise;
    store.setLanguage("en");
    await waitFor(() => expect(i18n.changes).toContain("en"));
    first.stop();

    const second = createController(store, i18n, native).controller;
    second.start();
    gate.resolve();

    await waitFor(() => expect(i18n.language).toBe("en"));
    await waitFor(() => expect(native.calls.map((call) => call.language)).toEqual(["zh-CN", "en"]));
    second.stop();
  });
});
