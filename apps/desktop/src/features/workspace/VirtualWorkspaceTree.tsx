import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";

import type { FlatRow } from "./workspaceTree";
import { visibleRange, WORKSPACE_OVERSCAN, WORKSPACE_ROW_HEIGHT } from "./virtualRows";

interface VirtualWorkspaceTreeProps {
  rows: FlatRow[];
  focusedKey: string | null;
  selectedKey: string | null;
  currentKey: string | null;
  /** Hidden panels keep their cache but skip measurement and row rendering. */
  active?: boolean;
  onFocusKey(key: string | null): void;
  onSelectKey(key: string | null): void;
  onToggle(segments: string[]): void;
  onOpenFile(segments: string[]): boolean | void | Promise<boolean>;
  onRetry(segments: string[]): void;
  /** Opens the confirmation flow for moving one file to the app trash. */
  onDeleteFile?: ((segments: string[]) => void) | undefined;
  onShowTrash?: (() => void) | undefined;
}

function kindIcon(row: FlatRow): string {
  switch (row.kind) {
    case "directory":
      return row.expanded ? "▾" : "▸";
    case "symlinkDirectory":
      return "↪";
    case "symlinkFile":
      return "↪";
    case "file":
      return "·";
  }
}

export function VirtualWorkspaceTree({
  rows,
  focusedKey,
  selectedKey,
  currentKey,
  active = true,
  onFocusKey,
  onSelectKey,
  onToggle,
  onOpenFile,
  onRetry,
  onDeleteFile,
  onShowTrash,
}: VirtualWorkspaceTreeProps) {
  const { t } = useTranslation(["workspace"]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  // Set after an in-place open is rejected; the layout effect returns focus to
  // the current document's row once the virtualized row is on screen.
  const [restoreTarget, setRestoreTarget] = useState<string | null>(null);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    segments: string[];
  } | null>(null);
  const currentKeyRef = useRef(currentKey);
  currentKeyRef.current = currentKey;

  useLayoutEffect(() => {
    if (!active) {
      return;
    }
    const element = scrollRef.current;
    if (!element) {
      return;
    }
    const measure = () => setViewportHeight(element.clientHeight);
    measure();
    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [active]);

  useEffect(() => {
    if (rows.length === 0) {
      return;
    }
    const exists = focusedKey !== null && rows.some((row) => row.key === focusedKey);
    if (exists) {
      return;
    }
    const parentKey =
      focusedKey === null
        ? null
        : focusedKey.includes("/")
          ? focusedKey.slice(0, focusedKey.lastIndexOf("/"))
          : "";
    const parent = parentKey === null ? undefined : rows.find((row) => row.key === parentKey);
    onFocusKey(parent?.key ?? rows[0]?.key ?? null);
  }, [focusedKey, onFocusKey, rows]);

  useEffect(() => {
    if (!menu) {
      return;
    }
    const close = (event: Event) => {
      if (
        event.target instanceof Node &&
        scrollRef.current?.querySelector("[data-workspace-menu]")?.contains(event.target)
      ) {
        return;
      }
      setMenu(null);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenu(null);
      }
    };
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("keydown", escape);
    };
  }, [menu]);

  useEffect(() => {
    if (!active || !currentKey) {
      return;
    }
    const element = findRow(scrollRef.current, currentKey);
    element?.scrollIntoView?.({ block: "nearest" });
  }, [active, currentKey]);

  useLayoutEffect(() => {
    if (restoreTarget === null) {
      return;
    }
    const element = findRow(scrollRef.current, restoreTarget);
    if (element) {
      onFocusKey(restoreTarget);
      element.focus({ preventScroll: true });
      element.scrollIntoView?.({ block: "nearest" });
      setRestoreTarget(null);
      return;
    }
    const index = rows.findIndex((row) => row.key === restoreTarget);
    const container = scrollRef.current;
    if (index < 0 || !container) {
      setRestoreTarget(null);
      return;
    }
    // The row scrolled out of the virtual window; center it and let the next
    // pass (after the scrollTop update renders) focus it.
    const nextTop = Math.max(0, index * WORKSPACE_ROW_HEIGHT - container.clientHeight / 2);
    container.scrollTop = nextTop;
    setScrollTop(nextTop);
  }, [onFocusKey, restoreTarget, rows, scrollTop]);

  const range = useMemo(
    () =>
      active
        ? visibleRange(
            rows.length,
            scrollTop,
            viewportHeight || rows.length * WORKSPACE_ROW_HEIGHT,
            WORKSPACE_ROW_HEIGHT,
            WORKSPACE_OVERSCAN,
          )
        : { start: 0, end: 0 },
    [active, rows.length, scrollTop, viewportHeight],
  );

  const activeKey =
    focusedKey !== null && rows.some((row) => row.key === focusedKey)
      ? focusedKey
      : (rows[0]?.key ?? null);

  const rollbackSelection = useCallback(
    (fallbackKey: string | null): void => {
      const target = currentKeyRef.current ?? fallbackKey;
      onSelectKey(target);
      if (target) {
        setRestoreTarget(target);
      }
    },
    [onSelectKey],
  );

  const openFileWithRollback = useCallback(
    (segments: string[], fallbackKey: string | null): void => {
      const result = onOpenFile(segments);
      if (result === false) {
        rollbackSelection(fallbackKey);
        return;
      }
      if (!result || typeof result !== "object" || typeof result.then !== "function") {
        return;
      }
      void result
        .then((opened) => {
          if (opened === false) {
            rollbackSelection(fallbackKey);
          }
        })
        .catch(() => rollbackSelection(fallbackKey));
    },
    [onOpenFile, rollbackSelection],
  );

  const focusRow = useCallback(
    (key: string): void => {
      onFocusKey(key);
      findRow(scrollRef.current, key)?.focus({ preventScroll: true });
    },
    [onFocusKey],
  );

  const moveFocus = useCallback(
    (index: number): void => {
      if (rows.length === 0) {
        return;
      }
      const clamped = Math.max(0, Math.min(index, rows.length - 1));
      const row = rows[clamped];
      if (row) {
        focusRow(row.key);
      }
    },
    [focusRow, rows],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      if (event.nativeEvent.isComposing) {
        return;
      }
      const target = event.target as HTMLElement;
      if (target.closest("button")) {
        return;
      }
      const index = rows.findIndex((row) => row.key === activeKey);
      const row = index >= 0 ? rows[index] : undefined;
      if (!row) {
        return;
      }

      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          moveFocus(index + 1);
          break;
        case "ArrowUp":
          event.preventDefault();
          moveFocus(index - 1);
          break;
        case "Home":
          event.preventDefault();
          moveFocus(0);
          break;
        case "End":
          event.preventDefault();
          moveFocus(rows.length - 1);
          break;
        case "ArrowRight":
          event.preventDefault();
          if (row.expandable) {
            if (!row.expanded) {
              onToggle(row.segments);
            } else {
              const child = rows[index + 1];
              if (child && child.depth === row.depth + 1) {
                focusRow(child.key);
              }
            }
          }
          break;
        case "ArrowLeft": {
          event.preventDefault();
          if (row.expandable && row.expanded) {
            onToggle(row.segments);
            break;
          }
          for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
            const candidate = rows[cursor];
            if (candidate && candidate.depth === row.depth - 1) {
              focusRow(candidate.key);
              break;
            }
          }
          break;
        }
        case "Enter":
        case " ":
          event.preventDefault();
          if (row.expandable) {
            onToggle(row.segments);
          } else if (row.openable) {
            openFileWithRollback(row.segments, row.key);
          }
          break;
        default:
          break;
      }
    },
    [activeKey, focusRow, moveFocus, onToggle, openFileWithRollback, rows],
  );

  return (
    <div
      ref={scrollRef}
      role="tree"
      aria-label={t("workspace:tree.region")}
      data-testid="workspace-tree"
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      onKeyDown={handleKeyDown}
      className="relative min-h-0 flex-1 overflow-y-auto py-1 outline-none"
    >
      <div style={{ height: rows.length * WORKSPACE_ROW_HEIGHT, position: "relative" }}>
        {rows.slice(range.start, range.end).map((row, offset) => {
          const index = range.start + offset;
          const isCurrent = row.key === currentKey;
          return (
            <div
              key={row.key}
              role="treeitem"
              data-workspace-row="true"
              data-workspace-key={row.key}
              data-workspace-current={isCurrent ? "true" : undefined}
              aria-level={row.depth + 1}
              aria-expanded={row.expandable ? row.expanded : undefined}
              aria-selected={row.key === selectedKey}
              aria-posinset={row.posInSet}
              aria-setsize={row.setSize}
              aria-busy={row.loadState === "loading" || undefined}
              aria-label={row.name}
              tabIndex={row.key === activeKey ? 0 : -1}
              title={row.errorCode ? t("workspace:tree.rowError") : row.name}
              style={{
                position: "absolute",
                top: index * WORKSPACE_ROW_HEIGHT,
                left: 0,
                right: 0,
                height: WORKSPACE_ROW_HEIGHT,
                paddingLeft: `${8 + row.depth * 14}px`,
              }}
              onFocus={() => onFocusKey(row.key)}
              onContextMenu={(event) => {
                if (row.kind !== "file" && row.kind !== "symlinkFile") {
                  return;
                }
                event.preventDefault();
                onSelectKey(row.key);
                setMenu({
                  x: event.clientX,
                  y: event.clientY,
                  segments: row.segments,
                });
              }}
              onClick={() => {
                const fallbackKey = selectedKey;
                onSelectKey(row.key);
                if (row.expandable) {
                  onToggle(row.segments);
                } else if (row.openable) {
                  // Single click opens, matching the Finder-like file tree.
                  // A rejected switch restores the current row below.
                  openFileWithRollback(row.segments, fallbackKey);
                }
              }}
              className={`flex cursor-default items-center gap-1.5 pr-2 text-sm outline-none transition-colors focus-visible:bg-accent-soft ${
                isCurrent
                  ? "bg-accent-soft text-ink"
                  : row.key === selectedKey
                    ? "bg-surface-raised text-ink"
                    : "text-ink-muted hover:bg-surface-raised hover:text-ink"
              } ${row.stale ? "italic" : ""}`}
            >
              <span aria-hidden="true" className="w-3 shrink-0 text-center text-[10px]">
                {kindIcon(row)}
              </span>
              <span className="min-w-0 flex-1 truncate">{row.name}</span>
              {row.truncated ? (
                <span
                  aria-label={t("workspace:tree.truncatedRow")}
                  title={t("workspace:tree.truncatedRow")}
                  className="shrink-0 text-[10px] text-ink-faint"
                >
                  …
                </span>
              ) : null}
              {row.loadState === "loading" ? (
                <span className="shrink-0 text-[10px] text-ink-faint" aria-hidden="true">
                  …
                </span>
              ) : row.loadState === "error" || row.stale ? (
                <button
                  type="button"
                  aria-label={t("workspace:tree.retry")}
                  title={t("workspace:tree.retry")}
                  onClick={(event) => {
                    event.stopPropagation();
                    onRetry(row.segments);
                  }}
                  className="shrink-0 rounded px-1 text-[11px] text-ink-muted transition-colors hover:bg-surface hover:text-ink"
                >
                  ↻
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      {menu ? (
        <div
          role="menu"
          data-workspace-menu="true"
          aria-label={t("workspace:menu.label")}
          style={{ position: "fixed", left: menu.x, top: menu.y }}
          className="z-50 min-w-40 rounded border border-line bg-surface py-1 shadow-xl"
        >
          {onDeleteFile ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(null);
                onDeleteFile(menu.segments);
              }}
              className="block w-full px-3 py-1.5 text-left text-xs text-danger hover:bg-surface-raised"
            >
              {t("workspace:menu.delete")}
            </button>
          ) : null}
          {onShowTrash ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(null);
                onShowTrash();
              }}
              className="block w-full px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-raised"
            >
              {t("workspace:menu.trash")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function findRow(container: HTMLElement | null, key: string): HTMLElement | null {
  if (!container) {
    return null;
  }
  const rows = container.querySelectorAll<HTMLElement>("[data-workspace-key]");
  for (const row of rows) {
    if (row.dataset.workspaceKey === key) {
      return row;
    }
  }
  return null;
}
