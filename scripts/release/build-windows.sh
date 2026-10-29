#!/usr/bin/env bash
# Cross-compile the Windows NSIS installer from macOS with cargo-xwin.
#
# This script never uploads or publishes. It writes the installer (with an
# ASCII asset name, like the macOS artifacts) into release-artifacts/v<version>/.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/release/build-windows.sh [options]

Options:
  --version <X.Y.Z>    Release version (default: src-tauri/tauri.conf.json)
  --skip-build         Reuse the existing NSIS bundle artifact
  --out-dir <path>     Output directory (default: release-artifacts/v<version>)
  -h, --help           Show this help

Requirements:
  cargo-xwin (cargo install cargo-xwin), rustup target add x86_64-pc-windows-msvc,
  and makensis (brew install makensis). The Windows SDK/CRT is downloaded into
  the cargo-xwin cache on the first build.

Notes:
  The installer has no Authenticode signature (Tauri cannot sign Windows
  binaries off a Windows host), so SmartScreen may warn. The updater
  (minisign) signature is still generated from the local updater key and is
  what latest.json verifies; without that key the build warns and no
  windows-x86_64 entry is written.
EOF
}

die() {
  echo "build-windows: ERROR: $*" >&2
  exit 1
}

info() {
  echo "build-windows: $*"
}

version=""
skip_build=0
out_dir=""
target="${WIN_TARGET:-x86_64-pc-windows-msvc}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      version="${2:-}"
      shift 2
      ;;
    --skip-build)
      skip_build=1
      shift
      ;;
    --out-dir)
      out_dir="${2:-}"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

if [[ -z "$version" ]]; then
  version="$(node -p "require('./src-tauri/tauri.conf.json').version")"
fi
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]]; then
  die "version is not semver: $version"
fi

command -v cargo-xwin >/dev/null 2>&1 || die "cargo-xwin is required (cargo install cargo-xwin)"
command -v makensis >/dev/null 2>&1 || die "makensis is required (brew install makensis)"
rustup target list --installed | grep -qx "$target" ||
  die "rust target $target is not installed (rustup target add $target)"

tag="v$version"
product_name="$(node -p "require('./src-tauri/tauri.conf.json').productName")"
[[ -n "$product_name" ]] || die "productName is empty in src-tauri/tauri.conf.json"
nsis_dir="$root/src-tauri/target/$target/release/bundle/nsis"

info "release version: $version"
node scripts/release/check-versions.mjs --expect "$version"

# The installer has no Authenticode signature (Tauri cannot sign Windows
# binaries off a Windows host), but the updater still needs a minisign
# signature: without it Windows auto-update cannot work and latest.json must
# not list windows-x86_64.
signing_key=""
if [[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  signing_key="$TAURI_SIGNING_PRIVATE_KEY"
elif [[ -n "${TAURI_SIGNING_PRIVATE_KEY_FILE:-}" ]]; then
  [[ -f "$TAURI_SIGNING_PRIVATE_KEY_FILE" ]] || die "TAURI_SIGNING_PRIVATE_KEY_FILE does not exist: $TAURI_SIGNING_PRIVATE_KEY_FILE"
  signing_key="$(cat "$TAURI_SIGNING_PRIVATE_KEY_FILE")"
elif [[ -f "$HOME/.tauri/qingmo-updater.key" ]]; then
  signing_key="$(cat "$HOME/.tauri/qingmo-updater.key")"
fi

signing_password=""
if [[ -n "$signing_key" ]]; then
  if [[ -n "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" ]]; then
    signing_password="$TAURI_SIGNING_PRIVATE_KEY_PASSWORD"
  elif [[ -n "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD_FILE:-}" ]]; then
    [[ -f "$TAURI_SIGNING_PRIVATE_KEY_PASSWORD_FILE" ]] || die "TAURI_SIGNING_PRIVATE_KEY_PASSWORD_FILE does not exist: $TAURI_SIGNING_PRIVATE_KEY_PASSWORD_FILE"
    signing_password="$(cat "$TAURI_SIGNING_PRIVATE_KEY_PASSWORD_FILE")"
  elif [[ -f "$HOME/.tauri/qingmo-updater.key.password" ]]; then
    signing_password="$(cat "$HOME/.tauri/qingmo-updater.key.password")"
  else
    die "TAURI_SIGNING_PRIVATE_KEY_PASSWORD is required to sign updater artifacts"
  fi
  export TAURI_SIGNING_PRIVATE_KEY="$signing_key"
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$signing_password"
  info "signing the updater artifact with the local updater key"
else
  echo "build-windows: WARNING: no updater key found; the installer will not support auto-update" >&2
  echo "build-windows: WARNING: latest.json will omit windows-x86_64 for this build" >&2
fi

if [[ $skip_build -eq 0 ]]; then
  info "cross-compiling the Windows NSIS installer (this can take several minutes)"
  build_args=(--runner cargo-xwin --target "$target" --bundles nsis)
  if [[ -z "$signing_key" ]]; then
    build_args+=(--config '{"bundle":{"createUpdaterArtifacts":false}}')
  fi
  pnpm tauri build "${build_args[@]}"
else
  info "reusing existing bundle artifacts (--skip-build)"
fi

setup="$(find "$nsis_dir" -maxdepth 1 -type f -name "${product_name}_${version}_*-setup.exe" -print -quit 2>/dev/null || true)"
if [[ ! -f "$setup" ]]; then
  setup="$(find "$nsis_dir" -maxdepth 1 -type f -name "*_${version}_*-setup.exe" -print -quit 2>/dev/null || true)"
fi
[[ -f "$setup" ]] || die "NSIS installer for $product_name $version not found under: $nsis_dir"
file "$setup" | grep -q "PE32" || die "not a Windows PE executable: $setup"

if [[ -z "$out_dir" ]]; then
  out_dir="$root/release-artifacts/$tag"
fi
mkdir -p "$out_dir"

# GitHub strips non-ASCII characters from release asset names; keep the
# downloadable installer ASCII while the app itself still displays 青墨.
# The updater signature is bound to the file name, so sign the ASCII copy.
ascii_setup="$out_dir/Qingmo_${version}_x64-setup.exe"
cp -f "$setup" "$ascii_setup"
rm -f "$ascii_setup.sig"
if [[ -n "$signing_key" ]]; then
  pnpm tauri signer sign --app-version "$version" "$ascii_setup"
fi
chmod 644 "$ascii_setup"

info "artifacts:"
ls -lh "$ascii_setup"
