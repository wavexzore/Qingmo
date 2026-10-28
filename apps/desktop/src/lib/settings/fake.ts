import type { SettingsPort } from "./port";

/** Browser/test adapter. It records effects instead of touching the OS. */
export class FakeSettings implements SettingsPort {
  closed = false;
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
}
