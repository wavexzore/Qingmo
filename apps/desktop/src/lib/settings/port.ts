import type {
  KeyStatus,
  MeetingConfigGetResponse,
  MeetingConfigPatch,
  MeetingConfigSetResponse,
  ModelProgress,
  ModelView,
} from "@qingmo/shared";

/** Keyring slot names exposed to the settings page. */
export type KeySlot = "asr" | "llm";

/**
 * The settings window's only native surface.
 *
 * Version metadata and window lifecycle stay in Rust; the webview never
 * receives a window primitive or a filesystem path. Model progress arrives as
 * an event, never as a poll.
 */
export interface SettingsPort {
  info(): Promise<string>;
  close(): Promise<void>;
  meetingConfigGet(): Promise<MeetingConfigGetResponse>;
  meetingConfigSet(
    patch: MeetingConfigPatch,
    expectedRevision: number,
  ): Promise<MeetingConfigSetResponse>;
  meetingKeyStatus(slot: KeySlot): Promise<KeyStatus>;
  meetingKeySet(slot: KeySlot, value: string): Promise<void>;
  meetingKeyClear(slot: KeySlot, all?: boolean): Promise<void>;
  meetingModelsList(): Promise<ModelView[]>;
  meetingModelDownload(id: string): Promise<{ downloadId: string }>;
  meetingModelDownloadCancel(downloadId: string): Promise<void>;
  meetingModelRemove(id: string): Promise<void>;
  /** Subscribes to `app://meeting-model-progress`; returns the unsubscribe. */
  onModelProgress(handler: (progress: ModelProgress) => void): () => void;
  openExternal(href: string): Promise<void>;
}
