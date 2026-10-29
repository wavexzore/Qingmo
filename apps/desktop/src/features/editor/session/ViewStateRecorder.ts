import type { EditorViewStateInput } from "@qingmo/shared";
import type { EditorView } from "@codemirror/view";

import type { IpcPort } from "../../../lib/ipc/port";
import type { EditorSession } from "../EditorSession";

export const VIEW_STATE_DEBOUNCE_MS = 1_000;
export const VIEW_STATE_MAX_WAIT_MS = 5_000;

export interface ViewStateRecorderOptions {
  ipc: Pick<IpcPort, "sessionViewStateSet">;
  session: EditorSession;
  debounceMs?: number;
  maxWaitMs?: number;
}

/**
 * Records the viewport/selection/preference of a named document.
 *
 * It never restores scrolling: `EditorHost` passes the persisted target to
 * `EditorView` before the first frame, so there is no visible jump. The
 * recorder only observes an attached view and writes the latest state after a
 * 1s debounce (5s max wait) plus on `pagehide`/`visibilitychange`.
 */
export class ViewStateRecorder {
  private readonly ipc: Pick<IpcPort, "sessionViewStateSet">;
  private readonly session: EditorSession;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly onScroll = (): void => this.schedule();
  private readonly onChange = (): void => this.schedule();
  private readonly onPageHide = (): void => {
    void this.flushNow();
  };
  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") {
      void this.flushNow();
    }
  };

  private view: EditorView | null = null;
  private unsubscribe: (() => void) | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSentKey: string | null = null;
  private chain: Promise<void> = Promise.resolve();
  private warned = false;
  private disposed = false;

  constructor({ ipc, session, debounceMs, maxWaitMs }: ViewStateRecorderOptions) {
    this.ipc = ipc;
    this.session = session;
    this.debounceMs = debounceMs ?? VIEW_STATE_DEBOUNCE_MS;
    this.maxWaitMs = maxWaitMs ?? VIEW_STATE_MAX_WAIT_MS;
  }

  /**
   * Binds the recorder to the live view. StrictMode mounts the host twice, so
   * a replacement view must be adopted instead of keeping a destroyed one.
   */
  attach(view: EditorView): void {
    if (this.disposed || this.view === view) {
      return;
    }
    if (this.view) {
      this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
    } else {
      this.unsubscribe = this.session.subscribe(this.onChange);
      window.addEventListener("pagehide", this.onPageHide);
      document.addEventListener("visibilitychange", this.onVisibilityChange);
    }
    this.view = view;
    view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
  }

  /**
   * Debounced write. Untitled and empty documents are skipped because they
   * have no stable identity/path to key on.
   */
  schedule(): void {
    if (!this.canWrite()) {
      return;
    }
    if (this.debounceTimer === null) {
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        void this.flushNow();
      }, this.debounceMs);
    }
    if (this.maxWaitTimer === null) {
      this.maxWaitTimer = setTimeout(() => {
        this.maxWaitTimer = null;
        void this.flushNow();
      }, this.maxWaitMs);
    }
  }

  /**
   * Writes the current snapshot immediately. Concurrent calls are serialized
   * so a slower earlier write can never overwrite a newer one.
   */
  flushNow(): Promise<void> {
    this.clearTimers();
    const captured = this.capture();
    if (!captured) {
      return this.chain;
    }
    const path = captured.path;
    const key = JSON.stringify([path, captured.state]);
    if (key === this.lastSentKey) {
      return this.chain;
    }
    this.lastSentKey = key;
    const state = captured.state;
    this.chain = this.chain.then(async () => {
      try {
        await this.ipc.sessionViewStateSet(path, state);
      } catch (error) {
        // A failed write must be retried by the next schedule; keep the
        // editor usable and log once per recorder.
        this.lastSentKey = null;
        if (!this.warned) {
          this.warned = true;
          console.warn("failed to persist the view state", error);
        }
      }
    });
    return this.chain;
  }

  /** Removes listeners and timers. Closing is the close guard's job. */
  dispose(): void {
    this.disposed = true;
    this.clearTimers();
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.view) {
      this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
    }
    window.removeEventListener("pagehide", this.onPageHide);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.view = null;
  }

  private canWrite(): boolean {
    return (
      !this.disposed &&
      this.view !== null &&
      !this.session.isUntitled &&
      this.session.editorState.doc.length > 0
    );
  }

  private capture(): { path: string; state: EditorViewStateInput } | null {
    const view = this.view;
    if (!view || !this.canWrite()) {
      return null;
    }
    const snapshot = this.session.getSnapshot();
    // A freshly created view has not measured its content padding yet;
    // `documentTop` would be 0 and the captured `topOffset` would lose the
    // padding. `lineBlockAtHeight` flushes that measurement synchronously, so
    // warm it up before reading `documentTop`.
    view.lineBlockAtHeight(0);
    const top = view.scrollDOM.getBoundingClientRect().top - view.documentTop;
    // `lineBlockAtHeight` takes a screen-space offset relative to the document
    // top (the same coordinate CM uses for mouse events); the padding above
    // the first line therefore produces a small negative value, not zero.
    const block = view.lineBlockAtHeight(top);
    return {
      path: snapshot.docId,
      state: {
        anchor: snapshot.selection.anchor,
        head: snapshot.selection.head,
        topPos: block.from,
        topOffset: block.top - top,
        scrollLeft: view.scrollDOM.scrollLeft,
        livePreviewPreferred: snapshot.livePreviewPreferred,
      },
    };
  }

  private clearTimers(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.maxWaitTimer !== null) {
      clearTimeout(this.maxWaitTimer);
      this.maxWaitTimer = null;
    }
  }
}
