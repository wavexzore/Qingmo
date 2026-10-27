#!/usr/bin/env bash
# Positive/negative fixtures for scripts/release/make-latest-json.mjs.
# Requires minisign on PATH. Never touches the real release key or network.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
make_script="$root/scripts/release/make-latest-json.mjs"
check_script="$root/scripts/release/check-latest-json.mjs"
tmp="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT

minisign -G -f -p "$tmp/test.pub" -s "$tmp/test.key" -W >/dev/null
artifact="$tmp/Qingmo.app.tar.gz"
printf 'fixture-artifact' >"$artifact"
minisign -S -s "$tmp/test.key" -m "$artifact" -x "$tmp/minisign.sig" \
  -t $'file:Qingmo.app.tar.gz\tversion:0.1.0' >/dev/null
node -e 'process.stdout.write(Buffer.from(require("fs").readFileSync(process.argv[1])).toString("base64"))' \
  "$tmp/minisign.sig" >"$artifact.sig"
cp "$artifact.sig" "$tmp/good.sig"

base_url="https://github.com/wavexzore/Qingmo/releases/download/v0.1.0"

expect_fail() {
  local name="$1"
  local message="$2"
  shift 2
  if "$@" >"$tmp/out" 2>"$tmp/err"; then
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

node "$make_script" \
  --version 0.1.0 \
  --artifacts "$tmp" \
  --out "$tmp/latest.json" \
  --base-url "$base_url" \
  --notes "fixture notes" >/dev/null
node -e '
const fs = require("fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const signature = fs.readFileSync(process.argv[2], "utf8").trim();
const baseUrl = process.argv[3];
if (manifest.version !== "0.1.0") throw new Error("wrong version");
if (manifest.notes !== "fixture notes") throw new Error("wrong notes");
if (Number.isNaN(new Date(manifest.pub_date).getTime())) throw new Error("wrong pub_date");
const keys = Object.keys(manifest.platforms);
if (keys.length !== 2) throw new Error(`wrong platform count: ${keys.length}`);
for (const key of ["darwin-aarch64", "darwin-x86_64"]) {
  const platform = manifest.platforms[key];
  if (!platform) throw new Error(`missing ${key}`);
  if (platform.signature !== signature) throw new Error(`wrong signature for ${key}`);
  if (platform.url !== `${baseUrl}/Qingmo.app.tar.gz`) {
    throw new Error(`wrong url for ${key}: ${platform.url}`);
  }
}
' "$tmp/latest.json" "$artifact.sig" "$base_url"
echo "PASS: generated manifest"

node "$check_script" \
  --latest-json "$tmp/latest.json" \
  --tag v0.1.0 \
  --pubkey "$tmp/test.pub" \
  --artifacts "$tmp" >/dev/null
echo "PASS: generated manifest verifies"

expect_fail "version mismatch" "does not match signature version" \
  node "$make_script" --version 0.2.0 --artifacts "$tmp" --out "$tmp/bad.json" --base-url "$base_url"

expect_fail "non-HTTPS base URL" "must use HTTPS" \
  node "$make_script" --version 0.1.0 --artifacts "$tmp" --out "$tmp/bad.json" \
  --base-url "http://github.com/wavexzore/Qingmo/releases/download/v0.1.0"

node -e 'require("fs").writeFileSync(process.argv[1], "x".repeat(100 * 1024 + 1))' "$tmp/large-notes.txt"
expect_fail "notes byte limit" "exceeds the" \
  node "$make_script" --version 0.1.0 --artifacts "$tmp" --out "$tmp/bad.json" \
  --base-url "$base_url" --notes-file "$tmp/large-notes.txt"

mv "$artifact.sig" "$tmp/missing.sig"
expect_fail "missing signature" "missing signature" \
  node "$make_script" --version 0.1.0 --artifacts "$tmp" --out "$tmp/bad.json" --base-url "$base_url"
mv "$tmp/missing.sig" "$artifact.sig"

printf 'not-a-signature' >"$tmp/not-minisign.sig"
cp "$tmp/not-minisign.sig" "$artifact.sig"
expect_fail "non-minisign signature" "not a base64 minisign signature" \
  node "$make_script" --version 0.1.0 --artifacts "$tmp" --out "$tmp/bad.json" --base-url "$base_url"
cp "$tmp/good.sig" "$artifact.sig"

minisign -S -s "$tmp/test.key" -m "$artifact" -x "$tmp/no-version.sig" >/dev/null
node -e 'process.stdout.write(Buffer.from(require("fs").readFileSync(process.argv[1])).toString("base64"))' \
  "$tmp/no-version.sig" >"$artifact.sig"
expect_fail "missing signed version" "has no signed version" \
  node "$make_script" --version 0.1.0 --artifacts "$tmp" --out "$tmp/bad.json" --base-url "$base_url"
cp "$tmp/good.sig" "$artifact.sig"

mkdir -p "$tmp/empty"
expect_fail "no updater tarball" "expected exactly one" \
  node "$make_script" --version 0.1.0 --artifacts "$tmp/empty" --out "$tmp/bad.json" --base-url "$base_url"

echo "make-latest-json negative fixtures: PASS"
