import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Outlet, useNavigate, useOutletContext } from "react-router-dom";

import type { AppError } from "@qingmo/shared";

import { useAppServices } from "../../app/AppServices";
import { CloseConfirmDialog } from "../../app/CloseConfirmDialog";
import { useCloseGuard } from "../../app/useCloseGuard";
import { useThemeService } from "../../app/useThemeService";
import { useToast } from "../../components/ToastHost";
import { AppError as AppErrorClass } from "../../lib/ipc/errors";
import { CommandPalette } from "../commands/CommandPalette";
import { commandRegistry } from "../commands/CommandRegistry";
import { useCommandKeybindings } from "../commands/keybindings";
import { useThemeCommand } from "../commands/themeCommand";
import { useDocumentSession } from "../editor/DocumentSessionContext";
import { EditorSession } from "../editor/EditorSession";
import { UpdateHost } from "../update/UpdateHost";
import { useUpdateController, useUpdateSnapshot } from "../update/UpdateProvider";
import { openFile } from "./openFile";

export interface WorkspaceActions {
  openDocument(): Promise<void>;
  opening: boolean;
}

/**
 * App-level workspace layout. It owns the single `file.open` registration and
 * the opening state, so the command remains available on both the blank editor
 * and an open document (T-015's palette) without duplicate registrations.
 */
export function WorkspaceLayout() {
  const { t } = useTranslation(["errors", "editor"]);
  const toast = useToast();
  const navigate = useNavigate();
  const { ipc, platform } = useAppServices();
  const { session, coordinator, setSession } = useDocumentSession();
  const closeGuard = useCloseGuard({ ipc, platform, coordinator });
  const updateController = useUpdateController();
  const updateSnapshot = useUpdateSnapshot();
  const [opening, setOpening] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const openingRef = useRef(false);
  const sessionRef = useRef(session);
  const coordinatorRef = useRef(coordinator);
  sessionRef.current = session;
  coordinatorRef.current = coordinator;
  const hasSession = session !== null;
  const updateBlocked = closeGuard.closing || closeGuard.prompt !== null;

  useThemeCommand();
  useThemeService(session);

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
      !paletteOpen && !updateBlocked && !updateDialogOpen && updateSnapshot?.phase !== "installing",
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
    setOpening(true);
    try {
      if (coordinatorRef.current) {
        const flushed = await coordinatorRef.current.flush("switch");
        if (!flushed.ok) {
          toast.push(t("editor:save.resolveBeforeSwitch"));
          return;
        }
      }

      const result = await openFile(ipc);
      if (!result.ok) {
        if (result.error.code !== "CANCELLED") {
          toast.push(t(`errors:${result.error.code}`));
        }
        return;
      }
      setSession(EditorSession.create(result.value));
      navigate("/editor");
    } finally {
      openingRef.current = false;
      setOpening(false);
    }
  }, [ipc, navigate, setSession, t, toast]);

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
      // Read the live session at execution time: opening another document
      // replaces the session/coordinator without leaving a stale command.
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
      // Large files stay in source mode until they shrink below the budget;
      // re-enabling preview there would only run the plugin's own no-op guard.
      when: () => !sessionRef.current?.getSnapshot().largeFile,
      run: () => {
        sessionRef.current?.toggleLivePreview();
      },
    });
    return () => disposable.dispose();
  }, [hasSession]);

  return (
    <>
      <Outlet context={{ openDocument, opening } satisfies WorkspaceActions} />
      <CommandPalette open={paletteOpen} onClose={closePalette} onError={handleCommandError} />
      <CloseConfirmDialog
        prompt={closeGuard.prompt}
        onAllow={closeGuard.allowClose}
        onCancel={closeGuard.cancelClose}
      />
      <UpdateHost
        blocked={updateBlocked}
        dialogOpen={updateDialogOpen}
        onDialogOpenChange={setUpdateDialogOpen}
      />
    </>
  );
}

export function useWorkspaceActions(): WorkspaceActions {
  return useOutletContext<WorkspaceActions>();
}
