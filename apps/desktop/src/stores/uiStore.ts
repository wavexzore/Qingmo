import { useSyncExternalStore } from "react";

import {
  DEFAULT_LANGUAGE,
  isSupportedLanguage,
  normalizeLanguage,
  type SupportedLanguage,
} from "../i18n/language";

export const THEME_STORAGE_KEY = "qingmo.ui.theme";
export const LANGUAGE_STORAGE_KEY = "qingmo.ui.language";
export const THEME_PREFERENCES = ["light", "dark", "system"] as const;

export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export type ResolvedTheme = "light" | "dark";

export interface UiSnapshot {
  /** Persisted preference. */
  theme: ThemePreference;
  /** Effective theme after resolving `system` against the OS preference. */
  resolvedTheme: ResolvedTheme;
  /** Persisted UI language. */
  language: SupportedLanguage;
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

function readStoredLanguage(storage: ThemeStorage | null): SupportedLanguage {
  if (!storage) {
    return DEFAULT_LANGUAGE;
  }
  try {
    return normalizeLanguage(storage.getItem(LANGUAGE_STORAGE_KEY));
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

/**
 * UI-only store. The persisted keys are the theme preference and the UI
 * language; document identity/body never enters this store. Theme changes are
 * applied to the root `data-theme` attribute and published to the editor theme
 * service.
 */
export class UiStore {
  private readonly storage: ThemeStorage | null;
  private readonly root: ThemeRoot | null;
  private readonly media: ThemeMediaQuery | null;
  private readonly listeners = new Set<() => void>();
  private snapshot: UiSnapshot;
  private mediaListening = false;
  private languagePersistenceDegraded = false;

  constructor(options: UiStoreOptions = {}) {
    this.storage = options.storage === undefined ? defaultStorage() : options.storage;
    this.root = options.root === undefined ? defaultRoot() : options.root;
    const matchMedia = options.matchMedia === undefined ? defaultMatchMedia : options.matchMedia;
    this.media = matchMedia?.("(prefers-color-scheme: dark)") ?? null;

    const theme = readStoredTheme(this.storage);
    this.snapshot = Object.freeze({
      theme,
      resolvedTheme: resolveTheme(theme, this.media?.matches ?? false),
      language: readStoredLanguage(this.storage),
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
    this.persist(THEME_STORAGE_KEY, next);
    this.replaceSnapshot({
      ...this.snapshot,
      theme: next,
      resolvedTheme: resolveTheme(next, this.media?.matches ?? false),
    });
    this.syncMediaListener();
  }

  /**
   * Persists the UI language. When storage is unavailable the choice still
   * applies for this session; `readPersistedLanguage()` then reports `null`
   * so the locale controller never rolls the choice back to a stale value.
   */
  setLanguage(next: SupportedLanguage): void {
    if (!isSupportedLanguage(next) || next === this.snapshot.language) {
      return;
    }
    this.languagePersistenceDegraded = !this.persist(LANGUAGE_STORAGE_KEY, next);
    this.replaceSnapshot({ ...this.snapshot, language: next });
  }

  /**
   * Reads the authoritative persisted language for cross-window guards.
   * `null` means there is no trustworthy stored value (storage disabled, read
   * failure, missing key, or a failed write in this window).
   */
  readPersistedLanguage(): SupportedLanguage | null {
    if (!this.storage || this.languagePersistenceDegraded) {
      return null;
    }
    try {
      const stored = this.storage.getItem(LANGUAGE_STORAGE_KEY);
      return stored === null ? null : normalizeLanguage(stored);
    } catch {
      return null;
    }
  }

  /** Explicitly switches to the opposite of the currently resolved theme. */
  toggleTheme(): ThemePreference {
    const next: ThemePreference = this.snapshot.resolvedTheme === "dark" ? "light" : "dark";
    this.setTheme(next);
    return next;
  }

  /**
   * Adopts a preference persisted by another window without writing it back.
   * The About window is a separate webview and uses this on `storage` events.
   */
  syncFromStorage(): void {
    const theme = readStoredTheme(this.storage);
    this.replaceSnapshot({
      theme,
      resolvedTheme: resolveTheme(theme, this.media?.matches ?? false),
      language: readStoredLanguage(this.storage),
    });
    this.syncMediaListener();
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
    this.replaceSnapshot({ ...this.snapshot, theme: "system", resolvedTheme });
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
    if (
      next.theme === this.snapshot.theme &&
      next.resolvedTheme === this.snapshot.resolvedTheme &&
      next.language === this.snapshot.language
    ) {
      return;
    }
    this.snapshot = Object.freeze(next);
    this.applyToRoot();
    for (const listener of [...this.listeners]) {
      listener();
    }
  }

  private persist(key: string, value: string): boolean {
    if (!this.storage) {
      return false;
    }
    try {
      this.storage.setItem(key, value);
      return true;
    } catch {
      // A blocked/quota-exhausted localStorage must never break the UI.
      return false;
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

export function useUiPreferences(): UiSnapshot {
  return useSyncExternalStore(uiStore.subscribe, uiStore.getSnapshot, uiStore.getSnapshot);
}
