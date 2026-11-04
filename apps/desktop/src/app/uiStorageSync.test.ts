import { describe, expect, it, vi } from "vitest";

import {
  EDITOR_TYPOGRAPHY_STORAGE_KEY,
  LANGUAGE_STORAGE_KEY,
  THEME_STORAGE_KEY,
} from "../stores/uiStore";
import { watchUiStorage } from "./uiStorageSync";

class FakeWindow extends EventTarget {
  emit(key: string | null): void {
    this.dispatchEvent(new StorageEvent("storage", { key }));
  }
}

describe("watchUiStorage", () => {
  it("syncs theme, language, typography, and clear events only", () => {
    const target = new FakeWindow();
    const store = { syncFromStorage: vi.fn() };
    const stop = watchUiStorage(store, target as unknown as Window);

    target.emit(THEME_STORAGE_KEY);
    target.emit(LANGUAGE_STORAGE_KEY);
    target.emit(EDITOR_TYPOGRAPHY_STORAGE_KEY);
    target.emit(null);
    target.emit("unrelated.key");

    expect(store.syncFromStorage).toHaveBeenCalledTimes(4);
    expect(store.syncFromStorage).toHaveBeenNthCalledWith(1, THEME_STORAGE_KEY);
    expect(store.syncFromStorage).toHaveBeenNthCalledWith(2, LANGUAGE_STORAGE_KEY);
    expect(store.syncFromStorage).toHaveBeenNthCalledWith(3, EDITOR_TYPOGRAPHY_STORAGE_KEY);
    expect(store.syncFromStorage).toHaveBeenNthCalledWith(4, null);

    stop();
    target.emit(LANGUAGE_STORAGE_KEY);
    expect(store.syncFromStorage).toHaveBeenCalledTimes(4);
  });
});
