import type { ApplyLocaleRequest, NativeShellLabels } from "@qingmo/shared";

import type { SupportedLanguage } from "../i18n/language";
import { buildNativeShellLabels } from "../i18n/native";
import type { UiSnapshot } from "../stores/uiStore";

export interface LocaleStore {
  getSnapshot(): Pick<UiSnapshot, "language">;
  subscribe(listener: () => void): () => void;
  /** `null` means storage is disabled, missing, or not trustworthy. */
  readPersistedLanguage(): SupportedLanguage | null;
  syncFromStorage(): void;
}

export interface LocaleI18n {
  language: string;
  changeLanguage(language: string): Promise<unknown>;
}

export interface LocaleNativePort {
  appApplyLocale(request: ApplyLocaleRequest): Promise<void>;
}

export interface LocaleControllerOptions {
  store: LocaleStore;
  i18n: LocaleI18n;
  native?: LocaleNativePort | null;
  buildLabels?: (language: SupportedLanguage) => NativeShellLabels;
  logger?: Pick<Console, "error" | "warn">;
}

/**
 * The only runtime coordinator between the persisted language and every
 * downstream projection (i18next, the native shell, other windows).
 *
 * Store notifications are coalesced: while one projection is in flight, newer
 * requests set `pending` and the drain loop reads the latest snapshot again.
 * `generation` invalidates every await that belonged to a stopped instance.
 */
export class LocaleController {
  private readonly store: LocaleStore;
  private readonly i18n: LocaleI18n;
  private readonly native: LocaleNativePort | null;
  private readonly buildLabels: (language: SupportedLanguage) => NativeShellLabels;
  private readonly logger: Pick<Console, "error" | "warn"> | undefined;

  private unsubscribe: (() => void) | null = null;
  private running = false;
  private pending = false;
  private stopped = false;
  private generation = 0;
  private appliedLanguage: SupportedLanguage | null = null;

  constructor(options: LocaleControllerOptions) {
    this.store = options.store;
    this.i18n = options.i18n;
    this.native = options.native ?? null;
    this.buildLabels = options.buildLabels ?? buildNativeShellLabels;
    this.logger = options.logger;
  }

  start(): void {
    if (this.unsubscribe) {
      return;
    }
    this.stopped = false;
    this.unsubscribe = this.store.subscribe(this.request);
    this.request();
  }

  stop(): void {
    this.stopped = true;
    this.generation += 1;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private request = (): void => {
    if (this.stopped) {
      return;
    }
    this.pending = true;
    if (!this.running) {
      void this.drain();
    }
  };

  private async drain(): Promise<void> {
    this.running = true;
    try {
      while (this.pending && !this.stopped) {
        this.pending = false;
        const generation = this.generation;
        const language = this.store.getSnapshot().language;
        if (language === this.appliedLanguage && this.i18n.language === language) {
          continue;
        }
        try {
          if (this.i18n.language !== language) {
            await this.i18n.changeLanguage(language);
            if (this.i18n.language !== language) {
              throw new Error(`i18n did not switch to ${language}`);
            }
          }
          if (this.stopped || generation !== this.generation) {
            return;
          }

          if (this.native) {
            // localStorage is authoritative across windows. A stale snapshot
            // must never overwrite a newer menu; `null` means storage is not
            // trustworthy, so the in-memory choice wins.
            const persisted = this.store.readPersistedLanguage();
            if (persisted !== null && persisted !== language) {
              this.store.syncFromStorage();
              this.appliedLanguage = null;
              continue;
            }

            await this.native.appApplyLocale({
              language,
              labels: this.buildLabels(language),
            });
            if (this.stopped || generation !== this.generation) {
              return;
            }

            const persistedAfter = this.store.readPersistedLanguage();
            if (persistedAfter !== null && persistedAfter !== language) {
              this.store.syncFromStorage();
              this.appliedLanguage = null;
              continue;
            }
          }

          this.appliedLanguage = language;
        } catch (error) {
          if (this.stopped || generation !== this.generation) {
            return;
          }
          this.appliedLanguage = null;
          this.logger?.error("failed to apply locale", error);
        }
      }
    } finally {
      this.running = false;
      // stop()/start() may race an await; a queued request must restart the
      // drain or the newest language would never reach the shell.
      if (this.pending && !this.stopped) {
        void this.drain();
      }
    }
  }
}
