import { FakeAbout } from "../lib/about/fake";
import type { AboutPort } from "../lib/about/port";
import { createTauriAbout } from "../lib/about/tauri";
import { isTauriRuntime } from "../lib/platform/runtime";
import { FakeUpdatePort } from "../lib/update/fake";
import type { UpdatePort } from "../lib/update/port";
import { createTauriUpdatePort } from "../lib/update/tauri";

export interface AboutServices {
  about: AboutPort;
  updates: UpdatePort;
}

/**
 * Production uses Rust for build metadata and links; a plain browser (Vite,
 * Playwright) gets deterministic adapters. `about.html` is a separate entry, so
 * it must not boot the document-app service graph.
 */
export function createAboutServices(): AboutServices {
  if (isTauriRuntime()) {
    return {
      about: createTauriAbout(),
      updates: createTauriUpdatePort(),
    };
  }

  const about = new FakeAbout();
  const updates = new FakeUpdatePort();
  if (import.meta.env.MODE === "e2e") {
    Object.assign(window, { __QINGMO_ABOUT_E2E__: { about, updates } });
  }
  return { about, updates };
}
