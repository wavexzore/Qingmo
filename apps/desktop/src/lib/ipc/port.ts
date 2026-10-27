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
  documentOpen(): Promise<FilePayload>;
  documentReload(docToken: string): Promise<FilePayload>;
  /** Native Save As; the webview supplies text but never a path. */
  documentSaveAs(text: string): Promise<FilePayload>;
  documentWriteAtomic(request: SaveRequest): Promise<SaveResult>;
  appCloseConfirm(request: CloseConfirmRequest): Promise<void>;
}
