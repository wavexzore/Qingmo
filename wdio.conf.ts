import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Options } from "@wdio/types";

const root = path.dirname(fileURLToPath(import.meta.url));
const binary = path.join(root, "src-tauri", "target", "debug", "qingmo");
const fixture = path.join(root, "e2e-tauri", "fixtures", "note.md");

// The Rust test feature reads this during setup. Setting it here also covers
// the service's child-process environment on every platform.
process.env.QINGMO_E2E_OPEN = fixture;

type TestrunnerConfig = Options.Testrunner & {
  capabilities: Array<Record<string, unknown>>;
};

export const config: TestrunnerConfig = {
  runner: "local",
  // One worker: the embedded provider owns a single app process, and most
  // specs share its one pinned document fixture. New specs (meeting, …) are
  // picked up automatically; long-running soak stays out of the default run.
  specs: [["./e2e-tauri/specs/*.spec.ts"]],
  exclude: ["./e2e-tauri/specs/soak.spec.ts"],
  maxInstances: 1,
  capabilities: [
    {
      browserName: "tauri",
      maxInstances: 1,
      "tauri:options": { application: binary },
    },
  ],
  logLevel: "info",
  bail: 0,
  waitforTimeout: 10_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 1,
  services: [
    [
      "@wdio/tauri-service",
      {
        driverProvider: "embedded",
        appBinaryPath: binary,
        env: { QINGMO_E2E_OPEN: fixture },
        captureBackendLogs: true,
        captureFrontendLogs: true,
        startTimeout: 120_000,
        commandTimeout: 60_000,
      },
    ],
  ],
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    timeout: 120_000,
  },
};
