#!/usr/bin/env bash
# Negative probe: the frontend command mirror must be checked by the contract.
# A stale name is injected, the contract test must fail, then the file is
# restored byte-for-byte.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

target="apps/desktop/src/lib/ipc/commands.ts"
backup="$(mktemp)"
log="$(mktemp)"
checksum() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}
before="$(checksum "$target")"
cp "$target" "$backup"

restore() {
  cp "$backup" "$target"
  rm -f "$backup" "$log"
}
trap restore EXIT

python3 - "$target" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
needle = '"app_update_install"'
if needle not in text:
    raise SystemExit(f"missing probe anchor in {path}: {needle}")
path.write_text(text.replace(needle, '"app_update_install_broken"', 1), encoding="utf-8")
PY

if cargo test \
  --manifest-path src-tauri/Cargo.toml \
  --test commands_contract \
  frontend_command_mirror_contains_every_contract_name >"$log" 2>&1; then
  echo "negative contract probe unexpectedly passed" >&2
  cat "$log" >&2
  exit 1
fi

restore
trap - EXIT

after="$(checksum "$target")"
if [[ "$before" != "$after" ]]; then
  echo "contract probe did not restore $target" >&2
  exit 1
fi

echo "negative contract probe reproduced the expected failure"
