import { describe, expect, it } from "vitest";

import i18n, { resources } from "./index";

type ResourceTree = { [key: string]: string | ResourceTree };

const PLURAL_SUFFIXES = ["zero", "one", "two", "few", "many", "other"] as const;
const EXPECTED_BASES = ["logs.files", "logs.toast.cleared"];

function flattenKeys(tree: ResourceTree, prefix = ""): string[] {
  return Object.entries(tree).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === "string" ? [path] : flattenKeys(value, path);
  });
}

function pluralBase(key: string): string | null {
  for (const suffix of PLURAL_SUFFIXES) {
    if (key.endsWith(`_${suffix}`)) {
      return key.slice(0, -(suffix.length + 1));
    }
  }
  return null;
}

function pluralCategories(keys: readonly string[], base: string): string[] {
  return keys
    .filter((key) => key.startsWith(`${base}_`))
    .map((key) => key.slice(base.length + 1))
    .filter((suffix): suffix is (typeof PLURAL_SUFFIXES)[number] =>
      (PLURAL_SUFFIXES as readonly string[]).includes(suffix),
    )
    .sort();
}

describe("i18n plural resources", () => {
  it("provides every plural category required by each language", () => {
    const zhKeys = flattenKeys(resources["zh-CN"]);
    const enKeys = flattenKeys(resources.en);

    for (const base of EXPECTED_BASES) {
      expect(zhKeys, `zh-CN missing ${base}_*`).not.toContain(base);
      expect(enKeys, `en missing ${base}_*`).not.toContain(base);

      const zhRequired = new Intl.PluralRules("zh-CN").resolvedOptions().pluralCategories;
      const enRequired = new Intl.PluralRules("en").resolvedOptions().pluralCategories;

      expect(pluralCategories(zhKeys, base), `zh-CN ${base}`).toEqual([...zhRequired].sort());
      expect(pluralCategories(enKeys, base), `en ${base}`).toEqual([...enRequired].sort());
    }

    const discoveredBases = new Set(
      [...zhKeys, ...enKeys].map(pluralBase).filter((base): base is string => base !== null),
    );
    expect([...discoveredBases].sort()).toEqual([...EXPECTED_BASES].sort());
  });

  it("resolves English singular/plural and Chinese _other at runtime", async () => {
    await i18n.changeLanguage("zh-CN");
    expect(i18n.t("logs:files", { count: 1, size: "1 KB" })).toBe("1 个文件 · 1 KB");
    expect(i18n.t("logs:toast.cleared", { count: 3 })).toBe("已删除 3 个旧日志文件");

    await i18n.changeLanguage("en");
    expect(i18n.t("logs:files", { count: 1, size: "1 KB" })).toBe("1 file · 1 KB");
    expect(i18n.t("logs:files", { count: 2, size: "2 KB" })).toBe("2 files · 2 KB");
    expect(i18n.t("logs:toast.cleared", { count: 1 })).toBe("Deleted 1 old log file");
    expect(i18n.t("logs:toast.cleared", { count: 2 })).toBe("Deleted 2 old log files");
  });
});
