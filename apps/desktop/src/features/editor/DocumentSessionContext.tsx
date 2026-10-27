import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useAppServices } from "../../app/AppServices";
import i18n from "../../i18n";
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

export function DocumentSessionProvider({ children }: { children: ReactNode }) {
  const { ipc } = useAppServices();
  const [bundle, setBundle] = useState<SessionBundle | null>(null);
  const currentRef = useRef<EditorSession | null>(null);
  const coordinatorRef = useRef<SaveCoordinator | null>(null);

  // The startup untitled document is a resource with a subscription. Creating
  // it in a layout effect keeps StrictMode's setup/cleanup/setup sequence
  // correct: a disposed instance is always replaced before paint.
  useLayoutEffect(() => {
    if (!currentRef.current) {
      const session = EditorSession.createUntitled(i18n.t("editor:empty.title"), {
        placeholder: i18n.t("editor:empty.placeholder"),
      });
      const coordinator = new SaveCoordinator({ session, ipc });
      currentRef.current = session;
      coordinatorRef.current = coordinator;
      setBundle({ session, coordinator });
    }

    return () => {
      coordinatorRef.current?.dispose();
      currentRef.current?.dispose();
      coordinatorRef.current = null;
      currentRef.current = null;
    };
  }, [ipc]);

  const setSession = useCallback(
    (next: EditorSession | null) => {
      const previous = currentRef.current;
      if (previous === next) {
        return;
      }

      coordinatorRef.current?.dispose();
      previous?.dispose();

      if (next) {
        const nextCoordinator = new SaveCoordinator({ session: next, ipc });
        currentRef.current = next;
        coordinatorRef.current = nextCoordinator;
        setBundle({ session: next, coordinator: nextCoordinator });
      } else {
        currentRef.current = null;
        coordinatorRef.current = null;
        setBundle(null);
      }
    },
    [ipc],
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
