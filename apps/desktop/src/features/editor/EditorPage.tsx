import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import { StatusBar } from "../../components/StatusBar";
import { ConflictBanner } from "./ConflictBanner";
import { EditorHost } from "./EditorHost";
import { useDocumentSession } from "./DocumentSessionContext";
import { useEditor } from "./useEditor";
import { useEditorStatus } from "./useEditorStatus";
import { useSaveCoordinator } from "./useSaveCoordinator";

function DocumentEditor() {
  const { t } = useTranslation(["common", "editor"]);
  const { session } = useEditor();
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

  return (
    <main
      data-testid={untitled ? "untitled-editor" : "document-session"}
      data-untitled={untitled ? "true" : undefined}
      className="flex h-dvh flex-col bg-paper text-ink"
    >
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

      {!showConflict && conflict ? (
        <div className="flex h-10 shrink-0 items-center justify-end border-b border-line bg-surface/80 px-5">
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
        </div>
      ) : null}

      <div
        className={
          untitled ? "mx-auto min-h-0 w-full max-w-[820px] flex-1" : "min-h-0 w-full flex-1"
        }
      >
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
