import { config as base } from "./wdio.conf";

// A single spec: the soak owns the app for its whole run, so running the
// regular suite in the same session would fight over the shared fixture.
export const config = {
  ...base,
  specs: [["./e2e-tauri/specs/soak.spec.ts"]],
  exclude: [],
};
