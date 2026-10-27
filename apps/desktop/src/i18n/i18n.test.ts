import { describe, expect, it } from "vitest";

import i18n, { resources } from "./index";

type ResourceTree = { [key: string]: string | ResourceTree };

function flattenKeys(tree: ResourceTree, prefix = ""): string[] {
  return Object.entries(tree).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === "string" ? [path] : flattenKeys(value, path);
  });
}

describe("i18n resources", () => {
  it("keeps zh-CN and en key sets aligned in every namespace", () => {
    for (const namespace of ["common", "editor", "errors", "commands", "update"] as const) {
      const zh = flattenKeys(resources["zh-CN"][namespace]).sort();
      const en = flattenKeys(resources.en[namespace]).sort();
      expect(en, `namespace ${namespace}`).toEqual(zh);
    }
  });

  it("covers every AppError code", () => {
    const codes = Object.keys(resources["zh-CN"].errors);
    expect(codes).toHaveLength(19);
    expect(codes).toEqual(Object.keys(resources.en.errors));

    for (const code of codes) {
      expect(i18n.t(`errors:${code}`)).not.toBe(`errors:${code}`);
    }
  });

  it("uses zh-CN by default and switches to en", async () => {
    await i18n.changeLanguage("zh-CN");
    expect(i18n.t("common:appName")).toBe("青墨");

    await i18n.changeLanguage("en");
    expect(i18n.t("common:appName")).toBe("Qingmo");
    expect(i18n.t("errors:BUSY")).toBe(
      "The previous operation is still running. Try again shortly.",
    );

    await i18n.changeLanguage("zh-CN");
  });
});
