import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import i18n from "../i18n";
import { LocaleController } from "../app/LocaleController";
import { watchUiStorage } from "../app/uiStorageSync";
import { uiStore } from "../stores/uiStore";
import { SettingsWindow } from "./SettingsWindow";
import { createSettingsServices } from "./services";
import "@qingmo/ui/tokens.css";
import "./settings.css";

// The settings window is a separate webview: apply the persisted preference
// before React renders, then follow changes made by another window.
uiStore.initialize();
const localeController = new LocaleController({
  store: uiStore,
  i18n,
  // Native menus and window titles are app-wide; the editable windows project
  // them. Settings only translates its own webview.
  native: null,
});
localeController.start();
watchUiStorage(uiStore);

const container = document.getElementById("root");

if (!container) {
  throw new Error("Root container #root is missing");
}

const services = createSettingsServices();

createRoot(container).render(
  <StrictMode>
    <SettingsWindow settings={services.settings} />
  </StrictMode>,
);
