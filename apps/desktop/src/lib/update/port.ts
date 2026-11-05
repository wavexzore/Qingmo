import type { UpdateFlushRequest, UpdateProgressPayload, UpdateSnapshot } from "@qingmo/shared";

/**
 * The only update channel available to the UI.
 *
 * Rust owns the state machine; this port is stateless on the Tauri side and
 * only mirrors snapshots/events. It is deliberately separate from `IpcPort`
 * so document commands cannot grow update responsibilities by accident.
 */
export interface UpdatePort {
  status(): Promise<UpdateSnapshot>;
  check(): Promise<UpdateSnapshot>;
  download(): Promise<UpdateSnapshot>;
  install(): Promise<void>;
  onState(handler: (snapshot: UpdateSnapshot) => void): Promise<() => void>;
  onProgress(handler: (progress: UpdateProgressPayload) => void): Promise<() => void>;
  /**
   * Rust asks every editable window to save before an install restarts the
   * app. The handler must answer through `flushAck`; a missing answer aborts
   * the install rather than risk unsaved text.
   */
  onFlushRequest(handler: (request: UpdateFlushRequest) => void): Promise<() => void>;
  /** Answers a pre-install flush request for this window. */
  flushAck(requestId: number, ok: boolean): Promise<void>;
}
