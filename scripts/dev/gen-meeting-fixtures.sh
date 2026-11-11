#!/usr/bin/env bash
# Generate the long meeting fixtures used by the native E2E specs.
#
# Usage: scripts/dev/gen-meeting-fixtures.sh [destination]
# The two-speaker source is looped so every window contains speech and the
# transcript timestamps keep advancing across the 10 minute boundary.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
dest="${1:-$root/e2e-tauri/fixtures}"
source="$root/e2e-tauri/fixtures/meeting-2spk.wav"

if [[ ! -f "$source" ]]; then
  echo "missing $source" >&2
  exit 1
fi
mkdir -p "$dest"

ffmpeg -v error -y -stream_loop -1 -i "$source" -t 1500 -ar 16000 -ac 1 \
  -c:a pcm_s16le "$dest/meeting-25min.wav"

ffmpeg -v error -y -stream_loop -1 -i "$source" -t 600 -ar 16000 -ac 1 \
  -c:a pcm_s16le "$dest/meeting-ten.wav"

ffmpeg -v error -y -stream_loop -1 -i "$source" -t 14400 -ar 16000 -ac 1 \
  -c:a aac -b:a 32k "$dest/meeting-4h.m4a"

shasum -a 256 "$dest/meeting-25min.wav" "$dest/meeting-ten.wav" "$dest/meeting-4h.m4a" \
  >"$dest/meeting-long.sha256"
