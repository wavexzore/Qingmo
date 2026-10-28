import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import i18n from "../i18n";
import { LocaleController } from "../app/LocaleController";
import { watchUiStorage } from "../app/uiStorageSync";
import { uiStore } from "../stores/uiStore";
import { AboutWindow } from "./AboutWindow";
import { createAboutServices } from "./services";
import "@qingmo/ui/tokens.css";
import "./about.css";

// The About window is a separate webview: apply the persisted preference
// before React renders, then follow changes made by the main window.
uiStore.initialize();
const localeController = new LocaleController({
  store: uiStore,
  i18n,
  // Native menus/titles are app-wide; only the main window projects them.
  native: null,
});
localeController.start();
watchUiStorage(uiStore);

const container = document.getElementById("root");

if (!container) {
  throw new Error("Root container #root is missing");
}

const services = createAboutServices();

createRoot(container).render(
  <StrictMode>
    <AboutWindow about={services.about} updates={services.updates} />
  </StrictMode>,
);
