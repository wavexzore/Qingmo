import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import type { AboutInfo, AboutLink } from "@qingmo/shared";

import { UpdateController } from "../features/update/UpdateController";
import type { AboutPort } from "../lib/about/port";
import type { UpdatePort } from "../lib/update/port";

export interface AboutWindowProps {
  about: AboutPort;
  updates: UpdatePort;
}

type UpdateTone = "success" | "checking" | "available" | "error";

interface StatusView {
  tone: UpdateTone;
  label: string;
}

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  const copied = document.execCommand("copy");
  area.remove();
  if (!copied) {
    throw new Error("clipboard copy was rejected");
  }
}

const EXTERNAL_ICON = (
  <svg viewBox="0 0 10 10" fill="none" aria-hidden="true">
    <path
      d="M3 2h5v5M8 2 2 8"
      stroke="currentColor"
      strokeWidth="1.1"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/**
 * The Colophon About window.
 *
 * It is intentionally self-contained: the only native boundary is `AboutPort`,
 * and update state comes from the same Rust-owned snapshots as the main app.
 */
export function AboutWindow({ about, updates }: AboutWindowProps) {
  const { t } = useTranslation(["about", "common"]);
  const [info, setInfo] = useState<AboutInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  const [controller] = useState(() => new UpdateController(updates, { autoCheck: false }));
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  useEffect(() => {
    controller.start();
    return () => controller.stop();
  }, [controller]);

  useEffect(() => {
    let cancelled = false;
    void about
      .info()
      .then((next) => {
        if (!cancelled) {
          setInfo(next);
        }
      })
      .catch((error: unknown) => {
        console.error("failed to load About metadata", error);
      });
    return () => {
      cancelled = true;
    };
  }, [about]);

  useEffect(() => {
    return () => {
      if (toastTimer.current !== null) {
        window.clearTimeout(toastTimer.current);
      }
    };
  }, []);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current !== null) {
      window.clearTimeout(toastTimer.current);
    }
    toastTimer.current = window.setTimeout(() => {
      setToast(null);
      toastTimer.current = null;
    }, 1900);
  }, []);

  const handleClose = useCallback(() => {
    void about.close().catch((error: unknown) => {
      console.error("failed to close the About window", error);
    });
  }, [about]);

  const handleCopy = useCallback(async () => {
    if (!info) {
      return;
    }
    const value = t("about:copyValue", {
      version: info.version,
      build: info.build,
      platform: info.platform,
    });
    try {
      await writeClipboard(value);
      showToast(t("about:toast.copied"));
    } catch {
      showToast(t("about:toast.copyFailed"));
    }
  }, [info, showToast, t]);

  const handleOpenLink = useCallback(
    async (link: AboutLink) => {
      try {
        await about.openLink(link);
      } catch {
        showToast(t("about:toast.openFailed"));
      }
    },
    [about, showToast, t],
  );

  const handleCheck = useCallback(async () => {
    if (checking) {
      return;
    }
    setChecking(true);
    setCheckError(false);
    try {
      await controller.check();
    } catch {
      setCheckError(true);
    } finally {
      setChecking(false);
    }
  }, [checking, controller]);

  const phase = snapshot?.phase ?? "idle";
  const checkingNow = checking || phase === "checking";
  const updateAvailable = phase === "available" && snapshot?.update !== null;
  const operationRunning = phase === "downloading" || phase === "ready" || phase === "installing";

  let status: StatusView;
  if (checkingNow) {
    status = { tone: "checking", label: t("about:status.checking") };
  } else if (phase === "available" && snapshot?.update) {
    status = {
      tone: "available",
      label: t("about:status.available", { version: snapshot.update.version }),
    };
  } else if (phase === "downloading" && snapshot?.update) {
    status = {
      tone: "available",
      label: t("about:status.downloading", { version: snapshot.update.version }),
    };
  } else if (phase === "ready" && snapshot?.update) {
    status = {
      tone: "available",
      label: t("about:status.ready", { version: snapshot.update.version }),
    };
  } else if (phase === "installing") {
    status = { tone: "available", label: t("about:status.installing") };
  } else if (checkError) {
    status = { tone: "error", label: t("about:status.error") };
  } else {
    status = { tone: "success", label: t("about:status.upToDate") };
  }

  const primaryLabel = updateAvailable
    ? t("about:actions.viewUpdate")
    : t("about:actions.checkUpdates");
  const primaryDisabled = checkingNow || operationRunning;

  const handlePrimary = useCallback(() => {
    if (updateAvailable) {
      void handleOpenLink("changelog");
    } else {
      void handleCheck();
    }
  }, [handleCheck, handleOpenLink, updateAvailable]);

  return (
    <main className="about-window" aria-label={t("about:aria.window")}>
      <header className="chrome" data-tauri-drag-region="deep">
        <div className="traffic">
          <button
            className="dot close"
            type="button"
            aria-label={t("about:actions.close")}
            data-testid="about-close"
            onClick={handleClose}
          >
            <svg viewBox="0 0 8 8" fill="none" aria-hidden="true">
              <path
                d="M2 2l4 4M6 2L2 6"
                stroke="currentColor"
                strokeWidth="1.1"
                strokeLinecap="round"
              />
            </svg>
          </button>
          <span className="dot min" aria-hidden="true" />
          <span className="dot max" aria-hidden="true" />
        </div>
        <span className="chrome-label">{t("about:windowLabel")}</span>
      </header>

      <section className="content">
        <div className="colophon">
          <div className="identity">
            <div className="identity-top">
              <img
                className="app-icon small"
                src="/qingmo-icon.png"
                alt={t("about:aria.icon")}
                width={52}
                height={52}
              />
              <div className="identity-copy">
                <p className="kicker">{t("about:kicker")}</p>
                <p>{t("about:promise")}</p>
              </div>
            </div>

            <h1 className="wordmark">{t("common:appName")}</h1>
            <p className="wordmark-en">{t("common:appNameLatin")}</p>
            <p className="manifesto">{t("about:manifesto")}</p>
          </div>

          <aside className="meta" aria-label={t("about:aria.versionInfo")}>
            <div className="meta-head">
              <span className="kicker">{t("about:edition")}</span>
              <span
                className="status"
                data-state={status.tone}
                data-testid="about-status"
                role="status"
                aria-live="polite"
              >
                <span className="status-dot" aria-hidden="true" />
                {status.label}
              </span>
            </div>

            <dl className="meta-list">
              <div className="meta-row">
                <dt>{t("about:meta.version")}</dt>
                <dd>
                  <button
                    className="value-copy"
                    type="button"
                    title={t("about:actions.copyVersion")}
                    aria-label={t("about:actions.copyVersion")}
                    data-testid="about-copy"
                    onClick={() => void handleCopy()}
                    disabled={!info}
                  >
                    <span data-testid="about-version">{info?.version ?? "—"}</span>
                    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <rect
                        x="5.25"
                        y="5.25"
                        width="7.5"
                        height="7.5"
                        rx="1.5"
                        stroke="currentColor"
                        strokeWidth="1.2"
                      />
                      <path
                        d="M10.75 5.25V4.5A1.5 1.5 0 0 0 9.25 3h-4.5A1.5 1.5 0 0 0 3.25 4.5v4.5a1.5 1.5 0 0 0 1.5 1.5h.5"
                        stroke="currentColor"
                        strokeWidth="1.2"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                </dd>
              </div>
              <div className="meta-row">
                <dt>{t("about:meta.build")}</dt>
                <dd data-testid="about-build">{info?.build ?? "—"}</dd>
              </div>
              <div className="meta-row">
                <dt>{t("about:meta.platform")}</dt>
                <dd data-testid="about-platform">{info?.platform ?? "—"}</dd>
              </div>
              <div className="meta-row">
                <dt>{t("about:meta.license")}</dt>
                <dd data-testid="about-license">{info?.license ?? "—"}</dd>
              </div>
            </dl>

            <button
              className="btn"
              type="button"
              data-testid="about-check"
              onClick={handlePrimary}
              disabled={primaryDisabled}
              aria-busy={checkingNow || undefined}
            >
              {primaryLabel}
            </button>
          </aside>
        </div>

        <footer className="footer">
          <span>{info?.copyright ?? "© 2026 Qingmo Contributors"}</span>
          <nav className="links" aria-label={t("about:aria.links")}>
            <button
              className="link"
              type="button"
              data-testid="about-link-docs"
              onClick={() => void handleOpenLink("docs")}
            >
              {t("about:links.docs")} {EXTERNAL_ICON}
            </button>
            <button
              className="link"
              type="button"
              data-testid="about-link-github"
              onClick={() => void handleOpenLink("github")}
            >
              {t("about:links.github")} {EXTERNAL_ICON}
            </button>
            <button
              className="link"
              type="button"
              data-testid="about-link-changelog"
              onClick={() => void handleOpenLink("changelog")}
            >
              {t("about:links.changelog")} {EXTERNAL_ICON}
            </button>
            <span className="divider" aria-hidden="true" />
            <button
              className="link"
              type="button"
              data-testid="about-link-license"
              onClick={() => void handleOpenLink("license")}
            >
              {t("about:links.license")}
            </button>
          </nav>
        </footer>
      </section>

      <div className={`toast${toast ? " show" : ""}`} role="status" aria-live="polite">
        {toast}
      </div>
    </main>
  );
}
