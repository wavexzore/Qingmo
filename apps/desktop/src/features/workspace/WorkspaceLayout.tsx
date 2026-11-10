import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Outlet, useNavigate } from "react-router-dom";

import type { AppError, FilePayload, Result } from "@qingmo/shared";

import { useAppServices } from "../../app/AppServices";
import { CloseConfirmDialog } from "../../app/CloseConfirmDialog";
import { useCloseGuard } from "../../app/useCloseGuard";
import { useEditorTypography } from "../../app/useEditorTypography";
import { useThemeService } from "../../app/useThemeService";
import { useToast } from "../../components/ToastHost";
import { buildEditorUiCopy } from "../../i18n/editorCopy";
import { normalizeLanguage } from "../../i18n/language";
import { MENU_ACTIONS } from "../../lib/ipc/commands";
import { AppError as AppErrorClass, normalizeError } from "../../lib/ipc/errors";
import type { IpcPort } from "../../lib/ipc/port";
import { isE2eMode } from "../../e2e/bridge";
import { isTauriRuntime } from "../../lib/platform/runtime";
import { uiStore } from "../../stores/uiStore";
import { CommandPalette } from "../commands/CommandPalette";
import { commandRegistry } from "../commands/CommandRegistry";
import { useCommandKeybindings } from "../commands/keybindings";
import { useThemeCommand } from "../commands/themeCommand";
import { useDocumentSession } from "../editor/DocumentSessionContext";
import type { EditorSession } from "../editor/EditorSession";
import { HistoryDialog } from "../editor/history/HistoryDialog";
import { OutlinePanel } from "../editor/outline/OutlinePanel";
import { createDocumentSession } from "../editor/session/createDocumentSession";
import { useEditorLocale } from "../editor/useEditorLocale";
import { useEditorStatus } from "../editor/useEditorStatus";
import { useLivePreviewMenu } from "../editor/useLivePreviewMenu";
import { LogDialog } from "../logs/LogDialog";
import { UpdateHost } from "../update/UpdateHost";
import { useUpdateController, useUpdateSnapshot } from "../update/UpdateProvider";
import { adoptInPlace } from "./adoptInPlace";
import { openFile } from "./openFile";
import { openWorkspaceFile } from "./openWorkspaceFile";
import { newDocument } from "./newDocument";
import {
  OutlineCountBadge,
  SidebarDock,
  SidebarReopenHandle,
  type SidebarDockHandle,
} from "./SidebarDock";
import { sidebarDockStore, useSidebarDock, type SidebarView } from "./sidebarDockStore";
import { useWorkspaceNavigation } from "./useWorkspaceNavigation";
import { workspaceErrorKey } from "./workspaceErrorMessage";
import { SearchPanel } from "./SearchPanel";
import { TrashDialog } from "./TrashDialog";
import { WorkspaceSidebar } from "./WorkspaceSidebar";

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
  const [historyOpen, setHistoryOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{
    segments: string[];
    name: string;
  } | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
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
  const dock = useSidebarDock();
  const navigation = useWorkspaceNavigation({
    ipc,
    session,
    isTreeVisible: () => {
      const snapshot = sidebarDockStore.getSnapshot();
      return snapshot.open && snapshot.view === "workspace";
    },
  });
  const hasWorkspace = navigation.workspace !== null;
  const hasOutline = session !== null;
  const dockAvailable = hasWorkspace || hasOutline;
  const resolvedView: SidebarView =
    dock.view === "search"
      ? hasWorkspace
        ? "search"
        : hasOutline
          ? "outline"
          : "workspace"
      : dock.view === "workspace"
        ? hasWorkspace
          ? "workspace"
          : hasOutline
            ? "outline"
            : "workspace"
        : hasOutline
          ? "outline"
          : hasWorkspace
            ? "workspace"
            : "outline";
  const dockRef = useRef<SidebarDockHandle>(null);
  const reopenRef = useRef<HTMLButtonElement>(null);
  const workspaceToken = navigation.workspace?.token ?? null;

  useThemeCommand();
  useThemeService(session);
  useEditorTypography(session);
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

  const focusAfterDockClose = useCallback(() => {
    if (sessionRef.current) {
      sessionRef.current.focusEditor();
      return;
    }
    reopenRef.current?.focus();
  }, []);

  const closeDock = useCallback(() => {
    sidebarDockStore.setOpen(false);
    focusAfterDockClose();
  }, [focusAfterDockClose]);

  const showDockView = useCallback(
    (view: SidebarView) => {
      sidebarDockStore.show(view);
      if (view === "workspace") {
        navigation.flushStale();
      }
    },
    [navigation],
  );

  const handleOutlineClose = useCallback(() => {
    if (hasWorkspace) {
      sidebarDockStore.show("workspace");
      dockRef.current?.focusTab();
      return;
    }
    closeDock();
  }, [closeDock, hasWorkspace]);

  const toggleWorkspaceSidebar = useCallback(() => {
    const snapshot = sidebarDockStore.getSnapshot();
    if (snapshot.open && snapshot.view === "workspace") {
      closeDock();
      return;
    }
    sidebarDockStore.show("workspace");
    navigation.flushStale();
    dockRef.current?.focusActivePanel();
  }, [closeDock, navigation]);

  const toggleOutline = useCallback(() => {
    sidebarDockStore.toggleView("outline", hasWorkspace ? "workspace" : null);
    const next = sidebarDockStore.getSnapshot();
    if (next.open) {
      if (next.view === "workspace") {
        navigation.flushStale();
      }
      dockRef.current?.focusActivePanel();
    } else {
      focusAfterDockClose();
    }
  }, [focusAfterDockClose, hasWorkspace, navigation]);

  const handleReopen = useCallback(() => {
    const last = sidebarDockStore.getSnapshot().view;
    const next: SidebarView | null =
      last === "workspace" && hasWorkspace
        ? "workspace"
        : last === "outline" && hasOutline
          ? "outline"
          : hasWorkspace
            ? "workspace"
            : hasOutline
              ? "outline"
              : null;
    if (!next) {
      return;
    }
    sidebarDockStore.openLast(next);
    if (next === "workspace") {
      navigation.flushStale();
    }
    dockRef.current?.focusActivePanel();
  }, [hasOutline, hasWorkspace, navigation]);

  // A workspace inherited at window boot opens the dock once. A user who has
  // already hidden it keeps it hidden for the rest of this window's life.
  useEffect(() => {
    if (workspaceToken && !sidebarDockStore.getSnapshot().everOpened) {
      sidebarDockStore.show("workspace");
    }
  }, [workspaceToken]);

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
   * Adopts a harness Open payload in place (browser/E2E only); see
   * `adoptInPlace.ts` for the preserve/re-read/abandon contract.
   */
  const adoptOpened = useCallback(
    (payload: FilePayload, baseline: string | null, previousToken: string | null) =>
      adoptInPlace(
        {
          ipc,
          getCurrentSession: () => getCurrentBundle().session,
          preserveCurrentSession,
          setSession,
          reportError: (error) => toast.push(t(`errors:${normalizeError(error).code}`)),
          reportBusy: () => toast.push(t("errors:BUSY")),
          uiCopy: buildEditorUiCopy(normalizeLanguage(i18n.language)),
        },
        payload,
        baseline,
        previousToken,
      ),
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

  const openDocumentFrom = useCallback(
    async (
      pick: (port: IpcPort) => Promise<Result<FilePayload | null, AppError>>,
      options: { inPlace?: boolean } = {},
    ): Promise<boolean> => {
      if (openingRef.current) {
        // Another open is already running; keep the optimistic tree selection
        // rather than rolling it back for a click that was simply ignored.
        return true;
      }
      openingRef.current = true;
      let release: (() => void) | null = null;
      try {
        release = await beginReplacement();
        // File > Open creates a new window in Tauri and must stay usable even
        // when the current document cannot be saved. The browser harness and
        // workspace tree opens replace this window instead.
        const inPlace = options.inPlace === true || !isTauriRuntime() || isE2eMode();
        let baseline: string | null = null;
        if (inPlace) {
          if (!(await preserveCurrentSession())) {
            return false;
          }
          baseline = getCurrentBundle().session?.readText() ?? null;
        }
        const previousToken = getCurrentBundle().session?.docToken ?? null;
        const result = await pick(ipc);
        if (!result.ok) {
          if (result.error.code !== "CANCELLED") {
            toast.push(t(`errors:${result.error.code}`));
            return false;
          }
          return true;
        }
        if (result.value === null) {
          // Tauri created a new window for this document; the current session
          // stays exactly as it was.
          return true;
        }
        if (inPlace) {
          if (!(await adoptOpened(result.value, baseline, previousToken))) {
            return false;
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
        return true;
      } finally {
        release?.();
        openingRef.current = false;
      }
    },
    [
      adoptOpened,
      beginReplacement,
      getCurrentBundle,
      i18n.language,
      ipc,
      navigate,
      preserveCurrentSession,
      setSession,
      t,
      toast,
    ],
  );

  const openDocument = useCallback(async () => {
    await openDocumentFrom(openFile);
  }, [openDocumentFrom]);

  const openWorkspaceDocument = useCallback(
    (segments: string[]) => {
      const token = workspaceToken;
      if (!token) {
        return;
      }
      // The tree always switches this window, including the native shell.
      return openDocumentFrom((port) => openWorkspaceFile(port, token, segments), {
        inPlace: true,
      });
    },
    [openDocumentFrom, workspaceToken],
  );

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete || !workspaceToken) {
      return;
    }
    setDeleteBusy(true);
    try {
      await ipc.workspaceDelete(workspaceToken, pendingDelete.segments);
      setPendingDelete(null);
      await navigation.refresh({ manual: true });
    } catch (error) {
      const appError = normalizeError(error);
      toast.push(t(`errors:${appError.code}`));
    } finally {
      setDeleteBusy(false);
    }
  }, [ipc, navigation, pendingDelete, t, toast, workspaceToken]);

  const openWorkspace = useCallback(async () => {
    try {
      const info = await navigation.openWorkspace();
      if (!info) {
        return;
      }
      sidebarDockStore.show("workspace");
      dockRef.current?.focusActivePanel();
    } catch (error) {
      const appError = normalizeError(error);
      if (appError.code !== "CANCELLED") {
        toast.push(t(workspaceErrorKey(appError.code)));
      }
    }
  }, [navigation, t, toast]);

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

  const startMeeting = useCallback(async () => {
    try {
      await ipc.meetingStart();
    } catch (error) {
      handleCommandError(normalizeError(error));
    }
  }, [handleCommandError, ipc]);

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
        case MENU_ACTIONS.fileOpenFolder:
          void openWorkspace();
          break;
        case MENU_ACTIONS.fileSave:
          void runMenuCommand("file.save");
          break;
        case MENU_ACTIONS.fileMeeting:
          void runMenuCommand("file.meeting");
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
  }, [
    menuEnabled,
    createDocument,
    openDocument,
    openWorkspace,
    openPalette,
    platform,
    runMenuCommand,
  ]);

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
      id: "file.meeting",
      titleKey: "commands:file.meeting",
      category: "commands:category.file",
      keybinding: "Mod+Shift+M",
      run: startMeeting,
    });
    return () => disposable.dispose();
  }, [startMeeting]);

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
      run: toggleOutline,
    });
    return () => disposable.dispose();
  }, [hasSession, toggleOutline]);

  useEffect(() => {
    const disposable = commandRegistry.register({
      id: "workspace.open",
      titleKey: "commands:workspace.open",
      category: "commands:category.workspace",
      run: openWorkspace,
    });
    return () => disposable.dispose();
  }, [openWorkspace]);

  useEffect(() => {
    if (!hasWorkspace) {
      return;
    }
    const disposables = [
      commandRegistry.register({
        id: "workspace.refresh",
        titleKey: "commands:workspace.refresh",
        category: "commands:category.workspace",
        run: () => navigation.refresh({ manual: true }),
      }),
      commandRegistry.register({
        id: "workspace.collapseAll",
        titleKey: "commands:workspace.collapseAll",
        category: "commands:category.workspace",
        run: navigation.collapseAll,
      }),
      commandRegistry.register({
        id: "workspace.toggleSidebar",
        titleKey: "commands:workspace.toggleSidebar",
        category: "commands:category.workspace",
        keybinding: "Mod+B",
        run: toggleWorkspaceSidebar,
      }),
    ];
    return () => {
      for (const disposable of disposables) {
        disposable.dispose();
      }
    };
  }, [
    hasWorkspace,
    navigation,
    navigation.collapseAll,
    navigation.refresh,
    toggleWorkspaceSidebar,
  ]);

  useEffect(() => {
    const disposable = commandRegistry.register({
      id: "workspace.search",
      titleKey: "commands:workspace.search",
      category: "commands:category.workspace",
      keybinding: "Mod+Shift+F",
      when: () => hasWorkspace,
      run: () => {
        sidebarDockStore.show("search");
        dockRef.current?.focusActivePanel();
      },
    });
    return () => disposable.dispose();
  }, [hasWorkspace]);

  useEffect(() => {
    if (!session || session.isUntitled) {
      return;
    }
    const disposable = commandRegistry.register({
      id: "document.history",
      titleKey: "commands:document.history",
      category: "commands:category.file",
      keybinding: "Mod+Shift+H",
      run: () => setHistoryOpen(true),
    });
    return () => disposable.dispose();
  }, [session]);

  useEffect(() => {
    if (!hasWorkspace) {
      return;
    }
    const disposable = commandRegistry.register({
      id: "workspace.trash",
      titleKey: "commands:workspace.trash",
      category: "commands:category.workspace",
      run: () => setTrashOpen(true),
    });
    return () => disposable.dispose();
  }, [hasWorkspace]);

  return (
    <div className="flex h-dvh flex-col bg-paper">
      <UpdateHost
        blocked={updateBlocked}
        dialogOpen={updateDialogOpen}
        onDialogOpenChange={setUpdateDialogOpen}
      />
      <div className="relative flex min-h-0 flex-1">
        {dockAvailable ? (
          <SidebarDock
            ref={dockRef}
            open={dock.open}
            view={resolvedView}
            hasWorkspace={hasWorkspace}
            hasOutline={hasOutline}
            onSelectView={showDockView}
            onClose={closeDock}
            outlineBadge={session ? <OutlineCountBadge session={session} /> : null}
            workspacePanel={
              hasWorkspace
                ? ({ active, focusRequest }) => (
                    <WorkspaceSidebar
                      navigation={navigation}
                      active={active}
                      focusRequest={focusRequest}
                      onOpenFile={openWorkspaceDocument}
                      onDeleteFile={(segments) =>
                        setPendingDelete({
                          segments,
                          name: segments[segments.length - 1] ?? "",
                        })
                      }
                      onShowTrash={() => setTrashOpen(true)}
                    />
                  )
                : undefined
            }
            outlinePanel={
              session
                ? ({ active, focusRequest }) => (
                    <OutlineTab
                      session={session}
                      active={active}
                      focusRequest={focusRequest}
                      onClose={handleOutlineClose}
                    />
                  )
                : undefined
            }
            searchPanel={
              hasWorkspace && workspaceToken
                ? ({ active, focusRequest }) => (
                    <SearchPanel
                      ipc={ipc}
                      workspaceToken={workspaceToken}
                      active={active}
                      focusRequest={focusRequest}
                      onOpenFile={openWorkspaceDocument}
                    />
                  )
                : undefined
            }
          />
        ) : null}
        <div className="relative min-h-0 min-w-0 flex-1">
          {dockAvailable && !dock.open && dock.everOpened ? (
            <SidebarReopenHandle ref={reopenRef} onClick={handleReopen} />
          ) : null}
          <WorkspaceContent />
        </div>
      </div>
      <CommandPalette open={paletteOpen} onClose={closePalette} onError={handleCommandError} />
      <CloseConfirmDialog
        prompt={closeGuard.prompt}
        onAllow={closeGuard.allowClose}
        onCancel={closeGuard.cancelClose}
      />
      <LogDialog open={logsOpen} onClose={() => setLogsOpen(false)} />
      {session && !session.isUntitled ? (
        <HistoryDialog
          open={historyOpen}
          docToken={session.getSnapshot().docToken}
          ipc={ipc}
          onClose={() => setHistoryOpen(false)}
          onRestore={(payload) => {
            session.replacePayload(payload);
          }}
        />
      ) : null}
      {pendingDelete ? (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-label={t("workspace:menu.confirmTitle")}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        >
          <div className="w-full max-w-sm rounded-lg border border-line bg-surface p-4 shadow-xl">
            <h2 className="text-sm font-semibold text-ink">{t("workspace:menu.confirmTitle")}</h2>
            <p className="mt-2 text-xs text-ink-muted">
              {t("workspace:menu.confirmBody", { name: pendingDelete.name })}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                disabled={deleteBusy}
                onClick={() => setPendingDelete(null)}
                className="rounded border border-line px-3 py-1.5 text-xs text-ink-muted hover:bg-surface-raised disabled:opacity-40"
              >
                {t("workspace:menu.cancel")}
              </button>
              <button
                type="button"
                disabled={deleteBusy}
                onClick={() => void confirmDelete()}
                className="rounded bg-danger px-3 py-1.5 text-xs text-white disabled:opacity-40"
              >
                {t("workspace:menu.confirm")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {hasWorkspace && workspaceToken ? (
        <TrashDialog
          open={trashOpen}
          workspaceToken={workspaceToken}
          ipc={ipc}
          onClose={() => setTrashOpen(false)}
          onChanged={() => {
            void navigation.refresh({ manual: true });
          }}
        />
      ) : null}
    </div>
  );
}

const WorkspaceContent = memo(function WorkspaceContent() {
  return <Outlet />;
});

interface OutlineTabProps {
  session: EditorSession;
  active: boolean;
  focusRequest: number;
  onClose(): void;
}

function OutlineTab({ session, active, focusRequest, onClose }: OutlineTabProps) {
  // Inactive tabs still call the hook but do not subscribe to cursor changes.
  const status = useEditorStatus(session, active);
  return (
    <OutlinePanel
      session={session}
      cursorLine={status.cursor?.line ?? 0}
      onClose={onClose}
      variant="dock"
      active={active}
      focusRequest={focusRequest}
    />
  );
}
