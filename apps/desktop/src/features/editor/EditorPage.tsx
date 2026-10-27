import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button, cx } from "@qingmo/ui";

import { StatusBar } from "../../components/StatusBar";
import { useWorkspaceActions } from "../workspace/WorkspaceLayout";
import { ConflictBanner } from "./ConflictBanner";
import { EditorHost } from "./EditorHost";
import { useDocumentSession } from "./DocumentSessionContext";
import { useEditor } from "./useEditor";
import { useEditorStatus } from "./useEditorStatus";
import { useSaveCoordinator } from "./useSaveCoordinator";

function DocumentEditor() {
  const { t } = useTranslation(["common", "editor"]);
  const { openDocument, opening } = useWorkspaceActions();
  const { session, metadata } = useEditor();
  const { coordinator } = useDocumentSession();
  const status = useEditorStatus(session);
  const save = useSaveCoordinator(coordinator);
  const [dismissedConflict, setDismissedConflict] = useState<string | null>(null);
  const [conflictActionError, setConflictActionError] = useState<string | null>(null);

  const untitled = session.isUntitled;
  const conflict = save.state === "conflict" ? save.conflict : null;
  const showConflict = !untitled && conflict !== null && conflict.currentHash !== dismissedConflict;
  const showStatusBar = !untitled || status.saveState !== "clean";

  const retrySave = useCallback(() => {
    if (coordinator) {
      void coordinator.retry();
    }
  }, [coordinator]);

  const reloadConflict = useCallback(async () => {
    const result = await coordinator?.reload();
    // A failed reload keeps the banner open; surface only the action error,
    // never the CONFLICT code that merely opened the banner.
    setConflictActionError(result && !result.ok ? (result.error?.code ?? "IO") : null);
  }, [coordinator]);

  const overwriteConflict = useCallback(async () => {
    const result = await coordinator?.forceSave();
    setConflictActionError(result && !result.ok ? (result.error?.code ?? "IO") : null);
  }, [coordinator]);

  const readOnlyLabel =
    metadata.readOnlyReason === "mdx"
      ? t("editor:document.readOnlyMdx")
      : metadata.readOnlyReason === "mixedEol"
        ? t("editor:document.readOnlyMixedEol")
        : t("editor:document.readOnly");

  return (
    <main
      data-testid={untitled ? "untitled-editor" : "document-session"}
      data-untitled={untitled ? "true" : undefined}
      className={cx(
        "grid h-dvh bg-paper text-ink",
        showStatusBar ? "grid-rows-[auto_1fr_auto]" : "grid-rows-[auto_1fr]",
      )}
    >
      <div className="min-w-0">
        {untitled ? (
          <header className="flex h-12 items-center justify-between gap-4 px-5">
            <h1 className="truncate font-serif text-lg tracking-[-0.02em]">{metadata.fileName}</h1>
            <Button
              variant="ghost"
              className="h-8 shrink-0 border-transparent px-3 text-xs text-ink-faint hover:text-ink"
              onClick={() => void openDocument()}
              disabled={opening}
              aria-busy={opening}
            >
              {t("common:actions.openFile")}
            </Button>
          </header>
        ) : (
          <header className="flex min-w-0 items-center gap-4 border-b border-line bg-surface/80 px-5 py-3 backdrop-blur">
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-baseline gap-3">
                <h1 className="truncate font-serif text-lg tracking-[-0.02em]">
                  {metadata.fileName}
                </h1>
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

            {!showConflict && conflict ? (
              <button
                type="button"
                data-testid="conflict-reopen"
                onClick={() => {
                  setDismissedConflict(null);
                }}
                className="shrink-0 rounded-full border border-danger/40 bg-danger/[0.08] px-3 py-1 text-xs text-danger transition-colors hover:bg-danger/[0.14]"
              >
                {t("editor:conflict.reopen")}
              </button>
            ) : null}

            <Button
              variant="ghost"
              className="h-8 shrink-0 px-3 text-xs"
              onClick={() => void openDocument()}
              disabled={opening}
              aria-busy={opening}
            >
              {t("common:actions.openFile")}
            </Button>
          </header>
        )}

        {showConflict && conflict ? (
          <ConflictBanner
            conflict={conflict}
            errorCode={conflictActionError}
            onReload={reloadConflict}
            onOverwrite={overwriteConflict}
            onDismiss={() => {
              setDismissedConflict(conflict.currentHash);
            }}
          />
        ) : null}
      </div>

      <div className={untitled ? "mx-auto h-full min-h-0 w-full max-w-[820px]" : "min-h-0 min-w-0"}>
        <EditorHost session={session} autoFocus={untitled} />
      </div>

      {showStatusBar ? <StatusBar snapshot={status} onRetry={retrySave} /> : null}
    </main>
  );
}

export function EditorPage() {
  const { session } = useDocumentSession();
  return session ? <DocumentEditor /> : null;
}
