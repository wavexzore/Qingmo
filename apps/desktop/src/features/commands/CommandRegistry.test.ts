import { describe, expect, it, vi } from "vitest";

import { CommandRegistry, normalizeKeybinding } from "./CommandRegistry";

function definition(
  id: string,
  overrides: Partial<Parameters<CommandRegistry["register"]>[0]> = {},
) {
  return {
    id,
    titleKey: `commands.${id}`,
    category: "test",
    run: () => undefined,
    ...overrides,
  };
}

describe("CommandRegistry", () => {
  it("registers, lists and disposes commands", () => {
    const registry = new CommandRegistry();
    const listener = vi.fn();
    const unsubscribe = registry.subscribe(listener);

    const command = registry.register(definition("file.open"));
    expect(registry.list().map((item) => item.id)).toEqual(["file.open"]);
    expect(listener).toHaveBeenCalledTimes(1);

    command.dispose();
    expect(registry.list()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    registry.register(definition("file.save"));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("rejects duplicate ids", () => {
    const registry = new CommandRegistry();
    registry.register(definition("file.open"));
    expect(() => registry.register(definition("file.open"))).toThrow(/already registered/);
  });

  it("warns about duplicate keybindings but keeps both commands", () => {
    const warn = vi.fn();
    const registry = new CommandRegistry({ warn });
    registry.register(definition("file.open", { keybinding: "Mod+O" }));
    registry.register(definition("file.save", { keybinding: "mod+o" }));

    expect(registry.getWarnings()).toHaveLength(1);
    expect(registry.getWarnings()[0]).toMatch(/file\.open/);
    expect(warn).toHaveBeenCalledOnce();
    expect(registry.list()).toHaveLength(2);
  });

  it("returns BUSY for unknown or unavailable commands", async () => {
    const registry = new CommandRegistry();
    expect(await registry.execute("missing")).toMatchObject({
      ok: false,
      error: { code: "BUSY" },
    });

    registry.register(definition("editor.only", { when: () => false }));
    expect(await registry.execute("editor.only")).toMatchObject({
      ok: false,
      error: { code: "BUSY" },
    });
  });

  it("normalizes thrown errors and succeeds with undefined", async () => {
    const registry = new CommandRegistry();
    registry.register(definition("ok"));
    expect(await registry.execute("ok")).toEqual({ ok: true, value: undefined });

    registry.register(
      definition("fails", {
        run: () => {
          throw new Error("disk full");
        },
      }),
    );
    expect(await registry.execute("fails")).toEqual({
      ok: false,
      error: { code: "IO", message: "disk full" },
    });

    registry.register(
      definition("typed", {
        run: () => {
          throw { code: "CONFLICT", message: "changed" };
        },
      }),
    );
    expect(await registry.execute("typed")).toEqual({
      ok: false,
      error: { code: "CONFLICT", message: "changed" },
    });
  });

  it("rejects re-entrant execution", async () => {
    const registry = new CommandRegistry();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    registry.register(
      definition("slow", {
        run: async () => {
          await gate;
        },
      }),
    );

    const first = registry.execute("slow");
    expect(await registry.execute("slow")).toMatchObject({
      ok: false,
      error: { code: "BUSY" },
    });
    release?.();
    expect(await first).toEqual({ ok: true, value: undefined });
  });

  it("normalizes modifier order", () => {
    expect(normalizeKeybinding("shift+mod+o")).toBe("shift+mod+o");
    expect(normalizeKeybinding("Mod + Shift + P")).toBe("shift+mod+p");
  });
});
