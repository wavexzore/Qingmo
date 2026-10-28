import type { NativeShellLabels } from "@qingmo/shared";

import i18n from "./index";
import type { SupportedLanguage } from "./language";

/**
 * Builds the only native-shell projection. Rust validates and renders this
 * DTO; it never keeps a second translation table.
 */
export function buildNativeShellLabels(language: SupportedLanguage): NativeShellLabels {
  const menu = i18n.getFixedT(language, "menu");
  const common = i18n.getFixedT(language, "common");
  const appName = common("appName");

  return {
    appName,
    about: menu("about", { appName }),
    settings: menu("settings"),
    services: menu("services"),
    hideApp: menu("hideApp", { appName }),
    hideOthers: menu("hideOthers"),
    showAll: menu("showAll"),
    quitApp: menu("quitApp", { appName }),
    file: menu("file"),
    open: menu("open"),
    save: menu("save"),
    closeWindow: menu("closeWindow"),
    edit: menu("edit"),
    undo: menu("undo"),
    redo: menu("redo"),
    cut: menu("cut"),
    copy: menu("copy"),
    paste: menu("paste"),
    selectAll: menu("selectAll"),
    view: menu("view"),
    livePreview: menu("livePreview"),
    commandPalette: menu("commandPalette"),
    toggleTheme: menu("toggleTheme"),
    logs: menu("logs"),
    fullscreen: menu("fullscreen"),
    theme: menu("theme"),
    themeLight: menu("themeLight"),
    themeDark: menu("themeDark"),
    themeSystem: menu("themeSystem"),
    language: menu("language"),
    languageZhCN: menu("languageZhCN"),
    languageEn: menu("languageEn"),
    window: menu("window"),
    minimize: menu("minimize"),
    zoom: menu("zoom"),
    maximize: menu("maximize"),
    bringAllToFront: menu("bringAllToFront"),
    help: menu("help"),
    untitledFileName: menu("untitledFileName"),
  };
}
