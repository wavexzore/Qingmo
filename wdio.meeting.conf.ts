import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Options } from "@wdio/types";

const root = path.dirname(fileURLToPath(import.meta.url));
const binary = path.join(root, "src-tauri", "target", "debug", "qingmo");
const fixture = path.join(root, "e2e-tauri", "fixtures", "note.md");
const e2eEnv = path.join(root, "e2e-tauri", "fixtures", "meeting", "e2e-env.json");

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
  specs: [["./e2e-tauri/specs/meeting*.spec.ts"]],
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
        env: {
          QINGMO_E2E_OPEN: fixture,
          QINGMO_E2E_ENV: e2eEnv,
          ...(process.env.E2E_MODELS || process.env.MEETING_E2E_MODELS
            ? { MEETING_E2E_MODELS: process.env.E2E_MODELS ?? process.env.MEETING_E2E_MODELS! }
            : {}),
        },
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
    // Real-model specs decode several minutes of audio in a debug build and
    // `this.timeout()` is not honoured by the embedded runner.
    timeout: 2_400_000,
  },
};
