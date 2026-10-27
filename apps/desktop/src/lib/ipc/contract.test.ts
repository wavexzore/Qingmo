import type { SaveRequest } from "@qingmo/shared";
import { describe, expect, it } from "vitest";

import {
  COMMANDS,
  COMMAND_NAMES,
  COMMAND_PERMISSIONS,
  commandPermission,
  EVENTS,
  EVENT_NAMES,
} from "./commands";

describe("IPC contract mirror", () => {
  it("keeps the five command names stable", () => {
    expect(COMMAND_NAMES).toEqual([
      "document_open",
      "document_reload",
      "document_save_as",
      "document_write_atomic",
      "app_close_confirm",
    ]);
    expect(new Set(COMMAND_NAMES).size).toBe(5);
  });

  it("maps every command to its Tauri ACL permission", () => {
    for (const command of COMMAND_NAMES) {
      expect(COMMAND_PERMISSIONS[command]).toBe(commandPermission(command));
    }
    expect(COMMAND_PERMISSIONS[COMMANDS.documentOpen]).toBe("allow-document-open");
    expect(COMMAND_PERMISSIONS[COMMANDS.documentSaveAs]).toBe("allow-document-save-as");
    expect(COMMAND_PERMISSIONS[COMMANDS.documentWriteAtomic]).toBe("allow-document-write-atomic");
  });

  it("keeps the single close event stable", () => {
    expect(EVENT_NAMES).toEqual(["app://close-requested"]);
    expect(EVENTS.closeRequested).toBe("app://close-requested");
  });

  it("accepts the optional expected hash on save requests", () => {
    const request: SaveRequest = {
      docToken: "token",
      text: "hello\n",
    };
    expect(request.expectedCurrentHash).toBeUndefined();

    const confirmed: SaveRequest = { ...request, expectedCurrentHash: "abc" };
    expect(confirmed.expectedCurrentHash).toBe("abc");
  });
});
