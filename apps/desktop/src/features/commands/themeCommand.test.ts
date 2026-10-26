import { describe, expect, it } from "vitest";

import { UiStore } from "../../stores/uiStore";
import { CommandRegistry } from "./CommandRegistry";
import { registerThemeCommand } from "./themeCommand";

function createStore(): UiStore {
  return new UiStore({ storage: null, matchMedia: null, root: null });
}

describe("view.toggleTheme command", () => {
  it("registers once and toggles the UI store", async () => {
    const registry = new CommandRegistry({ warn: () => undefined });
    const store = createStore();
    const disposable = registerThemeCommand({ registry, store });

    expect(registry.list().map((command) => command.id)).toEqual(["view.toggleTheme"]);
    expect(registry.list()[0]?.keybinding).toBe("Mod+Shift+L");
    expect(store.getSnapshot()).toEqual({ theme: "system", resolvedTheme: "light" });

    const result = await registry.execute("view.toggleTheme");

    expect(result.ok).toBe(true);
    expect(store.getSnapshot()).toEqual({ theme: "dark", resolvedTheme: "dark" });

    disposable.dispose();
    expect(registry.list()).toEqual([]);
  });
});
