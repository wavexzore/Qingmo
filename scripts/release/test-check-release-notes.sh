#!/usr/bin/env bash
# Positive/negative fixtures for scripts/release/check-release-notes.mjs.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$root/scripts/release/check-release-notes.mjs"
tmp="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT

fixture="$tmp/repo"
mkdir -p "$fixture/src-tauri" "$fixture/resources"
printf '{"version":"0.2.0"}\n' >"$fixture/src-tauri/tauri.conf.json"

write_notes() {
  local variant="${1:-ok}"
  VARIANT="$variant" OUT="$fixture/resources/notes.json" node <<'NODE'
const fs = require("fs");
const variant = process.env.VARIANT;
const entry = {
  version: variant === "wrong-version" ? "0.1.0" : "0.2.0",
  date: variant === "bad-date" ? "2026/10/28" : "2026-10-28",
  notes: {
    "zh-CN": ["中文说明"],
    "en-US": ["English note"],
  },
};
if (variant === "no-zh") delete entry.notes["zh-CN"];
if (variant === "no-en") delete entry.notes["en-US"];
if (variant === "empty-note") entry.notes["zh-CN"] = ["  "];
if (variant === "too-large") {
  entry.notes["zh-CN"] = [Array.from({ length: 60_000 }, () => "大").join("")];
  entry.notes["en-US"] = [Array.from({ length: 60_000 }, () => "a").join("")];
}
const versions = [entry];
if (variant === "duplicate") versions.push({ ...entry });
const url =
  variant === "bad-url"
    ? "https://example.com/releases/tag/v"
    : "https://github.com/wavexzore/Qingmo/releases/tag/v";
fs.writeFileSync(process.env.OUT, JSON.stringify({ releaseNotesUrl: url, versions }, null, 2));
NODE
}

expect_ok() {
  local name="$1"
  shift
  if ! node "$script" --root "$fixture" "$@" >"$tmp/out" 2>&1; then
    echo "FAIL (expected 0): $name" >&2
    cat "$tmp/out" >&2
    exit 1
  fi
  echo "ok   $name"
}

expect_fail() {
  local name="$1"
  shift
  set +e
  node "$script" --root "$fixture" "$@" >"$tmp/out" 2>&1
  local status=$?
  set -e
  if [[ $status -ne 1 ]]; then
    echo "FAIL (expected 1, got $status): $name" >&2
    cat "$tmp/out" >&2
    exit 1
  fi
  echo "ok   $name"
}

write_notes ok
expect_ok "valid notes"
expect_ok "explicit version" --version 0.2.0
expect_ok "render to file" --out "$tmp/notes.txt"
grep -q "中文说明" "$tmp/notes.txt"
grep -q "English note" "$tmp/notes.txt"
expect_ok "render one language" --lang zh-CN --out "$tmp/zh.txt"
grep -q "中文说明" "$tmp/zh.txt"
if grep -q "English note" "$tmp/zh.txt"; then
  echo "FAIL: --lang zh-CN rendered English notes" >&2
  exit 1
fi
echo "ok   render one language only"
expect_ok "json report" --json
grep -q '"ok": true' "$tmp/out"

write_notes wrong-version
expect_fail "missing version entry"
write_notes bad-date
expect_fail "bad date"
write_notes no-zh
expect_fail "missing zh-CN"
write_notes no-en
expect_fail "missing en-US"
write_notes empty-note
expect_fail "empty note"
write_notes duplicate
expect_fail "duplicate entry"
write_notes bad-url
expect_fail "bad releaseNotesUrl"
write_notes too-large
expect_fail "notes over 100 KiB"

set +e
node "$script" --root "$fixture" --lang fr >"$tmp/out" 2>&1
status=$?
set -e
[[ $status -eq 2 ]] || {
  echo "FAIL (expected 2): invalid --lang" >&2
  cat "$tmp/out" >&2
  exit 1
}
echo "ok   invalid --lang"

echo "check-release-notes: all cases passed"
