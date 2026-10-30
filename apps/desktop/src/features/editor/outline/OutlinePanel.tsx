import {
  Component,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

import { OUTLINE_PANEL_MAX_ENTRIES, OUTLINE_SAFETY_MAX_ENTRIES } from "@qingmo/editor-core";
import type { HeadingOutlineState } from "@qingmo/editor-core";

import type { EditorSession } from "../EditorSession";
import {
  activeOutlineIndex,
  outlineStatusHint,
  scrollPanelItemIntoView,
  type Translate,
} from "./active";
import { useOutline } from "./useOutline";

interface OutlinePanelProps {
  session: EditorSession;
  cursorLine: number;
  onClose(): void;
}

function OutlineMessage({ outline }: { outline: HeadingOutlineState }) {
  const { t } = useTranslation(["editor"]);
  if (outline.status === "error") {
    return (
      <p role="alert" className="px-4 py-3 text-sm text-danger">
        {t("editor:outline.error")}
      </p>
    );
  }
  if (outline.status === "partial") {
    if (outline.limitReason === "size") {
      return (
        <p role="status" className="px-4 py-3 text-sm text-ink-muted">
          {t("editor:outline.emptySize")}
        </p>
      );
    }
    if (outline.limitReason === "count") {
      return (
        <p role="status" className="px-4 py-3 text-sm text-ink-muted">
          {t("editor:outline.limitCount", { count: OUTLINE_SAFETY_MAX_ENTRIES })}
        </p>
      );
    }
    return (
      <p role="status" className="px-4 py-3 text-sm text-ink-muted">
        {t("editor:outline.generating")}
      </p>
    );
  }
  return (
    <p role="status" className="px-4 py-3 text-sm text-ink-muted">
      {t("editor:outline.empty")}
    </p>
  );
}

class OutlineListBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function OutlinePanelView({ session, cursorLine, onClose }: OutlinePanelProps) {
  const { t } = useTranslation(["editor"]);
  const outline = useOutline(session);
  const entries = outline.entries;
  const visibleEntries = useMemo(() => entries.slice(0, OUTLINE_PANEL_MAX_ENTRIES), [entries]);
  const activeIndex = activeOutlineIndex(visibleEntries, cursorLine);
  const minLevel = useMemo(
    () => visibleEntries.reduce((minimum, entry) => Math.min(minimum, entry.level), 6),
    [visibleEntries],
  );
  const [focusIndex, setFocusIndex] = useState(0);
  const navRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const pendingInitialFocus = useRef(true);
  const statusHint = outlineStatusHint(outline, visibleEntries.length, t as unknown as Translate);

  const close = useCallback(() => {
    onClose();
    session.focusEditor();
  }, [onClose, session]);

  const moveFocus = useCallback(
    (next: number) => {
      if (visibleEntries.length === 0) {
        return;
      }
      const index = Math.max(0, Math.min(next, visibleEntries.length - 1));
      setFocusIndex(index);
      const list = listRef.current;
      const item = list?.children[index] as HTMLElement | undefined;
      item?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
      if (list && item) {
        scrollPanelItemIntoView(list, item);
      }
    },
    [visibleEntries.length],
  );

  const handleListKeyDown = useCallback(
    (event: KeyboardEvent<HTMLUListElement>) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        moveFocus(focusIndex + 1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        moveFocus(focusIndex - 1);
      } else if (event.key === "Home") {
        event.preventDefault();
        moveFocus(0);
      } else if (event.key === "End") {
        event.preventDefault();
        moveFocus(visibleEntries.length - 1);
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        const entry = visibleEntries[focusIndex];
        if (entry) {
          session.revealPosition(entry.lineFrom);
        }
      }
    },
    [focusIndex, moveFocus, session, visibleEntries],
  );

  useEffect(() => {
    if (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(min-width: 900px)").matches
    ) {
      navRef.current?.focus();
    }
  }, []);

  useEffect(() => {
    if (visibleEntries.length === 0) {
      return;
    }
    setFocusIndex((current) => Math.min(current, visibleEntries.length - 1));
    if (!pendingInitialFocus.current) {
      return;
    }
    pendingInitialFocus.current = false;
    const nav = navRef.current;
    if (!nav || (document.activeElement !== nav && !nav.contains(document.activeElement))) {
      return;
    }
    const index = activeIndex >= 0 ? activeIndex : 0;
    const list = listRef.current;
    const item = list?.children[index] as HTMLElement | undefined;
    item?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    if (list && item) {
      scrollPanelItemIntoView(list, item);
    }
  }, [visibleEntries.length, activeIndex]);

  useEffect(() => {
    const list = listRef.current;
    if (!list || activeIndex < 0) {
      return;
    }
    const item = list.children[activeIndex] as HTMLElement | undefined;
    if (item) {
      scrollPanelItemIntoView(list, item);
    }
  }, [activeIndex]);

  const list = useMemo(
    () => (
      <ul
        ref={listRef}
        onKeyDown={handleListKeyDown}
        aria-label={t("editor:outline.region")}
        className="relative min-h-0 flex-1 overflow-y-auto py-1"
      >
        {visibleEntries.map((entry, index) => {
          const displayText = entry.plainText || entry.text;
          return (
            <li key={`${entry.line}:${index}`} className="list-none">
              <button
                type="button"
                tabIndex={index === focusIndex ? 0 : -1}
                aria-current={index === activeIndex ? "location" : undefined}
                aria-label={t("editor:outline.item", {
                  level: entry.level,
                  text: displayText,
                })}
                title={displayText}
                style={{
                  paddingLeft: `${12 + (entry.level - minLevel) * 12}px`,
                  paddingRight: "12px",
                }}
                onFocus={() => setFocusIndex(index)}
                onClick={() => {
                  session.revealPosition(entry.lineFrom);
                }}
                className="block w-full truncate py-1.5 text-left text-sm text-ink-muted transition-colors hover:bg-surface-raised hover:text-ink aria-[current=location]:bg-accent-soft aria-[current=location]:text-ink"
              >
                {displayText}
              </button>
            </li>
          );
        })}
      </ul>
    ),
    [activeIndex, focusIndex, handleListKeyDown, minLevel, session, t, visibleEntries],
  );

  return (
    <nav
      ref={navRef}
      tabIndex={-1}
      aria-label={t("editor:outline.region")}
      data-testid="outline-panel"
      data-outline-status={outline.status}
      data-outline-count={visibleEntries.length}
      data-outline-total={entries.length}
      data-outline-limit={outline.limitReason ?? "none"}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          close();
        }
      }}
      className="relative hidden h-full w-60 shrink-0 flex-col border-r border-line bg-surface/60 min-[900px]:flex"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <h2 className="min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-[0.12em] text-ink-muted">
          {t("editor:outline.title")}
        </h2>
        <span className="shrink-0 text-[10px] tabular-nums text-ink-faint">
          {t("editor:outline.count", { count: visibleEntries.length })}
        </span>
        <button
          type="button"
          aria-label={t("editor:outline.close")}
          title={t("editor:outline.close")}
          onClick={close}
          className="shrink-0 rounded p-1 text-ink-muted transition-colors hover:bg-surface-raised hover:text-ink"
        >
          ×
        </button>
      </header>
      {visibleEntries.length === 0 ? (
        <OutlineMessage outline={outline} />
      ) : (
        <OutlineListBoundary fallback={<OutlineMessage outline={outline} />}>
          {list}
        </OutlineListBoundary>
      )}
      {visibleEntries.length > 0 && statusHint ? (
        <footer className="shrink-0 border-t border-line px-3 py-1.5 text-[11px] text-ink-faint">
          {statusHint}
        </footer>
      ) : null}
    </nav>
  );
}

export const OutlinePanel = memo(OutlinePanelView);
