import { describe, expect, it } from "vitest";

import {
  DEFAULT_LANGUAGE,
  SUPPORTED_LANGUAGES,
  isSupportedLanguage,
  normalizeLanguage,
} from "./language";

const UNSUPPORTED_VALUES = ["en-US", "zh", "EN", "En", "", "fr", null, undefined, 0] as const;

describe("language policy", () => {
  it("defines exactly the supported languages and the zh-CN default", () => {
    expect(SUPPORTED_LANGUAGES).toEqual(["zh-CN", "en"]);
    expect(DEFAULT_LANGUAGE).toBe("zh-CN");
  });

  it("accepts only exact supported wire values", () => {
    expect(isSupportedLanguage("zh-CN")).toBe(true);
    expect(isSupportedLanguage("en")).toBe(true);

    for (const value of UNSUPPORTED_VALUES) {
      expect(isSupportedLanguage(value), `value ${String(value)}`).toBe(false);
    }
  });

  it("normalizes unsupported values to zh-CN without writing them back", () => {
    expect(normalizeLanguage("zh-CN")).toBe("zh-CN");
    expect(normalizeLanguage("en")).toBe("en");

    for (const value of UNSUPPORTED_VALUES) {
      expect(normalizeLanguage(value), `value ${String(value)}`).toBe("zh-CN");
    }
  });
});
