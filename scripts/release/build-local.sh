#!/usr/bin/env bash
# Build, sign, notarize and validate a local macOS universal release.
#
# This script never uploads or publishes. It writes a self-contained
# release-artifacts/v<version>/ directory that can be uploaded with gh.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/release/build-local.sh [options]

Options:
  --version <X.Y.Z>    Release version (default: src-tauri/tauri.conf.json)
  --skip-build         Reuse existing universal bundle artifacts
  --skip-notarize      Do not submit the DMG to Apple (app must already be notarized)
  --notes <text>       latest.json release notes (default: resources/notes.json)
  --notes-file <path>  Read release notes from a file (overrides resources/notes.json)
  --out-dir <path>     Output directory (default: release-artifacts/v<version>)
  -h, --help           Show this help

Required for a real build:
  Developer ID certificate in the keychain, or APPLE_CERTIFICATE_FILE +
  APPLE_CERTIFICATE_PASSWORD (or APPLE_CERTIFICATE + APPLE_CERTIFICATE_PASSWORD).
  APPLE_ID, APPLE_TEAM_ID, APPLE_PASSWORD (App-specific password).
  TAURI_SIGNING_PRIVATE_KEY (content or path) and its password.

Convenience fallbacks:
  Local one-click wrapper (ignored by git): .release/release.sh
  APPLE_CERTIFICATE_FILE=.release/certs/Qingmo-Developer-ID-Application.p12
  APPLE_CERTIFICATE_PASSWORD_FILE=.release/secrets/qingmo-developer-id.password
  APPLE_PASSWORD_FILE=~/.tauri/qingmo-apple-app-password
  TAURI_SIGNING_PRIVATE_KEY_FILE=~/.tauri/qingmo-updater.key
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD_FILE=~/.tauri/qingmo-updater.key.password
EOF
}

die() {
  echo "build-local: ERROR: $*" >&2
  exit 1
}

info() {
  echo "build-local: $*"
}

version=""
skip_build=0
skip_notarize=0
notes=""
notes_file=""
out_dir=""
target="universal-apple-darwin"
verify_dir=""

cleanup() {
  [[ -n "$verify_dir" ]] && rm -rf "$verify_dir"
  return 0
}
trap cleanup EXIT

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
    --skip-notarize)
      skip_notarize=1
      shift
      ;;
    --notes)
      notes="${2:-}"
      shift 2
      ;;
    --notes-file)
      notes_file="${2:-}"
      shift 2
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
if [[ -n "$notes" && -n "$notes_file" ]]; then
  die "--notes and --notes-file are mutually exclusive"
fi

tag="v$version"
macos_dir="$root/src-tauri/target/$target/release/bundle/macos"
dmg_dir="$root/src-tauri/target/$target/release/bundle/dmg"
app="$macos_dir/Qingmo.app"

info "release version: $version"
node scripts/release/check-versions.mjs --expect "$version"
info "checking release notes for $version"
node scripts/release/check-release-notes.mjs --version "$version"

if [[ $skip_build -eq 0 ]]; then
  if [[ -n "${APPLE_CERTIFICATE_FILE:-}" ]]; then
    [[ -f "$APPLE_CERTIFICATE_FILE" ]] || die "APPLE_CERTIFICATE_FILE does not exist: $APPLE_CERTIFICATE_FILE"
    if [[ -z "${APPLE_CERTIFICATE:-}" ]]; then
      export APPLE_CERTIFICATE
      APPLE_CERTIFICATE="$(base64 <"$APPLE_CERTIFICATE_FILE" | tr -d '\n')"
    fi
  fi
  if [[ -n "${APPLE_CERTIFICATE_PASSWORD_FILE:-}" && -z "${APPLE_CERTIFICATE_PASSWORD:-}" ]]; then
    [[ -f "$APPLE_CERTIFICATE_PASSWORD_FILE" ]] || die "APPLE_CERTIFICATE_PASSWORD_FILE does not exist: $APPLE_CERTIFICATE_PASSWORD_FILE"
    export APPLE_CERTIFICATE_PASSWORD
    APPLE_CERTIFICATE_PASSWORD="$(cat "$APPLE_CERTIFICATE_PASSWORD_FILE")"
  fi
  if [[ -n "${APPLE_CERTIFICATE:-}" && -z "${APPLE_CERTIFICATE_PASSWORD:-}" ]]; then
    die "APPLE_CERTIFICATE is set but APPLE_CERTIFICATE_PASSWORD is empty"
  fi

  if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
    if [[ -n "${APPLE_CERTIFICATE:-}" ]]; then
      die "APPLE_SIGNING_IDENTITY is required when using APPLE_CERTIFICATE/APPLE_CERTIFICATE_FILE"
    fi
    detected="$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Developer ID Application: .*\)"/\1/p' | head -n 1)"
    [[ -n "$detected" ]] || die "no Developer ID Application identity found; import the certificate or set APPLE_SIGNING_IDENTITY"
    export APPLE_SIGNING_IDENTITY="$detected"
  fi
  info "signing identity: $APPLE_SIGNING_IDENTITY"

  if [[ -z "${APPLE_ID:-}" ]]; then
    die "APPLE_ID is required for notarization"
  fi
  if [[ -z "${APPLE_TEAM_ID:-}" ]]; then
    die "APPLE_TEAM_ID is required for notarization"
  fi
  if [[ -z "${APPLE_PASSWORD:-}" ]]; then
    if [[ -n "${APPLE_PASSWORD_FILE:-}" ]]; then
      [[ -f "$APPLE_PASSWORD_FILE" ]] || die "APPLE_PASSWORD_FILE does not exist: $APPLE_PASSWORD_FILE"
      export APPLE_PASSWORD
      APPLE_PASSWORD="$(cat "$APPLE_PASSWORD_FILE")"
      info "using APPLE_PASSWORD from APPLE_PASSWORD_FILE"
    elif [[ -f "$HOME/.tauri/qingmo-apple-app-password" ]]; then
      export APPLE_PASSWORD
      APPLE_PASSWORD="$(cat "$HOME/.tauri/qingmo-apple-app-password")"
      info "using APPLE_PASSWORD from ~/.tauri/qingmo-apple-app-password"
    else
      die "APPLE_PASSWORD is required for notarization (use an Apple app-specific password)"
    fi
  fi

  if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
    if [[ -n "${TAURI_SIGNING_PRIVATE_KEY_FILE:-}" ]]; then
      [[ -f "$TAURI_SIGNING_PRIVATE_KEY_FILE" ]] || die "TAURI_SIGNING_PRIVATE_KEY_FILE does not exist: $TAURI_SIGNING_PRIVATE_KEY_FILE"
      export TAURI_SIGNING_PRIVATE_KEY
      TAURI_SIGNING_PRIVATE_KEY="$(cat "$TAURI_SIGNING_PRIVATE_KEY_FILE")"
      info "using updater key from TAURI_SIGNING_PRIVATE_KEY_FILE"
    elif [[ -f "$HOME/.tauri/qingmo-updater.key" ]]; then
      export TAURI_SIGNING_PRIVATE_KEY
      TAURI_SIGNING_PRIVATE_KEY="$(cat "$HOME/.tauri/qingmo-updater.key")"
      info "using updater key from ~/.tauri/qingmo-updater.key"
    else
      die "TAURI_SIGNING_PRIVATE_KEY is required to sign updater artifacts"
    fi
  fi
  if [[ -z "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" ]]; then
    if [[ -n "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD_FILE:-}" ]]; then
      [[ -f "$TAURI_SIGNING_PRIVATE_KEY_PASSWORD_FILE" ]] || die "TAURI_SIGNING_PRIVATE_KEY_PASSWORD_FILE does not exist: $TAURI_SIGNING_PRIVATE_KEY_PASSWORD_FILE"
      export TAURI_SIGNING_PRIVATE_KEY_PASSWORD
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat "$TAURI_SIGNING_PRIVATE_KEY_PASSWORD_FILE")"
    elif [[ -f "$HOME/.tauri/qingmo-updater.key.password" ]]; then
      export TAURI_SIGNING_PRIVATE_KEY_PASSWORD
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat "$HOME/.tauri/qingmo-updater.key.password")"
    else
      die "TAURI_SIGNING_PRIVATE_KEY_PASSWORD is required (empty passwords are rejected)"
    fi
  fi

  info "building universal app and dmg (this can take several minutes)"
  pnpm tauri build --target "$target" --bundles app,dmg
else
  info "reusing existing bundle artifacts (--skip-build)"
fi

[[ -d "$app" ]] || die "app not found: $app"
tarball="$macos_dir/Qingmo.app.tar.gz"
sig="$tarball.sig"
[[ -f "$tarball" ]] || die "updater tarball not found: $tarball"
[[ -s "$sig" ]] || die "updater signature not found: $sig"
dmg="$(find "$dmg_dir" -maxdepth 1 -type f -name '*.dmg' -print -quit 2>/dev/null || true)"
[[ -n "$dmg" ]] || die "dmg not found under: $dmg_dir"

info "verifying app signature, Gatekeeper assessment and notarization ticket"
codesign --verify --deep --strict --verbose=2 "$app"
spctl --assess --type execute --verbose=4 "$app"
xcrun stapler validate "$app"

verify_dir="$(mktemp -d)"
tar -xzf "$tarball" -C "$verify_dir"
archived_app="$(find "$verify_dir" -maxdepth 4 -name 'Qingmo.app' -type d -print -quit)"
[[ -n "$archived_app" ]] || die "Qingmo.app not found inside: $tarball"
info "verifying the app inside the updater tarball"
codesign --verify --deep --strict --verbose=2 "$archived_app"
spctl --assess --type execute --verbose=4 "$archived_app"
xcrun stapler validate "$archived_app"

archs="$(lipo -archs "$app/Contents/MacOS/qingmo")"
info "architectures: $archs"
case "$archs" in
  *arm64*x86_64* | *x86_64*arm64*) ;;
  *) die "app is not universal: $archs" ;;
esac

if [[ $skip_notarize -eq 0 ]]; then
  if xcrun stapler validate "$dmg" >/dev/null 2>&1; then
    info "DMG already has a stapled notarization ticket: $dmg"
  else
    [[ -n "${APPLE_ID:-}" ]] || die "APPLE_ID is required to notarize the DMG"
    [[ -n "${APPLE_PASSWORD:-}" ]] || die "APPLE_PASSWORD is required to notarize the DMG"
    [[ -n "${APPLE_TEAM_ID:-}" ]] || die "APPLE_TEAM_ID is required to notarize the DMG"
    info "notarizing DMG (Tauri only notarizes the app; this can take several minutes)"
    xcrun notarytool submit "$dmg" \
      --apple-id "$APPLE_ID" \
      --password "$APPLE_PASSWORD" \
      --team-id "$APPLE_TEAM_ID" \
      --wait
    xcrun stapler staple "$dmg"
  fi
  xcrun stapler validate "$dmg"
else
  info "skipping DMG notarization (--skip-notarize)"
fi

if [[ -z "$out_dir" ]]; then
  out_dir="$root/release-artifacts/$tag"
fi
if [[ "$out_dir" == "$macos_dir" ]]; then
  die "--out-dir must not be the Tauri macOS bundle directory"
fi
mkdir -p "$out_dir"
cp -f "$tarball" "$sig" "$dmg" "$out_dir/"

if [[ -n "$notes" ]]; then
  printf '%s\n' "$notes" >"$out_dir/RELEASE-NOTES.txt"
elif [[ -n "$notes_file" ]]; then
  cp -f "$notes_file" "$out_dir/RELEASE-NOTES.txt"
else
  node scripts/release/check-release-notes.mjs --version "$version" --out "$out_dir/RELEASE-NOTES.txt"
fi
chmod 644 "$out_dir"/*
rm -f "$out_dir/latest.json" "$out_dir/SHA256SUMS.txt"

notes_args=(--notes-file "$out_dir/RELEASE-NOTES.txt")

info "generating latest.json"
node scripts/release/make-latest-json.mjs \
  --version "$version" \
  --artifacts "$out_dir" \
  --out "$out_dir/latest.json" \
  --base-url "https://github.com/wavexzore/Qingmo/releases/download/$tag" \
  "${notes_args[@]}"

pubkey="$(node -p "require('./src-tauri/tauri.conf.json').plugins.updater.pubkey")"
info "verifying latest.json, platform keys, URL and minisign signatures"
node scripts/release/check-latest-json.mjs \
  --latest-json "$out_dir/latest.json" \
  --tag "$tag" \
  --pubkey "$pubkey" \
  --artifacts "$out_dir"

(
  cd "$out_dir"
  shasum -a 256 ./* >SHA256SUMS.txt
)

info "artifacts:"
ls -lh "$out_dir"
info "checksums: $out_dir/SHA256SUMS.txt"
cat <<EOF

Local release is ready and validated. Nothing was uploaded.

Next (manual, after review):
  # This count must be 0: a release already exists for the tag if it is not
  # (for example one created by the optional Release workflow). Do not create a
  # second one -- gh resolves upload/edit by tag, so duplicates are ambiguous.
  gh release list --limit 100 --json tagName,isDraft \\
    --jq '[.[] | select(.tagName == "$tag")] | length'

  gh release create $tag --draft --title "$tag" --notes-file "$out_dir/RELEASE-NOTES.txt"
  gh release upload $tag "$out_dir"/* --clobber
  gh release view $tag --json isDraft,assets
  # After checking latest.json and assets:
  gh release edit $tag --draft=false --latest
EOF
