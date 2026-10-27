import type { AboutInfo, AboutLink } from "@qingmo/shared";

import type { AboutPort } from "./port";

export const FAKE_ABOUT_INFO: AboutInfo = {
  version: "0.1.0",
  build: "0.1.0 · arm64",
  platform: "macOS",
  license: "Apache-2.0",
  copyright: "© 2026 Qingmo Contributors",
};

/** Browser/test adapter. It records effects instead of touching the OS. */
export class FakeAbout implements AboutPort {
  readonly openedLinks: AboutLink[] = [];
  closed = false;
  private readonly value: AboutInfo;

  constructor(value: AboutInfo = FAKE_ABOUT_INFO) {
    this.value = value;
  }

  async info(): Promise<AboutInfo> {
    return this.value;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async openLink(link: AboutLink): Promise<void> {
    this.openedLinks.push(link);
  }
}
