#!/usr/bin/env bash
# Regenerates ts-rs bindings and fails if the committed files change.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

cargo test --manifest-path src-tauri/Cargo.toml --test export_bindings >/dev/null

changed="$(git status --porcelain -- packages/shared/src/generated)"
if [[ -n "$changed" ]]; then
  echo "generated bindings are stale:" >&2
  echo "$changed" >&2
  git diff -- packages/shared/src/generated >&2 || true
  exit 1
fi

missing=0
while IFS= read -r file; do
  name="$(basename "$file" .ts)"
  if ! grep -Fq "export type { $name } from \"./$name\";" packages/shared/src/generated/index.ts; then
    echo "generated/index.ts is missing an export for $name" >&2
    missing=1
  fi
done < <(find packages/shared/src/generated -maxdepth 1 -name '*.ts' ! -name 'index.ts' -print)

if [[ "$missing" -ne 0 ]]; then
  exit 1
fi

echo "generated bindings are current"
