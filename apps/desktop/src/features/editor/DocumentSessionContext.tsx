import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { AppError, DraftMeta, EditorViewState, FilePayload, Result } from "@qingmo/shared";

import { useAppServices } from "../../app/AppServices";
import i18n from "../../i18n";
import { buildEditorUiCopy } from "../../i18n/editorCopy";
import { normalizeLanguage } from "../../i18n/language";
import { AppError as AppErrorClass, normalizeError } from "../../lib/ipc/errors";
import type { IpcPort } from "../../lib/ipc/port";
import { EditorSession } from "./EditorSession";
import { SaveCoordinator } from "./save/SaveCoordinator";
import { DraftJournal } from "./recovery/DraftJournal";
import { createDocumentSession } from "./session/createDocumentSession";
import { createOpenExternal } from "./session/open-external";
import { ViewStateRecorder } from "./session/ViewStateRecorder";

interface SessionBundle {
  session: EditorSession;
  coordinator: SaveCoordinator;
  recorder: ViewStateRecorder;
  journal: DraftJournal;
  viewState: EditorViewState | null;
}

export interface SetSessionExtras {
  /** Persisted scroll target, only meaningful for a named document. */
  viewState?: EditorViewState | null;
  /** Restored crash draft; the new session owns it for later cleanup. */
  draftId?: string | null;
}

interface DocumentSessionContextValue {
  session: EditorSession | null;
  /** One coordinator per open document; paired with `session`. */
  coordinator: SaveCoordinator | null;
  /** Records scroll/selection/preference for the attached view. */
  recorder: ViewStateRecorder | null;
  /** Writes crash drafts for untitled/error/conflict docs; explicit named flushes. */
  journal: DraftJournal | null;
  viewState: EditorViewState | null;
  /** Crash drafts available for recovery in this window. */
  drafts: DraftMeta[];
  /** Re-reads the global draft list, e.g. when the dialog opens. */
  refreshDrafts(): Promise<void>;
  setSession(next: EditorSession | null, extras?: SetSessionExtras): void;
  /** Replaces the current document with a fresh empty untitled session. */
  startUntitled(): void;
  /** Live bundle from the provider refs (not a render snapshot). */
  getCurrentBundle(): {
    session: EditorSession | null;
    coordinator: SaveCoordinator | null;
    journal: DraftJournal | null;
  };
  restoreDraft(id: string): Promise<Result<void, AppError>>;
  discardDraft(id: string): Promise<Result<void, AppError>>;
}

const DocumentSessionContext = createContext<DocumentSessionContextValue | null>(null);

/** Query marker added by Rust when it creates a window for one document. */
const DOCUMENT_WINDOW_PARAM = "window";
const DOCUMENT_WINDOW_VALUE = "document";

export function isDocumentWindow(search = window.location.search): boolean {
  return new URLSearchParams(search).get(DOCUMENT_WINDOW_PARAM) === DOCUMENT_WINDOW_VALUE;
}

/**
 * The pending payload is consumed by Rust once per window. React StrictMode
 * runs layout effects twice in development, so both runs must observe the
 * same result instead of the second one falling back to an empty document.
 */
let pendingDocumentPromise: Promise<FilePayload | null> | null = null;

function takePendingDocument(ipc: IpcPort): Promise<FilePayload | null> {
  pendingDocumentPromise ??= ipc.documentTakePending();
  return pendingDocumentPromise;
}

/** Test-only reset; production windows never remount the provider. */
export function resetPendingDocumentForTests(): void {
  pendingDocumentPromise = null;
}

export function DocumentSessionProvider({ children }: { children: ReactNode }) {
  const { ipc } = useAppServices();
  const documentWindow = isDocumentWindow();
  const [bundle, setBundle] = useState<SessionBundle | null>(null);
  const [drafts, setDrafts] = useState<DraftMeta[]>([]);
  const currentRef = useRef<EditorSession | null>(null);
  const coordinatorRef = useRef<SaveCoordinator | null>(null);
  const recorderRef = useRef<ViewStateRecorder | null>(null);
  const journalRef = useRef<DraftJournal | null>(null);
  const draftRefreshGeneration = useRef(0);

  const removeDraftLocally = useCallback((id: string) => {
    // Invalidate a list request that started before this removal, or its
    // stale answer would put the draft back into the UI.
    draftRefreshGeneration.current += 1;
    setDrafts((previous) => previous.filter((draft) => draft.id !== id));
  }, []);

  const startSession = useCallback(
    (
      session: EditorSession,
      viewState: EditorViewState | null = null,
      draftId: string | null = null,
    ) => {
      const coordinator = new SaveCoordinator({ session, ipc });
      const recorder = new ViewStateRecorder({ ipc, session });
      const journal = new DraftJournal({
        session,
        coordinator,
        ipc,
        ...(draftId ? { initialDraftId: draftId } : {}),
        onDiscarded: (id) => {
          removeDraftLocally(id);
        },
      });
      currentRef.current = session;
      coordinatorRef.current = coordinator;
      recorderRef.current = recorder;
      journalRef.current = journal;
      setBundle({ session, coordinator, recorder, journal, viewState });
      // A restored dirty session must be journaled immediately, without
      // waiting for the first edit.
      journal.evaluate();
    },
    [ipc, removeDraftLocally],
  );

  const setSession = useCallback(
    (next: EditorSession | null, extras: SetSessionExtras = {}) => {
      const previous = currentRef.current;
      if (previous === next) {
        return;
      }

      journalRef.current?.dispose();
      recorderRef.current?.dispose();
      coordinatorRef.current?.dispose();
      previous?.dispose();
      journalRef.current = null;
      recorderRef.current = null;
      coordinatorRef.current = null;
      currentRef.current = null;

      if (next) {
        startSession(next, extras.viewState ?? null, extras.draftId ?? null);
      } else {
        setBundle(null);
      }
    },
    [startSession],
  );

  const startUntitled = useCallback(() => {
    setSession(
      EditorSession.createUntitled(i18n.t("editor:empty.title"), {
        placeholder: i18n.t("editor:empty.placeholder"),
        uiCopy: buildEditorUiCopy(normalizeLanguage(i18n.language)),
        openExternal: createOpenExternal(ipc),
      }),
    );
  }, [ipc, setSession]);

  const getCurrentBundle = useCallback(
    () => ({
      session: currentRef.current,
      coordinator: coordinatorRef.current,
      journal: journalRef.current,
    }),
    [],
  );

  // The startup document is a resource with a subscription. Creating it in a
  // layout effect keeps StrictMode's setup/cleanup/setup sequence correct: a
  // disposed instance is always replaced before paint. Document windows wait
  // for the payload staged by Rust instead of briefly showing an untitled
  // editor; the main window still starts untitled synchronously.
  useLayoutEffect(() => {
    let cancelled = false;

    if (!documentWindow) {
      if (!currentRef.current) {
        startUntitled();
      }
    } else if (!currentRef.current) {
      takePendingDocument(ipc)
        .then(async (payload) => {
          if (cancelled) {
            return;
          }
          if (payload) {
            const created = await createDocumentSession(
              ipc,
              payload,
              buildEditorUiCopy(normalizeLanguage(i18n.language)),
            );
            // The effect may have been cleaned up while the view state was
            // being read; never publish a session into a dead provider.
            if (cancelled) {
              created.session.dispose();
              return;
            }
            startSession(created.session, created.viewState);
          } else {
            // A New window has no staged payload, and a manual reload already
            // discards the webview session; both keep the window usable by
            // starting a fresh untitled document.
            startUntitled();
          }
        })
        .catch((error: unknown) => {
          console.error("failed to take the pending document", error);
          if (!cancelled) {
            startUntitled();
          }
        });
    }

    return () => {
      cancelled = true;
      journalRef.current?.dispose();
      recorderRef.current?.dispose();
      coordinatorRef.current?.dispose();
      currentRef.current?.dispose();
      journalRef.current = null;
      recorderRef.current = null;
      coordinatorRef.current = null;
      currentRef.current = null;
    };
  }, [documentWindow, ipc, startSession, startUntitled]);

  const refreshDrafts = useCallback(async () => {
    const generation = draftRefreshGeneration.current + 1;
    draftRefreshGeneration.current = generation;
    try {
      const next = await ipc.sessionDraftList();
      if (generation === draftRefreshGeneration.current) {
        setDrafts(next);
      }
    } catch (error) {
      console.warn("failed to list crash drafts", normalizeError(error));
    }
  }, [ipc]);

  useLayoutEffect(() => {
    // Every window may recover: a New-only launch has no main window, and the
    // capability now grants draft list/read to document windows too.
    void refreshDrafts();
  }, [refreshDrafts]);

  const restoreDraft = useCallback(
    async (id: string): Promise<Result<void, AppError>> => {
      const current = currentRef.current;
      if (
        !current ||
        !current.isUntitled ||
        current.readText().length > 0 ||
        current.getSnapshot().saveState !== "clean"
      ) {
        return {
          ok: false,
          error: new AppErrorClass(
            "BUSY",
            "restoring a draft requires an empty, unchanged untitled document",
          ),
        };
      }

      try {
        const record = await ipc.sessionDraftRead(id);
        const session = EditorSession.createUntitled(record.title, {
          initialText: record.text,
          initialSelection: { anchor: record.anchor, head: record.head },
          initialDirty: true,
          placeholder: i18n.t("editor:empty.placeholder"),
          uiCopy: buildEditorUiCopy(normalizeLanguage(i18n.language)),
          openExternal: createOpenExternal(ipc),
        });
        // Copy the recovered draft into this window's own journal before
        // releasing the original id. Another window may list the same global
        // draft, so owning the original would let the two sessions overwrite
        // and discard each other.
        setSession(session);
        const copy = await journalRef.current?.flushNow({ force: true });
        if (copy?.ok) {
          try {
            await ipc.sessionDraftDiscard(id);
            // Keep the banner hidden while this window edits its own copy;
            // the dialog refreshes the list if it is reopened.
            removeDraftLocally(id);
          } catch (error) {
            // The recovered copy is safe in this session; a failed release
            // only leaves a duplicate in the recovery list.
            console.warn("failed to release the restored draft", normalizeError(error));
          }
        } else {
          // The copy is not on disk yet; keep the original visible as the
          // durable fallback until the journal retries.
          await refreshDrafts();
        }
        return { ok: true, value: undefined };
      } catch (error) {
        return { ok: false, error: normalizeError(error) };
      }
    },
    [ipc, refreshDrafts, removeDraftLocally, setSession],
  );

  const discardDraft = useCallback(
    async (id: string): Promise<Result<void, AppError>> => {
      try {
        // `false` means another window already removed it; the service truth
        // is still "gone", so drop the row locally either way.
        await ipc.sessionDraftDiscard(id);
        removeDraftLocally(id);
        return { ok: true, value: undefined };
      } catch (error) {
        return { ok: false, error: normalizeError(error) };
      }
    },
    [ipc, removeDraftLocally],
  );

  return (
    <DocumentSessionContext.Provider
      value={{
        session: bundle?.session ?? null,
        coordinator: bundle?.coordinator ?? null,
        recorder: bundle?.recorder ?? null,
        journal: bundle?.journal ?? null,
        viewState: bundle?.viewState ?? null,
        drafts,
        refreshDrafts,
        setSession,
        startUntitled,
        getCurrentBundle,
        restoreDraft,
        discardDraft,
      }}
    >
      {children}
    </DocumentSessionContext.Provider>
  );
}

export function useDocumentSession(): DocumentSessionContextValue {
  const value = useContext(DocumentSessionContext);
  if (!value) {
    throw new Error("useDocumentSession must be used inside DocumentSessionProvider");
  }
  return value;
}
