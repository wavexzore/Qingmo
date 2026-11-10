import { useCallback, useRef } from "react";
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
import { uiStore, useUiPreferences } from "../stores/uiStore";
import { LanguageSelect, type LanguageOption } from "./LanguageSelect";

export interface GeneralSettingsProps {
  onToast(message: string): void;
}

/** Language and typography; UI preferences stay in `uiStore`/localStorage. */
export function GeneralSettings({ onToast }: GeneralSettingsProps) {
  const { t } = useTranslation("settings");
  const { language, typography } = useUiPreferences();
  const typographyWarned = useRef(false);

  const handleLanguageChange = useCallback(
    (next: SupportedLanguage) => {
      if (next === language) {
        return;
      }
      uiStore.setLanguage(next);
      const nextT = i18n.getFixedT(next, "settings");
      const nativeName = nextT(next === "zh-CN" ? "language.zhCN" : "language.en");
      onToast(nextT("toast.languageChanged", { language: nativeName }));
    },
    [language, onToast],
  );

  const commitTypography = useCallback(
    (next: EditorTypography): boolean => {
      const persisted = uiStore.setTypography(next);
      if (!persisted && !typographyWarned.current) {
        typographyWarned.current = true;
        onToast(t("toast.typographyPersistenceFailed"));
      }
      return persisted;
    },
    [onToast, t],
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
      onToast(t("toast.typographyReset"));
    }
  }, [commitTypography, onToast, t]);

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
    <>
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
        <span className={`settings-ghost${language === "en" ? " is-en" : ""}`} aria-hidden="true">
          {t("note.ghost")}
        </span>
      </aside>
    </>
  );
}
