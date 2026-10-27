import { describe, expect, it, vi } from "vitest";

import {
  THEME_STORAGE_KEY,
  UiStore,
  type ThemeMediaQuery,
  type ThemePreference,
  type ThemeRoot,
  type ThemeStorage,
} from "./uiStore";

interface MemoryStorage extends ThemeStorage {
  values: Map<string, string>;
  writes: string[];
}

function memoryStorage(initial?: string | null): MemoryStorage {
  const values = new Map<string, string>();
  if (initial !== undefined && initial !== null) {
    values.set(THEME_STORAGE_KEY, initial);
  }
  return {
    values,
    writes: [],
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
      this.writes.push(value);
    },
  };
}

interface FakeMedia extends ThemeMediaQuery {
  emit(matches: boolean): void;
  listenerCount(): number;
}

function fakeMedia(matches = false): FakeMedia {
  const listeners = new Set<(event: { matches: boolean }) => void>();
  const media: FakeMedia = {
    matches,
    addEventListener(type, listener) {
      if (type === "change") {
        listeners.add(listener);
      }
    },
    removeEventListener(type, listener) {
      if (type === "change") {
        listeners.delete(listener);
      }
    },
    emit(next) {
      media.matches = next;
      for (const listener of [...listeners]) {
        listener({ matches: next });
      }
    },
    listenerCount: () => listeners.size,
  };
  return media;
}

function fakeRoot(): ThemeRoot & { attributes: Map<string, string> } {
  const attributes = new Map<string, string>();
  return {
    attributes,
    setAttribute(name, value) {
      attributes.set(name, value);
    },
  };
}

function createStore(
  options: {
    storage?: ThemeStorage | null;
    media?: ThemeMediaQuery | null;
    root?: ThemeRoot | null;
  } = {},
) {
  return new UiStore({
    storage: options.storage === undefined ? memoryStorage(null) : options.storage,
    matchMedia: () => options.media ?? null,
    root: options.root === undefined ? fakeRoot() : options.root,
  });
}

describe("uiStore theme", () => {
  it("reads a valid stored preference and applies it to the root", () => {
    const storage = memoryStorage("dark");
    const root = fakeRoot();
    const store = createStore({ storage, root });

    store.initialize();

    expect(store.getSnapshot()).toEqual({ theme: "dark", resolvedTheme: "dark" });
    expect(root.attributes.get("data-theme")).toBe("dark");
  });

  it("falls back to system for an invalid stored value", () => {
    const media = fakeMedia(true);
    const store = createStore({ storage: memoryStorage("sepia"), media });

    store.initialize();

    expect(store.getSnapshot()).toEqual({ theme: "system", resolvedTheme: "dark" });
  });

  it("persists explicit themes and toggles the resolved theme", () => {
    const storage = memoryStorage(null);
    const root = fakeRoot();
    const store = createStore({ storage, root });
    const listener = vi.fn();
    store.subscribe(listener);

    store.initialize();
    store.setTheme("dark");

    expect(store.getSnapshot()).toEqual({ theme: "dark", resolvedTheme: "dark" });
    expect(storage.values.get(THEME_STORAGE_KEY)).toBe("dark");
    expect(root.attributes.get("data-theme")).toBe("dark");
    expect(listener).toHaveBeenCalledTimes(1);

    expect(store.toggleTheme()).toBe("light");
    expect(store.getSnapshot()).toEqual({ theme: "light", resolvedTheme: "light" });
    expect(storage.values.get(THEME_STORAGE_KEY)).toBe("light");
    expect(root.attributes.get("data-theme")).toBe("light");
  });

  it("adopts a preference persisted by another window without writing it back", () => {
    const storage = memoryStorage("light");
    const root = fakeRoot();
    const store = createStore({ storage, root });

    store.initialize();
    storage.values.set(THEME_STORAGE_KEY, "dark");
    store.syncFromStorage();

    expect(store.getSnapshot()).toEqual({ theme: "dark", resolvedTheme: "dark" });
    expect(root.attributes.get("data-theme")).toBe("dark");
    expect(storage.writes).toEqual([]);
  });

  it("follows the OS preference in system mode and stops listening otherwise", () => {
    const media = fakeMedia(false);
    const root = fakeRoot();
    const store = createStore({ media, root });

    store.initialize();
    expect(store.getSnapshot()).toEqual({ theme: "system", resolvedTheme: "light" });
    expect(media.listenerCount()).toBe(1);

    media.emit(true);
    expect(store.getSnapshot()).toEqual({ theme: "system", resolvedTheme: "dark" });
    expect(root.attributes.get("data-theme")).toBe("dark");

    store.setTheme("light");
    expect(media.listenerCount()).toBe(0);
    expect(root.attributes.get("data-theme")).toBe("light");

    media.emit(false);
    expect(store.getSnapshot()).toEqual({ theme: "light", resolvedTheme: "light" });

    store.setTheme("system");
    expect(media.listenerCount()).toBe(1);
    expect(store.getSnapshot()).toEqual({ theme: "system", resolvedTheme: "light" });
  });

  it("survives blocked storage and an invalid preference", () => {
    const storage: ThemeStorage = {
      getItem() {
        throw new Error("storage blocked");
      },
      setItem() {
        throw new Error("quota exceeded");
      },
    };
    const store = createStore({ storage, media: null });

    expect(() => store.initialize()).not.toThrow();
    expect(store.getSnapshot()).toEqual({ theme: "system", resolvedTheme: "light" });

    expect(() => store.setTheme("sepia" as ThemePreference)).not.toThrow();
    expect(store.getSnapshot()).toEqual({ theme: "system", resolvedTheme: "light" });

    expect(() => store.setTheme("dark")).not.toThrow();
    expect(store.getSnapshot()).toEqual({ theme: "dark", resolvedTheme: "dark" });
  });
});
