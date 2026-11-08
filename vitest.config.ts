import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./apps/desktop/src/test/setup.ts"],
    restoreMocks: true,
    // Playwright/WDIO specs live under `e2e/` and `e2e-tauri/`; Vitest must
    // never collect them (they import @wdio/globals at module scope).
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "e2e/**",
      "e2e-tauri/**",
      "src-tauri/**",
    ],
  },
});
