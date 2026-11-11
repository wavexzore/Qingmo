#!/usr/bin/env bash
# Fetch and verify the transcription model combination for CI.
#
# Mirrors the models the native meeting E2E seeds: ASR, VAD, segmentation and
# speaker embedding. LLM packs stay out (E2E runs degraded summaries).
#
# Usage: scripts/meeting-models/ci-fetch.sh <destination>
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
dest="${1:-${MEETING_E2E_MODELS:-}}"
if [[ -z "$dest" ]]; then
  echo "usage: $0 <destination>" >&2
  exit 2
fi

ids=(paraformer-zh-en-int8 zipformer-zh-en-int8 silero-vad pyannote-segmentation-3-int8 campplus-zh-en-advanced)
"$root/scripts/meeting-models/fetch.sh" "$dest" "${ids[@]}"
"$root/scripts/meeting-models/verify.sh" "$dest" "${ids[@]}"

# The Rust catalog only accepts a pack with a valid `.ready` marker.
# Seeding may be a no-op when the cache already has the files; hashes are
# checked again afterwards.
cargo --quiet --manifest-path "$root/src-tauri/Cargo.toml" run \
  --example seed_meeting_models -- "$dest" "$dest" "${ids[@]}"
"$root/scripts/meeting-models/verify.sh" "$dest" "${ids[@]}"
