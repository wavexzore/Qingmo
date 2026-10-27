# Qingmo developer shortcuts.

# Architecture for the local macOS DMG: aarch64 (Apple Silicon) or x86_64 (Intel).
# `arm64` is accepted as an alias for `aarch64`.
MAC_ARCH ?= aarch64
ifeq ($(MAC_ARCH),arm64)
MAC_ARCH := aarch64
endif

.PHONY: run build-mac

# Start the Tauri v2 app in development mode (Vite + Rust).
run:
	pnpm tauri dev

# Build a local macOS DMG without updater artifacts or release signing.
# Usage: make build-mac                # Apple Silicon (default)
#        make build-mac MAC_ARCH=x86_64
# Output: src-tauri/target/$(MAC_ARCH)-apple-darwin/release/bundle/dmg/
build-mac:
	pnpm tauri build --target $(MAC_ARCH)-apple-darwin --bundles dmg \
		--config '{"bundle":{"createUpdaterArtifacts":false}}'
