export const WORKSPACE_ROW_HEIGHT = 28;
export const WORKSPACE_OVERSCAN = 8;
/** First-frame fallback when ResizeObserver has not measured the panel yet. */
export const DEFAULT_VIEWPORT_HEIGHT = 560;

export interface VisibleRange {
  start: number;
  end: number;
}

/**
 * Fixed-row virtual window.
 *
 * `end` is exclusive. Invalid/negative inputs clamp to an empty range, and a
 * row count that shrinks after the last scroll cannot produce an out-of-range
 * window.
 */
export function visibleRange(
  rowCount: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight = WORKSPACE_ROW_HEIGHT,
  overscan = WORKSPACE_OVERSCAN,
): VisibleRange {
  if (!Number.isFinite(rowCount) || rowCount <= 0 || rowHeight <= 0) {
    return { start: 0, end: 0 };
  }
  const top = Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0;
  const height = Number.isFinite(viewportHeight) ? Math.max(0, viewportHeight) : 0;
  const start = Math.min(Math.max(0, Math.floor(top / rowHeight) - overscan), rowCount - 1);
  const end = Math.max(start, Math.min(rowCount, Math.ceil((top + height) / rowHeight) + overscan));
  return { start, end };
}
