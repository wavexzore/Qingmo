import { describe, expect, it } from "vitest";

import i18n, { resources } from "./index";

type ResourceTree = { [key: string]: string | ResourceTree };

const EXPECTED_NAMESPACES = [
  "common",
  "editor",
  "errors",
  "commands",
  "update",
  "about",
  "settings",
  "logs",
  "menu",
] as const;

function flattenKeys(tree: ResourceTree, prefix = ""): string[] {
  return Object.entries(tree).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === "string" ? [path] : flattenKeys(value, path);
  });
}

function flattenLeaves(tree: ResourceTree, prefix = ""): Map<string, string> {
  const leaves = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      leaves.set(path, value);
    } else {
      for (const [child, childValue] of flattenLeaves(value, path)) {
        leaves.set(child, childValue);
      }
    }
  }
  return leaves;
}

const PLURAL_SUFFIXES = ["zero", "one", "two", "few", "many", "other"] as const;

/** Collapses `key_one`/`key_other` to `key` so zh may omit `_one`. */
function pluralBase(key: string): string {
  for (const suffix of PLURAL_SUFFIXES) {
    if (key.endsWith(`_${suffix}`)) {
      return key.slice(0, -(suffix.length + 1));
    }
  }
  return key;
}

function normalizedLeaves(tree: ResourceTree): Map<string, string> {
  const leaves = new Map<string, string>();
  for (const [key, value] of flattenLeaves(tree)) {
    const base = pluralBase(key);
    if (!leaves.has(base) || key.endsWith("_other")) {
      leaves.set(base, value);
    }
  }
  return leaves;
}

function placeholders(value: string): string[] {
  return [...value.matchAll(/{{\s*([^}]+?)\s*}}/g)]
    .map((match) => match[1]?.trim())
    .filter((name): name is string => Boolean(name))
    .sort();
}

describe("i18n resources", () => {
  it("keeps zh-CN and en key sets aligned in every namespace", () => {
    const namespaces = Object.keys(resources["zh-CN"]).sort();
    expect(namespaces).toEqual([...EXPECTED_NAMESPACES].sort());

    const zhNamespaces = resources["zh-CN"] as Record<string, ResourceTree>;
    const enNamespaces = resources.en as Record<string, ResourceTree>;
    for (const namespace of namespaces) {
      const zh = [...new Set(flattenKeys(zhNamespaces[namespace]!).map(pluralBase))].sort();
      const en = [...new Set(flattenKeys(enNamespaces[namespace]!).map(pluralBase))].sort();
      expect(en, `namespace ${namespace}`).toEqual(zh);
    }
  });

  it("keeps interpolation placeholders identical across languages", () => {
    const zh = normalizedLeaves(resources["zh-CN"]);
    const en = normalizedLeaves(resources.en);

    for (const [key, value] of zh) {
      expect(placeholders(en.get(key) ?? ""), `placeholders for ${key}`).toEqual(
        placeholders(value),
      );
    }

    expect(zh.get("menu.about")).toContain("{{appName}}");
    expect(en.get("menu.about")).toContain("{{appName}}");
  });

  it("uses zh-CN by default and switches to en", async () => {
    await i18n.changeLanguage("zh-CN");
    expect(i18n.t("common:appName")).toBe("青墨");
    expect(document.documentElement.lang).toBe("zh-CN");

    await i18n.changeLanguage("en");
    expect(i18n.t("common:appName")).toBe("Qingmo");
    expect(document.documentElement.lang).toBe("en");
    expect(i18n.t("errors:BUSY")).toBe(
      "The previous operation is still running. Try again shortly.",
    );

    await i18n.changeLanguage("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
  });
});
