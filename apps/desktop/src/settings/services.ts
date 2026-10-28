import { isTauriRuntime } from "../lib/platform/runtime";
import { FakeSettings } from "../lib/settings/fake";
import type { SettingsPort } from "../lib/settings/port";
import { createTauriSettings } from "../lib/settings/tauri";

export interface SettingsServices {
  settings: SettingsPort;
}

/**
 * `settings.html` is a separate entry, so it boots only the window-local
 * service graph instead of the document-app adapters.
 */
export function createSettingsServices(): SettingsServices {
  if (isTauriRuntime()) {
    return { settings: createTauriSettings() };
  }

  const settings = new FakeSettings();
  if (import.meta.env.MODE === "e2e") {
    Object.assign(window, { __QINGMO_SETTINGS_E2E__: { settings } });
  }
  return { settings };
}
