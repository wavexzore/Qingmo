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
  it("keeps the sixty-two command names stable", () => {
    expect(COMMAND_NAMES).toEqual([
      "document_open",
      "document_new",
      "document_take_pending",
      "document_activate",
      "document_reload",
      "document_save_as",
      "document_write_atomic",
      "document_save_image",
      "document_history_list",
      "document_history_read",
      "document_history_restore",
      "workspace_open",
      "workspace_current",
      "workspace_list",
      "workspace_open_document",
      "workspace_locate_document",
      "workspace_delete",
      "workspace_trash_list",
      "workspace_trash_restore",
      "workspace_trash_purge",
      "workspace_search",
      "workspace_search_rebuild",
      "app_close_confirm",
      "app_set_live_preview",
      "app_about_info",
      "app_about_close",
      "app_about_open_link",
      "app_open_external",
      "app_settings_info",
      "app_settings_close",
      "app_update_status",
      "app_update_check",
      "app_update_download",
      "app_update_install",
      "app_update_flush_ack",
      "app_logs_list",
      "app_logs_stats",
      "app_logs_export",
      "app_logs_open_dir",
      "app_logs_clear",
      "app_apply_locale",
      "session_view_state_get",
      "session_view_state_set",
      "session_draft_write",
      "session_draft_list",
      "session_draft_read",
      "session_draft_discard",
      "meeting_start",
      "meeting_retry",
      "meeting_cancel",
      "meeting_status",
      "meeting_take_result",
      "meeting_config_get",
      "meeting_config_set",
      "meeting_key_status",
      "meeting_key_set",
      "meeting_key_clear",
      "meeting_models_list",
      "meeting_model_download",
      "meeting_model_download_cancel",
      "meeting_model_remove",
      "app_settings_open",
    ]);
    expect(new Set(COMMAND_NAMES).size).toBe(62);
  });

  it("maps every command to its Tauri ACL permission", () => {
    for (const command of COMMAND_NAMES) {
      expect(COMMAND_PERMISSIONS[command]).toBe(commandPermission(command));
    }
    expect(COMMAND_PERMISSIONS[COMMANDS.documentOpen]).toBe("allow-document-open");
    expect(COMMAND_PERMISSIONS[COMMANDS.documentNew]).toBe("allow-document-new");
    expect(COMMAND_PERMISSIONS[COMMANDS.documentActivate]).toBe("allow-document-activate");
    expect(COMMAND_PERMISSIONS[COMMANDS.documentSaveAs]).toBe("allow-document-save-as");
    expect(COMMAND_PERMISSIONS[COMMANDS.documentWriteAtomic]).toBe("allow-document-write-atomic");
    expect(COMMAND_PERMISSIONS[COMMANDS.workspaceOpen]).toBe("allow-workspace-open");
    expect(COMMAND_PERMISSIONS[COMMANDS.workspaceList]).toBe("allow-workspace-list");
    expect(COMMAND_PERMISSIONS[COMMANDS.workspaceLocateDocument]).toBe(
      "allow-workspace-locate-document",
    );
    expect(COMMAND_PERMISSIONS[COMMANDS.documentSaveImage]).toBe("allow-document-save-image");
    expect(COMMAND_PERMISSIONS[COMMANDS.documentHistoryRestore]).toBe(
      "allow-document-history-restore",
    );
    expect(COMMAND_PERMISSIONS[COMMANDS.workspaceSearch]).toBe("allow-workspace-search");
    expect(COMMAND_PERMISSIONS[COMMANDS.appAboutOpenLink]).toBe("allow-app-about-open-link");
    expect(COMMAND_PERMISSIONS[COMMANDS.sessionViewStateGet]).toBe("allow-session-view-state-get");
    expect(COMMAND_PERMISSIONS[COMMANDS.sessionDraftDiscard]).toBe("allow-session-draft-discard");
    expect(COMMAND_PERMISSIONS[COMMANDS.meetingTakeResult]).toBe("allow-meeting-take-result");
    expect(COMMAND_PERMISSIONS[COMMANDS.meetingModelDownloadCancel]).toBe(
      "allow-meeting-model-download-cancel",
    );
    expect(COMMAND_PERMISSIONS[COMMANDS.appSettingsOpen]).toBe("allow-app-settings-open");
  });

  it("keeps the thirteen events stable", () => {
    expect(EVENT_NAMES).toEqual([
      "app://close-requested",
      "app://close-cancelled",
      "app://update-state",
      "app://update-progress",
      "app://update-flush-request",
      "app://menu-action",
      "app://document-changed",
      "app://document-relocated",
      "app://document-new-failed",
      "app://workspace-changed",
      "app://workspace-index-status",
      "app://meeting-progress",
      "app://meeting-model-progress",
    ]);
    expect(EVENTS.closeRequested).toBe("app://close-requested");
    expect(EVENTS.updateState).toBe("app://update-state");
    expect(EVENTS.updateProgress).toBe("app://update-progress");
    expect(EVENTS.updateFlushRequest).toBe("app://update-flush-request");
    expect(EVENTS.menuAction).toBe("app://menu-action");
    expect(EVENTS.documentChanged).toBe("app://document-changed");
    expect(EVENTS.documentRelocated).toBe("app://document-relocated");
    expect(EVENTS.documentNewFailed).toBe("app://document-new-failed");
    expect(EVENTS.workspaceChanged).toBe("app://workspace-changed");
    expect(EVENTS.closeCancelled).toBe("app://close-cancelled");
    expect(EVENTS.workspaceIndexStatus).toBe("app://workspace-index-status");
    expect(EVENTS.meetingProgress).toBe("app://meeting-progress");
    expect(EVENTS.meetingModelProgress).toBe("app://meeting-model-progress");
  });

  it("exposes every native menu action once", () => {
    expect(MENU_ACTION_NAMES).toEqual([
      "file.new",
      "file.open",
      "file.openFolder",
      "file.save",
      "file.meeting",
      "palette.open",
      "view.toggleLivePreview",
      "view.toggleOutline",
      "view.toggleTheme",
      "theme.light",
      "theme.dark",
      "theme.system",
      "app.openLogs",
      "language.zh-CN",
      "language.en",
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
