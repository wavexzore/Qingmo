import { useDocumentSession } from "./DocumentSessionContext";
import type { EditorMetadataSnapshot, EditorSession } from "./EditorSession";

/**
 * Metadata-only access to the current editor. The returned metadata object is
 * cached by the session, so React components can use it without subscribing to
 * per-keystroke cursor updates.
 */
export function useEditor(): {
  session: EditorSession;
  metadata: EditorMetadataSnapshot;
} {
  const { session } = useDocumentSession();
  if (!session) {
    throw new Error("useEditor requires an open document");
  }
  return { session, metadata: session.getMetadataSnapshot() };
}
