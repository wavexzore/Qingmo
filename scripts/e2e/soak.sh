#!/usr/bin/env bash
# T-107/T-209 acceptance soak.
#
# Phase A runs the deterministic crash/boundary suites (10 MiB × 3 encodings,
# 10 same-name image pastes, SIGKILL before commit, cross-process saves).
# Phase B drives the real Tauri binary through 50 create/edit/cancel-close/
# confirm-close cycles and periodic real saves, then asserts no window leaked.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

iterations="${QINGMO_SOAK_ITERATIONS:-50}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p logs
log="logs/soak-${stamp}.log"
exec > >(tee -a "$log") 2>&1

echo "soak started $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "commit $(git rev-parse HEAD)"
echo "iterations ${iterations}"

echo
echo "== 10 MiB boundaries (LF/CRLF/UTF-16) =="
cargo test --manifest-path src-tauri/Cargo.toml --test document_roundtrip ten_mib

echo
echo "== ten same-name image pastes =="
cargo test --manifest-path src-tauri/Cargo.toml --test image_assets \
  saves_next_to_the_document_and_never_overwrites

echo
echo "== SIGKILL before atomic commit =="
bash scripts/fault-injection/kill-after-temp.sh

echo
echo "== cross-process save lock =="
bash scripts/ci/two-process-save.sh

echo
echo "== real Tauri window soak (${iterations} cycles) =="
pnpm typecheck:e2e:tauri
pnpm build:tauri:e2e
QINGMO_SOAK_ITERATIONS="$iterations" pnpm exec wdio run wdio.soak.conf.ts

printf '{"at":"%s","commit":"%s","iterations":%s,"verdict":"PASS","log":"%s"}\n' \
  "$stamp" "$(git rev-parse HEAD)" "$iterations" "$log" >>logs/soak.jsonl
echo
echo "soak PASS $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
