import type { FilePayload, SaveRequest, SaveResult } from "@qingmo/shared";

export interface CloseConfirmRequest {
  allow: boolean;
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
  appCloseConfirm(request: CloseConfirmRequest): Promise<void>;
}
