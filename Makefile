# Qingmo developer shortcuts.

# macOS release builds go through the local release pipeline (sign, notarize,
# latest.json). The pipeline always builds a universal (arm64 + x86_64) app.
RELEASE_SH ?= ./.release/release.sh

# Architecture for the lightweight, unsigned DMG shortcut below.
# `arm64` is accepted as an alias for `aarch64`.
MAC_ARCH ?= aarch64
ifeq ($(MAC_ARCH),arm64)
MAC_ARCH := aarch64
endif

.PHONY: run build-mac build-mac-arch

# Start the Tauri v2 app in development mode (Vite + Rust).
run:
	pnpm tauri dev

# Local release build: checks versions + release notes, then builds, signs,
# notarizes and generates release-artifacts/v<version>/latest.json.
# Uses .release/release.sh when present, otherwise scripts/release/build-local.sh.
# Usage: make build-mac
build-mac:
	@if [ -x "$(RELEASE_SH)" ]; then \
		"$(RELEASE_SH)"; \
	else \
		echo "build-mac: $(RELEASE_SH) not found; using scripts/release/build-local.sh" >&2; \
		bash scripts/release/build-local.sh; \
	fi

# Lightweight macOS DMG without updater artifacts or release signing.
# Usage: make build-mac-arch                # Apple Silicon (default)
#        make build-mac-arch MAC_ARCH=x86_64
# Output: src-tauri/target/$(MAC_ARCH)-apple-darwin/release/bundle/dmg/
build-mac-arch:
	pnpm tauri build --target $(MAC_ARCH)-apple-darwin --bundles dmg \
		--config '{"bundle":{"createUpdaterArtifacts":false}}'
