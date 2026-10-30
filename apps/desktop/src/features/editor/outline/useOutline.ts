import { useSyncExternalStore } from "react";

import type { HeadingOutlineState } from "@qingmo/editor-core";

import type { EditorSession } from "../EditorSession";

/** Subscribes React to the session's independent outline channel. */
export function useOutline(session: EditorSession): HeadingOutlineState {
  return useSyncExternalStore(
    session.subscribeOutline,
    session.getOutlineSnapshot,
    session.getOutlineSnapshot,
  );
}
