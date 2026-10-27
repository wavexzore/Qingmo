import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { FilePayload } from "@qingmo/shared";

import { useAppServices } from "../../app/AppServices";
import i18n from "../../i18n";
import type { IpcPort } from "../../lib/ipc/port";
import { EditorSession } from "./EditorSession";
import { SaveCoordinator } from "./save/SaveCoordinator";

interface SessionBundle {
  session: EditorSession;
  coordinator: SaveCoordinator;
}

interface DocumentSessionContextValue {
  session: EditorSession | null;
  /** One coordinator per open document; paired with `session`. */
  coordinator: SaveCoordinator | null;
  setSession(next: EditorSession | null): void;
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
  const currentRef = useRef<EditorSession | null>(null);
  const coordinatorRef = useRef<SaveCoordinator | null>(null);

  const startSession = useCallback(
    (session: EditorSession) => {
      const coordinator = new SaveCoordinator({ session, ipc });
      currentRef.current = session;
      coordinatorRef.current = coordinator;
      setBundle({ session, coordinator });
    },
    [ipc],
  );

  const startUntitled = useCallback(() => {
    startSession(
      EditorSession.createUntitled(i18n.t("editor:empty.title"), {
        placeholder: i18n.t("editor:empty.placeholder"),
      }),
    );
  }, [startSession]);

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
        .then((payload) => {
          if (cancelled) {
            return;
          }
          if (payload) {
            startSession(EditorSession.create(payload));
          } else {
            // Only reachable after a manual reload, which already discards
            // the webview session; keep the window usable.
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
      coordinatorRef.current?.dispose();
      currentRef.current?.dispose();
      coordinatorRef.current = null;
      currentRef.current = null;
    };
  }, [documentWindow, ipc, startSession, startUntitled]);

  const setSession = useCallback(
    (next: EditorSession | null) => {
      const previous = currentRef.current;
      if (previous === next) {
        return;
      }

      coordinatorRef.current?.dispose();
      previous?.dispose();

      if (next) {
        startSession(next);
      } else {
        currentRef.current = null;
        coordinatorRef.current = null;
        setBundle(null);
      }
    },
    [startSession],
  );

  return (
    <DocumentSessionContext.Provider
      value={{
        session: bundle?.session ?? null,
        coordinator: bundle?.coordinator ?? null,
        setSession,
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
