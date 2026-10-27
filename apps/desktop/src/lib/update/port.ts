import type { UpdateProgressPayload, UpdateSnapshot } from "@qingmo/shared";

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
}
