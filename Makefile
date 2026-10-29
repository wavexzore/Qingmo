# Qingmo developer shortcuts.

# macOS release builds go through the local release pipeline (sign, notarize,
# latest.json). The pipeline always builds a universal (arm64 + x86_64) app.
RELEASE_SH ?= ./.release/release.sh

# Windows installers are cross-compiled from macOS with cargo-xwin + NSIS.
WIN_TARGET ?= x86_64-pc-windows-msvc

# Architecture for the lightweight, unsigned DMG shortcut below.
# `arm64` is accepted as an alias for `aarch64`.
MAC_ARCH ?= aarch64
ifeq ($(MAC_ARCH),arm64)
MAC_ARCH := aarch64
endif

.PHONY: run build build-mac build-win build-arch build-mac-arch

# Start the Tauri v2 app in development mode (Vite + Rust).
run:
	pnpm tauri dev

# Build both platforms into release-artifacts/v<version>/.
# Windows runs first so the macOS pipeline checksums the installer too.
# Usage: make build
#        make build WIN_ARGS="--skip-build"
build:
	@$(MAKE) --no-print-directory build-win WIN_ARGS="$(WIN_ARGS)"
	@$(MAKE) --no-print-directory build-mac

# macOS local release build: checks versions + release notes, then builds,
# signs, notarizes and generates release-artifacts/v<version>/latest.json.
# Uses .release/release.sh when present, otherwise scripts/release/build-local.sh.
# Usage: make build-mac
build-mac:
	@if [ -x "$(RELEASE_SH)" ]; then \
		"$(RELEASE_SH)"; \
	else \
		echo "build-mac: $(RELEASE_SH) not found; using scripts/release/build-local.sh" >&2; \
		bash scripts/release/build-local.sh; \
	fi

# Windows NSIS installer, cross-compiled with cargo-xwin (unsigned).
# Output: release-artifacts/v<version>/Qingmo_<version>_x64-setup.exe
# Usage: make build-win
#        make build-win WIN_ARGS="--skip-build"
build-win:
	WIN_TARGET="$(WIN_TARGET)" bash scripts/release/build-windows.sh $(WIN_ARGS)

# Lightweight macOS DMG without updater artifacts or release signing.
# Usage: make build-arch                # Apple Silicon (default)
#        make build-arch MAC_ARCH=x86_64
# Output: src-tauri/target/$(MAC_ARCH)-apple-darwin/release/bundle/dmg/
build-arch:
	pnpm tauri build --target $(MAC_ARCH)-apple-darwin --bundles dmg \
		--config '{"bundle":{"createUpdaterArtifacts":false}}'

# Deprecated aliases kept for existing scripts and docs.
build-mac-arch: build-arch
