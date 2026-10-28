import { describe, expect, it } from "vitest";

import { resources } from "./index";
import { buildNativeShellLabels } from "./native";

describe("native shell labels", () => {
  it("projects every menu field for both languages without placeholders", () => {
    for (const language of ["zh-CN", "en"] as const) {
      const labels = buildNativeShellLabels(language);
      for (const [field, value] of Object.entries(labels)) {
        expect(value.trim(), `${language}.${field}`).not.toBe("");
        expect(value, `${language}.${field}`).not.toContain("{{");
      }
    }

    expect(buildNativeShellLabels("zh-CN").appName).toBe("青墨");
    expect(buildNativeShellLabels("en").appName).toBe("Qingmo");
    expect(buildNativeShellLabels("zh-CN").about).toContain("青墨");
    expect(buildNativeShellLabels("en").about).toContain("Qingmo");
  });

  it("keeps the untitled file name a strict Markdown name", () => {
    expect(buildNativeShellLabels("zh-CN").untitledFileName).toBe("未命名.md");
    expect(buildNativeShellLabels("en").untitledFileName).toBe("Untitled.md");
  });

  it("keeps language endonyms identical across languages", () => {
    for (const language of ["zh-CN", "en"] as const) {
      const labels = buildNativeShellLabels(language);
      expect(labels.languageZhCN).toBe("简体中文");
      expect(labels.languageEn).toBe("English");
    }
  });

  it("keeps every native field backed by a menu resource key", () => {
    for (const language of ["zh-CN", "en"] as const) {
      const labels = buildNativeShellLabels(language);
      const fields = Object.keys(labels)
        .filter((field) => field !== "appName")
        .sort();
      const menuKeys = Object.keys(resources[language].menu).sort();

      expect(fields, language).toEqual(menuKeys);
    }
  });
});
