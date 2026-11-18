import type { SettingsPort } from "./port";

/** In-memory settings adapter with explicit state helpers for tests. */
export class FakeSettings implements SettingsPort {
  closed = false;
  readonly openedLinks: string[] = [];
  private readonly version: string;

  constructor(version = "0.1.2") {
    this.version = version;
  }

  async info(): Promise<string> {
    return this.version;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async openExternal(href: string): Promise<void> {
    this.openedLinks.push(href);
  }
}
