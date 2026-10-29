import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Outlet, useNavigate } from "react-router-dom";

import type { AppError } from "@qingmo/shared";

import { useAppServices } from "../../app/AppServices";
import { CloseConfirmDialog } from "../../app/CloseConfirmDialog";
import { useCloseGuard } from "../../app/useCloseGuard";
import { useThemeService } from "../../app/useThemeService";
import { useToast } from "../../components/ToastHost";
import { buildEditorUiCopy } from "../../i18n/editorCopy";
import { normalizeLanguage } from "../../i18n/language";
import { MENU_ACTIONS } from "../../lib/ipc/commands";
import { AppError as AppErrorClass } from "../../lib/ipc/errors";
import { uiStore } from "../../stores/uiStore";
import { CommandPalette } from "../commands/CommandPalette";
import { commandRegistry } from "../commands/CommandRegistry";
import { useCommandKeybindings } from "../commands/keybindings";
import { useThemeCommand } from "../commands/themeCommand";
import { useDocumentSession } from "../editor/DocumentSessionContext";
import { createDocumentSession } from "../editor/session/createDocumentSession";
import { useEditorLocale } from "../editor/useEditorLocale";
import { useLivePreviewMenu } from "../editor/useLivePreviewMenu";
import { LogDialog } from "../logs/LogDialog";
import { UpdateHost } from "../update/UpdateHost";
import { useUpdateController, useUpdateSnapshot } from "../update/UpdateProvider";
import { openFile } from "./openFile";

/**
 * App-level workspace layout. It owns the single `file.open` registration and
 * the native menu dispatch, so commands remain available on both the blank
 * editor and an open document (T-015's palette) without duplicate
 * registrations.
 */
export function WorkspaceLayout() {
  const { t, i18n } = useTranslation(["errors", "editor"]);
  const toast = useToast();
  const navigate = useNavigate();
  const { ipc, platform } = useAppServices();
  const { session, coordinator, recorder, setSession } = useDocumentSession();
  const closeGuard = useCloseGuard({ ipc, platform, coordinator, viewState: recorder });
  const updateController = useUpdateController();
  const updateSnapshot = useUpdateSnapshot();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const openingRef = useRef(false);
  const sessionRef = useRef(session);
  const coordinatorRef = useRef(coordinator);
  sessionRef.current = session;
  coordinatorRef.current = coordinator;
  const hasSession = session !== null;
  const updateBlocked = closeGuard.closing || closeGuard.prompt !== null;

  useThemeCommand();
  useThemeService(session);
  useEditorLocale(session);
  useLivePreviewMenu(ipc, session);

  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const handleCommandError = useCallback(
    (error: AppError) => {
      if (error.code === "CANCELLED") {
        return;
      }
      toast.push(t(`errors:${error.code}`));
    },
    [t, toast],
  );
  useCommandKeybindings({
    enabled:
      !paletteOpen &&
      !logsOpen &&
      !updateBlocked &&
      !updateDialogOpen &&
      updateSnapshot?.phase !== "installing",
    onOpenPalette: openPalette,
    onError: handleCommandError,
  });

  useEffect(() => {
    return updateController.registerPrepareInstall(async () => {
      const coordinator = coordinatorRef.current;
      if (coordinator) {
        return coordinator.flush("close");
      }
      if (sessionRef.current === null) {
        return { ok: true, state: "clean" } as const;
      }
      return {
        ok: false,
        state: "error",
        failure: "error",
        error: new AppErrorClass("IO", "document save coordinator is unavailable"),
      } as const;
    });
  }, [updateController]);

  const openDocument = useCallback(async () => {
    if (openingRef.current) {
      return;
    }
    openingRef.current = true;
    try {
      // Opening never replaces this window: Tauri creates a new document
      // window, so there is nothing to flush and a dirty untitled buffer must
      // not be forced through Save As first.
      const result = await openFile(ipc);
      if (!result.ok) {
        if (result.error.code !== "CANCELLED") {
          toast.push(t(`errors:${result.error.code}`));
        }
        return;
      }
      if (result.value === null) {
        // Tauri created a new window for this document; the current session
        // stays exactly as it was.
        return;
      }
      // Browser harness fallback: no native window exists, adopt in place.
      const created = await createDocumentSession(
        ipc,
        result.value,
        buildEditorUiCopy(normalizeLanguage(i18n.language)),
      );
      setSession(created.session, { viewState: created.viewState });
      navigate("/editor");
    } finally {
      openingRef.current = false;
    }
  }, [i18n.language, ipc, navigate, setSession, t, toast]);

  const runMenuCommand = useCallback(
    async (id: string) => {
      if (!commandRegistry.list().some((command) => command.id === id)) {
        return;
      }
      const result = await commandRegistry.execute(id);
      if (!result.ok) {
        handleCommandError(result.error);
      }
    },
    [handleCommandError],
  );

  // Native menu items are mirrored by the same availability gate as
  // keyboard shortcuts: no menu-driven open/save while a modal or install is
  // in progress.
  const menuEnabled =
    !paletteOpen &&
    !logsOpen &&
    !updateBlocked &&
    !updateDialogOpen &&
    updateSnapshot?.phase !== "installing";

  useEffect(() => {
    if (!menuEnabled) {
      return;
    }
    return platform.onMenuAction((action) => {
      switch (action) {
        case MENU_ACTIONS.fileOpen:
          void openDocument();
          break;
        case MENU_ACTIONS.fileSave:
          void runMenuCommand("file.save");
          break;
        case MENU_ACTIONS.paletteOpen:
          openPalette();
          break;
        case MENU_ACTIONS.toggleLivePreview:
          void runMenuCommand("view.toggleLivePreview");
          break;
        case MENU_ACTIONS.toggleTheme:
          void runMenuCommand("view.toggleTheme");
          break;
        case MENU_ACTIONS.themeLight:
          uiStore.setTheme("light");
          break;
        case MENU_ACTIONS.themeDark:
          uiStore.setTheme("dark");
          break;
        case MENU_ACTIONS.themeSystem:
          uiStore.setTheme("system");
          break;
        case MENU_ACTIONS.languageZhCN:
          uiStore.setLanguage("zh-CN");
          break;
        case MENU_ACTIONS.languageEn:
          uiStore.setLanguage("en");
          break;
        case MENU_ACTIONS.logs:
          setLogsOpen(true);
          break;
      }
    });
  }, [menuEnabled, openDocument, openPalette, platform, runMenuCommand]);

  useEffect(() => {
    const disposable = commandRegistry.register({
      id: "app.openLogs",
      titleKey: "commands:app.openLogs",
      category: "commands:category.app",
      keybinding: "Mod+Alt+L",
      run: () => {
        setLogsOpen(true);
      },
    });
    return () => disposable.dispose();
  }, []);

  useEffect(() => {
    const disposable = commandRegistry.register({
      id: "file.open",
      titleKey: "commands:file.open",
      category: "commands:category.file",
      keybinding: "Mod+O",
      run: openDocument,
    });
    return () => disposable.dispose();
  }, [openDocument]);

  useEffect(() => {
    if (!hasSession) {
      return;
    }
    const disposable = commandRegistry.register({
      id: "file.save",
      titleKey: "commands:file.save",
      category: "commands:category.file",
      keybinding: "Mod+S",
      // Read the live session at execution time so a replaced session never
      // leaves a stale coordinator bound to the command.
      when: () => !sessionRef.current?.getSnapshot().readOnly,
      run: async () => {
        await coordinatorRef.current?.flush("manual");
      },
    });
    return () => disposable.dispose();
  }, [hasSession]);

  useEffect(() => {
    if (!hasSession) {
      return;
    }
    const disposable = commandRegistry.register({
      id: "view.toggleLivePreview",
      titleKey: "commands:view.toggleLivePreview",
      category: "commands:category.view",
      // Source-tier documents stay in source mode until they shrink below the
      // budget; re-enabling preview there would only run the plugin's own
      // no-op guard.
      when: () => (sessionRef.current?.getSnapshot().previewTier ?? "source") !== "source",
      run: () => {
        sessionRef.current?.toggleLivePreview();
      },
    });
    return () => disposable.dispose();
  }, [hasSession]);

  return (
    <div className="flex h-dvh flex-col bg-paper">
      <UpdateHost
        blocked={updateBlocked}
        dialogOpen={updateDialogOpen}
        onDialogOpenChange={setUpdateDialogOpen}
      />
      <div className="min-h-0 flex-1">
        <Outlet />
      </div>
      <CommandPalette open={paletteOpen} onClose={closePalette} onError={handleCommandError} />
      <CloseConfirmDialog
        prompt={closeGuard.prompt}
        onAllow={closeGuard.allowClose}
        onCancel={closeGuard.cancelClose}
      />
      <LogDialog open={logsOpen} onClose={() => setLogsOpen(false)} />
    </div>
  );
}
