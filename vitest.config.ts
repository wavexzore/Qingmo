import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./apps/desktop/src/test/setup.ts"],
    restoreMocks: true,
    // Playwright specs live under `e2e/` and must never be collected by Vitest.
    exclude: ["**/node_modules/**", "**/dist/**", "**/coverage/**", "e2e/**", "src-tauri/**"],
  },
});
