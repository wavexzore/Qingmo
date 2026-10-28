import { describe, expect, it, vi } from "vitest";

import { LANGUAGE_STORAGE_KEY, THEME_STORAGE_KEY } from "../stores/uiStore";
import { watchUiStorage } from "./uiStorageSync";

class FakeWindow extends EventTarget {
  emit(key: string | null): void {
    this.dispatchEvent(new StorageEvent("storage", { key }));
  }
}

describe("watchUiStorage", () => {
  it("syncs theme, language, and clear events only", () => {
    const target = new FakeWindow();
    const store = { syncFromStorage: vi.fn() };
    const stop = watchUiStorage(store, target as unknown as Window);

    target.emit(THEME_STORAGE_KEY);
    target.emit(LANGUAGE_STORAGE_KEY);
    target.emit(null);
    target.emit("unrelated.key");

    expect(store.syncFromStorage).toHaveBeenCalledTimes(3);

    stop();
    target.emit(LANGUAGE_STORAGE_KEY);
    expect(store.syncFromStorage).toHaveBeenCalledTimes(3);
  });
});
