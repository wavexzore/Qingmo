import { describe, expect, it } from "vitest";

import {
  DEFAULT_EDITOR_TYPOGRAPHY,
  EDITOR_FONT_FAMILY_CSS_VAR,
  EDITOR_FONT_SIZE_DEFAULT,
  EDITOR_FONT_SIZE_MAX,
  EDITOR_FONT_SIZE_MIN,
  editorTypographyEquals,
  isEditorFontFamily,
  normalizeEditorFontSize,
  normalizeEditorTypography,
} from "./editor-typography";

describe("editor typography model", () => {
  it("exposes the current editor defaults", () => {
    expect(DEFAULT_EDITOR_TYPOGRAPHY).toEqual({ fontSize: 15, fontFamily: "mono" });
    expect(EDITOR_FONT_SIZE_DEFAULT).toBe(15);
    expect(EDITOR_FONT_SIZE_MIN).toBe(12);
    expect(EDITOR_FONT_SIZE_MAX).toBe(30);
    expect(Object.isFrozen(DEFAULT_EDITOR_TYPOGRAPHY)).toBe(true);
  });

  it("accepts only the three design-system font families", () => {
    expect(isEditorFontFamily("mono")).toBe(true);
    expect(isEditorFontFamily("sans")).toBe(true);
    expect(isEditorFontFamily("serif")).toBe(true);
    expect(isEditorFontFamily("system-ui")).toBe(false);
    expect(isEditorFontFamily(null)).toBe(false);
    expect(EDITOR_FONT_FAMILY_CSS_VAR.mono).toBe("var(--qm-font-mono)");
    expect(EDITOR_FONT_FAMILY_CSS_VAR.sans).toBe("var(--qm-font-sans)");
    expect(EDITOR_FONT_FAMILY_CSS_VAR.serif).toBe("var(--qm-font-serif)");
  });

  it("truncates and clamps finite sizes and rejects non-numbers", () => {
    expect(normalizeEditorFontSize(15.9)).toBe(15);
    expect(normalizeEditorFontSize(1)).toBe(12);
    expect(normalizeEditorFontSize(99)).toBe(30);
    expect(normalizeEditorFontSize(Number.NaN)).toBe(15);
    expect(normalizeEditorFontSize(Number.POSITIVE_INFINITY)).toBe(15);
    expect(normalizeEditorFontSize("20")).toBe(15);
    expect(normalizeEditorFontSize(null)).toBe(15);
  });

  it("normalizes unknown objects independently per field and is idempotent", () => {
    const value = normalizeEditorTypography({ fontSize: 22.8, fontFamily: "serif", extra: true });
    expect(value).toEqual({ fontSize: 22, fontFamily: "serif" });
    expect(Object.isFrozen(value)).toBe(true);
    expect(normalizeEditorTypography(value)).toEqual(value);

    expect(normalizeEditorTypography(null)).toEqual(DEFAULT_EDITOR_TYPOGRAPHY);
    expect(normalizeEditorTypography({ fontSize: 10, fontFamily: "comic" })).toEqual({
      fontSize: 12,
      fontFamily: "mono",
    });
    expect(normalizeEditorTypography("not-an-object")).toEqual(DEFAULT_EDITOR_TYPOGRAPHY);
  });

  it("compares values rather than object identity", () => {
    expect(
      editorTypographyEquals(
        { fontSize: 20, fontFamily: "sans" },
        { fontSize: 20, fontFamily: "sans" },
      ),
    ).toBe(true);
    expect(
      editorTypographyEquals(
        { fontSize: 20, fontFamily: "sans" },
        { fontSize: 20, fontFamily: "serif" },
      ),
    ).toBe(false);
  });
});
