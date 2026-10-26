/**
 * Live Preview thresholds. Kept in one module so the view plugin, tests, and
 * the later large-file task cannot drift into separate magic numbers.
 *
 * `MAX_FILE_BYTES` deliberately does not live here: Rust owns the 10MiB
 * read/write limit, while this module only decides whether preview decoration
 * is affordable.
 */
export const LP_MAX_UNITS = 2_000_000;
export const SYNTAX_TREE_BUDGET_MS = 8;
export const MAX_LINE_UNITS = 10_000;
