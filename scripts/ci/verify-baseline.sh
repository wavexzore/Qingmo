#!/usr/bin/env bash
# Read-only baseline snapshot for T-101. Nothing here writes to the repo; the
# output is meant to be pasted into 02 §3 with a timestamp.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

echo "== time =="
date -u '+%Y-%m-%dT%H:%M:%SZ'
echo
echo "== git =="
echo "head: $(git rev-parse HEAD)"
echo "branch: $(git branch --show-current)"
echo "dirty:"
git status --porcelain
echo
echo "== toolchain =="
rustc --version 2>/dev/null || echo "rustc: missing"
cargo --version 2>/dev/null || echo "cargo: missing"
node --version 2>/dev/null || echo "node: missing"
pnpm --version 2>/dev/null || echo "pnpm: missing"
echo
echo "== generated bindings =="
find packages/shared/src/generated -maxdepth 1 -name '*.ts' -print0 \
  | sort -z \
  | xargs -0 shasum
echo
echo "== gitnexus =="
if [[ -x .gitnexus/run.cjs || -f .gitnexus/run.cjs ]]; then
  node .gitnexus/run.cjs status 2>/dev/null | sed -n '1,20p' || echo "status unavailable"
else
  echo "no .gitnexus/run.cjs"
fi
echo
echo "== last commit =="
git log -1 --format='%H %ad %s' --date=iso-strict
echo
echo "baseline snapshot complete (read-only)"
