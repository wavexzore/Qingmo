import { useEffect } from "react";

import type { UiStore } from "../../stores/uiStore";
import { uiStore } from "../../stores/uiStore";
import { commandRegistry, type CommandRegistry, type Disposable } from "./CommandRegistry";

export interface ThemeCommandOptions {
  registry?: CommandRegistry;
  store?: Pick<UiStore, "toggleTheme">;
}

/**
 * Registers the single theme command. The optional registry/store seams keep
 * the command testable without mutating the app-level singleton.
 */
export function registerThemeCommand(options: ThemeCommandOptions = {}): Disposable {
  const registry = options.registry ?? commandRegistry;
  const store = options.store ?? uiStore;

  return registry.register({
    id: "view.toggleTheme",
    titleKey: "commands:view.toggleTheme",
    category: "commands:category.view",
    keybinding: "Mod+Shift+L",
    run: () => {
      store.toggleTheme();
    },
  });
}

/** Mounted once by the workspace layout, alongside the other app commands. */
export function useThemeCommand(): void {
  useEffect(() => {
    const disposable = registerThemeCommand();
    return () => disposable.dispose();
  }, []);
}
