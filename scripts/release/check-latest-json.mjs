#!/usr/bin/env node
/**
 * Validate a Tauri updater `latest.json` before a draft GitHub release is
 * published.
 *
 * The script intentionally keeps network access out of the trust decision:
 * it validates the manifest structure, binds the minisign trusted comment to
 * the expected version, and verifies the signature against the downloaded
 * artifact. `--no-network` only allows a structural lint when artifacts are
 * not available; it is never sufficient for a release gate.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const NOTES_MAX_BYTES = 100 * 1024;
const REQUIRED_PLATFORMS = ["darwin-aarch64", "darwin-x86_64"];
const PLATFORM_PATTERN = /^darwin-(aarch64|x86_64|universal(?:-[a-z0-9-]+)?)$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const ALLOWED_HOSTS = new Set([
  "api.github.com",
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

function usage() {
  console.error(`Usage:
  node scripts/release/check-latest-json.mjs \\
    --latest-json <latest.json> --tag <vX.Y.Z> \\
    --pubkey <base64-or-file> --artifacts <dir> [--no-network]

Exit codes:
  0  manifest is valid
  1  manifest is invalid or signature verification failed
`);
}

function parseArgs(argv) {
  const options = {
    latestJson: null,
    tag: null,
    pubkey: null,
    artifacts: null,
    noNetwork: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      usage();
      process.exit(0);
    }
    if (argument === "--no-network") {
      options.noNetwork = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      fail(`missing value for ${argument}`);
    }
    index += 1;
    switch (argument) {
      case "--latest-json":
        options.latestJson = value;
        break;
      case "--tag":
        options.tag = value;
        break;
      case "--pubkey":
        options.pubkey = value;
        break;
      case "--artifacts":
        options.artifacts = value;
        break;
      default:
        fail(`unknown argument: ${argument}`);
    }
  }

  if (!options.latestJson) {
    fail("--latest-json is required");
  }
  if (!options.tag) {
    fail("--tag is required");
  }
  return options;
}

function fail(message) {
  console.error(`check-latest-json: ERROR: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function readJson(filePath) {
  assert(existsSync(filePath), `latest.json does not exist: ${filePath}`);
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(
      `latest.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function validateNotes(notes) {
  assert(typeof notes === "string", "notes must be a string");
  const bytes = Buffer.byteLength(notes, "utf8");
  assert(
    bytes <= NOTES_MAX_BYTES,
    `notes is ${bytes} bytes, exceeds the ${NOTES_MAX_BYTES}-byte limit`,
  );
}

function validateNotesByLocale(value) {
  if (value === undefined) {
    return;
  }
  assert(
    value && typeof value === "object" && !Array.isArray(value),
    "notesByLocale must be an object",
  );
  const languages = Object.keys(value);
  assert(languages.length > 0, "notesByLocale is empty");
  for (const language of languages) {
    assert(
      ["zh-CN", "en-US"].includes(language),
      `unsupported notesByLocale language: ${language}`,
    );
    const text = value[language];
    assert(
      typeof text === "string" && text.trim().length > 0,
      `notesByLocale.${language} must be a non-empty string`,
    );
    const bytes = Buffer.byteLength(text, "utf8");
    assert(
      bytes <= NOTES_MAX_BYTES,
      `notesByLocale.${language} is ${bytes} bytes, exceeds the ${NOTES_MAX_BYTES}-byte limit`,
    );
  }
}

function validateDate(value) {
  assert(typeof value === "string" && value.length > 0, "pub_date must be a string");
  assert(
    /^\d{4}-\d{2}-\d{2}T/.test(value),
    `pub_date is not RFC3339-like: ${JSON.stringify(value)}`,
  );
  assert(!Number.isNaN(new Date(value).getTime()), `pub_date is not a valid date: ${value}`);
}

function decodeSignature(value, platform) {
  assert(typeof value === "string" && value.trim().length > 0, `${platform}.signature is empty`);
  assert(/^[A-Za-z0-9+/=\s]+$/.test(value), `${platform}.signature is not valid base64`);
  const decoded = Buffer.from(value, "base64").toString("utf8");
  assert(
    decoded.includes("untrusted comment:") && decoded.includes("trusted comment:"),
    `${platform}.signature is not a minisign signature file`,
  );
  return decoded;
}

function parseTrustedComment(signatureText, platform) {
  const trusted = signatureText.split("\n").find((line) => line.startsWith("trusted comment:"));
  assert(trusted, `${platform}.signature has no trusted comment`);
  return trusted;
}

function trustedField(trusted, field) {
  const match = new RegExp(`(?:^|[\\t ])${field}:([^\\t]+)`).exec(trusted);
  return match?.[1]?.trim() ?? null;
}

function validateUrl(value, tag, platform) {
  assert(typeof value === "string" && value.length > 0, `${platform}.url is empty`);
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${platform}.url is not a valid URL: ${value}`);
  }
  assert(url.protocol === "https:", `${platform}.url must use HTTPS: ${value}`);
  assert(
    url.port === "" || url.port === "443",
    `${platform}.url must use the default HTTPS port: ${value}`,
  );
  assert(ALLOWED_HOSTS.has(url.hostname), `${platform}.url host is not allowed: ${url.hostname}`);
  const pathSegments = url.pathname.split("/").map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      fail(`${platform}.url has malformed percent-encoding: ${url.pathname}`);
    }
  });
  assert(
    !pathSegments.some((segment) => segment.startsWith("._")),
    `${platform}.url contains an AppleDouble path segment: ${url.pathname}`,
  );

  if (url.pathname.includes("/releases/download/")) {
    assert(
      url.pathname.includes(`/releases/download/${tag}/`),
      `${platform}.url does not point at tag ${tag}: ${url.pathname}`,
    );
  } else if (
    url.hostname === "api.github.com" &&
    /\/repos\/[^/]+\/[^/]+\/releases\/assets\/\d+$/.test(url.pathname)
  ) {
    // Asset-id URLs do not contain the tag. The artifact name is bound by the
    // signed trusted comment and verified against --artifacts.
  } else if (
    url.hostname === "objects.githubusercontent.com" ||
    url.hostname === "release-assets.githubusercontent.com"
  ) {
    // Signed redirect URLs from GitHub. The trusted comment still binds the
    // version and file name.
  } else {
    fail(`${platform}.url is not a recognized GitHub release asset URL: ${value}`);
  }

  return url;
}

function loadPublicKey(value) {
  assert(value, "--pubkey is required when --artifacts is provided");
  if (existsSync(value) && !value.includes("\n")) {
    return readFileSync(value, "utf8");
  }
  const decoded = Buffer.from(value, "base64").toString("utf8");
  assert(
    decoded.includes("untrusted comment:") && decoded.includes("RW"),
    "--pubkey is neither a minisign public-key file nor a base64-encoded public key",
  );
  return decoded;
}

function verifySignature({ artifactPath, signatureText, publicKey, platform }) {
  assert(existsSync(artifactPath), `${platform} artifact does not exist: ${artifactPath}`);
  const stats = lstatSync(artifactPath);
  assert(stats.isFile() && !stats.isSymbolicLink(), `${platform} artifact is not a regular file`);
  assert(stats.size > 0, `${platform} artifact is empty: ${artifactPath}`);

  const temp = mkdtempSync(path.join(tmpdir(), "qingmo-latest-json-"));
  try {
    const signaturePath = path.join(temp, "signature");
    const publicKeyPath = path.join(temp, "public-key");
    writeFileSync(signaturePath, signatureText, { mode: 0o600 });
    writeFileSync(publicKeyPath, publicKey, { mode: 0o600 });

    const result = spawnSync(
      "minisign",
      ["-V", "-m", artifactPath, "-x", signaturePath, "-p", publicKeyPath],
      { encoding: "utf8" },
    );
    if (result.error) {
      fail(`minisign is not available: ${result.error.message}`);
    }
    if (result.status !== 0) {
      fail(
        `${platform} minisign verification failed for ${artifactPath}: ${(result.stderr || result.stdout || "").trim()}`,
      );
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const expectedVersion = options.tag.replace(/^v/, "");
  assert(VERSION_PATTERN.test(expectedVersion), `tag is not a semver version: ${options.tag}`);

  const manifest = readJson(options.latestJson);
  assert(
    manifest && typeof manifest === "object" && !Array.isArray(manifest),
    "latest.json must be an object",
  );
  assert(
    typeof manifest.version === "string" && VERSION_PATTERN.test(manifest.version),
    `latest.json version is invalid: ${JSON.stringify(manifest.version)}`,
  );
  assert(
    manifest.version === expectedVersion,
    `latest.json version ${manifest.version} does not match tag ${options.tag}`,
  );
  validateDate(manifest.pub_date);
  validateNotes(manifest.notes);
  validateNotesByLocale(manifest.notesByLocale);

  const platforms = manifest.platforms;
  assert(
    platforms && typeof platforms === "object" && !Array.isArray(platforms),
    "latest.json platforms must be an object",
  );
  const platformNames = Object.keys(platforms);
  assert(platformNames.length > 0, "latest.json platforms is empty");
  for (const platform of platformNames) {
    assert(PLATFORM_PATTERN.test(platform), `unsupported platform key: ${platform}`);
  }
  for (const platform of REQUIRED_PLATFORMS) {
    assert(
      platformNames.includes(platform),
      `latest.json is missing required platform: ${platform}`,
    );
  }

  const artifacts = options.artifacts;
  if (!artifacts && !options.noNetwork) {
    fail(
      "--artifacts is required for signature verification (or pass --no-network for structure-only)",
    );
  }
  const publicKey = artifacts ? loadPublicKey(options.pubkey) : null;

  for (const platform of platformNames) {
    const entry = platforms[platform];
    assert(
      entry && typeof entry === "object" && !Array.isArray(entry),
      `${platform} entry must be an object`,
    );
    const url = validateUrl(entry.url, options.tag, platform);
    const signatureText = decodeSignature(entry.signature, platform);
    const trusted = parseTrustedComment(signatureText, platform);

    const signedVersion = trustedField(trusted, "version");
    assert(signedVersion, `${platform}.signature trusted comment has no version`);
    assert(
      signedVersion === manifest.version,
      `${platform} signed version ${signedVersion} does not match manifest version ${manifest.version}`,
    );

    const signedFile = trustedField(trusted, "file");
    assert(signedFile, `${platform}.signature trusted comment has no file`);
    const artifactName = path.basename(signedFile);
    assert(
      artifactName.length > 0 && !artifactName.startsWith("._"),
      `${platform} artifact name is unsafe: ${signedFile}`,
    );
    const urlBase = decodeURIComponent(path.posix.basename(url.pathname));
    if (urlBase && !/^\d+$/.test(urlBase) && urlBase !== "latest.json") {
      assert(
        urlBase === artifactName,
        `${platform}.url artifact ${urlBase} does not match signed file ${artifactName}`,
      );
    }
    assert(
      !artifactName.startsWith("._"),
      `${platform} artifact is an AppleDouble file: ${artifactName}`,
    );

    if (artifacts) {
      verifySignature({
        artifactPath: path.join(artifacts, artifactName),
        signatureText,
        publicKey,
        platform,
      });
    }
  }

  const mode = artifacts ? "signatures verified" : "structure only";
  console.log(
    `check-latest-json: PASS (${manifest.version}, ${platformNames.join(", ")}, ${mode})`,
  );
}

main();
