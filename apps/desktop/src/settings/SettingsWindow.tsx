import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { SettingsPort } from "../lib/settings/port";
import { GeneralSettings } from "./GeneralSettings";

export interface SettingsWindowProps {
  settings: SettingsPort;
}

/**
 * The Colophon settings window.
 *
 * The native window is transparent and decoration-free, so this sheet owns the
 * whole visible surface. General preferences go through `uiStore`.
 */
export function SettingsWindow({ settings }: SettingsWindowProps) {
  const { t } = useTranslation("settings");
  const [version, setVersion] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [windowFocused, setWindowFocused] = useState(() => document.hasFocus());
  const toastTimer = useRef<number | null>(null);

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
            <button
              className="settings-nav-item"
              type="button"
              data-testid="nav-general"
              aria-current="page"
            >
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

            <GeneralSettings onToast={showToast} />
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
