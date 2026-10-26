#!/usr/bin/env bash
set -euo pipefail

# Kill the writer after it has written its temporary sibling but before the
# atomic rename. The original target must remain intact; the leftover temp file
# is then cleaned up. A normal run must commit and leave no temp file.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/qingmo-fault.XXXXXX")"
CHILD=""

cleanup() {
  if [[ -n "$CHILD" ]] && kill -0 "$CHILD" 2>/dev/null; then
    kill -9 "$CHILD" 2>/dev/null || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

find_temp() {
  find "$WORK" -type f -name '.target.md.*' -print -quit
}

TARGET="$WORK/target.md"
printf 'old-content\n' >"$TARGET"

cargo build --quiet --manifest-path "$ROOT/src-tauri/Cargo.toml" --example fault_write
BINARY="$ROOT/src-tauri/target/debug/examples/fault_write"

QINGMO_FAULT_AFTER_TEMP_MS=30000 "$BINARY" "$TARGET" >"$WORK/child.log" 2>&1 &
CHILD=$!

found=""
for _ in $(seq 1 1200); do
  found="$(find_temp)"
  if [[ -n "$found" ]]; then
    break
  fi
  if ! kill -0 "$CHILD" 2>/dev/null; then
    echo "child exited before creating a temporary file" >&2
    cat "$WORK/child.log" >&2
    exit 1
  fi
  sleep 0.05
done

if [[ -z "$found" ]]; then
  echo "temporary file was not observed" >&2
  cat "$WORK/child.log" >&2
  exit 1
fi

kill -9 "$CHILD" 2>/dev/null || true
wait "$CHILD" 2>/dev/null || true
CHILD=""

if [[ "$(cat "$TARGET")" != "old-content" ]]; then
  echo "target changed despite kill before commit" >&2
  exit 1
fi

if [[ -z "$(find_temp)" ]]; then
  echo "expected a leftover temporary file after SIGKILL" >&2
  exit 1
fi
rm -f "$WORK"/.target.md.*

env -u QINGMO_FAULT_AFTER_TEMP_MS "$BINARY" "$TARGET" >/dev/null
if [[ "$(cat "$TARGET")" != "new-content" ]]; then
  echo "normal write did not commit" >&2
  exit 1
fi
if [[ -n "$(find_temp)" ]]; then
  echo "temporary file left after successful commit" >&2
  exit 1
fi

echo "fault injection PASS"
