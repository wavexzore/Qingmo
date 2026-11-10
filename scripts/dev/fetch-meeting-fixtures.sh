#!/usr/bin/env bash
# Download model files used by local meeting tests (never committed).
# Kept separate from the production downloader in T-011.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
target="$root/src-tauri/target/meeting-fixtures"
mkdir -p "$target"

fetch() {
  local url="$1" expected="$2" out="$3"
  if [[ -f "$out" ]] && [[ "$(shasum -a 256 "$out" | cut -d' ' -f1)" == "$expected" ]]; then
    return
  fi
  curl --fail --location --retry 3 --output "$out.tmp" "$url"
  local actual
  actual="$(shasum -a 256 "$out.tmp" | cut -d' ' -f1)"
  if [[ "$actual" != "$expected" ]]; then
    echo "hash mismatch for $out: $actual" >&2
    rm -f "$out.tmp"
    exit 1
  fi
  mv "$out.tmp" "$out"
}

fetch \
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx" \
  "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6" \
  "$target/silero_vad.onnx"

echo "meeting test models ready in $target"
