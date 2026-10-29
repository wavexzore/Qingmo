import { StateEffect, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import {
  createEditorState,
  livePreview,
  normalizeLineEndings,
  previewTierFor,
  setEditorUiCopyEffect,
  setModeEffect,
  setPlaceholderEffect,
  setReadOnlyEffect,
  setThemeEffect,
  themeExtension,
  type EditorUiCopy,
  type PreviewTier,
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
  /** Preview tier derived from the current document length. */
  previewTier: PreviewTier;
  /** User preference; survives reloads and is independent of affordability. */
  livePreviewPreferred: boolean;
  /** Effective mode: preference AND tier !== "source". */
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
  /** Initial Widget/block copy; the locale hook replaces it on changes. */
  uiCopy?: EditorUiCopy;
  /** User preference for Live Preview; defaults to true. */
  previewPreference?: boolean;
  /**
   * Persisted selection restored before the first view exists. Clamped by
   * `createEditorState` against the normalized document length.
   */
  initialSelection?: EditorSelectionSnapshot;
  /** Initial text for a restored untitled draft; ignored for named files. */
  initialText?: string;
  /** Marks a restored untitled draft as dirty before the first edit. */
  initialDirty?: boolean;
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
  private placeholder: string | undefined;
  private pendingPlaceholder: string | null = null;
  private uiCopy: EditorUiCopy | undefined;
  private pendingUiCopy: EditorUiCopy | null = null;
  private metadata: EditorMetadataSnapshot;
  private state: EditorState;
  private snapshot: EditorSessionSnapshot;
  private previewPreference: boolean;
  private modeAttached = false;
  private pendingModeSync = false;
  private modeSyncScheduled = false;
  private untitled: boolean;
  private theme: "light" | "dark" = "light";
  private themeApplied = false;
  private view: EditorView | null = null;
  private compositionCleanup: (() => void) | null = null;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  private constructor(payload: FilePayload, options: EditorSessionOptions) {
    this.docTokenValue = payload.docToken;
    this.statusThrottleMs = options.statusThrottleMs ?? STATUS_THROTTLE_MS;
    this.extraExtensions = options.extensions ?? [];
    this.placeholder = options.placeholder;
    this.uiCopy = options.uiCopy;
    this.untitled = options.untitledTitle !== undefined;
    this.previewPreference = options.previewPreference ?? true;

    // `createEditorState` normalizes line endings, so derive the tier from the
    // normalized length in the same way the factory does.
    const tier = previewTierFor(normalizeLineEndings(payload.text).length);
    const effective = this.previewPreference && tier !== "source";
    const state = createEditorState({
      doc: payload.text,
      readOnly: payload.readOnly,
      extraExtensions: this.extraExtensions,
      previewEnabled: effective,
      ...(options.initialSelection ? { selection: options.initialSelection } : {}),
      ...(this.placeholder !== undefined ? { placeholder: this.placeholder } : {}),
      ...(this.uiCopy !== undefined ? { uiCopy: this.uiCopy } : {}),
    });
    this.state = state;
    this.modeAttached = effective;

    const selection = selectionOf(this.state);
    const initialDirty = options.initialDirty === true && !payload.readOnly;
    const saveState: SaveState = payload.readOnly ? "readonly" : initialDirty ? "dirty" : "clean";
    this.metadata = metadataOf(payload, options.untitledTitle);

    this.snapshot = Object.freeze({
      ...this.metadata,
      saveState,
      dirty: initialDirty,
      previewTier: tier,
      livePreviewPreferred: this.previewPreference,
      livePreview: effective,
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
    const text = options.initialText ?? "";
    return new EditorSession(
      {
        docToken: UNTITLED_DOC_TOKEN,
        path: "",
        text,
        format: { encoding: "utf8", hasBom: false, eol: "lf" },
        mixedEol: false,
        hash: "",
        size: new TextEncoder().encode(text).length,
        // UTF-16 code units, matching JavaScript `String.length`.
        textUnits: text.length,
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

    const tier = previewTierFor(normalizeLineEndings(payload.text).length);
    const effective = this.previewPreference && tier !== "source";
    let state = createEditorState({
      doc: payload.text,
      readOnly: payload.readOnly,
      extraExtensions: this.extraExtensions,
      previewEnabled: effective,
      ...(this.placeholder !== undefined ? { placeholder: this.placeholder } : {}),
      ...(this.uiCopy !== undefined ? { uiCopy: this.uiCopy } : {}),
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
    // A reload must not reset the user's preview preference; only the tier
    // and the effective mode are re-derived.
    this.modeAttached = effective;
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
      previewTier: tier,
      livePreviewPreferred: this.previewPreference,
      livePreview: effective,
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
    this.attachCompositionListener(view);
    this.attachUpdateListener(view);
    return () => this.detach(view);
  }

  detach(view?: EditorView): void {
    if (view && this.view !== view) {
      return;
    }
    this.compositionCleanup?.();
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
   * touches the document, so undo history and selection survive. Source-tier
   * documents cannot enable preview; shrinking below the boundary restores
   * the user's preference automatically through `handleUpdate`.
   */
  toggleLivePreview(): boolean {
    if (this.disposed) {
      return this.snapshot.livePreview;
    }
    const tier = previewTierFor(this.currentState.doc.length);
    if (tier === "source") {
      return false;
    }

    this.previewPreference = !this.previewPreference;
    const effective = this.previewPreference;
    this.modeAttached = effective;
    const effect = setModeEffect(effective ? livePreview() : []);
    if (this.view) {
      this.view.dispatch({ effects: effect });
    } else {
      this.state = this.state.update({ effects: effect }).state;
    }
    this.publish(
      {
        previewTier: tier,
        livePreviewPreferred: this.previewPreference,
        livePreview: effective,
      },
      true,
    );
    return effective;
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

  /**
   * Reconfigures the placeholder compartment for an untitled draft. Named
   * documents never show a hint, so they ignore this call. While an IME
   * composition is active the effect is deferred to `compositionend`; the
   * document, selection and undo history are untouched either way.
   */
  applyPlaceholder(text: string): void {
    if (this.disposed || !this.untitled) {
      return;
    }
    if (this.placeholder === text && this.pendingPlaceholder === null) {
      return;
    }
    this.placeholder = text;
    this.pendingPlaceholder = text;
    this.flushPlaceholder();
  }

  /**
   * Swaps the Widget/block copy in place. Like the placeholder, the effect is
   * deferred while an IME composition is active, and the document, selection
   * and undo history are untouched.
   */
  applyUiCopy(copy: EditorUiCopy): void {
    if (this.disposed || this.uiCopy?.version === copy.version) {
      return;
    }
    this.uiCopy = copy;
    this.pendingUiCopy = copy;
    this.flushUiCopy();
  }

  /**
   * Renames the in-memory untitled draft without touching `docId`/`docToken`.
   * The status bar reads `fileName` from the same immutable snapshot.
   */
  applyUntitledTitle(title: string): void {
    if (this.disposed || !this.untitled || this.metadata.fileName === title) {
      return;
    }
    this.metadata = Object.freeze({ ...this.metadata, fileName: title });
    this.publish({ fileName: title });
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
    this.compositionCleanup?.();
    this.pendingPlaceholder = null;
    this.pendingUiCopy = null;
    this.pendingModeSync = false;
    this.modeSyncScheduled = false;
    this.listeners.clear();
    this.statusListeners.clear();
    this.docChangedListeners.clear();
    this.view = null;
  }

  private attachCompositionListener(view: EditorView): void {
    const onCompositionEnd = (): void => {
      this.flushPlaceholder();
      this.flushUiCopy();
      if (this.pendingModeSync) {
        this.flushModeSync();
      }
    };
    view.contentDOM.addEventListener("compositionend", onCompositionEnd);
    this.compositionCleanup = () => {
      view.contentDOM.removeEventListener("compositionend", onCompositionEnd);
      this.compositionCleanup = null;
    };
  }

  private flushPlaceholder(): void {
    if (this.disposed || !this.untitled || this.pendingPlaceholder === null) {
      return;
    }
    if (this.view?.composing) {
      return;
    }
    const text = this.pendingPlaceholder;
    this.pendingPlaceholder = null;
    const effect = setPlaceholderEffect(text);
    if (this.view) {
      this.view.dispatch({ effects: effect });
    } else {
      this.state = this.state.update({ effects: effect }).state;
    }
  }

  private flushUiCopy(): void {
    if (this.disposed || this.pendingUiCopy === null) {
      return;
    }
    if (this.view?.composing) {
      return;
    }
    const copy = this.pendingUiCopy;
    this.pendingUiCopy = null;
    const effect = setEditorUiCopyEffect(copy);
    if (this.view) {
      this.view.dispatch({ effects: effect });
    } else {
      this.state = this.state.update({ effects: effect }).state;
    }
  }

  /**
   * Defers the mode compartment reconfiguration out of the update listener.
   * CM6 forbids a synchronous dispatch while an update is being processed;
   * an active IME composition additionally defers until `compositionend`.
   */
  private requestModeSync(): void {
    if (this.disposed) {
      return;
    }
    if (this.view?.composing) {
      this.pendingModeSync = true;
      return;
    }
    if (this.modeSyncScheduled) {
      return;
    }
    this.modeSyncScheduled = true;
    queueMicrotask(() => {
      this.modeSyncScheduled = false;
      this.flushModeSync();
    });
  }

  private flushModeSync(): void {
    if (this.disposed) {
      return;
    }
    if (this.view?.composing) {
      this.pendingModeSync = true;
      return;
    }
    this.pendingModeSync = false;
    const tier = previewTierFor(this.currentState.doc.length);
    const effective = this.previewPreference && tier !== "source";
    if (effective === this.modeAttached) {
      return;
    }
    // Set the flag before dispatch: the update listener runs synchronously
    // and would otherwise schedule the same sync again.
    this.modeAttached = effective;
    const effect = setModeEffect(effective ? livePreview() : []);
    if (this.view) {
      this.view.dispatch({ effects: effect });
    } else {
      this.state = this.state.update({ effects: effect }).state;
    }
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
    const tier = previewTierFor(update.state.doc.length);
    const effective = this.previewPreference && tier !== "source";
    if (effective !== this.modeAttached) {
      this.requestModeSync();
    }
    this.publish(
      {
        saveState,
        selection,
        cursor,
        previewTier: tier,
        livePreviewPreferred: this.previewPreference,
        livePreview: effective,
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
        | "saveState"
        | "selection"
        | "cursor"
        | "previewTier"
        | "livePreviewPreferred"
        | "livePreview"
        | "fileName"
      >
    >,
    immediateStatus = false,
  ): void {
    const saveState = patch.saveState ?? this.snapshot.saveState;
    const selection = patch.selection ?? this.snapshot.selection;
    const cursor = patch.cursor ?? this.snapshot.cursor;
    const previewTier = patch.previewTier ?? this.snapshot.previewTier;
    const livePreviewPreferred = patch.livePreviewPreferred ?? this.snapshot.livePreviewPreferred;
    const livePreview = patch.livePreview ?? this.snapshot.livePreview;
    const fileName = patch.fileName ?? this.snapshot.fileName;

    if (
      saveState === this.snapshot.saveState &&
      sameSelection(selection, this.snapshot.selection) &&
      sameCursor(cursor, this.snapshot.cursor) &&
      previewTier === this.snapshot.previewTier &&
      livePreviewPreferred === this.snapshot.livePreviewPreferred &&
      livePreview === this.snapshot.livePreview &&
      fileName === this.snapshot.fileName
    ) {
      return;
    }

    const next: EditorSessionSnapshot = Object.freeze({
      ...this.snapshot,
      saveState,
      dirty: saveState !== "clean" && saveState !== "readonly",
      previewTier,
      livePreviewPreferred,
      livePreview,
      fileName,
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
