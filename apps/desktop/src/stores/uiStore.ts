import { useSyncExternalStore } from "react";

export const THEME_STORAGE_KEY = "qingmo.ui.theme";
export const THEME_PREFERENCES = ["light", "dark", "system"] as const;

export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export type ResolvedTheme = "light" | "dark";

export interface UiSnapshot {
  /** Persisted preference. */
  theme: ThemePreference;
  /** Effective theme after resolving `system` against the OS preference. */
  resolvedTheme: ResolvedTheme;
}

export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ThemeMediaQuery {
  matches: boolean;
  addEventListener?: (type: "change", listener: (event: { matches: boolean }) => void) => void;
  removeEventListener?: (type: "change", listener: (event: { matches: boolean }) => void) => void;
  addListener?: (listener: (event: { matches: boolean }) => void) => void;
  removeListener?: (listener: (event: { matches: boolean }) => void) => void;
}

export interface ThemeRoot {
  setAttribute(name: string, value: string): void;
}

export interface UiStoreOptions {
  /** `null` disables persistence, which also models a blocked localStorage. */
  storage?: ThemeStorage | null;
  /** `null` disables OS preference tracking. */
  matchMedia?: ((query: string) => ThemeMediaQuery | null) | null;
  root?: ThemeRoot | null;
}

function isThemePreference(value: unknown): value is ThemePreference {
  return THEME_PREFERENCES.includes(value as ThemePreference);
}

function resolveTheme(theme: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (theme === "system") {
    return systemPrefersDark ? "dark" : "light";
  }
  return theme;
}

function defaultStorage(): ThemeStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function defaultMatchMedia(query: string): ThemeMediaQuery | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return null;
  }
  try {
    return window.matchMedia(query);
  } catch {
    return null;
  }
}

function defaultRoot(): ThemeRoot | null {
  return typeof document === "undefined" ? null : document.documentElement;
}

function readStoredTheme(storage: ThemeStorage | null): ThemePreference {
  if (!storage) {
    return "system";
  }
  try {
    const stored = storage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

/**
 * UI-only store. The only persisted key is the theme preference; document
 * identity/body never enters this store. Theme changes are applied to the root
 * `data-theme` attribute and published to the editor theme service.
 */
export class UiStore {
  private readonly storage: ThemeStorage | null;
  private readonly root: ThemeRoot | null;
  private readonly media: ThemeMediaQuery | null;
  private readonly listeners = new Set<() => void>();
  private snapshot: UiSnapshot;
  private mediaListening = false;

  constructor(options: UiStoreOptions = {}) {
    this.storage = options.storage === undefined ? defaultStorage() : options.storage;
    this.root = options.root === undefined ? defaultRoot() : options.root;
    const matchMedia = options.matchMedia === undefined ? defaultMatchMedia : options.matchMedia;
    this.media = matchMedia?.("(prefers-color-scheme: dark)") ?? null;

    const theme = readStoredTheme(this.storage);
    this.snapshot = Object.freeze({
      theme,
      resolvedTheme: resolveTheme(theme, this.media?.matches ?? false),
    });
  }

  /**
   * Applies the persisted preference to the document and starts OS preference
   * tracking when needed. Called once from the app entry before React renders.
   */
  initialize(): void {
    this.applyToRoot();
    this.syncMediaListener();
  }

  setTheme(theme: ThemePreference): void {
    const next = isThemePreference(theme) ? theme : "system";
    this.persist(next);
    this.replaceSnapshot({
      theme: next,
      resolvedTheme: resolveTheme(next, this.media?.matches ?? false),
    });
    this.syncMediaListener();
  }

  /** Explicitly switches to the opposite of the currently resolved theme. */
  toggleTheme(): ThemePreference {
    const next: ThemePreference = this.snapshot.resolvedTheme === "dark" ? "light" : "dark";
    this.setTheme(next);
    return next;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): UiSnapshot => this.snapshot;

  private handleMediaChange = (event: { matches: boolean }): void => {
    if (this.snapshot.theme !== "system") {
      return;
    }
    const resolvedTheme: ResolvedTheme = event.matches ? "dark" : "light";
    if (resolvedTheme === this.snapshot.resolvedTheme) {
      return;
    }
    this.replaceSnapshot({ theme: "system", resolvedTheme });
  };

  private syncMediaListener(): void {
    if (!this.media) {
      return;
    }
    const shouldListen = this.snapshot.theme === "system";
    if (shouldListen && !this.mediaListening) {
      if (this.media.addEventListener) {
        this.media.addEventListener("change", this.handleMediaChange);
      } else {
        this.media.addListener?.(this.handleMediaChange);
      }
      this.mediaListening = true;
      return;
    }
    if (!shouldListen && this.mediaListening) {
      if (this.media.removeEventListener) {
        this.media.removeEventListener("change", this.handleMediaChange);
      } else {
        this.media.removeListener?.(this.handleMediaChange);
      }
      this.mediaListening = false;
    }
  }

  private replaceSnapshot(next: UiSnapshot): void {
    if (next.theme === this.snapshot.theme && next.resolvedTheme === this.snapshot.resolvedTheme) {
      return;
    }
    this.snapshot = Object.freeze(next);
    this.applyToRoot();
    for (const listener of [...this.listeners]) {
      listener();
    }
  }

  private persist(theme: ThemePreference): void {
    if (!this.storage) {
      return;
    }
    try {
      this.storage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // A blocked/quota-exhausted localStorage must never break the UI.
    }
  }

  private applyToRoot(): void {
    try {
      this.root?.setAttribute("data-theme", this.snapshot.resolvedTheme);
    } catch {
      // Rendering can continue even if the document is unavailable.
    }
  }
}

/** App-level singleton; tests use `new UiStore({...})` for isolation. */
export const uiStore = new UiStore();

export function useUiTheme(): UiSnapshot {
  return useSyncExternalStore(uiStore.subscribe, uiStore.getSnapshot, uiStore.getSnapshot);
}
