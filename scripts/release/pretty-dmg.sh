#!/usr/bin/env bash
# Finish the DMG Finder layout that create-dmg cannot express.
#
# The bundler positions the app and the Applications alias, but it leaves
# `.VolumeIcon.icns` in the first icon slot, so the installer shows a stray
# file as soon as Finder reveals hidden items. This script converts the image
# to a writable copy, removes the volume-icon file so the window only holds the
# app and the Applications alias, points the icon view at the background that
# ships inside the signed app bundle, re-applies the install-window geometry,
# and converts the result back to a compressed, signed image.
#
# Usage: pretty-dmg.sh <dmg> [volume-name] [code-sign-identity]
set -euo pipefail

dmg="${1:-}"
volume_name="${2:-青墨}"
identity="${3:-${APPLE_SIGNING_IDENTITY:-}}"

if [[ -z "$dmg" || ! -f "$dmg" ]]; then
  echo "pretty-dmg: ERROR: dmg not found: ${dmg:-<empty>}" >&2
  exit 1
fi

work_dir="$(mktemp -d)"
mount_dir=""
writable="$work_dir/writable.dmg"
output="$work_dir/final.dmg"
mounted=0

cleanup() {
  if [[ $mounted -eq 1 ]]; then
    hdiutil detach "$mount_dir" >/dev/null 2>&1 || true
  fi
  rm -rf "$work_dir"
  [[ -n "$mount_dir" ]] && rmdir "$mount_dir" 2>/dev/null || true
}
trap cleanup EXIT

echo "pretty-dmg: converting $dmg"
hdiutil convert "$dmg" -format UDRW -o "$writable" >/dev/null
mount_dir="$(hdiutil attach "$writable" -readwrite -noverify -noautoopen -nobrowse \
  | awk -F '\t' '/\/Volumes\// { gsub(/^ +| +$/, "", $NF); print $NF; exit }')"
[[ -n "$mount_dir" && -d "$mount_dir" ]] || {
  echo "pretty-dmg: ERROR: failed to mount the writable image" >&2
  exit 1
}
mounted=1
open "$mount_dir" >/dev/null 2>&1 || true
sleep 2

if [[ -f "$mount_dir/.VolumeIcon.icns" ]]; then
  rm -f "$mount_dir/.VolumeIcon.icns"
fi
# Older bundles kept the picture in a hidden root folder; the image now lives
# in Resources so the mounted volume exposes exactly two items.
rm -rf "$mount_dir/.background"
[[ -f "$mount_dir/$volume_name.app/Contents/Resources/dmg-background.tiff" ]] || {
  echo "pretty-dmg: ERROR: app is missing Resources/dmg-background.tiff" >&2
  exit 1
}

started="$(date +%s)"
applied=0
# A window left over from bundling can swallow the background update, so close
# any stale window before each attempt and only accept an attempt once the
# alias is actually present in .DS_Store.
osascript -e "tell application \"Finder\" to tell disk \"$volume_name\" to close" >/dev/null 2>&1 || true
sleep 1
for attempt in 1 2 3; do
  if osascript - "$volume_name" <<'APPLESCRIPT'
on run argv
  set volumeName to item 1 of argv
  set picturePath to volumeName & ".app:Contents:Resources:dmg-background.tiff"
  tell application "Finder"
    tell disk volumeName
      open
      delay 2
      set opts to the icon view options of container window
      set background picture of opts to file picturePath
      tell opts
        set icon size to 128
        set text size to 16
        set arrangement to not arranged
      end tell
      tell container window
        set position of item "青墨.app" to {180, 180}
        set position of item "Applications" to {480, 180}
      end tell
      delay 1
      close
      open
      delay 2
      tell container window
        set current view to icon view
        set toolbar visible to false
        set statusbar visible to false
        set bounds to {200, 150, 860, 590}
        set position of item "青墨.app" to {180, 180}
        set position of item "Applications" to {480, 180}
        delay 1
        close
      end tell
    end tell
  end tell
end run
APPLESCRIPT
  then
    sleep 2
    if strings "$mount_dir/.DS_Store" | grep -q backgroundImageAlias; then
      applied=1
      break
    fi
    echo "pretty-dmg: background picture was not saved (attempt $attempt/3)" >&2
  else
    echo "pretty-dmg: Finder was not ready (attempt $attempt/3)" >&2
  fi
  sleep 1
done
[[ $applied -eq 1 ]] || {
  echo "pretty-dmg: ERROR: could not apply the Finder layout" >&2
  exit 1
}


# Finder flushes the layout to .DS_Store shortly after the window closes;
# the write is asynchronous, so give it time before looking at the mtime.
sleep 3
for _ in $(seq 1 20); do
  modified="$(stat -f %m "$mount_dir/.DS_Store" 2>/dev/null || echo 0)"
  [[ "$modified" -ge "$started" ]] && break
  sleep 0.5
done
sleep 1
sync

hdiutil detach "$mount_dir" >/dev/null
mounted=0
hdiutil convert "$writable" -format UDZO -o "$output" >/dev/null
mv "$output" "$dmg"
chmod 644 "$dmg"

if [[ -n "$identity" ]]; then
  echo "pretty-dmg: signing with $identity"
  codesign --force --sign "$identity" "$dmg"
fi

echo "pretty-dmg: done"
