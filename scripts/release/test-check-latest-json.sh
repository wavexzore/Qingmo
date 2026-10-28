#!/usr/bin/env bash
# Positive/negative fixtures for scripts/release/check-latest-json.mjs.
# Requires minisign on PATH. Never touches the real release key or network.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$root/scripts/release/check-latest-json.mjs"
tmp="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT

minisign -G -f -p "$tmp/test.pub" -s "$tmp/test.key" -W >/dev/null
artifact="$tmp/Qingmo.app.tar.gz"
printf 'fixture-artifact' >"$artifact"
minisign -S -s "$tmp/test.key" -m "$artifact" -x "$tmp/Qingmo.app.tar.gz.sig" \
  -t $'file:Qingmo.app.tar.gz\tversion:0.1.0' >/dev/null
signature="$(node -e 'process.stdout.write(Buffer.from(require("fs").readFileSync(process.argv[1])).toString("base64"))' "$tmp/Qingmo.app.tar.gz.sig")"
printf 'different-artifact' >"$tmp/other-artifact"
minisign -S -s "$tmp/test.key" -m "$tmp/other-artifact" -x "$tmp/other.sig" \
  -t $'file:Qingmo.app.tar.gz\tversion:0.1.0' >/dev/null
other_signature="$(node -e 'process.stdout.write(Buffer.from(require("fs").readFileSync(process.argv[1])).toString("base64"))' "$tmp/other.sig")"

write_manifest() {
  local variant="${1:-ok}"
  local signature_value="${2:-$signature}"
  VARIANT="$variant" SIGNATURE="$signature_value" OUT="$tmp/latest.json" node <<'NODE'
const fs = require("fs");
const variant = process.env.VARIANT;
const signature = process.env.SIGNATURE;
const version = variant === "bad-version" ? "0.2.0" : "0.1.0";
const url =
  variant === "appledouble"
    ? "https://github.com/wavexzore/Qingmo/releases/download/v0.1.0/._Qingmo.app.tar.gz"
    : "https://github.com/wavexzore/Qingmo/releases/download/v0.1.0/Qingmo.app.tar.gz";
const platforms = {
  "darwin-aarch64": { signature, url },
  "darwin-x86_64": { signature, url },
};
if (variant === "windows") {
  platforms["freebsd-x86_64"] = { signature, url };
}
const manifest = {
  version,
  notes: variant === "notes" ? "x".repeat(100 * 1024 + 1) : "fixture notes",
  pub_date: "2026-10-27T12:00:00Z",
  platforms,
};
if (variant === "locale") {
  manifest.notesByLocale = { "zh-CN": "中文", "en-US": "English" };
} else if (variant === "locale-empty") {
  manifest.notesByLocale = { "zh-CN": "" };
} else if (variant === "locale-key") {
  manifest.notesByLocale = { fr: "French" };
}
fs.writeFileSync(process.env.OUT, JSON.stringify(manifest, null, 2));
NODE
}

expect_pass() {
  local name="$1"
  shift
  if ! node "$script" "$@" >"$tmp/out" 2>"$tmp/err"; then
    echo "FAIL: expected pass: $name" >&2
    cat "$tmp/out" "$tmp/err" >&2
    exit 1
  fi
  echo "PASS: $name"
}

expect_fail() {
  local name="$1"
  local message="$2"
  shift 2
  if node "$script" "$@" >"$tmp/out" 2>"$tmp/err"; then
    echo "FAIL: expected failure: $name" >&2
    cat "$tmp/out" "$tmp/err" >&2
    exit 1
  fi
  if ! grep -q -- "$message" "$tmp/err"; then
    echo "FAIL: expected message '$message' for $name" >&2
    cat "$tmp/err" >&2
    exit 1
  fi
  echo "PASS: $name"
}

write_manifest ok
expect_pass "valid manifest" \
  --latest-json "$tmp/latest.json" --tag v0.1.0 --pubkey "$tmp/test.pub" --artifacts "$tmp"

expect_pass "structure-only lint" \
  --latest-json "$tmp/latest.json" --tag v0.1.0 --no-network

win_artifact="$tmp/Qingmo_0.1.0_x64-setup.exe"
printf 'windows-artifact' >"$win_artifact"
minisign -S -s "$tmp/test.key" -m "$win_artifact" -x "$tmp/win.sig" \
  -t $'file:Qingmo_0.1.0_x64-setup.exe\tversion:0.1.0' >/dev/null
win_signature="$(node -e 'process.stdout.write(Buffer.from(require("fs").readFileSync(process.argv[1])).toString("base64"))' "$tmp/win.sig")"

linux_artifact="$tmp/Qingmo_0.1.0_amd64.AppImage"
printf 'linux-artifact' >"$linux_artifact"
minisign -S -s "$tmp/test.key" -m "$linux_artifact" -x "$tmp/linux.sig" \
  -t $'file:Qingmo_0.1.0_amd64.AppImage\tversion:0.1.0' >/dev/null
linux_signature="$(node -e 'process.stdout.write(Buffer.from(require("fs").readFileSync(process.argv[1])).toString("base64"))' "$tmp/linux.sig")"

DARWIN_SIGNATURE="$signature" WIN_SIGNATURE="$win_signature" LINUX_SIGNATURE="$linux_signature" \
  OUT="$tmp/multi.json" node <<'NODE'
const fs = require("fs");
const base = "https://github.com/wavexzore/Qingmo/releases/download/v0.1.0";
const manifest = {
  version: "0.1.0",
  notes: "fixture notes",
  pub_date: "2026-10-27T12:00:00Z",
  platforms: {
    "darwin-aarch64": { signature: process.env.DARWIN_SIGNATURE, url: `${base}/Qingmo.app.tar.gz` },
    "darwin-x86_64": { signature: process.env.DARWIN_SIGNATURE, url: `${base}/Qingmo.app.tar.gz` },
    "windows-x86_64": {
      signature: process.env.WIN_SIGNATURE,
      url: `${base}/Qingmo_0.1.0_x64-setup.exe`,
    },
    "linux-x86_64": {
      signature: process.env.LINUX_SIGNATURE,
      url: `${base}/Qingmo_0.1.0_amd64.AppImage`,
    },
  },
};
fs.writeFileSync(process.env.OUT, JSON.stringify(manifest, null, 2));
NODE

expect_pass "all-platform manifest" \
  --latest-json "$tmp/multi.json" --tag v0.1.0 --pubkey "$tmp/test.pub" --artifacts "$tmp" \
  --require darwin-aarch64,darwin-x86_64,windows-x86_64,linux-x86_64

expect_fail "missing required platform" "missing required platform: windows-x86_64" \
  --latest-json "$tmp/latest.json" --tag v0.1.0 --pubkey "$tmp/test.pub" --artifacts "$tmp" \
  --require windows-x86_64

write_manifest bad-version
expect_fail "version mismatch" "does not match tag" \
  --latest-json "$tmp/latest.json" --tag v0.1.0 --pubkey "$tmp/test.pub" --artifacts "$tmp"

write_manifest windows
expect_fail "unknown platform key" "unsupported platform key" \
  --latest-json "$tmp/latest.json" --tag v0.1.0 --pubkey "$tmp/test.pub" --artifacts "$tmp"

write_manifest appledouble
expect_fail "AppleDouble URL" "AppleDouble" \
  --latest-json "$tmp/latest.json" --tag v0.1.0 --pubkey "$tmp/test.pub" --artifacts "$tmp"

write_manifest notes
expect_fail "notes byte limit" "exceeds the" \
  --latest-json "$tmp/latest.json" --tag v0.1.0 --pubkey "$tmp/test.pub" --artifacts "$tmp"

write_manifest locale
node "$script" \
  --latest-json "$tmp/latest.json" --tag v0.1.0 --pubkey "$tmp/test.pub" --artifacts "$tmp" >/dev/null
echo "PASS: structured per-language notes"

write_manifest locale-empty
expect_fail "empty locale note" "must be a non-empty" \
  --latest-json "$tmp/latest.json" --tag v0.1.0 --pubkey "$tmp/test.pub" --artifacts "$tmp"

write_manifest locale-key
expect_fail "unsupported locale key" "unsupported notesByLocale" \
  --latest-json "$tmp/latest.json" --tag v0.1.0 --pubkey "$tmp/test.pub" --artifacts "$tmp"

write_manifest ok
mkdir -p "$tmp/empty"
expect_fail "missing artifact" "artifact does not exist" \
  --latest-json "$tmp/latest.json" --tag v0.1.0 --pubkey "$tmp/test.pub" --artifacts "$tmp/empty"

write_manifest ok "$other_signature"
expect_fail "signature does not match artifact" "minisign verification failed" \
  --latest-json "$tmp/latest.json" --tag v0.1.0 --pubkey "$tmp/test.pub" --artifacts "$tmp"

write_manifest ok
expect_fail "artifacts required" "--artifacts is required" \
  --latest-json "$tmp/latest.json" --tag v0.1.0

echo "check-latest-json negative fixtures: PASS"
