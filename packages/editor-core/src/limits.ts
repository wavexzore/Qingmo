/**
 * Single source of truth for Live Preview affordability.
 *
 * `full`    <= 200_000 UTF-16 units: inline formatting + block widgets.
 * `partial` <= 2_000_000 units: inline formatting only; block widgets stay
 *           source because their layout/rendering cost is unbounded.
 * `source`  > 2_000_000 units: Live Preview is disabled entirely.
 *
 * `MAX_FILE_BYTES` deliberately does not live here: Rust owns the 10MiB
 * read/write limit, while this module only decides whether preview decoration
 * is affordable.
 */
export const PREVIEW_FULL_MAX_UNITS = 200_000;
export const PREVIEW_PARTIAL_MAX_UNITS = 2_000_000;

export type PreviewTier = "full" | "partial" | "source";

/**
 * Maps a document length to its preview tier.
 *
 * Non-finite and negative inputs (NaN, Infinity, -1) fail safe to `source`:
 * an unknown length must never enable expensive decorations.
 */
export function previewTierFor(units: number): PreviewTier {
  if (!Number.isFinite(units) || units < 0) {
    return "source";
  }
  if (units <= PREVIEW_FULL_MAX_UNITS) {
    return "full";
  }
  if (units <= PREVIEW_PARTIAL_MAX_UNITS) {
    return "partial";
  }
  return "source";
}

export const SYNTAX_TREE_BUDGET_MS = 8;
export const MAX_LINE_UNITS = 10_000;

/**
 * Outline affordability and work-budget constants. These intentionally do not
 * alias `PREVIEW_FULL_MAX_UNITS`: the TOC still owns its 200k empty state and
 * preview may change independently.
 */
export const OUTLINE_SCAN_MAX_UNITS = 200_000;
export const OUTLINE_SAFETY_MAX_ENTRIES = 5_000;
export const OUTLINE_PANEL_MAX_ENTRIES = 500;
export const OUTLINE_PARSE_CHUNK_UNITS = 50_000;
export const OUTLINE_PARSE_MAX_ATTEMPTS_PER_CHUNK = 16;
export const OUTLINE_PARSE_CHROMIUM_SLICE_MS = 8;
export const OUTLINE_PARSE_WEBKIT_DELAY_MS = 64;
export const OUTLINE_PARSE_WEBKIT_SLICE_MS = 4;
export const OUTLINE_SCROLL_MARGIN = 10;
