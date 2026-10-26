import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { Button } from "@qingmo/ui";

import { StatusBar, EMPTY_STATUS_SNAPSHOT } from "../../components/StatusBar";

export function EditorPage() {
  const { t } = useTranslation(["common", "editor"]);

  return (
    <main className="grid h-dvh grid-rows-[1fr_auto] bg-paper text-ink">
      <div className="grid min-h-0 place-items-center p-6">
        <section className="w-full max-w-[520px] rounded-card border border-line bg-surface p-8 shadow-card">
          <p className="text-[10px] uppercase tracking-[0.18em] text-accent">
            {t("common:appNameLatin")}
          </p>
          <h1 className="mt-3 font-serif text-3xl tracking-[-0.03em]">{t("editor:empty.title")}</h1>
          <p className="mt-3 text-sm leading-7 text-ink-muted">{t("editor:empty.description")}</p>
          <p className="mt-4 rounded-md border border-dashed border-line bg-surface-muted/60 px-4 py-3 text-xs leading-6 text-ink-muted">
            {t("editor:empty.hint")}
          </p>

          <div className="mt-7 flex flex-wrap items-center gap-3">
            <Button disabled>{t("editor:empty.openButton")}</Button>
            <Link
              to="/"
              className="inline-flex h-10 items-center rounded-md px-2 text-sm text-ink-muted underline decoration-line-strong underline-offset-4 transition-colors duration-[var(--qm-duration-fast)] hover:text-ink"
            >
              {t("common:actions.backToWelcome")}
            </Link>
          </div>
        </section>
      </div>

      <StatusBar snapshot={EMPTY_STATUS_SNAPSHOT} />
    </main>
  );
}
