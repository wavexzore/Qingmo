import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./apps/desktop/src/test/setup.ts"],
    restoreMocks: true,
  },
});
