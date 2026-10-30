import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Benchmarks are separate from `pnpm test`: they only run when asked, never
 * enter the production bundle, and execute serially so 10 MiB memory numbers
 * are not polluted by parallel workers.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@qingmo/editor-core": path.resolve(process.cwd(), "packages/editor-core/src/index.ts"),
      "@qingmo/shared": path.resolve(process.cwd(), "packages/shared/src/index.ts"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./bench/setup.ts"],
    include: ["bench/**/*.bench.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    restoreMocks: true,
    testTimeout: 600_000,
    hookTimeout: 600_000,
    // Benchmarks run serially and should measure compute, not a scavenge
    // triggered by the measurement loop itself. A larger young generation
    // keeps the outline matrix's short-lived entry arrays out of GC p95;
    // browser GC pauses are covered by `e2e/outline-perf.spec.ts`.
    execArgv: ["--max-semi-space-size=256", "--max-old-space-size=4096"],
  },
});
