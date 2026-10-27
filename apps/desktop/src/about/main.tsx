import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "../i18n";
import { THEME_STORAGE_KEY, uiStore } from "../stores/uiStore";
import { AboutWindow } from "./AboutWindow";
import { createAboutServices } from "./services";
import "@qingmo/ui/tokens.css";
import "./about.css";

// The About window is a separate webview: apply the persisted preference
// before React renders, then follow changes made by the main window.
uiStore.initialize();
window.addEventListener("storage", (event) => {
  if (event.key === THEME_STORAGE_KEY) {
    uiStore.syncFromStorage();
  }
});

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
