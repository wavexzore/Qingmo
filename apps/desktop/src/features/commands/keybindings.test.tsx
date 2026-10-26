import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AppError } from "@qingmo/shared";

import { CommandRegistry } from "./CommandRegistry";
import {
  eventToKeybinding,
  formatKeybinding,
  PALETTE_KEYBINDING,
  useCommandKeybindings,
  type CommandKeybindingOptions,
} from "./keybindings";

function keydown(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
}

function createRegistry() {
  return new CommandRegistry({ warn: () => undefined });
}

function Harness({ options }: { options: CommandKeybindingOptions }) {
  useCommandKeybindings(options);
  return null;
}

describe("eventToKeybinding", () => {
  it("maps Meta to mod on macOS and Ctrl to mod elsewhere", () => {
    expect(eventToKeybinding(keydown({ key: "o", metaKey: true }), true)).toBe("mod+o");
    expect(eventToKeybinding(keydown({ key: "o", ctrlKey: true }), false)).toBe("mod+o");
    expect(eventToKeybinding(keydown({ key: "o", ctrlKey: true }), true)).toBe("ctrl+o");
  });

  it("never treats Meta as mod on Windows/Linux", () => {
    expect(eventToKeybinding(keydown({ key: "o", metaKey: true }), false)).toBeNull();
  });

  it("orders modifiers canonically and keeps the key lowercase", () => {
    expect(
      eventToKeybinding(keydown({ key: "L", ctrlKey: true, shiftKey: true, altKey: true }), false),
    ).toBe("alt+shift+mod+l");
  });

  it("ignores modifier-only keys, repeats and empty keys", () => {
    expect(eventToKeybinding(keydown({ key: "Shift", shiftKey: true }), false)).toBeNull();
    expect(eventToKeybinding(keydown({ key: "Meta", metaKey: true }), true)).toBeNull();
    expect(eventToKeybinding(keydown({ key: "o", ctrlKey: true, repeat: true }), false)).toBeNull();
    expect(eventToKeybinding(keydown({ key: "" }), false)).toBeNull();
  });

  it("supports bare keys and formatted labels", () => {
    expect(eventToKeybinding(keydown({ key: "k" }), false)).toBe("k");
    expect(formatKeybinding("Mod+Shift+L", true)).toBe("⌘⇧L");
    expect(formatKeybinding("Mod+Shift+L", false)).toBe("Ctrl+Shift+L");
    expect(formatKeybinding("Mod+O", true)).toBe("⌘O");
  });
});

describe("useCommandKeybindings", () => {
  it("opens the palette with Mod+K and prevents the browser default", () => {
    const onOpenPalette = vi.fn();
    render(<Harness options={{ registry: createRegistry(), onOpenPalette }} />);

    const event = keydown({ key: "k", ctrlKey: true });
    window.dispatchEvent(event);

    expect(onOpenPalette).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    expect(PALETTE_KEYBINDING).toBe("Mod+K");
  });

  it("executes the registry command that owns the shortcut", async () => {
    const registry = createRegistry();
    const run = vi.fn();
    registry.register({
      id: "file.open",
      titleKey: "commands:file.open",
      category: "commands:category.file",
      keybinding: "Mod+O",
      run,
    });
    render(<Harness options={{ registry }} />);

    const event = keydown({ key: "o", ctrlKey: true });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  });

  it("reads the registry at event time, so late registrations work", async () => {
    const registry = createRegistry();
    render(<Harness options={{ registry }} />);

    const run = vi.fn();
    registry.register({
      id: "view.toggleTheme",
      titleKey: "commands:view.toggleTheme",
      category: "commands:category.view",
      keybinding: "Mod+Shift+L",
      run,
    });

    const event = keydown({ key: "l", ctrlKey: true, shiftKey: true });
    window.dispatchEvent(event);

    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(event.defaultPrevented).toBe(true);
  });

  it("ignores composing, repeated and already-handled events", async () => {
    const registry = createRegistry();
    const run = vi.fn();
    registry.register({
      id: "file.save",
      titleKey: "commands:file.save",
      category: "commands:category.file",
      keybinding: "Mod+S",
      run,
    });

    render(<Harness options={{ registry }} />);

    const composing = keydown({ key: "s", ctrlKey: true, isComposing: true });
    expect(composing.isComposing).toBe(true);
    window.dispatchEvent(composing);
    window.dispatchEvent(keydown({ key: "s", ctrlKey: true, repeat: true }));

    const handled = keydown({ key: "s", ctrlKey: true });
    handled.preventDefault();
    window.dispatchEvent(handled);

    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
  });

  it("ignores unavailable commands and a disabled listener", async () => {
    const registry = createRegistry();
    const run = vi.fn();
    registry.register({
      id: "file.save",
      titleKey: "commands:file.save",
      category: "commands:category.file",
      keybinding: "Mod+S",
      when: () => false,
      run,
    });

    const { rerender } = render(<Harness options={{ registry }} />);
    window.dispatchEvent(keydown({ key: "s", ctrlKey: true }));

    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();

    rerender(<Harness options={{ registry, enabled: false }} />);
    window.dispatchEvent(keydown({ key: "s", ctrlKey: true }));
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
  });

  it("removes the listener on unmount", async () => {
    const registry = createRegistry();
    const run = vi.fn();
    registry.register({
      id: "file.open",
      titleKey: "commands:file.open",
      category: "commands:category.file",
      keybinding: "Mod+O",
      run,
    });
    const { unmount } = render(<Harness options={{ registry }} />);
    unmount();

    window.dispatchEvent(keydown({ key: "o", ctrlKey: true }));

    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
  });

  it("forwards execution failures to onError", async () => {
    const registry = createRegistry();
    registry.register({
      id: "file.open",
      titleKey: "commands:file.open",
      category: "commands:category.file",
      keybinding: "Mod+O",
      run: () => {
        throw new Error("kaboom");
      },
    });
    const onError = vi.fn<(error: AppError) => void>();
    render(<Harness options={{ registry, onError }} />);

    window.dispatchEvent(keydown({ key: "o", ctrlKey: true }));

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ code: "IO", message: "kaboom" });
  });

  it("can listen on an explicit element instead of window", () => {
    const registry = createRegistry();
    const onOpenPalette = vi.fn();
    const surface = document.createElement("div");
    document.body.append(surface);
    render(<Harness options={{ registry, target: surface, onOpenPalette }} />);

    fireEvent.keyDown(surface, { key: "k", ctrlKey: true });

    expect(onOpenPalette).toHaveBeenCalledTimes(1);
    surface.remove();
  });
});
