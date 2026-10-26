import type { EditorState, Extension } from "@codemirror/state";
import { createEditorState } from "@qingmo/editor-core";
import type { FilePayload, ReadOnlyReason, TextFormat } from "@qingmo/shared";

import type { SaveState } from "../../lib/save-state";

export interface EditorSelectionSnapshot {
  anchor: number;
  head: number;
}

export interface EditorCursorSnapshot {
  line: number;
  column: number;
}

/**
 * Metadata-only snapshot consumed by React. The document body deliberately
 * never appears here; `readText()` is the on-demand bridge to EditorState.
 */
export interface EditorSessionSnapshot {
  /** Canonical path; P1 document identity. */
  docId: string;
  fileName: string;
  docToken: string;
  readOnly: boolean;
  readOnlyReason: ReadOnlyReason | null;
  format: TextFormat;
  hash: string;
  size: number;
  textUnits: number;
  mtimeMs: number;
  saveState: SaveState;
  /** Derived: saveState is neither clean nor readonly. */
  dirty: boolean;
  selection: EditorSelectionSnapshot;
  cursor: EditorCursorSnapshot;
  version: number;
}

export interface EditorSessionOptions {
  /** Extra CM6 extensions supplied by T-009's editor-core composition. */
  extensions?: readonly Extension[];
}

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function freezeFormat(format: TextFormat): TextFormat {
  return Object.freeze({
    encoding: format.encoding,
    hasBom: format.hasBom,
    eol: format.eol,
  });
}

function cursorAt(state: EditorState, position: number): EditorCursorSnapshot {
  const line = state.doc.lineAt(position);
  return Object.freeze({
    line: line.number,
    column: position - line.from + 1,
  });
}

/**
 * Owns the single CM6 EditorState for one open document.
 *
 * T-008 intentionally does not create an EditorView; T-010 attaches exactly
 * one view and routes its transactions back into this state. The snapshot is
 * immutable and contains no document text, so React can never become a second
 * source of truth.
 */
export class EditorSession {
  readonly docToken: string;

  private readonly listeners = new Set<() => void>();
  private state: EditorState;
  private snapshot: EditorSessionSnapshot;
  private disposed = false;

  private constructor(payload: FilePayload, options: EditorSessionOptions) {
    this.docToken = payload.docToken;

    this.state = createEditorState({
      doc: payload.text,
      readOnly: payload.readOnly,
      extraExtensions: options.extensions ?? [],
    });

    const selection = this.state.selection.main;
    const saveState: SaveState = payload.readOnly ? "readonly" : "clean";

    this.snapshot = Object.freeze({
      docId: payload.path,
      fileName: fileNameOf(payload.path),
      docToken: payload.docToken,
      readOnly: payload.readOnly,
      readOnlyReason: payload.readOnlyReason,
      format: freezeFormat(payload.format),
      hash: payload.hash,
      size: payload.size,
      textUnits: payload.textUnits,
      mtimeMs: payload.mtimeMs,
      saveState,
      dirty: false,
      selection: Object.freeze({ anchor: selection.anchor, head: selection.head }),
      cursor: cursorAt(this.state, selection.head),
      version: 0,
    });
  }

  static create(payload: FilePayload, options: EditorSessionOptions = {}): EditorSession {
    return new EditorSession(payload, options);
  }

  /** The only place the document body can be read; save reads it on demand. */
  readText(): string {
    return this.state.doc.toString();
  }

  get editorState(): EditorState {
    return this.state;
  }

  /**
   * T-011 pushes SaveCoordinator state through this method; it is not stored
   * as a second independent dirty flag.
   */
  setSaveState(next: SaveState): void {
    if (this.disposed) {
      return;
    }
    const effective: SaveState = this.snapshot.readOnly ? "readonly" : next;
    if (effective === this.snapshot.saveState) {
      return;
    }
    this.publish({ saveState: effective });
  }

  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) {
      return () => undefined;
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): EditorSessionSnapshot => this.snapshot;

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  private publish(patch: Pick<EditorSessionSnapshot, "saveState">): void {
    const saveState = patch.saveState;
    const next: EditorSessionSnapshot = Object.freeze({
      ...this.snapshot,
      saveState,
      dirty: saveState !== "clean" && saveState !== "readonly",
      version: this.snapshot.version + 1,
    });
    this.snapshot = next;
    for (const listener of this.listeners) {
      listener();
    }
  }
}
