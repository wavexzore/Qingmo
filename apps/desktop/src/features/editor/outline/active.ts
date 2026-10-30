import type { HeadingOutlineEntry, HeadingOutlineState } from "@qingmo/editor-core";

/** Returns the last visible heading at or before `cursorLine`, or -1. */
export function activeOutlineIndex(
  entries: readonly HeadingOutlineEntry[],
  cursorLine: number,
): number {
  let low = 0;
  let high = entries.length - 1;
  let result = -1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    const entry = entries[mid];
    if (!entry) {
      break;
    }
    if (entry.line <= cursorLine) {
      result = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return result;
}

/**
 * Scrolls only the outline list. `scrollIntoView` would also scroll the
 * editor page and any other scrollable ancestor.
 */
export function scrollPanelItemIntoView(list: HTMLElement, item: HTMLElement): void {
  const top = item.offsetTop;
  const bottom = top + item.offsetHeight;
  if (top < list.scrollTop) {
    list.scrollTop = top;
  } else if (bottom > list.scrollTop + list.clientHeight) {
    list.scrollTop = bottom - list.clientHeight;
  }
}

export type Translate = (key: string, options?: Record<string, unknown>) => string;

/** Single footer/status message, ordered by the root cause. */
export function outlineStatusHint(
  outline: HeadingOutlineState,
  visibleCount: number,
  t: Translate,
): string | null {
  if (outline.status === "error") {
    return t("editor:outline.error");
  }
  if (outline.limitReason === "size") {
    return t("editor:outline.limitSize");
  }
  if (outline.limitReason === "count") {
    return t("editor:outline.limitCount", { count: outline.entries.length });
  }
  if (outline.status === "partial") {
    return outline.entries.length > visibleCount
      ? t("editor:outline.generatingPanel", {
          shown: visibleCount,
          total: outline.entries.length,
        })
      : t("editor:outline.generating");
  }
  if (outline.entries.length > visibleCount) {
    return t("editor:outline.limitPanel", {
      shown: visibleCount,
      total: outline.entries.length,
    });
  }
  return null;
}
