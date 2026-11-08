#!/usr/bin/env bash
# Two real processes race to save the same file through the production
# DocumentRegistry + AtomicWriter + sidecar FileLockStore. The final bytes must
# be exactly one complete payload (never interleaved), a second writer must
# fail with BUSY while the lock is held, and a SIGKILLed holder must not leave a
# permanent lock.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

work="$(mktemp -d "${TMPDIR:-/tmp}/qingmo-two-process.XXXXXX")"
holder=""
cleanup() {
  if [[ -n "$holder" ]]; then
    kill -9 "$holder" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

cargo build --quiet --manifest-path src-tauri/Cargo.toml --example two_process_save
binary="$root/src-tauri/target/debug/examples/two_process_save"

target="$work/note.md"
printf 'seed\n' >"$target"

# 5 MiB per payload: both stay under the 10 MiB open limit (so a racing
# process can still open what the other just wrote) and are large enough that
# any interleaving or truncation would change the size.
python3 - "$work/a.md" "$work/b.md" <<'PY'
import sys
for path, char in zip(sys.argv[1:], ("a", "b")):
    with open(path, "w", encoding="utf-8", newline="") as handle:
        handle.write(char * (5 * 1024 * 1024) + "\n")
PY

assert_complete_payload() {
  if ! cmp -s "$target" "$work/a.md" && ! cmp -s "$target" "$work/b.md"; then
    echo "target is not either complete payload (interleaved or truncated)" >&2
    wc -c "$target" "$work/a.md" "$work/b.md" >&2
    exit 1
  fi
}

assert_no_temp() {
  if [[ -n "$(find "$work" -maxdepth 1 -type f -name '.note.md.*' -print -quit)" ]]; then
    echo "a temporary file was left after a successful commit" >&2
    exit 1
  fi
}

echo "== concurrent save race =="
start="$work/start"
"$binary" "$target" "$work/a.md" "$work/locks" "$start" >"$work/a.log" 2>&1 &
first=$!
"$binary" "$target" "$work/b.md" "$work/locks" "$start" >"$work/b.log" 2>&1 &
second=$!

# Both helpers are parked on the start barrier; release them together.
sleep 0.5
touch "$start"

succeeded=0
failed=0
for pid in "$first" "$second"; do
  if wait "$pid"; then
    succeeded=$((succeeded + 1))
  else
    failed=$((failed + 1))
  fi
done
if [[ "$succeeded" -lt 1 ]]; then
  echo "no helper saved successfully:" >&2
  cat "$work/a.log" "$work/b.log" >&2
  exit 1
fi
if [[ "$failed" -gt 0 ]] && ! grep -Eq '"code":"(Busy|Conflict)"|Conflict|Busy' \
  "$work/a.log" "$work/b.log"; then
  echo "a losing writer failed for an unexpected reason:" >&2
  cat "$work/a.log" "$work/b.log" >&2
  exit 1
fi
assert_complete_payload
assert_no_temp
echo "concurrent save PASS (${succeeded} committed, ${failed} rejected)"

echo
echo "== held lock returns BUSY without writing =="
before="$(shasum -a 256 "$target" | cut -d' ' -f1)"
QINGMO_FAULT_AFTER_TEMP_MS=30000 \
  "$binary" "$target" "$work/a.md" "$work/locks" >"$work/holder.log" 2>&1 &
holder=$!
found=""
for _ in $(seq 1 600); do
  found="$(find "$work" -maxdepth 1 -type f -name '.note.md.*' -print -quit)"
  if [[ -n "$found" ]]; then
    break
  fi
  if ! kill -0 "$holder" 2>/dev/null; then
    echo "holder exited before it held the lock" >&2
    cat "$work/holder.log" >&2
    exit 1
  fi
  sleep 0.05
done
if [[ -z "$found" ]]; then
  echo "the holder never reached the guarded write" >&2
  cat "$work/holder.log" >&2
  exit 1
fi

started="$(date +%s)"
if "$binary" "$target" "$work/b.md" "$work/locks" >"$work/waiting.log" 2>&1; then
  echo "a second writer succeeded while the lock was held" >&2
  exit 1
fi
elapsed=$(( $(date +%s) - started ))
if ! grep -q 'Busy' "$work/waiting.log"; then
  echo "the second writer did not report BUSY:" >&2
  cat "$work/waiting.log" >&2
  exit 1
fi
if [[ "$elapsed" -lt 1 ]]; then
  echo "BUSY returned too quickly to have waited on the lock (${elapsed}s)" >&2
  exit 1
fi
if [[ "$(shasum -a 256 "$target" | cut -d' ' -f1)" != "$before" ]]; then
  echo "the rejected writer changed the target" >&2
  exit 1
fi
echo "BUSY after ${elapsed}s; target unchanged"
kill -9 "$holder" 2>/dev/null || true
wait "$holder" 2>/dev/null || true
holder=""

echo
echo "== SIGKILL releases the lock =="
if [[ "$(head -c 4 "$target")" != "aaaa" && "$(head -c 4 "$target")" != "bbbb" ]]; then
  echo "the target changed despite the kill before commit" >&2
  exit 1
fi
# The SIGKILLed holder cannot clean its own temporary sibling.
rm -f "$work"/.note.md.*

if ! "$binary" "$target" "$work/b.md" "$work/locks" >"$work/recover.log" 2>&1; then
  echo "the lock did not recover after SIGKILL" >&2
  cat "$work/recover.log" >&2
  exit 1
fi
if ! cmp -s "$target" "$work/b.md"; then
  echo "the recovery save did not commit the full payload" >&2
  exit 1
fi
assert_no_temp
echo "SIGKILL lock recovery PASS"
