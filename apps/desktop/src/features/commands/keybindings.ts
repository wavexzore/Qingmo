import { useEffect } from "react";

import type { AppError } from "@qingmo/shared";

import { commandRegistry, normalizeKeybinding, type CommandRegistry } from "./CommandRegistry";

/** The palette is UI, not a registered business command. */
export const PALETTE_KEYBINDING = "Mod+K";

/**
 * Minimal DOM surface the hook needs. Using the native `EventListener`
 * signature keeps `window`, `document` and test elements assignable without a
 * cast; the listener narrows to `KeyboardEvent` before reading key state.
 */
export interface KeybindingTarget {
  addEventListener(
    type: "keydown",
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: "keydown",
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void;
}

export interface CommandKeybindingOptions {
  /** Commands are never duplicated; the registry remains the only source. */
  registry?: CommandRegistry;
  enabled?: boolean;
  target?: KeybindingTarget;
  onOpenPalette?: () => void;
  onError?: (error: AppError) => void;
}

export function isMacLike(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  return (
    /Mac|iPhone|iPad|iPod/i.test(navigator.platform ?? "") ||
    /Mac OS X/i.test(navigator.userAgent ?? "")
  );
}

/**
 * Converts a DOM keyboard event into the same canonical spelling used by
 * `CommandRegistry`. `mod` maps to Meta on macOS and Control elsewhere; a
 * Windows/Meta key never becomes `mod`, so it cannot fire save/open by accident.
 */
export function eventToKeybinding(event: KeyboardEvent, macLike = isMacLike()): string | null {
  if (event.repeat) {
    return null;
  }
  const key = event.key.toLowerCase();
  if (!key || key === "control" || key === "meta" || key === "alt" || key === "shift") {
    return null;
  }

  const parts: string[] = [];
  if (event.ctrlKey) {
    parts.push(macLike ? "ctrl" : "mod");
  }
  if (event.metaKey) {
    if (!macLike) {
      return null;
    }
    parts.push("mod");
  }
  if (event.altKey) {
    parts.push("alt");
  }
  if (event.shiftKey) {
    parts.push("shift");
  }
  parts.push(key);
  return normalizeKeybinding(parts.join("+"));
}

/** Human-readable shortcut, for example `⌘⇧L` or `Ctrl+Shift+L`. */
export function formatKeybinding(binding: string, macLike = isMacLike()): string {
  return binding
    .split("+")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .map((part) => {
      switch (part) {
        case "mod":
          return macLike ? "⌘" : "Ctrl";
        case "ctrl":
          return macLike ? "⌃" : "Ctrl";
        case "alt":
          return macLike ? "⌥" : "Alt";
        case "shift":
          return macLike ? "⇧" : "Shift";
        default:
          return part.length === 1 ? part.toUpperCase() : part;
      }
    })
    .join(macLike ? "" : "+");
}

/**
 * The only global keydown listener. It reads shortcuts from the registry at
 * event time, so features can register/unregister commands without a second
 * keymap or a stale snapshot.
 */
export function useCommandKeybindings(options: CommandKeybindingOptions = {}): void {
  const { registry = commandRegistry, enabled = true, target, onOpenPalette, onError } = options;

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const host = target ?? (typeof window === "undefined" ? null : window);
    if (!host) {
      return;
    }

    const listener: EventListener = (event) => {
      if (!(event instanceof KeyboardEvent)) {
        return;
      }
      if (event.defaultPrevented || event.isComposing) {
        return;
      }
      const binding = eventToKeybinding(event);
      if (!binding) {
        return;
      }

      if (binding === normalizeKeybinding(PALETTE_KEYBINDING)) {
        if (onOpenPalette) {
          event.preventDefault();
          onOpenPalette();
        }
        return;
      }

      const command = registry
        .list()
        .find(
          (candidate) =>
            candidate.keybinding && normalizeKeybinding(candidate.keybinding) === binding,
        );
      if (!command || (command.when && !command.when())) {
        return;
      }

      event.preventDefault();
      void registry.execute(command.id).then((result) => {
        if (!result.ok) {
          onError?.(result.error);
        }
      });
    };

    host.addEventListener("keydown", listener);
    return () => host.removeEventListener("keydown", listener);
  }, [enabled, onError, onOpenPalette, registry, target]);
}
