#!/usr/bin/env bash
# Negative probe: removing a capability must make the security contract fail.
# This is a config-level reproduction; the real invoke refusal was verified in
# T-002 (C-026) because Tauri's mock runtime does not enforce ACLs.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

target="src-tauri/capabilities/default.json"
backup="$(mktemp)"
log="$(mktemp)"
cp "$target" "$backup"

restore() {
  cp "$backup" "$target"
  rm -f "$backup"
}
trap restore EXIT

python3 - "$target" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
data = json.loads(path.read_text(encoding="utf-8"))
permissions = data.get("permissions")
if not isinstance(permissions, list):
    raise SystemExit("capability permissions must be a list")
needle = "allow-app-close-confirm"
if needle not in permissions:
    raise SystemExit(f"missing probe permission: {needle}")
data["permissions"] = [item for item in permissions if item != needle]
path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
PY

if cargo test \
  --manifest-path src-tauri/Cargo.toml \
  --test security_config \
  capability_contains_only_expected_permissions >"$log" 2>&1; then
  echo "negative capability probe unexpectedly passed" >&2
  cat "$log" >&2
  exit 1
fi

restore
trap - EXIT

if ! git diff --quiet -- "$target"; then
  echo "capability probe did not restore $target" >&2
  git diff -- "$target" >&2
  exit 1
fi

echo "negative capability probe reproduced the expected failure"
tail -3 "$log" 2>/dev/null || true
rm -f "$log"
