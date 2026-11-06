import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";

import type { AppErrorCode, WorkspaceInfo, WorkspaceTruncationReason } from "@qingmo/shared";

import type { EditorSession } from "../editor/EditorSession";
import { UNTITLED_DOC_TOKEN } from "../editor/EditorSession";
import type { IpcPort } from "../../lib/ipc/port";
import { AppError, normalizeError } from "../../lib/ipc/errors";
import {
  flattenWorkspaceRows,
  initialWorkspaceTreeState,
  workspaceTreeReducer,
  type FlatRow,
  type WorkspaceTreeState,
} from "./workspaceTree";
import { ancestorSegments, workspaceKey } from "./workspacePath";

/** Upper bound for one automatic refresh pass. */
export const MAX_REFRESH_DIRS = 32;
/** Trailing merge window shared by watcher events and focus refreshes. */
export const REFRESH_DEBOUNCE_MS = 250;
/** Focus/visibility refreshes are coalesced within this window. */
export const FOCUS_REFRESH_THROTTLE_MS = 1000;

export interface UseWorkspaceNavigationOptions {
  ipc: IpcPort;
  /** When provided, Save As/token changes trigger a new locate. */
  session?: EditorSession | null;
  /** Dock workspace tab visibility; hidden trees only mark stale. */
  isTreeVisible?: () => boolean;
}

export interface WorkspaceNavigation {
  workspace: WorkspaceInfo | null;
  rows: FlatRow[];
  expanded: Record<string, boolean>;
  rootLoading: boolean;
  rootError: AppErrorCode | null;
  rootTruncated: boolean;
  rootTruncationReason: WorkspaceTruncationReason | null;
  focusedKey: string | null;
  selectedKey: string | null;
  currentKey: string | null;
  openWorkspace(): Promise<WorkspaceInfo | null>;
  ensureLoaded(segments: string[]): Promise<void>;
  toggle(segments: string[]): void;
  retry(segments: string[]): void;
  refresh(options?: { manual?: boolean }): Promise<void>;
  collapseAll(): void;
  flushStale(): void;
  setFocusedKey(key: string | null): void;
  setSelectedKey(key: string | null): void;
}

interface RefreshTargets {
  targets: string[][];
  uncovered: string[];
  nextCursor: number;
}

function isTimeoutError(error: AppError): boolean {
  const details = error.details;
  return (
    typeof details === "object" &&
    details !== null &&
    !Array.isArray(details) &&
    typeof (details as Record<string, unknown>).timeoutMs === "number"
  );
}

function keysWithFlag(record: Record<string, boolean>, value: boolean): string[] {
  return Object.keys(record).filter((key) => record[key] === value);
}

/**
 * Picks the directories one refresh pass may relist.
 *
 * Manual refresh covers every expanded directory. Automatic refresh caps the
 * pass at 32 keys, prioritizes keys already known stale, then rotates through
 * the depth-ordered list so no directory starves forever.
 */
export function selectRefreshTargets(state: WorkspaceTreeState, manual: boolean): RefreshTargets {
  const all: string[][] = [[]];
  const expanded = Object.keys(state.expanded)
    .filter((key) => state.expanded[key] === true && key !== "")
    .map((key) => key.split("/"))
    .sort(
      (left, right) =>
        left.length - right.length || workspaceKey(left).localeCompare(workspaceKey(right)),
    );
  all.push(...expanded);

  if (manual || all.length <= MAX_REFRESH_DIRS) {
    return { targets: all, uncovered: [], nextCursor: state.refreshCursor };
  }

  const keyOf = (segments: string[]) => workspaceKey(segments);
  const stale = all.filter((segments) => state.staleKeys[keyOf(segments)] === true);
  const fresh = all.filter((segments) => state.staleKeys[keyOf(segments)] !== true);
  const rotatedFresh =
    fresh.length === 0
      ? []
      : [
          ...fresh.slice(state.refreshCursor % fresh.length),
          ...fresh.slice(0, state.refreshCursor % fresh.length),
        ];
  const ordered = [...stale, ...rotatedFresh];
  const targets = ordered.slice(0, MAX_REFRESH_DIRS);
  const selected = new Set(targets.map(keyOf));
  const uncovered = all.filter((segments) => !selected.has(keyOf(segments))).map(keyOf);
  const selectedFresh = targets.filter(
    (segments) => state.staleKeys[keyOf(segments)] !== true,
  ).length;
  const nextCursor = fresh.length === 0 ? 0 : (state.refreshCursor + selectedFresh) % fresh.length;
  return { targets, uncovered, nextCursor };
}

export function useWorkspaceNavigation(
  options: UseWorkspaceNavigationOptions,
): WorkspaceNavigation {
  const { ipc, session = null, isTreeVisible } = options;
  const [state, dispatch] = useReducer(workspaceTreeReducer, undefined, initialWorkspaceTreeState);
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [currentKey, setCurrentKey] = useState<string | null>(null);

  const stateRef = useRef(state);
  stateRef.current = state;
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const tokenRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  const visibleRef = useRef(isTreeVisible);
  visibleRef.current = isTreeVisible;
  const inFlightRef = useRef(new Set<string>());
  const refreshingRef = useRef(false);
  const pendingRefreshRef = useRef(false);
  const timeoutFailuresRef = useRef(0);
  const openingRef = useRef(false);
  const scheduleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFocusRefreshRef = useRef(0);

  const subscribeStatus = useCallback(
    (listener: () => void) => (session ? session.subscribeStatus(listener) : () => undefined),
    [session],
  );
  const getDocToken = useCallback(
    () => (session ? session.getSnapshot().docToken : null),
    [session],
  );
  const docToken = useSyncExternalStore(subscribeStatus, getDocToken, getDocToken);

  const applyWorkspace = useCallback((info: WorkspaceInfo | null) => {
    generationRef.current += 1;
    tokenRef.current = info?.token ?? null;
    setWorkspace(info);
    setFocusedKey(null);
    setSelectedKey(null);
    setCurrentKey(null);
    inFlightRef.current.clear();
    timeoutFailuresRef.current = 0;
    lastFocusRefreshRef.current = 0;
    dispatch({
      type: "reset",
      token: info?.token ?? null,
      root: info?.root ?? null,
      name: info?.name ?? null,
    });
  }, []);

  const loadDirectory = useCallback(
    async (
      info: WorkspaceInfo,
      segments: string[],
      loadOptions: { force?: boolean } = {},
    ): Promise<void> => {
      const key = workspaceKey(segments);
      const snapshot = stateRef.current;
      if (!loadOptions.force && snapshot.loaded[key] === true && snapshot.staleKeys[key] !== true) {
        return;
      }
      if (inFlightRef.current.has(key)) {
        return;
      }
      inFlightRef.current.add(key);
      const generation = generationRef.current;
      const seq = (snapshot.seq[key] ?? 0) + 1;
      dispatch({ type: "loadStart", key, seq });
      try {
        const listing = await ipc.workspaceList(info.token, segments);
        if (tokenRef.current !== info.token || generationRef.current !== generation) {
          return;
        }
        dispatch({
          type: "loadSuccess",
          key,
          seq,
          entries: listing.entries,
          truncated: listing.truncated,
          truncationReason: listing.truncationReason,
        });
      } catch (error) {
        if (tokenRef.current !== info.token || generationRef.current !== generation) {
          return;
        }
        const appError = normalizeError(error);
        dispatch({ type: "loadError", key, seq, code: appError.code });
        if (key !== "" && (appError.code === "NOT_FOUND" || appError.code === "OUTSIDE_SCOPE")) {
          // The directory is gone (or a symlink now points outside): drop its
          // subtree and let the parent refresh rediscover the new state.
          dispatch({ type: "removeSubtree", key });
        }
        if (appError.code === "INVALID_PATH") {
          applyWorkspace(null);
        }
      } finally {
        inFlightRef.current.delete(key);
      }
    },
    [applyWorkspace, ipc],
  );

  const openWorkspace = useCallback(async (): Promise<WorkspaceInfo | null> => {
    if (openingRef.current) {
      return workspaceRef.current;
    }
    openingRef.current = true;
    try {
      const info = await ipc.workspaceOpen();
      applyWorkspace(info);
      await loadDirectory(info, [], { force: true });
      return info;
    } finally {
      openingRef.current = false;
    }
  }, [applyWorkspace, ipc, loadDirectory]);

  const ensureLoaded = useCallback(
    async (segments: string[]): Promise<void> => {
      const info = workspaceRef.current;
      if (!info) {
        return;
      }
      const key = workspaceKey(segments);
      const snapshot = stateRef.current;
      if (snapshot.loaded[key] === true && snapshot.staleKeys[key] !== true) {
        return;
      }
      await loadDirectory(info, segments, {
        force: snapshot.staleKeys[key] === true,
      });
    },
    [loadDirectory],
  );

  const toggle = useCallback(
    (segments: string[]): void => {
      const key = workspaceKey(segments);
      const expanding = stateRef.current.expanded[key] !== true;
      dispatch({ type: "toggle", key });
      const info = workspaceRef.current;
      if (!expanding || !info) {
        return;
      }
      const snapshot = stateRef.current;
      if (snapshot.loaded[key] !== true || snapshot.staleKeys[key] === true) {
        void loadDirectory(info, segments, {
          force: snapshot.staleKeys[key] === true,
        });
      }
    },
    [loadDirectory],
  );

  const retry = useCallback(
    (segments: string[]): void => {
      const info = workspaceRef.current;
      if (info) {
        void loadDirectory(info, segments, { force: true });
      }
    },
    [loadDirectory],
  );

  const runRefresh = useCallback(
    async (info: WorkspaceInfo, manual: boolean, generation: number): Promise<void> => {
      const snapshot = stateRef.current;
      const { targets, uncovered, nextCursor } = selectRefreshTargets(snapshot, manual);
      const requests: Record<string, number> = {};
      for (const segments of targets) {
        const key = workspaceKey(segments);
        requests[key] = (snapshot.seq[key] ?? 0) + 1;
      }
      dispatch({ type: "refreshStart", requests });
      dispatch({ type: "setRefreshCursor", value: nextCursor });
      if (uncovered.length > 0) {
        dispatch({ type: "markStaleKeys", keys: uncovered });
      }

      let timeouts = 0;
      let anyFailure = false;
      await Promise.all(
        targets.map(async (segments) => {
          const key = workspaceKey(segments);
          const seq = requests[key] ?? 0;
          try {
            const listing = await ipc.workspaceList(info.token, segments);
            if (tokenRef.current !== info.token || generationRef.current !== generation) {
              return;
            }
            dispatch({
              type: "loadSuccess",
              key,
              seq,
              entries: listing.entries,
              truncated: listing.truncated,
              truncationReason: listing.truncationReason,
            });
          } catch (error) {
            if (tokenRef.current !== info.token || generationRef.current !== generation) {
              return;
            }
            anyFailure = true;
            const appError = normalizeError(error);
            if (isTimeoutError(appError)) {
              timeouts += 1;
            }
            dispatch({ type: "loadError", key, seq, code: appError.code });
            if (
              key !== "" &&
              (appError.code === "NOT_FOUND" || appError.code === "OUTSIDE_SCOPE")
            ) {
              dispatch({ type: "removeSubtree", key });
            }
            if (appError.code === "INVALID_PATH") {
              applyWorkspace(null);
            }
          }
        }),
      );

      if (tokenRef.current !== info.token || generationRef.current !== generation) {
        return;
      }
      if (timeouts > 0) {
        timeoutFailuresRef.current += 1;
        if (timeoutFailuresRef.current >= 2) {
          dispatch({ type: "pauseAutoRefresh" });
        }
        return;
      }
      timeoutFailuresRef.current = 0;
      if (manual && !anyFailure) {
        dispatch({ type: "resumeAutoRefresh" });
      }
    },
    [applyWorkspace, ipc],
  );

  const refresh = useCallback(
    async (refreshOptions: { manual?: boolean } = {}): Promise<void> => {
      const info = workspaceRef.current;
      if (!info) {
        return;
      }
      if (!refreshOptions.manual && stateRef.current.autoRefreshPaused) {
        dispatch({ type: "invalidateAllCached" });
        return;
      }
      if (refreshingRef.current) {
        pendingRefreshRef.current = true;
        return;
      }
      refreshingRef.current = true;
      const generation = generationRef.current;
      try {
        let first = true;
        do {
          pendingRefreshRef.current = false;
          await runRefresh(info, refreshOptions.manual === true && first, generation);
          first = false;
        } while (pendingRefreshRef.current && tokenRef.current === info.token);
      } finally {
        refreshingRef.current = false;
      }
    },
    [runRefresh],
  );

  /**
   * Trailing merge for watcher events and focus/visibility refreshes.
   *
   * Manual refresh bypasses this path entirely, so a button/command is never
   * swallowed by the debounce or the focus throttle.
   */
  const scheduleRefresh = useCallback((): void => {
    if (!workspaceRef.current) {
      return;
    }
    if (scheduleTimerRef.current !== null) {
      clearTimeout(scheduleTimerRef.current);
    }
    scheduleTimerRef.current = setTimeout(() => {
      scheduleTimerRef.current = null;
      if (stateRef.current.autoRefreshPaused) {
        dispatch({ type: "invalidateAllCached" });
        return;
      }
      void refresh({ manual: false });
    }, REFRESH_DEBOUNCE_MS);
  }, [refresh]);

  const markTreeStale = useCallback((): void => {
    dispatch({ type: "invalidateAllCached" });
  }, []);

  // Subscribe before the first load so a change during boot cannot be lost.
  useEffect(() => {
    return ipc.onWorkspaceChanged(() => {
      if (!workspaceRef.current) {
        return;
      }
      const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
      if (hidden || visibleRef.current?.() === false) {
        markTreeStale();
        return;
      }
      scheduleRefresh();
    });
  }, [ipc, markTreeStale, scheduleRefresh]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const info = await ipc.workspaceCurrent();
        if (cancelled) {
          return;
        }
        applyWorkspace(info);
        if (info) {
          await loadDirectory(info, [], { force: true });
        }
      } catch (error) {
        if (!cancelled) {
          const appError = normalizeError(error);
          dispatch({ type: "loadStart", key: "", seq: 0 });
          dispatch({ type: "loadError", key: "", seq: 0, code: appError.code });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyWorkspace, ipc, loadDirectory]);

  useEffect(() => {
    const refreshOnFocus = (): void => {
      if (!workspaceRef.current) {
        return;
      }
      const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
      if (hidden || visibleRef.current?.() === false) {
        // The tree is not being looked at; remember that a refresh is needed
        // and let the tab/focus flush handle it once it becomes visible.
        markTreeStale();
        return;
      }
      if (refreshingRef.current) {
        markTreeStale();
      }
      const now = Date.now();
      if (now - lastFocusRefreshRef.current < FOCUS_REFRESH_THROTTLE_MS) {
        return;
      }
      lastFocusRefreshRef.current = now;
      scheduleRefresh();
    };

    const refreshOnVisibility = (): void => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        markTreeStale();
        return;
      }
      refreshOnFocus();
    };

    window.addEventListener("focus", refreshOnFocus);
    document.addEventListener("visibilitychange", refreshOnVisibility);
    return () => {
      window.removeEventListener("focus", refreshOnFocus);
      document.removeEventListener("visibilitychange", refreshOnVisibility);
      if (scheduleTimerRef.current !== null) {
        clearTimeout(scheduleTimerRef.current);
        scheduleTimerRef.current = null;
      }
    };
  }, [markTreeStale, scheduleRefresh]);

  const collapseAll = useCallback((): void => {
    dispatch({ type: "collapseAll" });
    setFocusedKey(null);
    setSelectedKey(null);
  }, []);

  const flushStale = useCallback((): void => {
    if (!workspaceRef.current || visibleRef.current?.() === false) {
      return;
    }
    const snapshot = stateRef.current;
    const hasStale =
      keysWithFlag(snapshot.stale, true).length > 0 ||
      keysWithFlag(snapshot.staleKeys, true).length > 0;
    if (hasStale) {
      void refresh({ manual: true });
    }
  }, [refresh]);

  const reveal = useCallback(
    async (targetToken: string): Promise<void> => {
      const info = workspaceRef.current;
      if (!info || !targetToken) {
        return;
      }
      const generation = generationRef.current;
      try {
        const segments = await ipc.workspaceLocateDocument(info.token, targetToken);
        if (tokenRef.current !== info.token || generationRef.current !== generation) {
          return;
        }
        if (!segments || segments.length === 0) {
          setCurrentKey(null);
          return;
        }
        const ancestors = ancestorSegments(segments);
        for (const prefix of ancestors) {
          await loadDirectory(info, prefix);
          if (tokenRef.current !== info.token || generationRef.current !== generation) {
            return;
          }
        }
        dispatch({ type: "expand", keys: ancestors.map(workspaceKey) });
        setCurrentKey(workspaceKey(segments));
      } catch (error) {
        if (normalizeError(error).code !== "INVALID_PATH") {
          return;
        }
        setCurrentKey(null);
      }
    },
    [ipc, loadDirectory],
  );

  useEffect(() => {
    if (!workspace || !docToken || docToken === UNTITLED_DOC_TOKEN) {
      return;
    }
    void reveal(docToken);
  }, [docToken, reveal, workspace]);

  const rows = flattenWorkspaceRows(state);

  return {
    workspace,
    rows,
    expanded: state.expanded,
    rootLoading: state.loading[""] === true,
    rootError: state.errors[""] ?? null,
    rootTruncated: state.truncated[""] === true,
    rootTruncationReason: state.truncationReason[""] ?? null,
    focusedKey,
    selectedKey,
    currentKey,
    openWorkspace,
    ensureLoaded,
    toggle,
    retry,
    refresh,
    collapseAll,
    flushStale,
    setFocusedKey,
    setSelectedKey,
  };
}
