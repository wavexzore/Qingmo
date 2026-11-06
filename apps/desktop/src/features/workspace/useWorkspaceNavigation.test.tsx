import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { IpcPort } from "../../lib/ipc/port";
import { COMMANDS } from "../../lib/ipc/commands";
import { AppError } from "../../lib/ipc/errors";
import { FakeIpc } from "../../lib/ipc/fake";
import type { EditorSession } from "../editor/EditorSession";
import { useWorkspaceNavigation } from "./useWorkspaceNavigation";

const WORKSPACE = { token: "workspace-1", root: "/docs", name: "docs" };

function entry(
  name: string,
  kind: "directory" | "file" = "file",
): {
  name: string;
  kind: "directory" | "file";
  expandable: boolean;
  openable: boolean;
} {
  return {
    name,
    kind,
    expandable: kind === "directory",
    openable: kind === "file",
  };
}

function controlledPort(options: { gone?: () => boolean } = {}) {
  const calls: string[][] = [];
  const state = {
    gone: options.gone ?? (() => false),
    failTimeouts: false,
    calls,
  };
  const port = {
    workspaceCurrent: async () => ({ ...WORKSPACE }),
    workspaceList: async (_token: string, segments: string[]) => {
      calls.push([...segments]);
      if (segments.length === 1 && segments[0] === "docs" && state.gone()) {
        throw new AppError("NOT_FOUND", "the directory is gone");
      }
      if (state.failTimeouts) {
        throw new AppError("IO", "workspace list timed out", { timeoutMs: 15_000 });
      }
      return {
        segments: [...segments],
        entries: segments.length === 0 ? [entry("docs", "directory")] : [entry("note.md")],
        truncated: false,
        truncationReason: null,
      };
    },
    workspaceLocateDocument: async () => null,
    onWorkspaceChanged: () => () => undefined,
  } as unknown as IpcPort;
  return { port, state };
}

function fakeStatusSession(initialToken: string) {
  let token = initialToken;
  const listeners = new Set<() => void>();
  const session = {
    subscribeStatus: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => ({ docToken: token }),
  } as unknown as EditorSession;
  return {
    session,
    setToken(next: string) {
      token = next;
      for (const listener of [...listeners]) {
        listener();
      }
    },
  };
}

function workspaceIpc(): FakeIpc {
  return new FakeIpc({
    workspace: {
      root: "/docs",
      files: [
        { path: "/docs/notes/a.md", text: "a" },
        { path: "/docs/readme.md", text: "readme" },
      ],
    },
  });
}

describe("useWorkspaceNavigation", () => {
  it("loads the current workspace and lazily expands directories", async () => {
    const ipc = workspaceIpc();
    const { result } = renderHook(() => useWorkspaceNavigation({ ipc }));

    await waitFor(() => expect(result.current.workspace?.root).toBe("/docs"));
    await waitFor(() =>
      expect(result.current.rows.map((row) => row.key)).toEqual(["notes", "readme.md"]),
    );

    act(() => result.current.toggle(["notes"]));
    await waitFor(() =>
      expect(result.current.rows.map((row) => row.key)).toEqual([
        "notes",
        "notes/a.md",
        "readme.md",
      ]),
    );

    // Expanding an already loaded directory does not issue another request.
    const callsBefore = ipc
      .getWorkspaceCalls()
      .filter((call) => call.command === COMMANDS.workspaceList).length;
    act(() => result.current.toggle(["notes"]));
    act(() => result.current.toggle(["notes"]));
    await waitFor(() => expect(result.current.rows.map((row) => row.key)).toContain("notes/a.md"));
    const callsAfter = ipc
      .getWorkspaceCalls()
      .filter((call) => call.command === COMMANDS.workspaceList).length;
    expect(callsAfter).toBe(callsBefore);
  });

  it("refreshes the root and every expanded directory manually", async () => {
    const ipc = workspaceIpc();
    const { result } = renderHook(() => useWorkspaceNavigation({ ipc }));
    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    act(() => result.current.toggle(["notes"]));
    await waitFor(() => expect(result.current.rows).toHaveLength(3));

    ipc.addWorkspaceFile("/docs/new.md", "new");
    ipc.addWorkspaceFile("/docs/notes/b.md", "b");
    await act(async () => {
      await result.current.refresh({ manual: true });
    });

    expect(result.current.rows.map((row) => row.key)).toEqual([
      "notes",
      "notes/a.md",
      "notes/b.md",
      "new.md",
      "readme.md",
    ]);
    const listed = ipc
      .getWorkspaceCalls()
      .filter((call) => call.command === COMMANDS.workspaceList)
      .slice(-2)
      .map((call) => call.args.dirSegments);
    expect(listed).toEqual([[], ["notes"]]);
  });

  it("switches workspaces without keeping the old token or rows", async () => {
    const ipc = workspaceIpc();
    ipc.addWorkspaceFile("/other/only.md", "other");
    ipc.setWorkspaceFolder("/other");
    const { result } = renderHook(() => useWorkspaceNavigation({ ipc }));
    await waitFor(() => expect(result.current.workspace?.root).toBe("/docs"));

    await act(async () => {
      const info = await result.current.openWorkspace();
      expect(info?.root).toBe("/other");
    });

    expect(result.current.workspace?.token).toBe("fake-workspace-2");
    await waitFor(() => expect(result.current.rows.map((row) => row.name)).toEqual(["only.md"]));
  });

  it("shows a root error without discarding the workspace", async () => {
    const ipc = workspaceIpc();
    ipc.failAlways(COMMANDS.workspaceList, "PERMISSION_DENIED");
    const { result } = renderHook(() => useWorkspaceNavigation({ ipc }));

    await waitFor(() => expect(result.current.rootError).toBe("PERMISSION_DENIED"));
    expect(result.current.workspace?.root).toBe("/docs");
    expect(result.current.rows).toEqual([]);
  });

  it("clears the workspace when the token is rejected", async () => {
    const ipc = workspaceIpc();
    const { result } = renderHook(() => useWorkspaceNavigation({ ipc }));
    await waitFor(() => expect(result.current.workspace).not.toBeNull());

    ipc.failNext(COMMANDS.workspaceList, "INVALID_PATH");
    await act(async () => {
      await result.current.refresh({ manual: true });
    });

    expect(result.current.workspace).toBeNull();
    expect(result.current.rows).toEqual([]);
  });

  it("reveals the current document, expands its ancestors and keeps editor focus", async () => {
    const ipc = workspaceIpc();
    const token = (await ipc.workspaceCurrent())?.token;
    expect(token).toBeTruthy();
    const inside = await ipc.workspaceOpenDocument(token as string, ["notes", "a.md"]);
    const fake = fakeStatusSession("untitled");

    const outsideFocus = document.createElement("input");
    document.body.append(outsideFocus);
    outsideFocus.focus();

    const { result } = renderHook(() => useWorkspaceNavigation({ ipc, session: fake.session }));
    await waitFor(() => expect(result.current.workspace?.root).toBe("/docs"));

    fake.setToken(inside.docToken);

    await waitFor(() => expect(result.current.currentKey).toBe("notes/a.md"));
    expect(result.current.expanded["notes"]).toBe(true);
    expect(result.current.rows.map((row) => row.key)).toContain("notes/a.md");
    expect(document.activeElement).toBe(outsideFocus);

    const locate = ipc
      .getWorkspaceCalls()
      .filter((call) => call.command === COMMANDS.workspaceLocateDocument);
    expect(locate).toHaveLength(1);
    expect(locate[0]?.args).toEqual({
      workspaceToken: token,
      docToken: inside.docToken,
    });

    outsideFocus.remove();
  });

  it("re-locates after a Save As token change and clears an outside highlight", async () => {
    const ipc = workspaceIpc();
    const token = (await ipc.workspaceCurrent())?.token;
    const inside = await ipc.workspaceOpenDocument(token as string, ["notes", "a.md"]);
    const fake = fakeStatusSession("untitled");
    const { result } = renderHook(() => useWorkspaceNavigation({ ipc, session: fake.session }));
    await waitFor(() => expect(result.current.workspace).not.toBeNull());
    expect(result.current.currentKey).toBeNull();

    fake.setToken(inside.docToken);
    await waitFor(() => expect(result.current.currentKey).toBe("notes/a.md"));

    // The Save As target is outside the workspace: locate returns null and the
    // previous highlight must not linger.
    fake.setToken("outside-token");
    await waitFor(() => expect(result.current.currentKey).toBeNull());
  });

  it("never calls locate without a workspace", async () => {
    const ipc = new FakeIpc({ files: [{ path: "/docs/note.md", text: "x" }] });
    const fake = fakeStatusSession("token-1");
    const { result } = renderHook(() => useWorkspaceNavigation({ ipc, session: fake.session }));

    await act(async () => undefined);
    expect(result.current.workspace).toBeNull();
    expect(
      ipc.getWorkspaceCalls().some((call) => call.command === COMMANDS.workspaceLocateDocument),
    ).toBe(false);
  });
});

describe("useWorkspaceNavigation refresh fallbacks", () => {
  it("refreshes after window focus with the trailing debounce", async () => {
    const ipc = workspaceIpc();
    const { result } = renderHook(() => useWorkspaceNavigation({ ipc }));
    await waitFor(() => expect(result.current.rows).toHaveLength(2));

    ipc.addWorkspaceFile("/docs/new.md", "new");
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => expect(result.current.rows.map((row) => row.key)).toContain("new.md"));
  });

  it("coalesces focus refreshes within one second", async () => {
    const ipc = workspaceIpc();
    const { result } = renderHook(() => useWorkspaceNavigation({ ipc }));
    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    const listCalls = () =>
      ipc.getWorkspaceCalls().filter((call) => call.command === COMMANDS.workspaceList).length;
    const before = listCalls();

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(listCalls()).toBe(before + 1));

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(listCalls()).toBe(before + 1);
  });

  it("marks the tree stale while hidden and refreshes when visible again", async () => {
    const ipc = workspaceIpc();
    const { result } = renderHook(() => useWorkspaceNavigation({ ipc }));
    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    const listCalls = () =>
      ipc.getWorkspaceCalls().filter((call) => call.command === COMMANDS.workspaceList).length;
    const before = listCalls();

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(listCalls()).toBe(before);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(listCalls()).toBe(before + 1));
  });

  it("marks stale while the workspace tab is hidden and flushes on return", async () => {
    const ipc = workspaceIpc();
    let treeVisible = true;
    const { result } = renderHook(() =>
      useWorkspaceNavigation({ ipc, isTreeVisible: () => treeVisible }),
    );
    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    const listCalls = () =>
      ipc.getWorkspaceCalls().filter((call) => call.command === COMMANDS.workspaceList).length;
    const before = listCalls();

    treeVisible = false;
    ipc.addWorkspaceFile("/docs/while-hidden.md", "hidden");
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(listCalls()).toBe(before);

    treeVisible = true;
    act(() => {
      result.current.flushStale();
    });
    await waitFor(() =>
      expect(result.current.rows.map((row) => row.key)).toContain("while-hidden.md"),
    );
  });

  it("merges consecutive watcher events into one refresh", async () => {
    const ipc = workspaceIpc();
    const { result } = renderHook(() => useWorkspaceNavigation({ ipc }));
    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    const listCalls = () =>
      ipc.getWorkspaceCalls().filter((call) => call.command === COMMANDS.workspaceList).length;
    const before = listCalls();

    ipc.addWorkspaceFile("/docs/watched.md", "watched");
    act(() => {
      ipc.emitWorkspaceChanged();
      ipc.emitWorkspaceChanged();
      ipc.emitWorkspaceChanged();
    });
    await waitFor(() => expect(result.current.rows.map((row) => row.key)).toContain("watched.md"));
    expect(listCalls()).toBe(before + 1);
  });

  it("watcher events while the tree is hidden only mark it stale", async () => {
    const ipc = workspaceIpc();
    let treeVisible = true;
    const { result } = renderHook(() =>
      useWorkspaceNavigation({ ipc, isTreeVisible: () => treeVisible }),
    );
    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    const listCalls = () =>
      ipc.getWorkspaceCalls().filter((call) => call.command === COMMANDS.workspaceList).length;
    const before = listCalls();

    treeVisible = false;
    ipc.addWorkspaceFile("/docs/hidden-event.md", "hidden");
    act(() => {
      ipc.emitWorkspaceChanged();
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(listCalls()).toBe(before);

    treeVisible = true;
    act(() => {
      result.current.flushStale();
    });
    await waitFor(() =>
      expect(result.current.rows.map((row) => row.key)).toContain("hidden-event.md"),
    );
  });

  it("keeps at most one pending refresh while another is in flight", async () => {
    const calls: string[] = [];
    let hold = false;
    let resolveGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    const port = {
      workspaceCurrent: async () => ({ ...WORKSPACE }),
      workspaceList: async (_token: string, segments: string[]) => {
        calls.push(segments.join("/"));
        if (hold) {
          await gate;
        }
        return {
          segments: [...segments],
          entries: [],
          truncated: false,
          truncationReason: null,
        };
      },
      workspaceLocateDocument: async () => null,
      onWorkspaceChanged: () => () => undefined,
    } as unknown as IpcPort;

    const { result } = renderHook(() => useWorkspaceNavigation({ ipc: port }));
    await waitFor(() => expect(calls).toHaveLength(1));

    hold = true;
    const firstPass = result.current.refresh({ manual: true });
    await waitFor(() => expect(calls).toHaveLength(2));

    // Both extra requests collapse into a single trailing pass.
    void result.current.refresh({ manual: true });
    void result.current.refresh({ manual: true });

    hold = false;
    resolveGate();
    await firstPass;
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(calls).toHaveLength(3);
  });

  it("manual refresh bypasses the one-second focus throttle", async () => {
    const ipc = workspaceIpc();
    const { result } = renderHook(() => useWorkspaceNavigation({ ipc }));
    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    const listCalls = () =>
      ipc.getWorkspaceCalls().filter((call) => call.command === COMMANDS.workspaceList).length;
    const before = listCalls();

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(listCalls()).toBe(before + 1));

    await act(async () => {
      await result.current.refresh({ manual: true });
    });
    expect(listCalls()).toBe(before + 2);
  });

  it("pauses automatic refresh after two consecutive timeouts and resumes on manual success", async () => {
    const { port, state } = controlledPort();
    const { result } = renderHook(() => useWorkspaceNavigation({ ipc: port }));
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    expect(state.calls).toHaveLength(1);

    state.failTimeouts = true;
    await act(async () => {
      await result.current.refresh();
    });
    await act(async () => {
      await result.current.refresh();
    });
    expect(state.calls).toHaveLength(3);

    // Automatic refresh is paused: it only marks the cache stale.
    await act(async () => {
      await result.current.refresh();
    });
    expect(state.calls).toHaveLength(3);

    state.failTimeouts = false;
    await act(async () => {
      await result.current.refresh({ manual: true });
    });
    expect(state.calls).toHaveLength(4);

    // A successful manual refresh cleared the breaker.
    await act(async () => {
      await result.current.refresh();
    });
    expect(state.calls).toHaveLength(5);
  });

  it("removes a directory subtree when its refresh reports NOT_FOUND", async () => {
    const { port, state } = controlledPort();
    const { result } = renderHook(() => useWorkspaceNavigation({ ipc: port }));
    await waitFor(() => expect(result.current.rows).toHaveLength(1));

    act(() => result.current.toggle(["docs"]));
    await waitFor(() =>
      expect(result.current.rows.map((row) => row.key)).toEqual(["docs", "docs/note.md"]),
    );

    state.gone = () => true;
    act(() => result.current.retry(["docs"]));
    await waitFor(() => expect(result.current.rows.map((row) => row.key)).toEqual(["docs"]));
    expect(result.current.expanded["docs"]).toBeUndefined();
  });
});
