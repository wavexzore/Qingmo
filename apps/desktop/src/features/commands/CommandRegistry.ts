import type { AppError, Result } from "@qingmo/shared";
import { err, ok } from "@qingmo/shared";

export interface Disposable {
  dispose(): void;
}

export interface CommandDefinition {
  /** Stable command id, for example `file.open`. */
  id: string;
  /** i18n key used by the palette and menus. */
  titleKey: string;
  /** i18n key for the category label. */
  category: string;
  /** Normalized later; `Mod+Shift+P` is the canonical spelling. */
  keybinding?: string;
  /** Optional availability predicate; false yields a BUSY result. */
  when?: () => boolean;
  run: () => void | Promise<void>;
}

export interface CommandRegistryOptions {
  warn?: (message: string) => void;
}

const MODIFIER_ORDER = ["ctrl", "alt", "shift", "mod"];

export function normalizeKeybinding(binding: string): string {
  const parts = binding
    .split("+")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  const modifiers = new Set(parts.filter((part) => MODIFIER_ORDER.includes(part)));
  const keys = parts.filter((part) => !MODIFIER_ORDER.includes(part));
  const orderedModifiers = MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier));
  return [...orderedModifiers, ...keys].join("+");
}

function isAppError(value: unknown): value is AppError {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    "message" in value &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

function normalizeError(value: unknown): AppError {
  if (isAppError(value)) {
    return value;
  }
  if (value instanceof Error) {
    return { code: "IO", message: value.message };
  }
  return { code: "IO", message: String(value) };
}

export class CommandRegistry {
  private readonly commands = new Map<string, CommandDefinition>();
  private readonly listeners = new Set<() => void>();
  private readonly running = new Set<string>();
  private readonly warnings: string[] = [];
  private readonly warn: (message: string) => void;
  private snapshot: readonly CommandDefinition[] = Object.freeze([]);

  constructor(options: CommandRegistryOptions = {}) {
    this.warn = options.warn ?? ((message) => console.warn(message));
  }

  register(definition: CommandDefinition): Disposable {
    if (this.commands.has(definition.id)) {
      throw new Error(`Command already registered: ${definition.id}`);
    }

    if (definition.keybinding) {
      const normalized = normalizeKeybinding(definition.keybinding);
      for (const existing of this.commands.values()) {
        if (existing.keybinding && normalizeKeybinding(existing.keybinding) === normalized) {
          const message = `Keybinding conflict: ${definition.id} and ${existing.id} both use ${normalized}`;
          this.warnings.push(message);
          this.warn(message);
        }
      }
    }

    this.commands.set(definition.id, definition);
    this.publish();
    return { dispose: () => this.unregister(definition.id) };
  }

  unregister(id: string): void {
    if (this.commands.delete(id)) {
      this.publish();
    }
  }

  async execute(id: string): Promise<Result<void, AppError>> {
    const command = this.commands.get(id);
    if (!command) {
      return err({ code: "BUSY", message: `Unknown command: ${id}` });
    }
    if (command.when && !command.when()) {
      return err({ code: "BUSY", message: `Command is not available: ${id}` });
    }
    if (this.running.has(id)) {
      return err({ code: "BUSY", message: `Command is already running: ${id}` });
    }

    this.running.add(id);
    try {
      await command.run();
      return ok(undefined);
    } catch (error) {
      return err(normalizeError(error));
    } finally {
      this.running.delete(id);
    }
  }

  list(): readonly CommandDefinition[] {
    return this.snapshot;
  }

  getWarnings(): readonly string[] {
    return Object.freeze([...this.warnings]);
  }

  getSnapshot = (): readonly CommandDefinition[] => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private publish(): void {
    this.snapshot = Object.freeze([...this.commands.values()]);
    for (const listener of this.listeners) {
      listener();
    }
  }
}

/** Application-level registry. Features register their commands into this table. */
export const commandRegistry = new CommandRegistry();
