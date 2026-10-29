import type {
  ApplyLocaleRequest,
  DocumentChangedPayload,
  DraftMeta,
  DraftRecord,
  DraftWriteRequest,
  EditorViewState,
  EditorViewStateInput,
  FilePayload,
  SaveRequest,
  SaveResult,
} from "@qingmo/shared";

export interface CloseConfirmRequest {
  allow: boolean;
}

export interface LivePreviewRequest {
  livePreview: boolean;
}

/**
 * The only document/file channel available to the UI.
 *
 * There is deliberately no path parameter: the native dialog runs in Rust and
 * `docToken` is the only handle the webview may present.
 */
export interface IpcPort {
  /**
   * Opens a document through the native dialog.
   *
   * Tauri creates a new window and resolves `null`; the caller must not touch
   * its own session. Browser test adapters cannot create native windows, so
   * they return the payload for the caller to adopt in place.
   */
  documentOpen(): Promise<FilePayload | null>;
  /** Consumes the payload staged for a freshly created document window. */
  documentTakePending(): Promise<FilePayload | null>;
  documentReload(docToken: string): Promise<FilePayload>;
  /** Native Save As; the webview supplies text but never a path. */
  documentSaveAs(text: string): Promise<FilePayload>;
  documentWriteAtomic(request: SaveRequest): Promise<SaveResult>;
  /**
   * Rust reports a different (or missing) disk version for an open document.
   * The payload carries its `docToken`; every window ignores tokens it does
   * not own. Returns an unsubscribe function.
   */
  onDocumentChanged(callback: (change: DocumentChangedPayload) => void): () => void;
  appCloseConfirm(request: CloseConfirmRequest): Promise<void>;
  /** Mirrors this window's Live Preview mode in the native menu bar. */
  appSetLivePreview(request: LivePreviewRequest): Promise<void>;
  /** Projects the current language and native labels into the shell. */
  appApplyLocale(request: ApplyLocaleRequest): Promise<void>;
  /** Persisted view state for a named document; `null` when unknown. */
  sessionViewStateGet(path: string): Promise<EditorViewState | null>;
  sessionViewStateSet(path: string, state: EditorViewStateInput): Promise<void>;
  /** Creates or updates a crash draft; the returned id is owned by the caller. */
  sessionDraftWrite(request: DraftWriteRequest): Promise<DraftMeta>;
  /** Main window only: metadata for every recoverable draft. */
  sessionDraftList(): Promise<DraftMeta[]>;
  /** Main window only: the draft body, used only after an explicit restore. */
  sessionDraftRead(id: string): Promise<DraftRecord>;
  /** Deletes the draft; `false` means it was already gone. */
  sessionDraftDiscard(id: string): Promise<boolean>;
}
