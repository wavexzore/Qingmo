#!/usr/bin/env bash
# Guard the sherpa-onnx vendored patch (F-280):
# - dependency is pinned to =2.0.1
# - the patched crate is the only path-sourced package and stays 2.0.1
# - the diff against the crates.io tarball is limited to the probability field
# - the native sys crate stays on the same version
# Usage: check-vendor.sh [--require]
#   --require  failure instead of a skip when vendor/sherpa-onnx is absent
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
vendor="$root/src-tauri/vendor/sherpa-onnx"
lock="$root/src-tauri/Cargo.lock"
require=0
[[ "${1:-}" == "--require" ]] && require=1

if [[ ! -d "$vendor" ]]; then
  if (( require )); then
    echo "check-vendor: vendor/sherpa-onnx is required but absent" >&2
    exit 1
  fi
  echo "check-vendor: vendor/sherpa-onnx absent; skipping (T-003 must add it)"
  exit 0
fi

vendor_version="$(sed -n 's/^version = "\(.*\)"/\1/p' "$vendor/Cargo.toml" | head -1)"
sys_version="$(awk '/^name = "sherpa-onnx-sys"$/{f=1} f && /^version =/{print; exit}' "$lock" | sed -n 's/^version = "\(.*\)"/\1/p')"

[[ "$vendor_version" == "2.0.1" ]] || { echo "vendor version $vendor_version != 2.0.1" >&2; exit 1; }
[[ "$sys_version" == "2.0.1" ]] || { echo "sherpa-onnx-sys $sys_version != 2.0.1" >&2; exit 1; }
grep -q '^\[patch.crates-io\]' "$root/src-tauri/Cargo.toml" || {
  echo "missing [patch.crates-io]" >&2; exit 1; }
grep -Eq '^sherpa-onnx = \{ path = "vendor/sherpa-onnx"' "$root/src-tauri/Cargo.toml" || {
  echo "patch does not target vendor/sherpa-onnx" >&2; exit 1; }
grep -Eq '^sherpa-onnx = "=2\.0\.1"$' "$root/src-tauri/Cargo.toml" || {
  echo "dependency pin lost (expected =2.0.1)" >&2; exit 1; }

# A registry package has a `source =` line; a patched path package must not.
awk '
  /^name = "sherpa-onnx"$/ { found = 1; f = 1; next }
  f && /^source =/ { print "sherpa-onnx is not path-sourced"; bad = 1; exit }
  f && /^$/ { exit }
  END { if (!found) { print "sherpa-onnx missing from Cargo.lock"; exit 1 } exit bad }
' "$lock"

cargo_home="${CARGO_HOME:-$HOME/.cargo}"
base="$(ls -d "$cargo_home"/registry/src/*/sherpa-onnx-2.0.1 2>/dev/null | head -1 || true)"
tmp=""
cleanup() { if [[ -n "${tmp:-}" ]]; then rm -rf "$tmp"; fi; }
trap cleanup EXIT
if [[ -z "$base" ]]; then
  # A patched lock has no registry source, so `cargo fetch` will not unpack the
  # original crate. Fetch the published tarball ourselves; the checksum pins it.
  crate_sha="6956e34735af6efe416f5879181eee8e1b51be57dc6ce0a053691ae747114089"
  tmp="$(mktemp -d)"
  if curl --fail --location --silent --show-error --retry 3 \
      --output "$tmp/sherpa.crate" \
      "https://static.crates.io/crates/sherpa-onnx/sherpa-onnx-2.0.1.crate"; then
    actual="$(shasum -a 256 "$tmp/sherpa.crate" | cut -d' ' -f1)"
    if [[ "$actual" != "$crate_sha" ]]; then
      echo "crate checksum $actual != $crate_sha" >&2
      exit 1
    fi
    tar -xzf "$tmp/sherpa.crate" -C "$tmp"
    base="$tmp/sherpa-onnx-2.0.1"
  fi
fi
if [[ -n "$base" ]]; then
  diff_out="$(diff -rq "$base" "$vendor" 2>/dev/null | sed 's#^#/#' || true)"
  unexpected="$(printf '%s\n' "$diff_out" | grep -v 'offline_asr.rs' | grep -v 'PATCH.md' \
    | grep -v '^/Only in .*: .cargo-ok$' | grep -v '^/Only in .*: .cargo_vcs_info.json$' \
    | grep -v '^/Only in .*: PATCH.md$' || true)"
  if [[ -n "$unexpected" ]]; then
    echo "unexpected vendor drift:" >&2
    printf '%s\n' "$unexpected" >&2
    exit 1
  fi
  # The only allowed change inside offline_asr.rs is the probability field.
  field_diff="$(diff -u "$base/src/offline_asr.rs" "$vendor/src/offline_asr.rs" \
    | grep -E '^[+-][^+-]' || true)"
  bad_adds="$(printf '%s\n' "$field_diff" | grep '^+' \
    | grep -v 'ys_log_probs' | grep -v 'serde(default)' | grep -Ev '^\+\s*(///|//)' | grep -v '^+$' || true)"
  bad_dels="$(printf '%s\n' "$field_diff" | grep '^-' | grep -v '^---' || true)"
  if [[ -n "$bad_adds" || -n "$bad_dels" ]]; then
    echo "offline_asr.rs has changes beyond the probability field:" >&2
    printf '%s\n%s\n' "$bad_adds" "$bad_dels" >&2
    exit 1
  fi
else
  if (( require )); then
    echo "check-vendor: registry source not found under $cargo_home; cannot verify the diff" >&2
    exit 1
  fi
  echo "check-vendor: registry source not found under $cargo_home; diff whitelist skipped" >&2
fi

grep -q 'ys_log_probs' "$vendor/src/offline_asr.rs" || {
  echo "patch lost ys_log_probs" >&2; exit 1; }
grep -q 'serde(default)' "$vendor/src/offline_asr.rs" || {
  echo "patch lost #[serde(default)]" >&2; exit 1; }
[[ -f "$vendor/PATCH.md" ]] || { echo "vendor/PATCH.md missing" >&2; exit 1; }

echo "check-vendor: ok"
