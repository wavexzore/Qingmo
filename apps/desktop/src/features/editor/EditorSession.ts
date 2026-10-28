import { StateEffect, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import {
  createEditorState,
  LP_MAX_UNITS,
  livePreview,
  setModeEffect,
  setReadOnlyEffect,
  setThemeEffect,
  themeExtension,
} from "@qingmo/editor-core";
import type { FilePayload, ReadOnlyReason, SaveResult, TextFormat } from "@qingmo/shared";

import type { SaveState } from "../../lib/save-state";

export const STATUS_THROTTLE_MS = 100;
export const UNTITLED_DOC_TOKEN = "untitled";
export const UNTITLED_DOC_ID = "untitled";

export interface EditorSelectionSnapshot {
  anchor: number;
  head: number;
}

export interface EditorCursorSnapshot {
  line: number;
  column: number;
}

/**
 * Metadata mirror. It is replaced when a save updates size/mtime or a reload
 * replaces the payload; the document body never lives here.
 */
export interface EditorMetadataSnapshot {
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
}

/**
 * Metadata-only snapshot consumed by React. The document body deliberately
 * never appears here; `readText()` is the on-demand bridge to EditorState.
 */
export interface EditorSessionSnapshot extends EditorMetadataSnapshot {
  saveState: SaveState;
  /** Derived: saveState is neither clean nor readonly. */
  dirty: boolean;
  /** Doc length exceeds the Live Preview unit budget. */
  largeFile: boolean;
  /** Effective mode: user preference AND not a large file. */
  livePreview: boolean;
  selection: EditorSelectionSnapshot;
  cursor: EditorCursorSnapshot;
  version: number;
}

export interface EditorSessionOptions {
  /** Extra CM6 extensions supplied by editor-core consumers. */
  extensions?: readonly Extension[];
  /** Overridable for tests; production uses STATUS_THROTTLE_MS. */
  statusThrottleMs?: number;
  /** Displayed by CM6 while an empty untitled document has no text. */
  placeholder?: string;
  /** Marks this session as an in-memory untitled document. */
  untitledTitle?: string;
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

function metadataOf(payload: FilePayload, untitledTitle?: string): EditorMetadataSnapshot {
  const untitled = untitledTitle !== undefined;
  return Object.freeze({
    docId: untitled ? UNTITLED_DOC_ID : payload.path,
    fileName: untitled ? (untitledTitle ?? "") : fileNameOf(payload.path),
    docToken: payload.docToken,
    readOnly: payload.readOnly,
    readOnlyReason: payload.readOnlyReason,
    format: freezeFormat(payload.format),
    hash: payload.hash,
    size: payload.size,
    textUnits: payload.textUnits,
    mtimeMs: payload.mtimeMs,
  });
}

function selectionOf(state: EditorState): EditorSelectionSnapshot {
  const selection = state.selection.main;
  return Object.freeze({ anchor: selection.anchor, head: selection.head });
}

function cursorAt(state: EditorState, position: number): EditorCursorSnapshot {
  const line = state.doc.lineAt(position);
  return Object.freeze({
    line: line.number,
    column: position - line.from + 1,
  });
}

function sameSelection(left: EditorSelectionSnapshot, right: EditorSelectionSnapshot): boolean {
  return left.anchor === right.anchor && left.head === right.head;
}

function sameCursor(left: EditorCursorSnapshot, right: EditorCursorSnapshot): boolean {
  return left.line === right.line && left.column === right.column;
}

/**
 * Owns the single CM6 EditorState for one open document.
 *
 * T-010 attaches exactly one EditorView (via EditorHost) and routes its
 * transactions back into this store. The snapshot is immutable and contains no
 * document text, so React can never become a second source of truth.
 */
export class EditorSession {
  private docTokenValue: string;

  private readonly listeners = new Set<() => void>();
  private readonly statusListeners = new Set<() => void>();
  private readonly docChangedListeners = new Set<() => void>();
  private readonly extraExtensions: readonly Extension[];
  private readonly statusThrottleMs: number;
  private readonly placeholder: string | undefined;
  private metadata: EditorMetadataSnapshot;
  private state: EditorState;
  private snapshot: EditorSessionSnapshot;
  private previewEnabled: boolean;
  private untitled: boolean;
  private theme: "light" | "dark" = "light";
  private themeApplied = false;
  private view: EditorView | null = null;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  private constructor(payload: FilePayload, options: EditorSessionOptions) {
    this.docTokenValue = payload.docToken;
    this.statusThrottleMs = options.statusThrottleMs ?? STATUS_THROTTLE_MS;
    this.extraExtensions = options.extensions ?? [];
    this.placeholder = options.placeholder;
    this.untitled = options.untitledTitle !== undefined;

    this.state = createEditorState({
      doc: payload.text,
      readOnly: payload.readOnly,
      extraExtensions: this.extraExtensions,
      ...(this.placeholder !== undefined ? { placeholder: this.placeholder } : {}),
    });

    const selection = selectionOf(this.state);
    const saveState: SaveState = payload.readOnly ? "readonly" : "clean";
    const largeFile = this.state.doc.length > LP_MAX_UNITS;
    this.previewEnabled = !largeFile;
    this.metadata = metadataOf(payload, options.untitledTitle);

    this.snapshot = Object.freeze({
      ...this.metadata,
      saveState,
      dirty: false,
      largeFile,
      livePreview: this.previewEnabled,
      selection,
      cursor: cursorAt(this.state, selection.head),
      version: 0,
    });
  }

  static create(payload: FilePayload, options: EditorSessionOptions = {}): EditorSession {
    return new EditorSession(payload, options);
  }

  /** Creates the in-memory document shown on startup, before any path exists. */
  static createUntitled(
    title: string,
    options: Omit<EditorSessionOptions, "untitledTitle"> = {},
  ): EditorSession {
    return new EditorSession(
      {
        docToken: UNTITLED_DOC_TOKEN,
        path: "",
        text: "",
        format: { encoding: "utf8", hasBom: false, eol: "lf" },
        mixedEol: false,
        hash: "",
        size: 0,
        textUnits: 0,
        mtimeMs: 0,
        readOnly: false,
        readOnlyReason: null,
      },
      { ...options, untitledTitle: title },
    );
  }

  get docToken(): string {
    return this.docTokenValue;
  }

  get isUntitled(): boolean {
    return this.untitled;
  }

  /** The only place the document body can be read; save reads it on demand. */
  readText(): string {
    return this.currentState.doc.toString();
  }

  get editorState(): EditorState {
    return this.currentState;
  }

  get attachedView(): EditorView | null {
    return this.view;
  }

  getMetadataSnapshot = (): EditorMetadataSnapshot => this.metadata;

  /**
   * Mirrors successful save metadata for the status bar. The hash remains
   * informational: every save still sends only docToken/text and lets Rust
   * compare against its own base hash.
   */
  applySaveResult(result: SaveResult): void {
    if (this.disposed) {
      return;
    }
    const metadata: EditorMetadataSnapshot = Object.freeze({
      ...this.metadata,
      hash: result.hash,
      size: result.size,
      mtimeMs: result.mtimeMs,
      textUnits: this.currentState.doc.length,
    });
    this.metadata = metadata;
    this.snapshot = Object.freeze({
      ...this.snapshot,
      ...metadata,
    });
  }

  /**
   * Binds an untitled session to the file created by native Save As without
   * rebuilding EditorState, so text, selection and undo history survive.
   */
  adoptSavedAs(payload: FilePayload): void {
    if (this.disposed) {
      return;
    }
    if (!this.untitled) {
      throw new Error("only an untitled session can adopt a saved path");
    }
    if (payload.path.length === 0) {
      throw new Error("save-as returned an empty path");
    }

    this.docTokenValue = payload.docToken;
    this.untitled = false;
    this.metadata = metadataOf(payload);

    if (payload.readOnly) {
      const effect = setReadOnlyEffect(true);
      if (this.view) {
        this.view.dispatch({ effects: effect });
      } else {
        this.state = this.state.update({ effects: effect }).state;
      }
    }

    const current = this.currentState;
    const selection = selectionOf(current);
    this.snapshot = Object.freeze({
      ...this.snapshot,
      ...this.metadata,
      saveState: payload.readOnly ? "readonly" : "clean",
      dirty: false,
      textUnits: current.doc.length,
      selection,
      cursor: cursorAt(current, selection.head),
      version: this.snapshot.version + 1,
    });

    for (const listener of [...this.listeners]) {
      listener();
    }
    this.flushStatus();
  }

  /**
   * Rebuilds the state from a reloaded payload. A fresh EditorState also
   * clears undo history, which is the required conflict-reload semantic.
   */
  replacePayload(payload: FilePayload): void {
    if (this.disposed) {
      return;
    }
    if (payload.docToken !== this.docToken) {
      throw new Error("reload returned a different docToken");
    }

    let state = createEditorState({
      doc: payload.text,
      readOnly: payload.readOnly,
      extraExtensions: this.extraExtensions,
      ...(this.placeholder !== undefined ? { placeholder: this.placeholder } : {}),
    });
    if (this.themeApplied) {
      state = state.update({ effects: setThemeEffect(themeExtension(this.theme)) }).state;
    }
    // A watcher-driven reload should not throw the reader back to the top of
    // the document; clamp the previous cursor into the new text.
    const previous = this.snapshot.selection;
    state = state.update({
      selection: {
        anchor: Math.min(previous.anchor, state.doc.length),
        head: Math.min(previous.head, state.doc.length),
      },
    }).state;
    const largeFile = state.doc.length > LP_MAX_UNITS;
    this.previewEnabled = !largeFile;
    this.metadata = metadataOf(payload);

    if (this.view) {
      this.view.setState(state);
      this.attachUpdateListener(this.view);
    } else {
      this.state = state;
    }

    const current = this.currentState;
    const selection = selectionOf(current);
    this.snapshot = Object.freeze({
      ...this.metadata,
      saveState: payload.readOnly ? "readonly" : "clean",
      dirty: false,
      largeFile,
      livePreview: this.previewEnabled,
      selection,
      cursor: cursorAt(current, selection.head),
      version: this.snapshot.version + 1,
    });

    for (const listener of [...this.listeners]) {
      listener();
    }
    this.flushStatus();
  }

  /**
   * Attaches the single view created by EditorHost. A second attach without a
   * detach is a programming error, so it fails loudly rather than silently
   * creating two update listeners.
   */
  attach(view: EditorView): () => void {
    if (this.disposed) {
      return () => undefined;
    }
    if (this.view) {
      throw new Error("EditorSession already has an attached EditorView");
    }
    this.attachUpdateListener(view);
    return () => this.detach(view);
  }

  detach(view?: EditorView): void {
    if (view && this.view !== view) {
      return;
    }
    this.view = null;
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
    this.publish({ saveState: effective }, true);
  }

  /**
   * Reconfigures the existing mode compartment. It never rebuilds the view or
   * touches the document, so undo history and selection survive. Large files
   * stay in source mode until they shrink below the unit budget.
   */
  toggleLivePreview(): boolean {
    if (this.disposed) {
      return this.snapshot.livePreview;
    }
    const largeFile = this.currentState.doc.length > LP_MAX_UNITS;
    if (largeFile) {
      return false;
    }

    this.previewEnabled = !this.previewEnabled;
    const effect = setModeEffect(this.previewEnabled ? livePreview() : []);
    if (this.view) {
      this.view.dispatch({ effects: effect });
    } else {
      this.state = this.state.update({ effects: effect }).state;
    }
    this.publish({ largeFile: false, livePreview: this.previewEnabled }, true);
    return this.previewEnabled;
  }

  /**
   * Reconfigures only the theme compartment. The view identity, document,
   * selection and undo history all survive; `replacePayload` reapplies the
   * current theme because a fresh EditorState starts with the default light
   * theme.
   */
  applyTheme(theme: "light" | "dark"): void {
    if (this.disposed || (this.themeApplied && this.theme === theme)) {
      return;
    }
    this.theme = theme;
    this.themeApplied = true;
    const effect = setThemeEffect(themeExtension(theme));
    if (this.view) {
      this.view.dispatch({ effects: effect });
    } else {
      this.state = this.state.update({ effects: effect }).state;
    }
  }

  /** SaveCoordinator subscribes here; the session never imports it. */
  onDocChanged(listener: () => void): () => void {
    if (this.disposed) {
      return () => undefined;
    }
    this.docChangedListeners.add(listener);
    return () => {
      this.docChangedListeners.delete(listener);
    };
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

  /**
   * Status-bar subscription: cursor/selection notifications are trailing
   * throttled, while save-state changes flush immediately.
   */
  subscribeStatus = (listener: () => void): (() => void) => {
    if (this.disposed) {
      return () => undefined;
    }
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  };

  flushStatus(): void {
    if (this.statusTimer !== null) {
      clearTimeout(this.statusTimer);
      this.statusTimer = null;
    }
    for (const listener of [...this.statusListeners]) {
      listener();
    }
  }

  getSnapshot = (): EditorSessionSnapshot => this.snapshot;

  dispose(): void {
    this.disposed = true;
    if (this.statusTimer !== null) {
      clearTimeout(this.statusTimer);
      this.statusTimer = null;
    }
    this.listeners.clear();
    this.statusListeners.clear();
    this.docChangedListeners.clear();
    this.view = null;
  }

  private attachUpdateListener(view: EditorView): void {
    this.view = view;
    this.state = view.state;
    const listener = EditorView.updateListener.of((update) => this.handleUpdate(update));
    view.dispatch({ effects: StateEffect.appendConfig.of(listener) });
    this.state = view.state;
  }

  private get currentState(): EditorState {
    return this.view?.state ?? this.state;
  }

  private handleUpdate(update: ViewUpdate): void {
    if (this.disposed) {
      return;
    }
    this.state = update.state;
    if (!update.docChanged && !update.selectionSet) {
      return;
    }

    let saveState = this.snapshot.saveState;
    let immediateStatus = false;

    if (update.docChanged && !this.snapshot.readOnly && saveState === "clean") {
      saveState = "dirty";
      immediateStatus = true;
    }

    const selection = selectionOf(update.state);
    const cursor = cursorAt(update.state, selection.head);
    const largeFile = update.state.doc.length > LP_MAX_UNITS;
    this.publish(
      {
        saveState,
        selection,
        cursor,
        largeFile,
        livePreview: this.previewEnabled && !largeFile,
      },
      immediateStatus,
    );

    // Notify after the dirty snapshot is visible, so SaveCoordinator can move
    // the same store from dirty to scheduled without being overwritten by the
    // editor's own state transition.
    if (update.docChanged) {
      for (const listener of [...this.docChangedListeners]) {
        listener();
      }
    }
  }

  private publish(
    patch: Partial<
      Pick<
        EditorSessionSnapshot,
        "saveState" | "selection" | "cursor" | "largeFile" | "livePreview"
      >
    >,
    immediateStatus = false,
  ): void {
    const saveState = patch.saveState ?? this.snapshot.saveState;
    const selection = patch.selection ?? this.snapshot.selection;
    const cursor = patch.cursor ?? this.snapshot.cursor;
    const largeFile = patch.largeFile ?? this.snapshot.largeFile;
    const livePreview = patch.livePreview ?? this.snapshot.livePreview;

    if (
      saveState === this.snapshot.saveState &&
      sameSelection(selection, this.snapshot.selection) &&
      sameCursor(cursor, this.snapshot.cursor) &&
      largeFile === this.snapshot.largeFile &&
      livePreview === this.snapshot.livePreview
    ) {
      return;
    }

    const next: EditorSessionSnapshot = Object.freeze({
      ...this.snapshot,
      saveState,
      dirty: saveState !== "clean" && saveState !== "readonly",
      largeFile,
      livePreview,
      selection,
      cursor,
      version: this.snapshot.version + 1,
    });
    this.snapshot = next;

    for (const listener of [...this.listeners]) {
      listener();
    }

    if (immediateStatus) {
      this.flushStatus();
    } else {
      this.scheduleStatus();
    }
  }

  private scheduleStatus(): void {
    if (this.statusTimer !== null) {
      return;
    }
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      this.flushStatus();
    }, this.statusThrottleMs);
  }
}
