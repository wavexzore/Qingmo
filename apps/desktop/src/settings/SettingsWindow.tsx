import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  DEFAULT_EDITOR_TYPOGRAPHY,
  EDITOR_FONT_FAMILY_CSS_VAR,
  EDITOR_FONT_FAMILY_IDS,
  EDITOR_FONT_SIZE_MAX,
  EDITOR_FONT_SIZE_MIN,
  EDITOR_LINE_HEIGHT,
  editorTypographyEquals,
  type EditorTypography,
} from "@qingmo/shared";

import i18n from "../i18n";
import type { SupportedLanguage } from "../i18n/language";
import type { SettingsPort } from "../lib/settings/port";
import { uiStore, useUiPreferences } from "../stores/uiStore";
import { LanguageSelect, type LanguageOption } from "./LanguageSelect";

export interface SettingsWindowProps {
  settings: SettingsPort;
}

/**
 * The Colophon settings window.
 *
 * The native window is transparent and decoration-free, so this sheet owns the
 * whole visible surface. Language changes go through `uiStore` only: the
 * window-local `LocaleController` translates this webview, while the other
 * windows pick up the persisted value through `watchUiStorage`.
 */
export function SettingsWindow({ settings }: SettingsWindowProps) {
  const { t } = useTranslation("settings");
  const { language, typography } = useUiPreferences();
  const [version, setVersion] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [windowFocused, setWindowFocused] = useState(() => document.hasFocus());
  const toastTimer = useRef<number | null>(null);
  const typographyWarned = useRef(false);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current !== null) {
      window.clearTimeout(toastTimer.current);
    }
    toastTimer.current = window.setTimeout(() => {
      setToast(null);
      toastTimer.current = null;
    }, 2200);
  }, []);

  const handleClose = useCallback(() => {
    if (closing) {
      return;
    }
    setClosing(true);
    void settings.close().catch((error: unknown) => {
      console.error("failed to close the settings window", error);
      setClosing(false);
    });
  }, [closing, settings]);

  useEffect(() => {
    let cancelled = false;
    void settings
      .info()
      .then((next) => {
        if (!cancelled) {
          setVersion(next);
        }
      })
      .catch((error: unknown) => {
        console.error("failed to load the settings metadata", error);
      });
    return () => {
      cancelled = true;
    };
  }, [settings]);

  useEffect(() => {
    const handleFocus = () => setWindowFocused(true);
    const handleBlur = () => setWindowFocused(false);
    window.addEventListener("focus", handleFocus);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("blur", handleBlur);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimer.current !== null) {
        window.clearTimeout(toastTimer.current);
      }
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }
      if (document.querySelector('[data-language-select][data-open="true"]')) {
        return;
      }
      event.preventDefault();
      handleClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleClose]);

  const handleLanguageChange = useCallback(
    (next: SupportedLanguage) => {
      if (next === language) {
        return;
      }
      uiStore.setLanguage(next);
      const nextT = i18n.getFixedT(next, "settings");
      const nativeName = nextT(next === "zh-CN" ? "language.zhCN" : "language.en");
      showToast(nextT("toast.languageChanged", { language: nativeName }));
    },
    [language, showToast],
  );

  const commitTypography = useCallback(
    (next: EditorTypography): boolean => {
      const persisted = uiStore.setTypography(next);
      if (!persisted && !typographyWarned.current) {
        typographyWarned.current = true;
        showToast(t("toast.typographyPersistenceFailed"));
      }
      return persisted;
    },
    [showToast, t],
  );

  const updateTypography = useCallback(
    (patch: Partial<EditorTypography>) => {
      const current = uiStore.getSnapshot().typography;
      commitTypography({ ...current, ...patch });
    },
    [commitTypography],
  );

  const resetTypography = useCallback(() => {
    if (commitTypography(DEFAULT_EDITOR_TYPOGRAPHY)) {
      showToast(t("toast.typographyReset"));
    }
  }, [commitTypography, showToast, t]);

  const languageOptions: LanguageOption[] = [
    {
      value: "zh-CN",
      nativeName: t("language.zhCN"),
      detail: t("language.zhCNDetail"),
      code: t("language.zhCNCode"),
    },
    {
      value: "en",
      nativeName: t("language.en"),
      detail: t("language.enDetail"),
      code: t("language.enCode"),
    },
  ];

  return (
    <main
      className="settings-window"
      aria-label={t("aria.window")}
      data-testid="settings-window"
      data-window-focused={windowFocused ? "true" : "false"}
    >
      <header className="settings-chrome" data-tauri-drag-region="deep">
        <div className="settings-traffic">
          <button
            className="settings-dot close"
            type="button"
            aria-label={t("actions.close")}
            data-testid="settings-close"
            onClick={handleClose}
          >
            <svg viewBox="0 0 8 8" fill="none" aria-hidden="true">
              <path d="M1.1 1.1 6.9 6.9M6.9 1.1 1.1 6.9" stroke="currentColor" strokeWidth="1.75" />
            </svg>
          </button>
        </div>
        <span className="settings-chrome-title">Qingmo</span>
        <span className="settings-chrome-meta">{version ? `v${version}` : ""}</span>
      </header>

      <div className="settings-body">
        <aside className="settings-rail" aria-label={t("aria.rail")}>
          <p className="settings-kicker">{t("windowLabel")}</p>
          <p className="settings-rail-title">{t("title")}</p>
          <p className="settings-rail-lede">{t("lede")}</p>

          <nav className="settings-nav" aria-label={t("aria.rail")}>
            <p className="settings-nav-caption">{t("nav.caption")}</p>
            <button className="settings-nav-item" type="button" aria-current="page">
              <span className="settings-nav-index">01</span>
              <span className="settings-nav-copy">
                <span className="settings-nav-label">{t("nav.general")}</span>
                <span className="settings-nav-note">{t("nav.generalNote")}</span>
              </span>
              <span className="settings-nav-mark" aria-hidden="true" />
            </button>
          </nav>

          <p className="settings-rail-note">{t("storageNote")}</p>

          <footer className="settings-rail-foot">
            <span className="settings-rail-sig">{t("localFirst")}</span>
            <span>{version ? `v${version}` : ""}</span>
          </footer>
        </aside>

        <div className="settings-main">
          <div className="settings-scroll">
            <p className="settings-breadcrumb">
              <span>{t("breadcrumb.settings")}</span>
              <span className="settings-slash" aria-hidden="true">
                /
              </span>
              <span>{t("breadcrumb.general")}</span>
            </p>

            <header className="settings-head">
              <h1>{t("heading")}</h1>
              <p>{t("description")}</p>
            </header>

            <section className="settings-section" aria-labelledby="settings-interface-heading">
              <header className="settings-section-head">
                <span className="settings-section-num">01</span>
                <h2 id="settings-interface-heading">{t("section.interface")}</h2>
                <span className="settings-section-rule" aria-hidden="true" />
              </header>

              <div className="settings-row">
                <div className="settings-copy">
                  <h3 id="settings-language-heading">{t("language.title")}</h3>
                  <p>{t("language.description")}</p>
                </div>

                <LanguageSelect
                  value={language}
                  options={languageOptions}
                  label={t("language.ariaLabel")}
                  onChange={handleLanguageChange}
                />
              </div>

              <p className="settings-hint">{t("hint")}</p>
            </section>

            <section className="settings-section" aria-labelledby="settings-typography-heading">
              <header className="settings-section-head">
                <span className="settings-section-num">02</span>
                <h2 id="settings-typography-heading">{t("section.typography")}</h2>
                <span className="settings-section-rule" aria-hidden="true" />
              </header>

              <div className="settings-row">
                <div className="settings-copy">
                  <h3 id="settings-font-size-heading">{t("typography.fontSize")}</h3>
                  <p>{t("typography.fontSizeHint")}</p>
                </div>
                <div className="settings-typography-controls">
                  <div className="settings-range-row">
                    <input
                      id="settings-font-size"
                      data-testid="settings-font-size"
                      className="settings-range"
                      type="range"
                      min={EDITOR_FONT_SIZE_MIN}
                      max={EDITOR_FONT_SIZE_MAX}
                      step={1}
                      value={typography.fontSize}
                      aria-labelledby="settings-font-size-heading"
                      aria-valuetext={`${typography.fontSize} px`}
                      onChange={(event) =>
                        updateTypography({ fontSize: Number(event.currentTarget.value) })
                      }
                    />
                    <span
                      className="settings-range-value"
                      data-testid="settings-font-size-value"
                      aria-hidden="true"
                    >
                      {typography.fontSize}px
                    </span>
                  </div>
                </div>
              </div>

              <div className="settings-row">
                <div className="settings-copy">
                  <h3 id="settings-font-family-heading">{t("typography.fontFamily")}</h3>
                  <p>{t("typography.fontFamilyHint")}</p>
                </div>
                <div
                  className="settings-font-grid"
                  role="radiogroup"
                  aria-labelledby="settings-font-family-heading"
                >
                  {EDITOR_FONT_FAMILY_IDS.map((family) => (
                    <label
                      className="settings-font-option"
                      key={family}
                      data-testid={`settings-font-option-${family}`}
                      data-checked={typography.fontFamily === family ? "true" : "false"}
                    >
                      <input
                        className="settings-font-radio"
                        type="radio"
                        name="editor-font-family"
                        value={family}
                        checked={typography.fontFamily === family}
                        data-testid={`settings-font-${family}`}
                        onChange={() => updateTypography({ fontFamily: family })}
                      />
                      <span
                        className="settings-font-sample"
                        style={{ fontFamily: EDITOR_FONT_FAMILY_CSS_VAR[family] }}
                        aria-hidden="true"
                      >
                        Aa
                      </span>
                      <span className="settings-font-name">{t(`typography.family.${family}`)}</span>
                      <span className="settings-font-detail">
                        {t(`typography.family.${family}Detail`)}
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              <div
                className="settings-type-preview"
                data-testid="settings-typography-preview"
                role="group"
                aria-label={t("typography.previewAria")}
              >
                <span className="settings-type-preview-label">{t("typography.preview")}</span>
                <p
                  style={{
                    fontFamily: EDITOR_FONT_FAMILY_CSS_VAR[typography.fontFamily],
                    fontSize: typography.fontSize,
                    lineHeight: EDITOR_LINE_HEIGHT,
                  }}
                >
                  {t("typography.previewText")}
                </p>
              </div>

              <div className="settings-typography-foot">
                <p className="settings-hint">{t("typography.hint")}</p>
                <button
                  className="settings-reset"
                  type="button"
                  data-testid="settings-typography-reset"
                  onClick={resetTypography}
                  disabled={editorTypographyEquals(typography, DEFAULT_EDITOR_TYPOGRAPHY)}
                >
                  {t("typography.reset")}
                </button>
              </div>
            </section>

            <aside className="settings-note">
              <p className="settings-note-quote">{t("note.quote")}</p>
              <p className="settings-note-body">{t("note.body")}</p>
              <span
                className={`settings-ghost${language === "en" ? " is-en" : ""}`}
                aria-hidden="true"
              >
                {t("note.ghost")}
              </span>
            </aside>
          </div>

          <footer className="settings-footer">
            <span className="settings-esc">
              <kbd>Esc</kbd>
              <span>{t("footer.esc")}</span>
            </span>
            <span className="settings-footer-meta">
              {version ? t("footer.version", { version }) : ""}
            </span>
          </footer>
        </div>
      </div>

      {toast ? (
        <div className="settings-toast show" role="status" aria-live="polite">
          {toast}
        </div>
      ) : null}
    </main>
  );
}
