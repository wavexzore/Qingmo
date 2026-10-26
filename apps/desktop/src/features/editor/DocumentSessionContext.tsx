import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useAppServices } from "../../app/AppServices";
import type { EditorSession } from "./EditorSession";
import { SaveCoordinator } from "./save/SaveCoordinator";

interface DocumentSessionContextValue {
  session: EditorSession | null;
  /** One coordinator per open document; null on the welcome page. */
  coordinator: SaveCoordinator | null;
  setSession(next: EditorSession | null): void;
}

const DocumentSessionContext = createContext<DocumentSessionContextValue | null>(null);

export function DocumentSessionProvider({ children }: { children: ReactNode }) {
  const { ipc } = useAppServices();
  const [session, setCurrent] = useState<EditorSession | null>(null);
  const [coordinator, setCoordinator] = useState<SaveCoordinator | null>(null);
  const currentRef = useRef<EditorSession | null>(null);
  const coordinatorRef = useRef<SaveCoordinator | null>(null);

  const setSession = useCallback(
    (next: EditorSession | null) => {
      const previous = currentRef.current;
      if (previous === next) {
        return;
      }

      coordinatorRef.current?.dispose();
      const nextCoordinator = next ? new SaveCoordinator({ session: next, ipc }) : null;

      currentRef.current = next;
      coordinatorRef.current = nextCoordinator;
      setCurrent(next);
      setCoordinator(nextCoordinator);

      previous?.dispose();
    },
    [ipc],
  );

  useEffect(
    () => () => {
      coordinatorRef.current?.dispose();
      currentRef.current?.dispose();
      coordinatorRef.current = null;
      currentRef.current = null;
    },
    [],
  );

  return (
    <DocumentSessionContext.Provider value={{ session, coordinator, setSession }}>
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
