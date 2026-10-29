import { EditorView } from "@codemirror/view";
import { useEffect, useRef } from "react";

import type { EditorViewState } from "@qingmo/shared";

import type { EditorSession } from "./EditorSession";
import type { ViewStateRecorder } from "./session/ViewStateRecorder";

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
  viewState = null,
  recorder = null,
}: {
  session: EditorSession;
  /** Focus the startup untitled editor so the caret is ready like Typora. */
  autoFocus?: boolean;
  /** Persisted scroll target applied before the first frame. */
  viewState?: EditorViewState | null;
  /** Records subsequent scroll/selection changes; detached on dispose. */
  recorder?: ViewStateRecorder | null;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const autoFocusRef = useRef(autoFocus);
  const viewStateRef = useRef(viewState);
  const recorderRef = useRef(recorder);
  autoFocusRef.current = autoFocus;
  viewStateRef.current = viewState;
  recorderRef.current = recorder;

  useEffect(() => {
    const parent = hostRef.current;
    if (!parent) {
      return;
    }

    const target = scrollTarget(session, viewStateRef.current);
    const view = new EditorView({
      state: session.editorState,
      parent,
      ...(target ? { scrollTo: target } : {}),
    });
    const detach = session.attach(view);
    recorderRef.current?.attach(view);
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

/**
 * Builds the CM6 scroll target from a persisted block anchor. `topPos` is
 * clamped to the current document, so a document that shrank since the last
 * write still opens at its last line instead of throwing.
 */
function scrollTarget(session: EditorSession, viewState: EditorViewState | null) {
  if (!viewState) {
    return undefined;
  }
  const length = session.editorState.doc.length;
  const position = Math.min(length, Math.max(0, Math.trunc(viewState.topPos)));
  return EditorView.scrollIntoView(position, {
    y: "start",
    yMargin: viewState.topOffset,
    x: "start",
    xMargin: -viewState.scrollLeft,
  });
}
