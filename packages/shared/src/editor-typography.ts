/**
 * Shared, DOM-free model for the editor typography preference.
 *
 * The desktop store persists this value and the editor-core package projects
 * it into a CodeMirror theme. Keeping the normalization here means both layers
 * accept exactly the same value set and cannot drift.
 */

export const EDITOR_FONT_FAMILY_IDS = ["mono", "sans", "serif"] as const;
export type EditorFontFamily = (typeof EDITOR_FONT_FAMILY_IDS)[number];

export const EDITOR_FONT_SIZE_MIN = 12;
export const EDITOR_FONT_SIZE_MAX = 30;
export const EDITOR_FONT_SIZE_DEFAULT = 15;
export const EDITOR_LINE_HEIGHT = 1.75;

export interface EditorTypography {
  readonly fontSize: number;
  readonly fontFamily: EditorFontFamily;
}

export const DEFAULT_EDITOR_TYPOGRAPHY: Readonly<EditorTypography> = Object.freeze({
  fontSize: EDITOR_FONT_SIZE_DEFAULT,
  fontFamily: "mono",
});

/** CSS values are tokens, not font stacks; the UI never accepts free-form families. */
export const EDITOR_FONT_FAMILY_CSS_VAR: Readonly<Record<EditorFontFamily, string>> = Object.freeze(
  {
    mono: "var(--qm-font-mono)",
    sans: "var(--qm-font-sans)",
    serif: "var(--qm-font-serif)",
  },
);

export function isEditorFontFamily(value: unknown): value is EditorFontFamily {
  return typeof value === "string" && EDITOR_FONT_FAMILY_IDS.includes(value as EditorFontFamily);
}

export function normalizeEditorFontSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return EDITOR_FONT_SIZE_DEFAULT;
  }
  const integer = Math.trunc(value);
  return Math.min(EDITOR_FONT_SIZE_MAX, Math.max(EDITOR_FONT_SIZE_MIN, integer));
}

/**
 * Converts any stored/unknown value into a valid frozen typography object.
 * Missing fields fall back independently; no input is allowed to escape the
 * declared range or family set.
 */
export function normalizeEditorTypography(value: unknown): EditorTypography {
  const source =
    typeof value === "object" && value !== null
      ? (value as { fontSize?: unknown; fontFamily?: unknown })
      : {};
  return Object.freeze({
    fontSize: normalizeEditorFontSize(source.fontSize),
    fontFamily: isEditorFontFamily(source.fontFamily) ? source.fontFamily : "mono",
  });
}

export function editorTypographyEquals(a: EditorTypography, b: EditorTypography): boolean {
  return a.fontSize === b.fontSize && a.fontFamily === b.fontFamily;
}
