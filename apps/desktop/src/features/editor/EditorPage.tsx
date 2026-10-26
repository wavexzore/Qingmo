import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { Button } from "@qingmo/ui";

import { StatusBar } from "../../components/StatusBar";
import { EditorHost } from "./EditorHost";
import { useDocumentSession } from "./DocumentSessionContext";
import { useEditor } from "./useEditor";
import { useEditorStatus } from "./useEditorStatus";

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

function DocumentEditor() {
  const { t } = useTranslation(["common", "editor"]);
  const { session, metadata } = useEditor();
  const status = useEditorStatus(session);

  const readOnlyLabel =
    metadata.readOnlyReason === "mdx"
      ? t("editor:document.readOnlyMdx")
      : metadata.readOnlyReason === "mixedEol"
        ? t("editor:document.readOnlyMixedEol")
        : t("editor:document.readOnly");

  return (
    <main
      data-testid="document-session"
      className="grid h-dvh grid-rows-[auto_1fr_auto] bg-paper text-ink"
    >
      <header className="flex min-w-0 items-center gap-4 border-b border-line bg-surface/80 px-5 py-3 backdrop-blur">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-3">
            <h1 className="truncate font-serif text-lg tracking-[-0.02em]">{metadata.fileName}</h1>
            <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
              {metadata.format.encoding} · {metadata.format.eol}
            </span>
          </div>
          <p
            className="mt-0.5 truncate font-mono text-[11px] text-ink-faint"
            title={metadata.docId}
          >
            {metadata.docId}
          </p>
        </div>

        {metadata.readOnly ? (
          <span
            data-testid="read-only-badge"
            className="shrink-0 rounded-full border border-line-strong bg-surface-muted px-3 py-1 text-xs text-ink-muted"
          >
            {readOnlyLabel}
          </span>
        ) : null}

        <Link
          to="/"
          className="shrink-0 rounded-md px-2 text-xs text-ink-muted underline decoration-line-strong underline-offset-4 transition-colors duration-[var(--qm-duration-fast)] hover:text-ink"
        >
          {t("common:actions.backToWelcome")}
        </Link>
      </header>

      <EditorHost session={session} />

      <StatusBar snapshot={status} />
    </main>
  );
}

export function EditorPage() {
  const { session } = useDocumentSession();
  return session ? <DocumentEditor /> : <EmptyEditor />;
}
