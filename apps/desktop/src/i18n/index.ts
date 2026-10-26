import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import { en } from "./locales/en";
import { zhCN } from "./locales/zh-CN";

export const resources = {
  "zh-CN": zhCN,
  en,
} as const;

export type SupportedLanguage = keyof typeof resources;

export const DEFAULT_LANGUAGE: SupportedLanguage = "zh-CN";

void i18n.use(initReactI18next).init({
  resources,
  lng: DEFAULT_LANGUAGE,
  fallbackLng: "en",
  supportedLngs: Object.keys(resources),
  defaultNS: "common",
  ns: ["common", "editor", "errors", "commands"],
  interpolation: { escapeValue: false },
  returnNull: false,
  initAsync: false,
  react: { useSuspense: false },
});

export default i18n;
