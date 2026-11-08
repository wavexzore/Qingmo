import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./i18n";
import "./styles.css";
import { watchUiStorage } from "./app/uiStorageSync";
import { uiStore } from "./stores/uiStore";

// The WDIO plugin is test-only. The e2e build sets VITE_WDIO_PLUGIN=1;
// normal builds constant-fold the condition away.
if (import.meta.env.VITE_WDIO_PLUGIN === "1") {
  void import("@wdio/tauri-plugin");
}

// Apply the persisted theme before the first React render to avoid a flash.
uiStore.initialize();
watchUiStorage(uiStore);

const container = document.getElementById("root");

if (!container) {
  throw new Error("Root container #root is missing");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
