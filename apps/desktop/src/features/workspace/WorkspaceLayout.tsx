import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Outlet, useNavigate } from "react-router-dom";

import type { AppError, FilePayload } from "@qingmo/shared";

import { useAppServices } from "../../app/AppServices";
import { CloseConfirmDialog } from "../../app/CloseConfirmDialog";
import { useCloseGuard } from "../../app/useCloseGuard";
import { useThemeService } from "../../app/useThemeService";
import { useToast } from "../../components/ToastHost";
import { buildEditorUiCopy } from "../../i18n/editorCopy";
import { normalizeLanguage } from "../../i18n/language";
import { MENU_ACTIONS } from "../../lib/ipc/commands";
import { AppError as AppErrorClass, normalizeError } from "../../lib/ipc/errors";
import { isE2eMode } from "../../e2e/bridge";
import { isTauriRuntime } from "../../lib/platform/runtime";
import { uiStore } from "../../stores/uiStore";
import { CommandPalette } from "../commands/CommandPalette";
import { commandRegistry } from "../commands/CommandRegistry";
import { useCommandKeybindings } from "../commands/keybindings";
import { useThemeCommand } from "../commands/themeCommand";
import { useDocumentSession } from "../editor/DocumentSessionContext";
import { outlineVisibilityStore } from "../editor/outline/outlineVisibility";
import {
  createDocumentSession,
  type CreatedDocumentSession,
} from "../editor/session/createDocumentSession";
import { useEditorLocale } from "../editor/useEditorLocale";
import { useLivePreviewMenu } from "../editor/useLivePreviewMenu";
import { LogDialog } from "../logs/LogDialog";
import { UpdateHost } from "../update/UpdateHost";
import { useUpdateController, useUpdateSnapshot } from "../update/UpdateProvider";
import { openFile } from "./openFile";
import { newDocument } from "./newDocument";

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
  const {
    session,
    coordinator,
    recorder,
    journal,
    refreshDrafts,
    setSession,
    startUntitled,
    getCurrentBundle,
  } = useDocumentSession();
  const closeGuard = useCloseGuard({
    ipc,
    platform,
    coordinator,
    viewState: recorder,
    journal,
  });
  const updateController = useUpdateController();
  const updateSnapshot = useUpdateSnapshot();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const openingRef = useRef(false);
  const creatingRef = useRef(false);
  // Open and New both replace (or retire) this window's session in the
  // browser harness. Serializing them keeps a flush from racing the token
  // swap of an Open started a moment later.
  const replacementQueue = useRef<Promise<void>>(Promise.resolve());
  const beginReplacement = useCallback(async (): Promise<() => void> => {
    const previous = replacementQueue.current;
    let release!: () => void;
    replacementQueue.current = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  }, []);

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

  /**
   * Preserves the current session before a harness Open/New replaces it.
   *
   * Named documents flush to disk; untitled ones force a crash draft (the
   * store may have pruned an earlier copy). Every pass also refreshes the
   * draft list before comparing, and text that arrives meanwhile triggers
   * another pass (three times, then one final attempt). Returns false after
   * surfacing the error, in which case the caller must keep the session.
   */
  const preserveCurrentSession = useCallback(async (): Promise<boolean> => {
    const { session: current, coordinator, journal: liveJournal } = getCurrentBundle();
    if (!current || !coordinator) {
      return true;
    }

    const attempt = async (): Promise<"stable" | "changed" | "failed"> => {
      const before = current.readText();
      const flushed = await coordinator.flush("auto");
      if (!flushed.ok) {
        await liveJournal?.flushNow({ force: true, preserveNamedDirty: true });
        await refreshDrafts();
        handleCommandError(
          flushed.error ??
            new AppErrorClass(
              flushed.failure === "conflict" ? "CONFLICT" : "IO",
              "the current document could not be saved",
            ),
        );
        return "failed";
      }
      if (current.isUntitled && before.length > 0) {
        const draft = await liveJournal?.flushNow({ force: true });
        if (!draft?.ok) {
          await refreshDrafts();
          handleCommandError(
            draft && !draft.ok
              ? normalizeError(draft.error)
              : new AppErrorClass("IO", "the crash draft could not be written"),
          );
          return "failed";
        }
      }
      // The list refresh is part of the protected interval too; text typed
      // while it is in flight must trigger another pass, not vanish with the
      // replaced session.
      await refreshDrafts();
      return current.readText() === before ? "stable" : "changed";
    };

    for (let attemptIndex = 0; attemptIndex < 3; attemptIndex += 1) {
      const result = await attempt();
      if (result === "failed") {
        return false;
      }
      if (result === "stable") {
        return true;
      }
    }
    // The user out-typed every retry; this is the last chance to capture the
    // tail. Changes during the writes above are caught by the adoption tail
    // passes below; keystrokes landing during this final list refresh are not
    // and remain inside the known narrow window.
    return (await attempt()) !== "failed";
  }, [getCurrentBundle, handleCommandError, refreshDrafts]);

  /**
   * Adopts a harness Open payload in place (browser/E2E only).
   *
   * The session being replaced is preserved first (dialog input, then the
   * tail passes that watch the adoption handoff itself), the same file is
   * re-read from disk so a late save is never overwritten, and every failure
   * abandons the adoption with the current session kept. Returns true only
   * when the payload session was installed.
   */
  const adoptInPlace = useCallback(
    async (
      payload: FilePayload,
      baseline: string | null,
      previousToken: string | null,
    ): Promise<boolean> => {
      const uiCopy = buildEditorUiCopy(normalizeLanguage(i18n.language));
      const live = getCurrentBundle().session;
      const samePath = live !== null && live.getSnapshot().docId === payload.path;
      const late = live !== null && live.readText() !== baseline;
      // From here every write must go through the session being replaced, so
      // restore its token before any await lets an auto-save fire.
      if (previousToken) {
        await ipc.documentActivate(previousToken);
      }
      if (late && !(await preserveCurrentSession())) {
        return false;
      }
      // Snapshot the text the late preserve left behind; the tail passes
      // compare against this to catch input typed during the handoff.
      let preserved = live?.readText() ?? null;
      // The payload can predate a late save when the same file is reopened;
      // adopting it verbatim would let the next save overwrite that text.
      const rebuildFromDisk = async (
        current: CreatedDocumentSession,
      ): Promise<CreatedDocumentSession> => {
        const fresh = await ipc.documentReload(current.session.docToken);
        const rebuilt = await createDocumentSession(ipc, fresh, uiCopy);
        current.session.dispose();
        return rebuilt;
      };
      let created: CreatedDocumentSession | undefined;
      try {
        created = await createDocumentSession(ipc, payload, uiCopy);
        await ipc.documentActivate(created.session.docToken);
        if (late && samePath) {
          created = await rebuildFromDisk(created);
        }
        // Text typed while the adoption was being prepared has no carrier
        // yet. Two bounded passes keep even a fast typist covered; whatever
        // lands inside the second rebuild remains a known narrow window.
        for (let pass = 0; pass < 2; pass += 1) {
          if (live === null || live.readText() === preserved) {
            break;
          }
          if (previousToken) {
            await ipc.documentActivate(previousToken);
          }
          if (!(await preserveCurrentSession())) {
            created.session.dispose();
            return false;
          }
          preserved = live.readText();
          await ipc.documentActivate(created.session.docToken);
          if (samePath) {
            created = await rebuildFromDisk(created);
          }
        }
      } catch (error) {
        // A failed re-read must not adopt a stale payload, and a failed tail
        // save must not drop the text: keep the current session, whose latest
        // snapshot is already preserved on disk or as a draft.
        const normalized = normalizeError(error);
        console.warn("failed to finish the in-place adoption", normalized);
        created?.session.dispose();
        if (previousToken) {
          await ipc.documentActivate(previousToken);
        }
        toast.push(t(`errors:${normalized.code}`));
        return false;
      }
      setSession(created.session, { viewState: created.viewState });
      return true;
    },
    [getCurrentBundle, i18n.language, ipc, preserveCurrentSession, setSession, t, toast],
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
    let release: (() => void) | null = null;
    try {
      release = await beginReplacement();
      // Only the browser harness (or the E2E bridge) replaces this window;
      // native Open creates a new window and must stay usable even when the
      // current document cannot be saved.
      const replacesInPlace = !isTauriRuntime() || isE2eMode();
      let baseline: string | null = null;
      if (replacesInPlace) {
        if (!(await preserveCurrentSession())) {
          return;
        }
        baseline = getCurrentBundle().session?.readText() ?? null;
      }
      const previousToken = getCurrentBundle().session?.docToken ?? null;
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
      if (replacesInPlace) {
        // Browser harness fallback: no native window exists, adopt in place.
        if (!(await adoptInPlace(result.value, baseline, previousToken))) {
          return;
        }
      } else {
        const created = await createDocumentSession(
          ipc,
          result.value,
          buildEditorUiCopy(normalizeLanguage(i18n.language)),
        );
        setSession(created.session, { viewState: created.viewState });
      }
      navigate("/editor");
    } finally {
      release?.();
      openingRef.current = false;
    }
  }, [
    adoptInPlace,
    beginReplacement,
    getCurrentBundle,
    i18n.language,
    ipc,
    navigate,
    preserveCurrentSession,
    setSession,
    t,
    toast,
  ]);

  const createDocument = useCallback(async () => {
    if (creatingRef.current) {
      return;
    }
    creatingRef.current = true;
    let release: (() => void) | null = null;
    try {
      release = await beginReplacement();
      // New never saves or replaces the current document in Tauri: a new
      // window is created. Browser harnesses cannot, so they report `current`
      // and this window is reset. Flush a named document before replacing it;
      // an untitled document writes a crash draft instead (auto flush is a
      // no-op there), and a failed flush keeps the current session visible.
      const result = await newDocument(ipc);
      if (!result.ok) {
        handleCommandError(result.error);
        return;
      }
      if (result.value === "current") {
        const current = getCurrentBundle().session;
        if (!(await preserveCurrentSession())) {
          return;
        }
        if (getCurrentBundle().session === current) {
          startUntitled();
          navigate("/editor");
        }
      }
    } finally {
      release?.();
      creatingRef.current = false;
    }
  }, [
    beginReplacement,
    getCurrentBundle,
    handleCommandError,
    ipc,
    navigate,
    preserveCurrentSession,
    startUntitled,
  ]);

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

  // Menu items that still reach the webview share the keyboard-shortcut
  // availability gate. Native New is handled entirely in Rust and is always
  // available.
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
        case MENU_ACTIONS.fileNew:
          void createDocument();
          break;
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
        case MENU_ACTIONS.toggleOutline:
          void runMenuCommand("view.toggleOutline");
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
  }, [menuEnabled, createDocument, openDocument, openPalette, platform, runMenuCommand]);

  // Native New bypasses the webview; Rust only emits this when it failed.
  useEffect(() => {
    return platform.onDocumentNewFailed(handleCommandError);
  }, [platform, handleCommandError]);

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
      id: "file.new",
      titleKey: "commands:file.new",
      category: "commands:category.file",
      keybinding: "Mod+N",
      run: createDocument,
    });
    return () => disposable.dispose();
  }, [createDocument]);

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

  useEffect(() => {
    if (!hasSession) {
      return;
    }
    const disposable = commandRegistry.register({
      id: "view.toggleOutline",
      titleKey: "commands:view.toggleOutline",
      category: "commands:category.view",
      run: () => {
        const open = outlineVisibilityStore.toggle();
        if (!open) {
          sessionRef.current?.focusEditor();
        }
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
