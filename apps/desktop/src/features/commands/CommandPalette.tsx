import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";

import type { AppError } from "@qingmo/shared";
import { cx } from "@qingmo/ui";

import { commandRegistry, type CommandDefinition, type CommandRegistry } from "./CommandRegistry";
import { formatKeybinding, PALETTE_KEYBINDING } from "./keybindings";

export interface CommandPaletteProps {
  open: boolean;
  onClose(): void;
  onError?(error: AppError): void;
  registry?: CommandRegistry;
}

/**
 * Registry-backed command palette. It never owns a command list: titles,
 * categories and shortcuts are read from the one CommandRegistry snapshot.
 */
export function CommandPalette({
  open,
  onClose,
  onError,
  registry = commandRegistry,
}: CommandPaletteProps) {
  const { t } = useTranslation("commands");
  const commands = useSyncExternalStore(
    registry.subscribe,
    registry.getSnapshot,
    registry.getSnapshot,
  );
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  const available = useMemo(
    () => commands.filter((command) => !command.when || command.when()),
    [commands],
  );
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return available;
    }
    return available.filter((command) => {
      const title = t(command.titleKey).toLowerCase();
      const category = t(command.category).toLowerCase();
      const keybinding = command.keybinding
        ? formatKeybinding(command.keybinding).toLowerCase()
        : "";
      return [title, category, command.id, keybinding].some((value) => value.includes(needle));
    });
  }, [available, query, t]);

  useEffect(() => {
    if (!open) {
      return;
    }
    previousFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery("");
    setActiveIndex(0);
    inputRef.current?.focus();
    return () => {
      const target = previousFocus.current;
      if (target && document.contains(target)) {
        target.focus();
      }
    };
  }, [open]);

  useEffect(() => {
    if (activeIndex >= filtered.length) {
      setActiveIndex(Math.max(0, filtered.length - 1));
    }
  }, [activeIndex, filtered.length]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const active = filtered[activeIndex];
    if (!active) {
      return;
    }
    document.getElementById(`command-palette-${active.id}`)?.scrollIntoView?.({
      block: "nearest",
    });
  }, [activeIndex, filtered, open]);

  if (!open) {
    return null;
  }

  const activeCommand = filtered[activeIndex];

  const execute = async (command: CommandDefinition) => {
    onClose();
    const result = await registry.execute(command.id);
    if (!result.ok) {
      onError?.(result.error);
    }
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "Tab") {
      // The input is the only focusable control in the modal; keep focus
      // inside instead of letting Tab reach the obscured page behind it.
      event.preventDefault();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (filtered.length > 0) {
        setActiveIndex((current) => (current + 1) % filtered.length);
      }
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (filtered.length > 0) {
        setActiveIndex((current) => (current - 1 + filtered.length) % filtered.length);
      }
      return;
    }
    if (event.key === "Enter" && activeCommand) {
      event.preventDefault();
      void execute(activeCommand);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink/30 px-4 pt-[12vh] backdrop-blur-[2px]"
      data-testid="command-palette-overlay"
      onMouseDown={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="command-palette-title"
        className="w-full max-w-[560px] overflow-hidden rounded-card border border-line bg-surface shadow-card"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="command-palette-title" className="sr-only">
          {t("commands:palette.title")}
        </h2>

        <div className="border-b border-line px-4 py-3">
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-list"
            aria-autocomplete="list"
            aria-activedescendant={
              activeCommand ? `command-palette-${activeCommand.id}` : undefined
            }
            className="w-full bg-transparent text-base text-ink outline-none placeholder:text-ink-faint"
            placeholder={t("commands:palette.placeholder")}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={handleKeyDown}
          />
        </div>

        <ul
          id="command-palette-list"
          role="listbox"
          aria-label={t("commands:palette.title")}
          className="max-h-[min(420px,50vh)] overflow-y-auto p-2"
        >
          {filtered.length === 0 ? (
            <li className="px-3 py-6 text-center text-sm text-ink-muted">
              {t("commands:palette.empty")}
            </li>
          ) : (
            filtered.map((command, index) => (
              <li
                key={command.id}
                id={`command-palette-${command.id}`}
                role="option"
                aria-selected={index === activeIndex}
                className={cx(
                  "flex cursor-pointer items-center gap-3 rounded-md px-3 py-2.5",
                  index === activeIndex ? "bg-accent-soft text-ink" : "text-ink-muted",
                )}
                onMouseEnter={() => setActiveIndex(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  void execute(command);
                }}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{t(command.titleKey)}</p>
                  <p className="mt-0.5 text-[10px] uppercase tracking-[0.12em] text-ink-faint">
                    {t(command.category)}
                  </p>
                </div>
                {command.keybinding ? (
                  <kbd className="shrink-0 rounded border border-line bg-surface-raised px-2 py-1 font-mono text-[10px] text-ink-muted">
                    {formatKeybinding(command.keybinding)}
                  </kbd>
                ) : null}
              </li>
            ))
          )}
        </ul>

        <div className="flex items-center justify-between border-t border-line px-4 py-2 text-[10px] text-ink-faint">
          <span>{t("commands:palette.hint")}</span>
          <kbd className="font-mono">{formatKeybinding(PALETTE_KEYBINDING)}</kbd>
        </div>
      </section>
    </div>
  );
}
