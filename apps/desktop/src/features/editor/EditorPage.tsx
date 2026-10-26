import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { Button } from "@qingmo/ui";

import { StatusBar, type StatusBarSnapshot } from "../../components/StatusBar";
import type { EditorSession } from "./EditorSession";
import { useDocumentSession } from "./DocumentSessionContext";

function EmptyEditor() {
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

      <StatusBar />
    </main>
  );
}

function DocumentOverview({ session }: { session: EditorSession }) {
  const { t } = useTranslation(["common", "editor"]);
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);

  const readOnlyLabel =
    snapshot.readOnlyReason === "mdx"
      ? t("editor:document.readOnlyMdx")
      : snapshot.readOnlyReason === "mixedEol"
        ? t("editor:document.readOnlyMixedEol")
        : t("editor:document.readOnly");

  const formatLabel = [
    snapshot.format.encoding,
    snapshot.format.eol,
    snapshot.format.hasBom ? "BOM" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const status: StatusBarSnapshot = {
    fileName: snapshot.fileName,
    saveState: snapshot.saveState,
    cursor: snapshot.cursor,
    encoding: snapshot.format.encoding,
    eol: snapshot.format.eol,
    size: snapshot.size,
    mode: "source",
  };

  return (
    <main className="grid h-dvh grid-rows-[1fr_auto] bg-paper text-ink">
      <div className="min-h-0 overflow-auto p-6">
        <section
          data-testid="document-session"
          className="mx-auto w-full max-w-[720px] rounded-card border border-line bg-surface p-8 shadow-card"
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[10px] uppercase tracking-[0.18em] text-accent">
                {t("common:appNameLatin")}
              </p>
              <h1 className="mt-2 break-words font-serif text-3xl tracking-[-0.03em]">
                {snapshot.fileName}
              </h1>
              <p className="mt-2 text-sm leading-7 text-ink-muted">
                {t("editor:document.description")}
              </p>
            </div>
            {snapshot.readOnly ? (
              <span
                data-testid="read-only-badge"
                className="shrink-0 rounded-full border border-line-strong bg-surface-muted px-3 py-1 text-xs text-ink-muted"
              >
                {readOnlyLabel}
              </span>
            ) : null}
          </div>

          <dl className="mt-8 grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
            <div className="sm:col-span-2">
              <dt className="text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                {t("editor:document.path")}
              </dt>
              <dd className="mt-1 break-all font-mono text-xs text-ink-muted">{snapshot.docId}</dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                {t("editor:document.format")}
              </dt>
              <dd className="mt-1 text-ink-muted">{formatLabel}</dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                {t("editor:document.units")}
              </dt>
              <dd className="mt-1 text-ink-muted">{snapshot.textUnits}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                {t("editor:document.hash")}
              </dt>
              <dd className="mt-1 truncate font-mono text-xs text-ink-faint" title={snapshot.hash}>
                {snapshot.hash}
              </dd>
            </div>
          </dl>

          <p className="mt-8 rounded-md border border-dashed border-line bg-surface-muted/60 px-4 py-3 text-xs leading-6 text-ink-muted">
            {t("editor:document.viewPending")}
          </p>

          <div className="mt-7 flex flex-wrap items-center gap-3">
            <Link
              to="/"
              className="inline-flex h-10 items-center rounded-md px-2 text-sm text-ink-muted underline decoration-line-strong underline-offset-4 transition-colors duration-[var(--qm-duration-fast)] hover:text-ink"
            >
              {t("common:actions.backToWelcome")}
            </Link>
          </div>
        </section>
      </div>

      <StatusBar snapshot={status} />
    </main>
  );
}

export function EditorPage() {
  const { session } = useDocumentSession();
  return session ? <DocumentOverview session={session} /> : <EmptyEditor />;
}
