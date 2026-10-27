#!/usr/bin/env node
/**
 * Verifies that every version declaration used by the desktop release agrees.
 *
 * Covered sources (8):
 *   - 5 package.json files (root, desktop, shared, editor-core, ui)
 *   - src-tauri/Cargo.toml (the `[package]` section)
 *   - src-tauri/tauri.conf.json
 *   - src-tauri/Cargo.lock (the `qingmo` package entry)
 *
 * Usage:
 *   node scripts/release/check-versions.mjs
 *   node scripts/release/check-versions.mjs --expect 0.1.0
 *   node scripts/release/check-versions.mjs --expect v0.1.0 --json
 *   node scripts/release/check-versions.mjs --root /path/to/fixture
 *
 * Exit codes: 0 = all versions agree; 1 = mismatch/read error; 2 = usage error.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, "../..");

const PACKAGE_FILES = [
  "package.json",
  "apps/desktop/package.json",
  "packages/editor-core/package.json",
  "packages/shared/package.json",
  "packages/ui/package.json",
];

function usage() {
  return [
    "Usage: node scripts/release/check-versions.mjs [--expect <semver>] [--json] [--root <dir>]",
    "",
    "  --expect <semver>  Also require every source to equal this version (accepts a leading `v`).",
    "  --json             Print a machine-readable report instead of the table.",
    "  --root <dir>       Repository root to inspect (default: two levels above this script).",
    "  -h, --help         Show this help.",
  ].join("\n");
}

function failUsage(message) {
  process.stderr.write(`check-versions: ${message}\n\n${usage()}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = { expect: null, json: false, root: DEFAULT_ROOT, help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--expect") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) failUsage("--expect requires a value");
      options.expect = normalizeVersion(value);
      index += 1;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--root") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) failUsage("--root requires a value");
      options.root = resolve(value);
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      failUsage(`unknown argument: ${arg}`);
    }
  }

  if (options.expect !== null && !SEMVER.test(options.expect)) {
    failUsage(`--expect is not a valid semver: ${options.expect}`);
  }

  return options;
}

function normalizeVersion(value) {
  return value.startsWith("v") ? value.slice(1) : value;
}

function readText(root, relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

function readJsonVersion(root, relativePath) {
  const parsed = JSON.parse(readText(root, relativePath));
  if (typeof parsed.version !== "string") {
    throw new Error("missing string `version` field");
  }
  return parsed.version;
}

function readCargoPackageVersion(root) {
  const source = readText(root, "src-tauri/Cargo.toml");
  const section = source.match(/^\[package\][ \t]*$/m);
  if (!section || section.index === undefined) {
    throw new Error("missing [package] section");
  }

  const rest = source.slice(section.index + section[0].length);
  const nextSection = rest.search(/^\[/m);
  const packageSection = nextSection === -1 ? rest : rest.slice(0, nextSection);
  const version = packageSection.match(/^version\s*=\s*"([^"]+)"/m);
  if (!version) {
    throw new Error("missing version in [package] section");
  }
  return version[1];
}

function readCargoLockVersion(root) {
  const source = readText(root, "src-tauri/Cargo.lock");
  const blocks = source.split(/^\[\[package\]\][ \t]*$/m);
  for (const block of blocks) {
    if (!/^name\s*=\s*"qingmo"[ \t]*$/m.test(block)) continue;
    const version = block.match(/^version\s*=\s*"([^"]+)"/m);
    if (!version) {
      throw new Error("qingmo package entry has no version");
    }
    return version[1];
  }
  throw new Error('no `name = "qingmo"` package entry');
}

function collectSources(root) {
  const sources = [];
  const errors = [];

  const add = (relativePath, reader) => {
    try {
      const version = reader(root, relativePath);
      sources.push({ file: relativePath, version });
    } catch (error) {
      errors.push({
        code: "READ_FAILED",
        file: relativePath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  for (const file of PACKAGE_FILES) add(file, readJsonVersion);
  add("src-tauri/Cargo.toml", readCargoPackageVersion);
  add("src-tauri/tauri.conf.json", readJsonVersion);
  add("src-tauri/Cargo.lock", readCargoLockVersion);

  return { sources, errors };
}

function checkVersions(sources, errors, expect) {
  const reference = sources[0] ?? null;
  const expected = expect ?? reference?.version ?? null;

  for (const source of sources) {
    if (expected !== null && source.version !== expected) {
      errors.push({
        code: "VERSION_MISMATCH",
        file: source.file,
        message: `${source.version} != ${expected}`,
        expected,
        actual: source.version,
      });
    }
    if (!SEMVER.test(source.version)) {
      errors.push({
        code: "INVALID_SEMVER",
        file: source.file,
        message: `not a valid semver: ${source.version}`,
        actual: source.version,
      });
    }
  }

  return {
    ok: errors.length === 0,
    expected,
    reference: reference ? { file: reference.file, version: reference.version } : null,
    sources,
    errors,
  };
}

function printHuman(report) {
  const lines = [`Version sources (${report.sources.length}):`];
  for (const source of report.sources) {
    const marker = source.version === report.expected ? "ok" : "MISMATCH";
    lines.push(`  ${source.file.padEnd(38)} ${source.version.padEnd(12)} ${marker}`);
  }

  if (report.ok) {
    lines.push(`Version check: PASS (${report.expected})`);
    process.stdout.write(`${lines.join("\n")}\n`);
    return;
  }

  lines.push("Version check: FAIL");
  for (const error of report.errors) {
    const file = error.file ? `${error.file}: ` : "";
    lines.push(`  - [${error.code}] ${file}${error.message}`);
  }
  process.stderr.write(`${lines.join("\n")}\n`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const { sources, errors } = collectSources(options.root);
  const report = checkVersions(sources, errors, options.expect);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printHuman(report);
  }

  process.exit(report.ok ? 0 : 1);
}

main();
