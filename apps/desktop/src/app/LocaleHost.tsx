import { useEffect } from "react";

import i18n from "../i18n";
import { uiStore } from "../stores/uiStore";
import { LocaleController } from "./LocaleController";
import { useAppServices } from "./AppServices";

/**
 * Owns the main-window locale controller. It sits inside AppServices (which
 * provides the IPC port) and outside DocumentSession (which consumes i18n).
 */
export function LocaleHost() {
  const { ipc } = useAppServices();

  useEffect(() => {
    const controller = new LocaleController({
      store: uiStore,
      i18n,
      native: ipc,
    });
    controller.start();
    return () => {
      controller.stop();
    };
  }, [ipc]);

  return null;
}
