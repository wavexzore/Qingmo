import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import { uiStore } from "../stores/uiStore";
import { DEFAULT_LANGUAGE, type SupportedLanguage } from "./language";
import { en } from "./locales/en";
import { zhCN } from "./locales/zh-CN";

export const resources = {
  "zh-CN": zhCN,
  en,
} as const;

export type { SupportedLanguage } from "./language";
export {
  DEFAULT_LANGUAGE,
  SUPPORTED_LANGUAGES,
  isSupportedLanguage,
  normalizeLanguage,
} from "./language";

const namespaces = Object.keys(resources[DEFAULT_LANGUAGE]);

function syncDocumentLanguage(language: string): void {
  if (typeof document !== "undefined") {
    document.documentElement.lang = language;
  }
}

void i18n.use(initReactI18next).init({
  resources,
  lng: uiStore.getSnapshot().language,
  fallbackLng: "en",
  supportedLngs: Object.keys(resources),
  defaultNS: "common",
  ns: namespaces,
  interpolation: { escapeValue: false },
  returnNull: false,
  initAsync: false,
  react: { useSuspense: false },
});

i18n.on("languageChanged", syncDocumentLanguage);
syncDocumentLanguage((i18n.language as SupportedLanguage | undefined) ?? DEFAULT_LANGUAGE);

export default i18n;
