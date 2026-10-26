import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { Button } from "@qingmo/ui";

import { useWorkspaceActions } from "./WorkspaceLayout";

export function WelcomePage() {
  const { t } = useTranslation(["common"]);
  const { openDocument, opening } = useWorkspaceActions();

  return (
    <main className="relative grid min-h-dvh place-items-center overflow-hidden bg-paper p-6 text-ink">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_18%_12%,var(--qm-accent-soft),transparent_34%),radial-gradient(circle_at_82%_88%,rgba(154,106,31,0.08),transparent_32%)]"
      />

      <section className="relative w-full max-w-[560px] rounded-card border border-line bg-surface p-9 shadow-card sm:p-11">
        <header className="flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-md bg-accent font-serif text-lg text-surface-raised shadow-[inset_0_1px_0_rgba(255,255,255,0.22)]">
            青
          </span>
          <div>
            <h1 className="font-serif text-2xl tracking-[0.06em]">{t("common:appName")}</h1>
            <p className="text-[9px] uppercase tracking-[0.24em] text-ink-faint">
              {t("common:appNameLatin")}
            </p>
          </div>
        </header>

        <p className="mt-10 text-[10px] uppercase tracking-[0.18em] text-accent">
          {t("common:welcome.kicker")}
        </p>
        <h2 className="mt-3 text-balance font-serif text-[34px] leading-[1.22] tracking-[-0.04em] sm:text-[40px]">
          {t("common:welcome.title")}
        </h2>
        <p className="mt-4 max-w-[44ch] text-sm leading-7 text-ink-muted">
          {t("common:welcome.description")}
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Button onClick={openDocument} disabled={opening} aria-busy={opening}>
            {t("common:actions.openFile")}
          </Button>
          <Link
            to="/editor"
            className="inline-flex h-10 items-center rounded-md px-2 text-sm text-ink-muted underline decoration-line-strong underline-offset-4 transition-colors duration-[var(--qm-duration-fast)] hover:text-ink"
          >
            {t("common:actions.openEditor")}
          </Link>
        </div>

        <section className="mt-10 border-t border-line pt-6" aria-labelledby="recent-heading">
          <h2
            id="recent-heading"
            className="text-[10px] uppercase tracking-[0.16em] text-ink-faint"
          >
            {t("common:welcome.recentTitle")}
          </h2>
          <p className="mt-3 rounded-md border border-dashed border-line bg-surface-muted/60 px-4 py-3 text-xs leading-6 text-ink-muted">
            {t("common:welcome.recentEmpty")}
          </p>
        </section>
      </section>
    </main>
  );
}
