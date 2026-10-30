import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import { StatusBar } from "../../components/StatusBar";
import { ConflictBanner } from "./ConflictBanner";
import { RecoveryBanner } from "./recovery/RecoveryBanner";
import { RecoveryDialog } from "./recovery/RecoveryDialog";
import { EditorHost } from "./EditorHost";
import { OutlinePanel } from "./outline/OutlinePanel";
import { outlineVisibilityStore, useOutlineOpen } from "./outline/outlineVisibility";
import { usePanelPresence } from "./outline/usePanelPresence";
import { useDocumentSession } from "./DocumentSessionContext";
import { useEditor } from "./useEditor";
import { useEditorStatus } from "./useEditorStatus";
import { useExternalDocumentChanges } from "./useExternalDocumentChanges";
import { useSaveCoordinator } from "./useSaveCoordinator";

function DocumentEditor() {
  const { t } = useTranslation(["common", "editor"]);
  const { session } = useEditor();
  const { coordinator, drafts, recorder, viewState, restoreDraft, discardDraft } =
    useDocumentSession();
  const status = useEditorStatus(session);
  const outlineOpen = useOutlineOpen();
  const { mounted: outlineMounted, visible: outlineVisible } = usePanelPresence(outlineOpen);
  const closeOutline = useCallback(() => {
    outlineVisibilityStore.setOpen(false);
  }, []);
  const save = useSaveCoordinator(coordinator);
  useExternalDocumentChanges(session, coordinator);
  const [dismissedConflict, setDismissedConflict] = useState<string | null>(null);
  const [conflictActionError, setConflictActionError] = useState<string | null>(null);
  const [recoveryOpen, setRecoveryOpen] = useState(false);

  const untitled = session.isUntitled;
  const conflict = save.state === "conflict" ? save.conflict : null;
  const showConflict = !untitled && conflict !== null && conflict.currentHash !== dismissedConflict;
  const showStatusBar = !untitled || status.saveState !== "clean";
  const canRestoreDraft =
    untitled && session.getSnapshot().saveState === "clean" && session.readText().length === 0;

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
      className="flex h-full flex-col bg-paper text-ink"
    >
      <RecoveryBanner drafts={drafts} onOpen={() => setRecoveryOpen(true)} />
      <RecoveryDialog
        drafts={drafts}
        open={recoveryOpen}
        canRestore={canRestoreDraft}
        onClose={() => setRecoveryOpen(false)}
        onRestore={async (id) => {
          const result = await restoreDraft(id);
          if (result.ok) {
            setRecoveryOpen(false);
          }
          return result;
        }}
        onDiscard={discardDraft}
      />

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

      <div className="flex min-h-0 w-full flex-1">
        {outlineMounted ? (
          <OutlinePanel
            session={session}
            cursorLine={status.cursor?.line ?? 0}
            onClose={closeOutline}
            visible={outlineVisible}
          />
        ) : null}
        <div className="min-h-0 min-w-0 flex-1">
          <EditorHost
            session={session}
            autoFocus={untitled}
            viewState={viewState}
            recorder={recorder}
          />
        </div>
      </div>

      {showStatusBar ? <StatusBar snapshot={status} onRetry={retrySave} /> : null}
    </main>
  );
}

export function EditorPage() {
  const { session } = useDocumentSession();
  return session ? <DocumentEditor /> : null;
}
