import type {
  ApplyLocaleRequest,
  DocumentChangedPayload,
  DocumentRelocatedPayload,
  DraftMeta,
  DraftRecord,
  DraftWriteRequest,
  EditorViewState,
  EditorViewStateInput,
  FilePayload,
  HistoryEntry,
  HistoryRecord,
  ImageSaveResult,
  SaveRequest,
  SaveResult,
  SearchResponse,
  TrashEntry,
  TrashRestoreMode,
  TrashRestoreResult,
  WorkspaceInfo,
  WorkspaceListing,
} from "@qingmo/shared";

export interface CloseConfirmRequest {
  allow: boolean;
  /** Generation from the close request; stale values are rejected by Rust. */
  generation: number;
}

export interface LivePreviewRequest {
  livePreview: boolean;
}

/**
 * Where a New request placed the untitled document.
 *
 * Tauri creates a native window (`window`). Browser harnesses cannot, so they
 * reset the current window (`current`) and the caller adopts the new empty
 * session in place.
 */
export type DocumentNewPlacement = "window" | "current";

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
  /**
   * Makes a payload returned by `documentOpen` the active document token, or
   * restores an earlier token after an abandoned open.
   *
   * Browser adapters keep one active token and switch it on open; a caller
   * that aborts (failed late write) can activate its previous token again.
   * The `untitled` sentinel clears the active record (no writable path), and
   * an unknown token is rejected with `INVALID_PATH`. The native adapter
   * switches the window token and keeps the previous one alive for one
   * rollback; the next switch or the window close releases it.
   */
  documentActivate(docToken: string): Promise<void>;
  /**
   * Creates a new empty document. A native window receives an untitled
   * session on boot and this window keeps its document untouched. Browser
   * adapters return `current`; the caller flushes (or journals) the current
   * document and then replaces this window's session.
   */
  documentNew(): Promise<DocumentNewPlacement>;
  /** Consumes the payload staged for a freshly created document window. */
  documentTakePending(): Promise<FilePayload | null>;
  documentReload(docToken: string): Promise<FilePayload>;
  /** Native Save As; the webview supplies text but never a path. */
  documentSaveAs(text: string): Promise<FilePayload>;
  documentWriteAtomic(request: SaveRequest): Promise<SaveResult>;
  /** Persists one pasted/dropped image under the document's assets/ folder. */
  documentSaveImage(request: {
    docToken: string;
    fileName: string;
    mime: string;
    dataBase64: string;
  }): Promise<ImageSaveResult>;
  documentHistoryList(docToken: string, limit?: number, offset?: number): Promise<HistoryEntry[]>;
  documentHistoryRead(docToken: string, entryId: string): Promise<HistoryRecord>;
  documentHistoryRestore(docToken: string, entryId: string): Promise<FilePayload>;
  /**
   * Rust reports a different (or missing) disk version for an open document.
   * The payload carries its `docToken`; every window ignores tokens it does
   * not own. Returns an unsubscribe function.
   */
  onDocumentChanged(callback: (change: DocumentChangedPayload) => void): () => void;
  /** A rename moved the open document; the payload carries its new path. */
  onDocumentRelocated(callback: (relocated: DocumentRelocatedPayload) => void): () => void;
  /**
   * Opens a folder through the native dialog. The returned token identifies
   * this window's workspace; it is never persisted and never shared.
   */
  workspaceOpen(): Promise<WorkspaceInfo>;
  /** The calling window's current workspace, or `null` at startup. */
  workspaceCurrent(): Promise<WorkspaceInfo | null>;
  /** Lists one directory level below the workspace root. */
  workspaceList(workspaceToken: string, dirSegments: string[]): Promise<WorkspaceListing>;
  /**
   * Reads a tree file for an in-window switch. The caller preserves the
   * current document, adopts the payload, then calls `documentActivate`.
   * A failed adoption leaves the current document and its token untouched.
   */
  workspaceOpenDocument(workspaceToken: string, segments: string[]): Promise<FilePayload>;
  /** Path segments of this window's current document, or `null`. */
  workspaceLocateDocument(workspaceToken: string, docToken: string): Promise<string[] | null>;
  workspaceDelete(workspaceToken: string, segments: string[]): Promise<TrashEntry>;
  workspaceTrashList(workspaceToken: string): Promise<TrashEntry[]>;
  workspaceTrashRestore(
    workspaceToken: string,
    entryId: string,
    mode: TrashRestoreMode,
  ): Promise<TrashRestoreResult>;
  workspaceTrashPurge(workspaceToken: string, entryId: string): Promise<void>;
  workspaceSearch(
    workspaceToken: string,
    query: string,
    limit?: number,
    offset?: number,
  ): Promise<SearchResponse>;
  workspaceSearchRebuild(workspaceToken: string): Promise<void>;
  /**
   * Subscribes to workspace tree changes for this window. The payload is
   * empty by design; the hook re-lists known directories.
   */
  onWorkspaceChanged(callback: () => void): () => void;
  onCloseCancelled(callback: (payload: { reason: string; generation: number }) => void): () => void;
  onWorkspaceIndexStatus(
    callback: (payload: import("@qingmo/shared").WorkspaceIndexStatusPayload) => void,
  ): () => void;
  appCloseConfirm(request: CloseConfirmRequest): Promise<void>;
  /** Mirrors this window's Live Preview mode in the native menu bar. */
  appSetLivePreview(request: LivePreviewRequest): Promise<void>;
  /** Projects the current language and native labels into the shell. */
  appApplyLocale(request: ApplyLocaleRequest): Promise<void>;
  /**
   * Opens an external link in the system browser. Rust owns the scheme
   * whitelist; the webview only supplies the destination.
   */
  appOpenExternal(href: string): Promise<void>;
  /** Persisted view state for a named document; `null` when unknown. */
  sessionViewStateGet(path: string, docToken?: string): Promise<EditorViewState | null>;
  sessionViewStateSet(path: string, state: EditorViewStateInput, docToken?: string): Promise<void>;
  /** Creates or updates a crash draft; the returned id is owned by the caller. */
  sessionDraftWrite(request: DraftWriteRequest): Promise<DraftMeta>;
  /** Main window only: metadata for every recoverable draft. */
  sessionDraftList(): Promise<DraftMeta[]>;
  /** Main window only: the draft body, used only after an explicit restore. */
  sessionDraftRead(id: string): Promise<DraftRecord>;
  /** Deletes the draft; `false` means it was already gone. */
  sessionDraftDiscard(id: string): Promise<boolean>;
}
