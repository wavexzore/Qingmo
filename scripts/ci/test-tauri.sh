#!/usr/bin/env bash
# Real Tauri E2E: build the production frontend + debug binary with the
# embedded WebDriver feature, then drive it through WDIO.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

if [[ "$(uname -s)" != "Darwin" && "$(uname -s)" != "Linux" ]]; then
  echo "test:tauri is currently supported on macOS and Linux only" >&2
  exit 1
fi

spec_args=()
if [[ "${1:-}" == "--" ]]; then
  shift
fi
runner=test:tauri
if [[ "${1:-}" == "soak" ]]; then
  # The soak owns its own config; selecting it via --spec would intersect
  # with the default config's exclude list and yield zero specs.
  runner=test:tauri:soak
elif [[ $# -gt 0 && -n "${1:-}" ]]; then
  spec_args=(--spec "./e2e-tauri/specs/${1}*.spec.ts")
fi

pnpm typecheck:e2e:tauri
pnpm build:tauri:e2e

if find apps/desktop/dist -type f \( -name '*.js' -o -name '*.html' -o -name '*.css' \) \
  -print0 | xargs -0 grep -l "FakeIpc" 2>/dev/null | grep -q .; then
  echo "the Tauri E2E bundle contains FakeIpc; it must use the production IpcPort" >&2
  exit 1
fi

if (( ${#spec_args[@]} )); then
  pnpm "$runner" "${spec_args[@]}"
else
  pnpm "$runner"
fi
