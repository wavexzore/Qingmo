import type { AppErrorCode, WorkspaceEntry, WorkspaceTruncationReason } from "@qingmo/shared";

import { workspaceKey } from "./workspacePath";

export type WorkspaceLoadState = "unloaded" | "loading" | "loaded" | "error";

export interface FlatRow {
  key: string;
  segments: string[];
  name: string;
  kind: WorkspaceEntry["kind"];
  depth: number;
  expandable: boolean;
  openable: boolean;
  /** Supported meeting audio; shown but not opened as a document. */
  audio: boolean;
  expanded: boolean;
  posInSet: number;
  setSize: number;
  loadState: WorkspaceLoadState;
  stale: boolean;
  errorCode: AppErrorCode | null;
  truncated: boolean;
  truncationReason: WorkspaceTruncationReason | null;
}

export interface WorkspaceTreeState {
  token: string | null;
  root: string | null;
  name: string | null;
  /** Only changes on token reset; refresh must not bump this. */
  generation: number;
  children: Record<string, WorkspaceEntry[]>;
  loaded: Record<string, boolean>;
  loading: Record<string, boolean>;
  errors: Record<string, AppErrorCode | null>;
  /** Per-key monotonic request id; invalidates old responses for the same key. */
  seq: Record<string, number>;
  expanded: Record<string, boolean>;
  truncated: Record<string, boolean>;
  truncationReason: Record<string, WorkspaceTruncationReason | null>;
  /** Last refresh failed but old children are still shown. */
  stale: Record<string, boolean>;
  /** Keys whose cached children are invalid (watcher event or refresh cap). */
  staleKeys: Record<string, boolean>;
  /** Round-robin cursor so automatic passes eventually cover every expanded key. */
  refreshCursor: number;
  /** True after two consecutive timeouts; only a successful manual refresh clears it. */
  autoRefreshPaused: boolean;
}

export type WorkspaceTreeAction =
  | { type: "reset"; token: string | null; root: string | null; name: string | null }
  | { type: "loadStart"; key: string; seq: number }
  | {
      type: "loadSuccess";
      key: string;
      seq: number;
      entries: WorkspaceEntry[];
      truncated: boolean;
      truncationReason: WorkspaceTruncationReason | null;
    }
  | { type: "loadError"; key: string; seq: number; code: AppErrorCode }
  | { type: "toggle"; key: string }
  | { type: "expand"; keys: string[] }
  | { type: "collapseAll" }
  | { type: "removeSubtree"; key: string }
  | { type: "refreshStart"; requests: Record<string, number> }
  | { type: "invalidateAllCached" }
  | { type: "markStaleKeys"; keys: string[] }
  | { type: "setRefreshCursor"; value: number }
  | { type: "pauseAutoRefresh" }
  | { type: "resumeAutoRefresh" };

export function initialWorkspaceTreeState(): WorkspaceTreeState {
  return {
    token: null,
    root: null,
    name: null,
    generation: 0,
    children: {},
    loaded: {},
    loading: {},
    errors: {},
    seq: {},
    expanded: {},
    truncated: {},
    truncationReason: {},
    stale: {},
    staleKeys: {},
    refreshCursor: 0,
    autoRefreshPaused: false,
  };
}

export function workspaceTreeReducer(
  state: WorkspaceTreeState,
  action: WorkspaceTreeAction,
): WorkspaceTreeState {
  switch (action.type) {
    case "reset":
      return {
        ...initialWorkspaceTreeState(),
        token: action.token,
        root: action.root,
        name: action.name,
        generation: state.generation + 1,
      };
    case "loadStart": {
      const currentSeq = state.seq[action.key];
      if (currentSeq !== undefined && currentSeq > action.seq) {
        return state;
      }
      return {
        ...state,
        seq: { ...state.seq, [action.key]: action.seq },
        loading: { ...state.loading, [action.key]: true },
        errors: { ...state.errors, [action.key]: null },
      };
    }
    case "loadSuccess": {
      if (state.seq[action.key] !== action.seq) {
        return state;
      }
      const previous = state.children[action.key] ?? [];
      const next = {
        ...state,
        children: { ...state.children, [action.key]: action.entries },
        loaded: { ...state.loaded, [action.key]: true },
        loading: { ...state.loading, [action.key]: false },
        errors: { ...state.errors, [action.key]: null },
        truncated: { ...state.truncated, [action.key]: action.truncated },
        truncationReason: {
          ...state.truncationReason,
          [action.key]: action.truncationReason,
        },
        stale: { ...state.stale, [action.key]: false },
        staleKeys: { ...state.staleKeys, [action.key]: false },
      };
      return reconcileRemovedDirectories(next, action.key, previous, action.entries);
    }
    case "loadError": {
      if (state.seq[action.key] !== action.seq) {
        return state;
      }
      const hasOldChildren = (state.children[action.key] ?? []).length > 0;
      return {
        ...state,
        loading: { ...state.loading, [action.key]: false },
        errors: { ...state.errors, [action.key]: action.code },
        loaded: {
          ...state.loaded,
          [action.key]: hasOldChildren || state.loaded[action.key] === true,
        },
        stale: { ...state.stale, [action.key]: hasOldChildren },
      };
    }
    case "toggle":
      return {
        ...state,
        expanded: { ...state.expanded, [action.key]: !state.expanded[action.key] },
      };
    case "expand": {
      if (action.keys.length === 0) {
        return state;
      }
      const expanded = { ...state.expanded };
      for (const key of action.keys) {
        expanded[key] = true;
      }
      return { ...state, expanded };
    }
    case "collapseAll": {
      const keepOnlyRoot = <T>(record: Record<string, T>, rootValue?: T): Record<string, T> => {
        const next: Record<string, T> = {};
        if (rootValue !== undefined) {
          next[""] = rootValue;
        } else if (record[""] !== undefined) {
          next[""] = record[""];
        }
        return next;
      };
      return {
        ...state,
        children: keepOnlyRoot(state.children),
        loaded: keepOnlyRoot(state.loaded),
        loading: keepOnlyRoot(state.loading),
        errors: keepOnlyRoot(state.errors),
        seq: keepOnlyRoot(state.seq),
        truncated: keepOnlyRoot(state.truncated),
        truncationReason: keepOnlyRoot(state.truncationReason),
        stale: keepOnlyRoot(state.stale),
        staleKeys: keepOnlyRoot(state.staleKeys),
        expanded: {},
        refreshCursor: 0,
      };
    }
    case "removeSubtree": {
      if (action.key === "") {
        return state;
      }
      const inside = (key: string): boolean =>
        key === action.key || key.startsWith(`${action.key}/`);
      const filter = <T>(record: Record<string, T>): Record<string, T> =>
        Object.fromEntries(Object.entries(record).filter(([key]) => !inside(key)));
      const parentKey = action.key.includes("/")
        ? action.key.slice(0, action.key.lastIndexOf("/"))
        : "";
      return {
        ...state,
        children: filter(state.children),
        loaded: filter(state.loaded),
        loading: filter(state.loading),
        errors: filter(state.errors),
        seq: filter(state.seq),
        truncated: filter(state.truncated),
        truncationReason: filter(state.truncationReason),
        stale: filter(state.stale),
        staleKeys: { ...filter(state.staleKeys), [parentKey]: true },
        expanded: filter(state.expanded),
      };
    }
    case "refreshStart": {
      const seq = { ...state.seq };
      const loading = { ...state.loading };
      const errors = { ...state.errors };
      for (const [key, value] of Object.entries(action.requests)) {
        seq[key] = value;
        loading[key] = true;
        errors[key] = null;
      }
      return { ...state, seq, loading, errors };
    }
    case "invalidateAllCached": {
      const keys = new Set<string>([
        "",
        ...Object.keys(state.children),
        ...Object.keys(state.expanded),
        ...Object.keys(state.loaded),
      ]);
      const staleKeys = { ...state.staleKeys };
      for (const key of keys) {
        staleKeys[key] = true;
      }
      return { ...state, staleKeys };
    }
    case "markStaleKeys": {
      if (action.keys.length === 0) {
        return state;
      }
      const staleKeys = { ...state.staleKeys };
      for (const key of action.keys) {
        staleKeys[key] = true;
      }
      return { ...state, staleKeys };
    }
    case "setRefreshCursor":
      return { ...state, refreshCursor: action.value };
    case "pauseAutoRefresh":
      return state.autoRefreshPaused ? state : { ...state, autoRefreshPaused: true };
    case "resumeAutoRefresh":
      return state.autoRefreshPaused ? { ...state, autoRefreshPaused: false } : state;
    default:
      return state;
  }
}

function reconcileRemovedDirectories(
  state: WorkspaceTreeState,
  parentKey: string,
  previous: WorkspaceEntry[],
  entries: WorkspaceEntry[],
): WorkspaceTreeState {
  if (previous.length === 0) {
    return state;
  }
  const nextByName = new Map(entries.map((entry) => [entry.name, entry]));
  const removed = previous
    .filter((entry) => entry.expandable)
    .filter((entry) => {
      const candidate = nextByName.get(entry.name);
      return !candidate || !candidate.expandable;
    })
    .map((entry) => (parentKey ? `${parentKey}/${entry.name}` : entry.name));
  if (removed.length === 0) {
    return state;
  }

  const isInside = (key: string): boolean =>
    removed.some((prefix) => key === prefix || key.startsWith(`${prefix}/`));

  const filter = <T>(record: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(record).filter(([key]) => !isInside(key)));

  return {
    ...state,
    children: filter(state.children),
    loaded: filter(state.loaded),
    loading: filter(state.loading),
    errors: filter(state.errors),
    seq: filter(state.seq),
    truncated: filter(state.truncated),
    truncationReason: filter(state.truncationReason),
    stale: filter(state.stale),
    staleKeys: filter(state.staleKeys),
    expanded: filter(state.expanded),
  };
}

/** Visible rows derived from children + expanded; never stored twice. */
export function flattenWorkspaceRows(state: WorkspaceTreeState): FlatRow[] {
  const rows: FlatRow[] = [];

  const walk = (parentSegments: string[], depth: number): void => {
    const parentKey = workspaceKey(parentSegments);
    const entries = state.children[parentKey] ?? [];
    const setSize = entries.length;
    entries.forEach((entry, index) => {
      const segments = [...parentSegments, entry.name];
      const key = workspaceKey(segments);
      const expanded = entry.expandable && state.expanded[key] === true;
      const children = state.children[key] ?? [];
      const errorCode = state.errors[key] ?? null;
      const loading = state.loading[key] === true;
      const loaded = state.loaded[key] === true;
      const loadState: WorkspaceLoadState = loading
        ? "loading"
        : errorCode !== null && children.length === 0
          ? "error"
          : loaded || children.length > 0
            ? "loaded"
            : "unloaded";
      rows.push({
        key,
        segments,
        name: entry.name,
        kind: entry.kind,
        depth,
        expandable: entry.expandable,
        openable: entry.openable,
        audio: entry.audio,
        expanded,
        posInSet: index + 1,
        setSize,
        loadState,
        stale: state.stale[key] === true || state.staleKeys[key] === true,
        errorCode,
        truncated: state.truncated[key] === true,
        truncationReason: state.truncationReason[key] ?? null,
      });
      if (expanded) {
        walk(segments, depth + 1);
      }
    });
  };

  walk([], 0);
  return rows;
}

/** Root plus every expanded directory, in depth-first order. */
export function expandedDirectorySegments(state: WorkspaceTreeState): string[][] {
  const segments: string[][] = [[]];
  for (const key of Object.keys(state.expanded)) {
    if (state.expanded[key] === true) {
      segments.push(key === "" ? [] : key.split("/"));
    }
  }
  return segments;
}
