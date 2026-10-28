import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const HAN = /[\u4e00-\u9fff]/;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "target", ".git"]);

function walk(directory: string, result: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    if (SKIP_DIRS.has(entry)) {
      continue;
    }
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      walk(path, result);
    } else {
      result.push(path);
    }
  }
  return result;
}

function isTestFile(path: string): boolean {
  return /\.test\.(ts|tsx)$/.test(path);
}

function scan(root: string, extensions: readonly string[]): string[] {
  return walk(root).filter((path) => extensions.some((extension) => path.endsWith(extension)));
}

function hanOffenders(files: readonly string[], skip: (path: string) => boolean): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    if (skip(file)) {
      continue;
    }
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (HAN.test(line)) {
        offenders.push(`${relative(ROOT, file)}:${index + 1}`);
      }
    });
  }
  return offenders;
}

describe("single translation source", () => {
  it("keeps desktop source free of hard-coded Han outside locales", () => {
    const files = scan(join(ROOT, "apps/desktop/src"), [".ts", ".tsx"]);
    const offenders = hanOffenders(files, (path) => {
      return isTestFile(path) || path.includes(`${sep}i18n${sep}locales${sep}`);
    });

    expect(offenders).toEqual([]);
  });

  it("keeps editor-core source free of hard-coded Han", () => {
    const files = scan(join(ROOT, "packages/editor-core/src"), [".ts"]);
    const offenders = hanOffenders(files, isTestFile);

    expect(offenders).toEqual([]);
  });

  it("does not introduce a second language persistence key", () => {
    const roots = [
      join(ROOT, "apps"),
      join(ROOT, "packages"),
      join(ROOT, "src-tauri/src"),
      join(ROOT, "e2e"),
    ];
    const offenders = roots
      .flatMap((root) => scan(root, [".ts", ".tsx", ".rs"]))
      .filter((path) => !isTestFile(path))
      .filter((path) => readFileSync(path, "utf8").includes("i18nextLng"));

    expect(offenders).toEqual([]);
  });
});
