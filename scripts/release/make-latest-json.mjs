#!/usr/bin/env node
/**
 * Build a Tauri updater `latest.json` from a locally built universal macOS
 * bundle. The signature is the content of the generated `.sig` file; Tauri
 * requires this exact value, not a path or URL.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const NOTES_MAX_BYTES = 100 * 1024;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function usage() {
  console.error(`Usage:
  node scripts/release/make-latest-json.mjs \\
    --version <X.Y.Z> --artifacts <bundle/macos> --out <latest.json> \\
    [--base-url <release download base>] [--notes <text> | --notes-file <path>] \
    [--notes-zh-file <path> --notes-en-file <path>]

The release URL defaults to:
  https://github.com/wavexzore/Qingmo/releases/download/v<version>
`);
}

function fail(message) {
  console.error(`make-latest-json: ERROR: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    version: null,
    artifacts: null,
    out: null,
    baseUrl: null,
    notes: "",
    notesFile: null,
    notesZhFile: null,
    notesEnFile: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      usage();
      process.exit(0);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      fail(`missing value for ${argument}`);
    }
    index += 1;
    switch (argument) {
      case "--version":
        options.version = value;
        break;
      case "--artifacts":
        options.artifacts = value;
        break;
      case "--out":
        options.out = value;
        break;
      case "--base-url":
        options.baseUrl = value.replace(/\/+$/, "");
        break;
      case "--notes":
        options.notes = value;
        break;
      case "--notes-file":
        options.notesFile = value;
        break;
      case "--notes-zh-file":
        options.notesZhFile = value;
        break;
      case "--notes-en-file":
        options.notesEnFile = value;
        break;
      default:
        fail(`unknown argument: ${argument}`);
    }
  }

  if (!options.version) {
    fail("--version is required");
  }
  if (!VERSION_PATTERN.test(options.version)) {
    fail(`--version is not semver: ${options.version}`);
  }
  if (!options.artifacts) {
    fail("--artifacts is required");
  }
  if (!options.out) {
    fail("--out is required");
  }
  if (options.notes && options.notesFile) {
    fail("--notes and --notes-file are mutually exclusive");
  }
  if (Boolean(options.notesZhFile) !== Boolean(options.notesEnFile)) {
    fail("--notes-zh-file and --notes-en-file must be provided together");
  }
  if ((options.notes || options.notesFile) && options.notesZhFile) {
    fail("--notes-file is mutually exclusive with the per-language notes files");
  }
  return options;
}

function validateHttpsBase(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`--base-url is not a valid URL: ${value}`);
  }
  if (url.protocol !== "https:") {
    fail(`--base-url must use HTTPS: ${value}`);
  }
  if (url.search || url.hash) {
    fail(`--base-url must not contain a query or fragment: ${value}`);
  }
  return value.replace(/\/+$/, "");
}

function findUpdaterArtifact(artifacts) {
  if (!existsSync(artifacts) || !statSync(artifacts).isDirectory()) {
    fail(`artifacts directory does not exist: ${artifacts}`);
  }
  const candidates = readdirSync(artifacts).filter((name) => name.endsWith(".app.tar.gz"));
  if (candidates.length !== 1) {
    fail(
      `expected exactly one *.app.tar.gz in ${artifacts}, found ${candidates.length}: ${candidates.join(", ") || "none"}`,
    );
  }
  const name = candidates[0];
  const tarballPath = path.join(artifacts, name);
  const signaturePath = path.join(artifacts, `${name}.sig`);
  if (!existsSync(tarballPath) || !statSync(tarballPath).isFile()) {
    fail(`updater tarball is not a regular file: ${tarballPath}`);
  }
  if (!existsSync(signaturePath) || !statSync(signaturePath).isFile()) {
    fail(`missing signature: ${signaturePath}`);
  }
  return { name, tarballPath, signaturePath };
}

function readSignature(signaturePath) {
  const signature = readFileSync(signaturePath, "utf8").trim();
  if (!signature) {
    fail(`signature is empty: ${signaturePath}`);
  }
  const decoded = Buffer.from(signature, "base64").toString("utf8");
  if (!decoded.includes("untrusted comment:") || !decoded.includes("trusted comment:")) {
    fail(
      `${signaturePath} is not a base64 minisign signature; Tauri requires the .sig file content`,
    );
  }
  return { signature, decoded };
}

function readSignedVersion(decoded, signaturePath) {
  const trusted = decoded.split("\n").find((line) => line.startsWith("trusted comment:"));
  if (!trusted) {
    fail(`${signaturePath} has no minisign trusted comment`);
  }
  const match = /(?:^|[\t ])version:([^\t\s]+)/.exec(trusted);
  if (!match) {
    fail(
      `${signaturePath} has no signed version; rebuild with Tauri CLI >= 2.12 so requireSignedVersion can bind the manifest`,
    );
  }
  return match[1];
}

function readNotesFile(notesFile) {
  if (!existsSync(notesFile)) {
    fail(`notes file does not exist: ${notesFile}`);
  }
  return readFileSync(notesFile, "utf8");
}

function readNotes(options) {
  if (options.notesZhFile) {
    const zh = readNotesFile(options.notesZhFile);
    const en = readNotesFile(options.notesEnFile);
    return {
      notes: [`[zh-CN]`, zh.trim(), "", `[en-US]`, en.trim()].join("\n") + "\n",
      notesByLocale: { "zh-CN": zh, "en-US": en },
    };
  }
  return {
    notes: options.notesFile ? readNotesFile(options.notesFile) : options.notes,
    notesByLocale: null,
  };
}

const options = parseArgs(process.argv.slice(2));
const artifacts = path.resolve(options.artifacts);
const { name: tarballName, signaturePath } = findUpdaterArtifact(artifacts);
const { signature, decoded } = readSignature(signaturePath);
const signedVersion = readSignedVersion(decoded, signaturePath);
if (signedVersion !== options.version) {
  fail(
    `--version ${options.version} does not match signature version ${signedVersion} in ${signaturePath}`,
  );
}

const { notes, notesByLocale } = readNotes(options);
const notesBytes = Buffer.byteLength(notes, "utf8");
if (notesBytes > NOTES_MAX_BYTES) {
  fail(`notes is ${notesBytes} bytes, exceeds the ${NOTES_MAX_BYTES}-byte limit`);
}
if (notesByLocale) {
  for (const [language, text] of Object.entries(notesByLocale)) {
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > NOTES_MAX_BYTES) {
      fail(
        `notesByLocale.${language} is ${bytes} bytes, exceeds the ${NOTES_MAX_BYTES}-byte limit`,
      );
    }
  }
}

const baseUrl = validateHttpsBase(
  options.baseUrl ?? `https://github.com/wavexzore/Qingmo/releases/download/v${options.version}`,
);
const assetUrl = `${baseUrl}/${encodeURIComponent(tarballName)}`;
const manifest = {
  version: options.version,
  notes,
  ...(notesByLocale ? { notesByLocale } : {}),
  pub_date: new Date().toISOString(),
  platforms: {
    "darwin-aarch64": { signature, url: assetUrl },
    "darwin-x86_64": { signature, url: assetUrl },
  },
};

const outPath = path.resolve(options.out);
mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `make-latest-json: wrote ${outPath} (${options.version}, ${tarballName}, ${notesBytes} bytes notes)`,
);
