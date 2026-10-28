/**
 * The settings window's only native surface.
 *
 * Version metadata and window lifecycle stay in Rust; the webview never
 * receives a window primitive or a filesystem path.
 */
export interface SettingsPort {
  info(): Promise<string>;
  close(): Promise<void>;
}
