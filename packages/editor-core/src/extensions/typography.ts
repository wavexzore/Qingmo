import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  EDITOR_FONT_FAMILY_CSS_VAR,
  EDITOR_LINE_HEIGHT,
  normalizeEditorTypography,
  type EditorTypography,
} from "@qingmo/shared";

const cache = new Map<string, Extension>();

function keyOf(typography: EditorTypography): string {
  return `${typography.fontSize}:${typography.fontFamily}`;
}

/**
 * Base editor typography. This is the only place that owns the document
 * font-size, family and line-height; colours and syntax highlighting remain in
 * `themeExtension`.
 *
 * The cache is important: `EditorView.theme` creates a new style module and a
 * new theme facet prefix on every call. Reusing the same extension for the
 * same values keeps repeated layout effects cheap and, because an unchanged
 * facet does not trigger `mustMeasureContent`, callers must keep the equality
 * guard in `EditorSession.applyTypography`.
 */
export function typographyExtension(input: EditorTypography): Extension {
  const typography = normalizeEditorTypography(input);
  const key = keyOf(typography);
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const extension = EditorView.theme({
    "&": {
      fontSize: `${typography.fontSize}px`,
    },
    ".cm-scroller": {
      fontFamily: EDITOR_FONT_FAMILY_CSS_VAR[typography.fontFamily],
      lineHeight: String(EDITOR_LINE_HEIGHT),
    },
  });
  cache.set(key, extension);
  return extension;
}
