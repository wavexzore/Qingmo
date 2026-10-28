import { describe, expect, it } from "vitest";

import { CommandRegistry } from "./CommandRegistry";
import { registerLocaleCommands } from "./localeCommand";

describe("language commands", () => {
  it("registers both languages once and routes them to the store", async () => {
    const registry = new CommandRegistry({ warn: () => undefined });
    const calls: string[] = [];
    const disposable = registerLocaleCommands({
      registry,
      store: {
        setLanguage(language) {
          calls.push(language);
        },
      },
    });

    const commands = registry.list();
    expect(commands.map((command) => command.id)).toEqual(["language.zh-CN", "language.en"]);
    expect(commands.map((command) => command.titleKey)).toEqual([
      "commands:language.zhCN",
      "commands:language.en",
    ]);
    expect(commands.every((command) => command.category === "commands:category.app")).toBe(true);

    await registry.execute("language.zh-CN");
    await registry.execute("language.en");
    expect(calls).toEqual(["zh-CN", "en"]);

    disposable.dispose();
    expect(registry.list()).toEqual([]);
  });
});
