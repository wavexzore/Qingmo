import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

import type { EditorSession } from "./EditorSession";

interface DocumentSessionContextValue {
  session: EditorSession | null;
  setSession(next: EditorSession | null): void;
}

const DocumentSessionContext = createContext<DocumentSessionContextValue | null>(null);

export function DocumentSessionProvider({ children }: { children: ReactNode }) {
  const [session, setCurrent] = useState<EditorSession | null>(null);
  const currentRef = useRef<EditorSession | null>(null);

  const setSession = useCallback((next: EditorSession | null) => {
    const previous = currentRef.current;
    currentRef.current = next;
    setCurrent(next);
    if (previous && previous !== next) {
      previous.dispose();
    }
  }, []);

  return (
    <DocumentSessionContext.Provider value={{ session, setSession }}>
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
