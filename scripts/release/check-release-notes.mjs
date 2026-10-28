#!/usr/bin/env node
/**
 * Validates that the version being released has bilingual release notes in
 * resources/notes.json, and optionally renders them as the plain-text notes
 * that go into latest.json.
 *
 * Usage:
 *   node scripts/release/check-release-notes.mjs
 *   node scripts/release/check-release-notes.mjs --version 0.2.0
 *   node scripts/release/check-release-notes.mjs --out /tmp/notes.txt
 *   node scripts/release/check-release-notes.mjs --lang zh-CN --out /tmp/notes.txt
 *   node scripts/release/check-release-notes.mjs --json
 *
 * Exit codes: 0 = notes are complete; 1 = missing/invalid notes; 2 = usage error.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NOTES_MAX_BYTES = 100 * 1024;
const LANGUAGES = ["zh-CN", "en-US"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const RELEASE_NOTES_URL = "https://github.com/wavexzore/Qingmo/releases/tag/v";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, "../..");

function usage() {
  return [
    "Usage: node scripts/release/check-release-notes.mjs [--version <semver>] [--lang <all|zh-CN|en-US>] [--out <file>] [--json] [--root <dir>]",
    "",
    "  --version <semver>  Version to check (default: src-tauri/tauri.conf.json).",
    "  --lang <lang>       Language to render: all (default), zh-CN or en-US.",
    "  --out <file>        Write rendered plain-text notes to this file.",
    "  --json              Print a machine-readable report.",
    "  --root <dir>        Repository root to inspect (default: two levels above this script).",
    "  -h, --help          Show this help.",
  ].join("\n");
}

function failUsage(message) {
  process.stderr.write(`check-release-notes: ${message}\n\n${usage()}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = {
    version: null,
    lang: "all",
    out: null,
    json: false,
    root: DEFAULT_ROOT,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--version") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) failUsage("--version requires a value");
      options.version = value.startsWith("v") ? value.slice(1) : value;
      index += 1;
    } else if (arg === "--lang") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) failUsage("--lang requires a value");
      if (value !== "all" && !LANGUAGES.includes(value)) {
        failUsage(`--lang must be all, ${LANGUAGES.join(" or ")}`);
      }
      options.lang = value;
      index += 1;
    } else if (arg === "--out") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) failUsage("--out requires a value");
      options.out = resolve(value);
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

  if (options.version !== null && !SEMVER.test(options.version)) {
    failUsage(`--version is not a valid semver: ${options.version}`);
  }

  return options;
}

function readVersion(root, version) {
  if (version !== null) return version;
  const config = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
  if (typeof config.version !== "string") {
    throw new Error("src-tauri/tauri.conf.json has no string `version`");
  }
  return config.version;
}

function collectNotes(root, version) {
  const errors = [];
  const file = "resources/notes.json";
  let parsed;

  try {
    parsed = JSON.parse(readFileSync(join(root, file), "utf8"));
  } catch (error) {
    const code = error?.code === "ENOENT" ? "FILE_MISSING" : "PARSE_FAILED";
    return { file, entry: null, errors: [{ code, file, message: error.message }] };
  }

  if (
    typeof parsed?.releaseNotesUrl !== "string" ||
    !parsed.releaseNotesUrl.startsWith(RELEASE_NOTES_URL)
  ) {
    errors.push({
      code: "URL_INVALID",
      file,
      message: `releaseNotesUrl must start with ${RELEASE_NOTES_URL}`,
    });
  }
  if (!Array.isArray(parsed?.versions)) {
    errors.push({ code: "VERSIONS_MISSING", file, message: "missing `versions` array" });
    return { file, entry: null, errors };
  }

  const matches = parsed.versions.filter((item) => item?.version === version);
  if (matches.length === 0) {
    errors.push({ code: "NO_ENTRY", file, message: `no entry for version ${version}` });
    return { file, entry: null, errors };
  }
  if (matches.length > 1) {
    errors.push({
      code: "DUPLICATE_ENTRY",
      file,
      message: `${matches.length} entries for version ${version}`,
    });
  }

  const entry = matches[0];
  if (typeof entry.date !== "string" || !DATE.test(entry.date)) {
    errors.push({ code: "DATE_INVALID", file, message: "`date` must be YYYY-MM-DD" });
  }
  for (const language of LANGUAGES) {
    const notes = entry.notes?.[language];
    if (!Array.isArray(notes) || notes.length === 0) {
      errors.push({
        code: "LANG_MISSING",
        file,
        message: `notes.${language} must be a non-empty array`,
      });
      continue;
    }
    notes.forEach((note, index) => {
      if (typeof note !== "string" || note.trim() === "") {
        errors.push({ code: "NOTE_EMPTY", file, message: `notes.${language}[${index}] is empty` });
      }
    });
  }

  return { file, entry, errors };
}

function render(entry, lang) {
  const lines = [`青墨 ${entry.version} (${entry.date})`];
  const languages = lang === "all" ? LANGUAGES : [lang];
  for (const language of languages) {
    const heading = language === "zh-CN" ? "中文" : "English";
    lines.push("", `[${language}]`, heading);
    for (const note of entry.notes[language]) lines.push(`- ${note.trim()}`);
  }
  return `${lines.join("\n")}\n`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  let version;
  try {
    version = readVersion(options.root, options.version);
  } catch (error) {
    process.stderr.write(`check-release-notes: ${error.message}\n`);
    process.exit(1);
  }

  const { file, entry, errors } = collectNotes(options.root, version);
  let rendered = null;
  if (errors.length === 0) {
    rendered = render(entry, options.lang);
    const bytes = Buffer.byteLength(rendered, "utf8");
    if (bytes > NOTES_MAX_BYTES) {
      errors.push({
        code: "NOTES_TOO_LARGE",
        file,
        message: `${bytes} bytes > ${NOTES_MAX_BYTES} bytes`,
      });
    }
  }

  const report = {
    ok: errors.length === 0,
    version,
    file,
    languages: entry?.notes ? Object.keys(entry.notes) : [],
    errors,
  };

  if (errors.length === 0 && options.out) {
    writeFileSync(options.out, rendered, "utf8");
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (report.ok) {
    const counts = LANGUAGES.map((language) => `${language} ${entry.notes[language].length}`).join(
      " / ",
    );
    process.stdout.write(`Release notes check: PASS (${version}; ${counts})\n`);
  } else {
    process.stderr.write(`Release notes check: FAIL (${version})\n`);
    for (const error of errors) {
      process.stderr.write(`  - [${error.code}] ${error.file}: ${error.message}\n`);
    }
  }

  process.exit(report.ok ? 0 : 1);
}

main();
