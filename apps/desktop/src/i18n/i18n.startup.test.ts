import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const LANGUAGE_KEY = "qingmo.ui.language";

beforeEach(() => {
  window.localStorage.clear();
  vi.resetModules();
});

afterEach(() => {
  window.localStorage.clear();
  vi.resetModules();
});

describe("i18n startup language", () => {
  it("uses the persisted supported language", async () => {
    window.localStorage.setItem(LANGUAGE_KEY, "en");

    const { default: i18n } = await import("./index");

    expect(i18n.language).toBe("en");
    expect(i18n.t("common:appName")).toBe("Qingmo");
  });

  it("falls back to zh-CN for an invalid persisted value", async () => {
    window.localStorage.setItem(LANGUAGE_KEY, "en-US");

    const { default: i18n } = await import("./index");

    expect(i18n.language).toBe("zh-CN");
    expect(i18n.t("common:appName")).toBe("青墨");
  });
});
