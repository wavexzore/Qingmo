import { describe, expect, it } from "vitest";

import type { WorkspaceEntry } from "@qingmo/shared";

import { selectRefreshTargets } from "./useWorkspaceNavigation";
import {
  flattenWorkspaceRows,
  initialWorkspaceTreeState,
  workspaceTreeReducer,
  type WorkspaceTreeState,
} from "./workspaceTree";

function entry(name: string, kind: WorkspaceEntry["kind"] = "file"): WorkspaceEntry {
  return {
    name,
    kind,
    expandable: kind === "directory",
    openable: kind === "file" || kind === "symlinkFile",
    audio: false,
  };
}

function loaded(
  entries: WorkspaceEntry[],
  key = "",
  state: WorkspaceTreeState = initialWorkspaceTreeState(),
): WorkspaceTreeState {
  const seq = (state.seq[key] ?? 0) + 1;
  const started = workspaceTreeReducer(state, { type: "loadStart", key, seq });
  return workspaceTreeReducer(started, {
    type: "loadSuccess",
    key,
    seq,
    entries,
    truncated: false,
    truncationReason: null,
  });
}

describe("workspace tree reducer", () => {
  it("resets on token changes and bumps only the generation", () => {
    const state = loaded([entry("docs", "directory")]);
    const reset = workspaceTreeReducer(state, {
      type: "reset",
      token: "token-b",
      root: "/b",
      name: "b",
    });

    expect(reset.token).toBe("token-b");
    expect(reset.generation).toBe(state.generation + 1);
    expect(reset.children).toEqual({});
    expect(reset.expanded).toEqual({});
    expect(reset.autoRefreshPaused).toBe(false);
  });

  it("ignores stale responses for the same key", () => {
    const state = loaded([entry("a.md")]);
    const seq = state.seq[""] ?? 0;
    const stale = workspaceTreeReducer(state, {
      type: "loadSuccess",
      key: "",
      seq: seq - 1,
      entries: [entry("ghost.md")],
      truncated: false,
      truncationReason: null,
    });
    expect(stale).toBe(state);
  });

  it("keeps old children and marks them stale after a failed refresh", () => {
    let state = loaded([entry("docs", "directory")]);
    state = workspaceTreeReducer(state, {
      type: "loadStart",
      key: "",
      seq: 2,
    });
    state = workspaceTreeReducer(state, {
      type: "loadError",
      key: "",
      seq: 2,
      code: "IO",
    });

    expect(state.children[""]).toHaveLength(1);
    expect(state.errors[""]).toBe("IO");
    expect(state.stale[""]).toBe(true);
    expect(state.loading[""]).toBe(false);
  });

  it("drops the subtree of a directory that disappeared from its parent", () => {
    let state = loaded([entry("docs", "directory")]);
    state = loaded([entry("note.md")], "docs", state);
    state = workspaceTreeReducer(state, { type: "expand", keys: ["docs"] });
    expect(state.children["docs"]).toHaveLength(1);

    state = loaded([entry("other.md")], "", state);
    expect(state.children["docs"]).toBeUndefined();
    expect(state.expanded["docs"]).toBeUndefined();
    expect(state.loaded["docs"]).toBeUndefined();
  });

  it("refreshing one directory keeps another expanded directory intact", () => {
    let state = loaded([entry("a", "directory"), entry("b", "directory")]);
    state = loaded([entry("a.md")], "a", state);
    state = loaded([entry("b.md")], "b", state);
    state = workspaceTreeReducer(state, { type: "expand", keys: ["a", "b"] });

    state = loaded([entry("a2.md")], "a", state);

    expect(state.children["a"]?.map((item) => item.name)).toEqual(["a2.md"]);
    expect(state.children["b"]?.map((item) => item.name)).toEqual(["b.md"]);
    expect(state.expanded["b"]).toBe(true);
    expect(state.loaded["b"]).toBe(true);
    expect(state.errors["b"]).toBeNull();
  });

  it("removes a confirmed-missing directory subtree and marks its parent stale", () => {
    let state = loaded([entry("docs", "directory")]);
    state = loaded([entry("nested", "directory")], "docs", state);
    state = loaded([entry("note.md")], "docs/nested", state);
    state = workspaceTreeReducer(state, {
      type: "expand",
      keys: ["docs", "docs/nested"],
    });
    state = workspaceTreeReducer(state, { type: "removeSubtree", key: "docs" });

    expect(state.children["docs"]).toBeUndefined();
    expect(state.children["docs/nested"]).toBeUndefined();
    expect(state.expanded["docs"]).toBeUndefined();
    expect(state.expanded["docs/nested"]).toBeUndefined();
    expect(state.staleKeys[""]).toBe(true);
    expect(state.children[""]).toHaveLength(1);
  });

  it("ignores a removeSubtree request for the root key", () => {
    const state = loaded([entry("docs", "directory")]);
    expect(workspaceTreeReducer(state, { type: "removeSubtree", key: "" })).toBe(state);
  });

  it("invalidates every cached key when a watcher event arrives", () => {
    let state = loaded([entry("docs", "directory")]);
    state = loaded([entry("note.md")], "docs", state);
    state = workspaceTreeReducer(state, { type: "expand", keys: ["docs"] });
    state = workspaceTreeReducer(state, { type: "invalidateAllCached" });

    expect(state.staleKeys[""]).toBe(true);
    expect(state.staleKeys["docs"]).toBe(true);
  });

  it("collapseAll keeps only the root cache", () => {
    let state = loaded([entry("docs", "directory")]);
    state = loaded([entry("note.md")], "docs", state);
    state = workspaceTreeReducer(state, { type: "expand", keys: ["docs"] });
    state = workspaceTreeReducer(state, { type: "collapseAll" });

    expect(state.children[""]).toHaveLength(1);
    expect(state.children["docs"]).toBeUndefined();
    expect(state.expanded).toEqual({});
  });

  it("flattens only expanded branches with posinset and load state", () => {
    let state = loaded([entry("docs", "directory"), entry("root.md")]);
    state = workspaceTreeReducer(state, {
      type: "expand",
      keys: ["docs"],
    });
    state = loaded([entry("nested", "directory")], "docs", state);

    const rows = flattenWorkspaceRows(state);
    expect(rows.map((row) => row.key)).toEqual(["docs", "docs/nested", "root.md"]);
    expect(rows[0]).toMatchObject({
      depth: 0,
      posInSet: 1,
      setSize: 2,
      expanded: true,
      loadState: "loaded",
    });
    expect(rows[1]).toMatchObject({ depth: 1, loadState: "unloaded" });
    expect(rows[2]).toMatchObject({ depth: 0, posInSet: 2, loadState: "unloaded" });
  });

  it("caps automatic refresh, prioritizes stale keys and rotates the cursor", () => {
    let state = initialWorkspaceTreeState();
    const entries = Array.from({ length: 40 }, (_, index) =>
      entry(`dir-${index.toString().padStart(2, "0")}`, "directory"),
    );
    state = loaded(entries);
    state = workspaceTreeReducer(state, {
      type: "expand",
      keys: entries.map((item) => item.name),
    });
    state = workspaceTreeReducer(state, {
      type: "markStaleKeys",
      keys: ["", "dir-00", "dir-01"],
    });

    const first = selectRefreshTargets(state, false);
    expect(first.targets).toHaveLength(32);
    expect(first.uncovered).toHaveLength(9);
    expect(first.targets[0]).toEqual([]);
    expect(first.targets.map((segments) => segments.join("/"))).toContain("dir-00");

    state = workspaceTreeReducer(state, {
      type: "setRefreshCursor",
      value: first.nextCursor,
    });
    const second = selectRefreshTargets(state, false);
    expect(second.targets).toHaveLength(32);
    expect(second.targets).not.toEqual(first.targets);

    const manual = selectRefreshTargets(state, true);
    expect(manual.targets).toHaveLength(41);
    expect(manual.uncovered).toEqual([]);
  });

  it("maps the audio flag and keeps audio rows unopenable", () => {
    const state = loaded([
      {
        name: "voice.m4a",
        kind: "file",
        expandable: false,
        openable: false,
        audio: true,
      },
    ]);

    const rows = flattenWorkspaceRows(state);
    expect(rows[0]).toMatchObject({ audio: true, openable: false });
  });
});
