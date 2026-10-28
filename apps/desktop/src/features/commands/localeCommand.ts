import { useEffect } from "react";

import type { UiStore } from "../../stores/uiStore";
import { uiStore } from "../../stores/uiStore";
import { commandRegistry, type CommandRegistry, type Disposable } from "./CommandRegistry";

export interface LocaleCommandOptions {
  registry?: CommandRegistry;
  store?: Pick<UiStore, "setLanguage">;
}

/**
 * Registers the two language commands used by the palette. Both native menu
 * items and these commands call the same `UiStore` action; LocaleController is
 * the only subscriber that projects the change.
 */
export function registerLocaleCommands(options: LocaleCommandOptions = {}): Disposable {
  const registry = options.registry ?? commandRegistry;
  const store = options.store ?? uiStore;

  const zh = registry.register({
    id: "language.zh-CN",
    titleKey: "commands:language.zhCN",
    category: "commands:category.app",
    run: () => {
      store.setLanguage("zh-CN");
    },
  });
  const en = registry.register({
    id: "language.en",
    titleKey: "commands:language.en",
    category: "commands:category.app",
    run: () => {
      store.setLanguage("en");
    },
  });

  return {
    dispose() {
      zh.dispose();
      en.dispose();
    },
  };
}

/** Mounted once by the workspace layout. */
export function useLocaleCommands(): void {
  useEffect(() => {
    const disposable = registerLocaleCommands();
    return () => disposable.dispose();
  }, []);
}
