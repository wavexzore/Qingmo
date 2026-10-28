import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import type { SupportedLanguage } from "../i18n/language";

export interface LanguageOption {
  value: SupportedLanguage;
  nativeName: string;
  detail: string;
  code: string;
}

export interface LanguageSelectProps {
  value: SupportedLanguage;
  options: readonly LanguageOption[];
  label: string;
  onChange(value: SupportedLanguage): void;
}

/**
 * Select-only combobox for the settings window.
 *
 * Focus stays on the trigger while `aria-activedescendant` follows the active
 * option, matching the WAI-ARIA select-only combobox pattern. The menu is
 * deliberately a popup rather than a native `<select>` so both the endonym and
 * the locale code can be read at a glance.
 */
export function LanguageSelect({ value, options, label, onChange }: LanguageSelectProps) {
  const rawId = useId();
  const menuId = `settings-language-menu-${rawId.replaceAll(":", "")}`;
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const current = options[selectedIndex] ?? options[0];

  const setActive = (index: number) => {
    if (options.length === 0) {
      return;
    }
    const next = (index + options.length) % options.length;
    setActiveIndex(next);
    optionRefs.current[next]?.scrollIntoView?.({ block: "nearest" });
  };

  const openMenu = () => {
    setActive(selectedIndex);
    setOpen(true);
  };

  const closeMenu = (focusTrigger = true) => {
    setOpen(false);
    if (focusTrigger) {
      triggerRef.current?.focus();
    }
  };

  useEffect(() => {
    if (!open) {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleFocusIn = (event: FocusEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("focusin", handleFocusIn);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("focusin", handleFocusIn);
    };
  }, [open]);

  const choose = (option: LanguageOption | undefined) => {
    if (!option) {
      return;
    }
    onChange(option.value);
    closeMenu();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!open) {
      if (
        event.key === "ArrowDown" ||
        event.key === "ArrowUp" ||
        event.key === "Enter" ||
        event.key === " "
      ) {
        event.preventDefault();
        openMenu();
      }
      return;
    }

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActive(activeIndex + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        setActive(activeIndex - 1);
        break;
      case "Home":
        event.preventDefault();
        setActive(0);
        break;
      case "End":
        event.preventDefault();
        setActive(options.length - 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        choose(options[activeIndex] ?? current);
        break;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        closeMenu();
        break;
      case "Tab":
        setOpen(false);
        break;
      default:
        break;
    }
  };

  if (!current) {
    return null;
  }

  return (
    <div
      className="settings-select"
      data-language-select
      data-open={open ? "true" : "false"}
      ref={containerRef}
    >
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        aria-activedescendant={open ? `${menuId}-option-${activeIndex}` : undefined}
        aria-label={`${label}: ${current.nativeName}`}
        className="settings-select-trigger"
        onClick={() => {
          if (open) {
            closeMenu();
          } else {
            openMenu();
          }
        }}
        onKeyDown={handleKeyDown}
        data-testid="settings-language"
      >
        <svg
          className="settings-select-globe"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          aria-hidden="true"
        >
          <circle cx="8" cy="8" r="5.6" />
          <path d="M2.4 8h11.2M8 2.4c1.7 1.6 2.6 3.5 2.6 5.6S9.7 12 8 13.6C6.3 12 5.4 10.1 5.4 8S6.3 4 8 2.4Z" />
        </svg>
        <span className="settings-select-copy">
          <span className="settings-select-native">{current.nativeName}</span>
          <span className="settings-select-code">{current.code}</span>
        </span>
        <svg
          className="settings-select-chevron"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>

      <div
        id={menuId}
        className="settings-select-menu"
        role="listbox"
        aria-label={label}
        aria-hidden={!open}
      >
        {options.map((option, index) => (
          <button
            key={option.value}
            ref={(element) => {
              optionRefs.current[index] = element;
            }}
            id={`${menuId}-option-${index}`}
            type="button"
            role="option"
            tabIndex={-1}
            aria-selected={option.value === value}
            data-active={open && index === activeIndex ? "true" : undefined}
            className="settings-select-option"
            onPointerDown={(event) => event.preventDefault()}
            onPointerEnter={() => {
              if (open) {
                setActive(index);
              }
            }}
            onClick={() => choose(option)}
          >
            <span className="settings-select-option-copy">
              <span className="settings-select-option-native">{option.nativeName}</span>
              <span className="settings-select-option-detail">{option.detail}</span>
            </span>
            <svg
              className="settings-select-check"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="m3.2 8.4 3 3L12.8 4.6" />
            </svg>
          </button>
        ))}
      </div>
    </div>
  );
}
