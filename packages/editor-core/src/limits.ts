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
