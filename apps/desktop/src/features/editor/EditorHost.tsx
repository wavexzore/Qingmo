import { EditorView } from "@codemirror/view";
import { useEffect, useRef } from "react";

import type { EditorSession } from "./EditorSession";

/**
 * Creates the one and only EditorView for the attached session.
 *
 * The effect depends only on the session identity: theme/mode/LP changes
 * reconfigure compartments and must not recreate the DOM. StrictMode's
 * mount -> cleanup -> mount sequence therefore ends with exactly one live
 * view, not a skipped second mount.
 */
export function EditorHost({
  session,
  autoFocus = false,
}: {
  session: EditorSession;
  /** Focus the startup untitled editor so the caret is ready like Typora. */
  autoFocus?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const autoFocusRef = useRef(autoFocus);
  autoFocusRef.current = autoFocus;

  useEffect(() => {
    const parent = hostRef.current;
    if (!parent) {
      return;
    }

    const view = new EditorView({
      state: session.editorState,
      parent,
    });
    const detach = session.attach(view);
    if (autoFocusRef.current) {
      view.focus();
    }

    return () => {
      detach();
      view.destroy();
    };
  }, [session]);

  return (
    <div
      ref={hostRef}
      data-testid="editor-host"
      className="h-full min-h-0 overflow-hidden bg-paper"
    />
  );
}
