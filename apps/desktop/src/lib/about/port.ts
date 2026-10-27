import type { AboutInfo, AboutLink } from "@qingmo/shared";

/**
 * The About window's only native surface.
 *
 * Version metadata and external destinations are resolved in Rust: the webview
 * never supplies a URL and never receives a filesystem or window primitive.
 */
export interface AboutPort {
  info(): Promise<AboutInfo>;
  close(): Promise<void>;
  openLink(link: AboutLink): Promise<void>;
}
