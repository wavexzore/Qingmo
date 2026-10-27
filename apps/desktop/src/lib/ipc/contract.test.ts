import type { SaveRequest } from "@qingmo/shared";
import { describe, expect, it } from "vitest";

import {
  COMMANDS,
  COMMAND_NAMES,
  COMMAND_PERMISSIONS,
  commandPermission,
  EVENTS,
  EVENT_NAMES,
  MENU_ACTION_NAMES,
} from "./commands";

describe("IPC contract mirror", () => {
  it("keeps the ten command names stable", () => {
    expect(COMMAND_NAMES).toEqual([
      "document_open",
      "document_take_pending",
      "document_reload",
      "document_save_as",
      "document_write_atomic",
      "app_close_confirm",
      "app_update_status",
      "app_update_check",
      "app_update_download",
      "app_update_install",
    ]);
    expect(new Set(COMMAND_NAMES).size).toBe(10);
  });

  it("maps every command to its Tauri ACL permission", () => {
    for (const command of COMMAND_NAMES) {
      expect(COMMAND_PERMISSIONS[command]).toBe(commandPermission(command));
    }
    expect(COMMAND_PERMISSIONS[COMMANDS.documentOpen]).toBe("allow-document-open");
    expect(COMMAND_PERMISSIONS[COMMANDS.documentSaveAs]).toBe("allow-document-save-as");
    expect(COMMAND_PERMISSIONS[COMMANDS.documentWriteAtomic]).toBe("allow-document-write-atomic");
  });

  it("keeps the four events stable", () => {
    expect(EVENT_NAMES).toEqual([
      "app://close-requested",
      "app://update-state",
      "app://update-progress",
      "app://menu-action",
    ]);
    expect(EVENTS.closeRequested).toBe("app://close-requested");
    expect(EVENTS.updateState).toBe("app://update-state");
    expect(EVENTS.updateProgress).toBe("app://update-progress");
    expect(EVENTS.menuAction).toBe("app://menu-action");
  });

  it("exposes every native menu action once", () => {
    expect(MENU_ACTION_NAMES).toEqual([
      "file.open",
      "file.save",
      "palette.open",
      "view.toggleLivePreview",
      "view.toggleTheme",
      "theme.light",
      "theme.dark",
      "theme.system",
    ]);
    expect(new Set(MENU_ACTION_NAMES).size).toBe(MENU_ACTION_NAMES.length);
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
