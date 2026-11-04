import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FilePayload } from "@qingmo/shared";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppServicesProvider } from "../../app/AppServices";
import { routes } from "../../app/routes";
import { AppErrorBoundary } from "../../components/AppErrorBoundary";
import { ToastProvider } from "../../components/ToastHost";
import { COMMANDS } from "../../lib/ipc/commands";
import { FakeIpc } from "../../lib/ipc/fake";
import type { IpcPort } from "../../lib/ipc/port";
import { FakePlatform } from "../../lib/platform/fake";
import { FakeLogPort } from "../../lib/log/fake";
import { FakeUpdatePort } from "../../lib/update/fake";
import { THEME_STORAGE_KEY, uiStore } from "../../stores/uiStore";
import { commandRegistry } from "../commands/CommandRegistry";
import { DocumentSessionProvider, useDocumentSession } from "../editor/DocumentSessionContext";
import type { EditorSession } from "../editor/EditorSession";
import { outlineVisibilityStore } from "../editor/outline/outlineVisibility";
import { UpdateProvider } from "../update/UpdateProvider";
import { newDocument } from "./newDocument";
import { openFile } from "./openFile";

function SessionProbe({ onSession }: { onSession: (session: EditorSession | null) => void }) {
  onSession(useDocumentSession().session);
  return null;
}

function renderApp(
  ipc: IpcPort,
  options: { onSession?: (session: EditorSession | null) => void } = {},
) {
  const platform = new FakePlatform();
  const router = createMemoryRouter(routes, { initialEntries: ["/"] });
  render(
    <AppErrorBoundary>
      <ToastProvider>
        <AppServicesProvider
          services={{ ipc, platform, updates: new FakeUpdatePort(), logs: new FakeLogPort() }}
        >
          <DocumentSessionProvider>
            {options.onSession ? <SessionProbe onSession={options.onSession} /> : null}
            <UpdateProvider autoCheck={false}>
              <RouterProvider router={router} />
            </UpdateProvider>
          </DocumentSessionProvider>
        </AppServicesProvider>
      </ToastProvider>
    </AppErrorBoundary>,
  );
  return { router, platform };
}

function fileIpc(
  text = "# Hello\n",
  options: { path?: string; readOnlyReason?: "mdx" | "mixedEol" | null } = {},
) {
  return new FakeIpc({
    files: [
      {
        path: options.path ?? "/docs/note.md",
        text,
        readOnlyReason: options.readOnlyReason ?? null,
      },
    ],
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  commandRegistry.unregister("file.new");
  commandRegistry.unregister("file.open");
  commandRegistry.unregister("file.save");
  commandRegistry.unregister("view.toggleLivePreview");
  commandRegistry.unregister("view.toggleOutline");
  commandRegistry.unregister("view.toggleTheme");
  uiStore.setTheme("system");
  localStorage.removeItem(THEME_STORAGE_KEY);
  document.documentElement.removeAttribute("data-theme");
  outlineVisibilityStore.resetForTests();
});

describe("openFile", () => {
  it("returns the payload from the port without taking a path", async () => {
    const ipc = fileIpc("# Hi\n");
    const spy = vi.spyOn(ipc, "documentOpen");

    const result = await openFile(ipc);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).not.toBeNull();
    }
    if (result.ok && result.value) {
      expect(result.value.path).toBe("/docs/note.md");
      expect(result.value.text).toBe("# Hi\n");
      expect(result.value.docToken).toBeTruthy();
    }
    expect(spy).toHaveBeenCalledWith();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("returns null when Tauri opened the document in a new window", async () => {
    const ipc = fileIpc();
    // The Tauri adapter resolves null after creating a native window; the
    // fake's narrowed type still returns a payload, so force the production
    // shape here.
    vi.spyOn(ipc, "documentOpen").mockResolvedValue(null as unknown as FilePayload);

    const result = await openFile(ipc);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeNull();
    }
  });

  it("treats a cancelled dialog as a normal CANCELLED result", async () => {
    const ipc = new FakeIpc({
      files: [{ path: "/docs/note.md", text: "x" }],
      openFile: null,
    });

    const result = await openFile(ipc);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CANCELLED");
    }
  });

  it("normalizes port failures and unknown exceptions", async () => {
    const denied = fileIpc();
    denied.failNext(COMMANDS.documentOpen, "PERMISSION_DENIED", "denied");
    const deniedResult = await openFile(denied);
    expect(deniedResult.ok).toBe(false);
    if (!deniedResult.ok) {
      expect(deniedResult.error.code).toBe("PERMISSION_DENIED");
    }

    const broken: IpcPort = {
      documentOpen: vi.fn().mockRejectedValue("bridge unavailable"),
      documentActivate: vi.fn(),
      documentNew: vi.fn(),
      documentTakePending: vi.fn(),
      documentReload: vi.fn(),
      documentSaveAs: vi.fn(),
      documentWriteAtomic: vi.fn(),
      onDocumentChanged: vi.fn(() => () => undefined),
      appCloseConfirm: vi.fn(),
      appSetLivePreview: vi.fn(),
      appApplyLocale: vi.fn(),
      appOpenExternal: vi.fn(),
      sessionViewStateGet: vi.fn(),
      sessionViewStateSet: vi.fn(),
      sessionDraftWrite: vi.fn(),
      sessionDraftList: vi.fn(),
      sessionDraftRead: vi.fn(),
      sessionDraftDiscard: vi.fn(),
    };
    const brokenResult = await openFile(broken);
    expect(brokenResult.ok).toBe(false);
    if (!brokenResult.ok) {
      expect(brokenResult.error.code).toBe("IO");
      expect(brokenResult.error.message).toBe("bridge unavailable");
    }
  });
});

describe("newDocument", () => {
  it("returns the placement reported by the port", async () => {
    const ipc = fileIpc();
    const spy = vi.spyOn(ipc, "documentNew").mockResolvedValue("window");

    const result = await newDocument(ipc);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("window");
    }
    expect(spy).toHaveBeenCalledWith();
  });

  it("normalizes port failures", async () => {
    const ipc = fileIpc();
    ipc.failNext(COMMANDS.documentNew, "IO", "window backend failed");

    const result = await newDocument(ipc);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("IO");
      expect(result.error.message).toBe("window backend failed");
    }
  });
});

describe("blank editor -> editor open flow", () => {
  it("opens a file, creates the session, and renders the editor host", async () => {
    const ipc = fileIpc("# Hello\n\nsecret body\n");
    const { router, platform } = renderApp(ipc);

    platform.emitMenuAction("file.open");

    expect(await screen.findByTestId("document-session")).toBeInTheDocument();
    const statusBar = screen.getByTestId("status-bar");
    await waitFor(() => expect(statusBar).toHaveTextContent("note.md"));
    // The body lives in CM6's DOM, never in the React metadata snapshot
    // (editor-session.test.ts asserts JSON.stringify(snapshot) has no text).
    await waitFor(() => expect(screen.getByTestId("editor-host")).toHaveTextContent("secret body"));
    expect(router.state.location.pathname).toBe("/editor");
    expect(commandRegistry.list().filter((item) => item.id === "file.open")).toHaveLength(1);
    expect(commandRegistry.list().filter((item) => item.id === "file.save")).toHaveLength(1);
    expect(
      commandRegistry.list().filter((item) => item.id === "view.toggleLivePreview"),
    ).toHaveLength(1);
    await waitFor(() => expect(statusBar).toHaveTextContent("实时预览"));

    const saved = await commandRegistry.execute("file.save");
    expect(saved.ok).toBe(true);
    expect(ipc.getFile("/docs/note.md")?.text).toBe("# Hello\n\nsecret body\n");

    expect((await commandRegistry.execute("view.toggleLivePreview")).ok).toBe(true);
    await waitFor(() => expect(screen.getByTestId("status-bar")).toHaveTextContent("源码"));
    expect(screen.getByTestId("status-bar")).not.toHaveTextContent("实时预览");

    expect((await commandRegistry.execute("view.toggleLivePreview")).ok).toBe(true);
    await waitFor(() => expect(screen.getByTestId("status-bar")).toHaveTextContent("实时预览"));

    expect(commandRegistry.list().filter((item) => item.id === "view.toggleTheme")).toHaveLength(1);
    const themeBefore = document.documentElement.getAttribute("data-theme");
    const editorBefore = document.querySelector(".cm-editor")?.className;
    expect(editorBefore).toBeTruthy();
    expect((await commandRegistry.execute("view.toggleTheme")).ok).toBe(true);
    const themeAfter = document.documentElement.getAttribute("data-theme");
    expect(themeAfter).toMatch(/^(light|dark)$/);
    expect(themeAfter).not.toBe(themeBefore);
    await waitFor(() =>
      expect(document.querySelector(".cm-editor")?.className).not.toBe(editorBefore),
    );
  });

  it("keeps the current document when the port opens another window", async () => {
    const ipc = fileIpc("# Current\n");
    const spy = vi.spyOn(ipc, "documentOpen").mockResolvedValue(null as unknown as FilePayload);
    const { router, platform } = renderApp(ipc);

    platform.emitMenuAction("file.open");

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("untitled-editor")).toBeInTheDocument();
    expect(screen.queryByTestId("document-session")).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");
  });

  it("opens another file from a dirty untitled document without Save As", async () => {
    const ipc = fileIpc();
    const openSpy = vi.spyOn(ipc, "documentOpen").mockResolvedValue(null as unknown as FilePayload);
    const saveAsSpy = vi.spyOn(ipc, "documentSaveAs");
    const captured: { current: EditorSession | null } = { current: null };
    const { platform } = renderApp(ipc, {
      onSession: (value) => {
        captured.current = value;
      },
    });

    await waitFor(() => expect(captured.current?.attachedView).not.toBeNull());
    const view = captured.current?.attachedView;
    if (!view) {
      throw new Error("untitled editor view is not attached");
    }
    act(() => {
      view.dispatch({ changes: { from: 0, insert: "# draft" } });
    });
    await waitFor(() => expect(captured.current?.getSnapshot().dirty).toBe(true));

    platform.emitMenuAction("file.open");

    await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));
    expect(saveAsSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId("untitled-editor")).toBeInTheDocument();
  });

  it("does not preserve or block Open in the native shell", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    const ipc = fileIpc();
    const openSpy = vi.spyOn(ipc, "documentOpen").mockResolvedValue(null as unknown as FilePayload);
    const draftSpy = vi.spyOn(ipc, "sessionDraftWrite");
    const captured: { current: EditorSession | null } = { current: null };
    const { platform } = renderApp(ipc, {
      onSession: (value) => {
        captured.current = value;
      },
    });

    await waitFor(() => expect(captured.current?.attachedView).not.toBeNull());
    const view = captured.current?.attachedView;
    if (!view) {
      throw new Error("untitled editor view is not attached");
    }
    act(() => {
      view.dispatch({ changes: { from: 0, insert: "precious" } });
    });
    await waitFor(() => expect(captured.current?.getSnapshot().dirty).toBe(true));
    // A failed draft must not stop the native dialog from opening either.
    ipc.failNext(COMMANDS.sessionDraftWrite, "IO", "draft storage unavailable");

    platform.emitMenuAction("file.open");

    await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));
    expect(draftSpy).not.toHaveBeenCalled();
    expect(captured.current?.readText()).toBe("precious");
    expect(captured.current?.isUntitled).toBe(true);
  });

  it("keeps typing that lands during the draft-list refresh before New", async () => {
    const ipc = fileIpc();
    ipc.setCommandDelay(COMMANDS.sessionDraftList, 150);
    const captured: { current: EditorSession | null } = { current: null };
    const { platform } = renderApp(ipc, {
      onSession: (value) => {
        captured.current = value;
      },
    });

    await waitFor(() => expect(captured.current?.attachedView).not.toBeNull());
    const view = captured.current?.attachedView;
    if (!view) {
      throw new Error("untitled editor view is not attached");
    }
    act(() => {
      view.dispatch({ changes: { from: 0, insert: "A" } });
    });

    platform.emitMenuAction("file.new");
    // Typing after the first write but while the refresh is in flight must
    // trigger another pass instead of being dropped.
    await waitFor(() => expect(ipc.draftWrites).toHaveLength(1));
    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: "B" } });
    });

    await waitFor(() => expect(captured.current?.readText()).toBe(""));
    expect(ipc.draftWrites.at(-1)?.text).toBe("AB");
  });

  it("keeps the same EditorView when the outline is toggled", async () => {
    const ipc = fileIpc("# Outline\n");
    const captured: { current: EditorSession | null } = { current: null };
    const { platform } = renderApp(ipc, {
      onSession: (value) => {
        captured.current = value;
      },
    });

    platform.emitMenuAction("file.open");
    await screen.findByTestId("document-session");
    await waitFor(() => expect(captured.current?.attachedView).not.toBeNull());
    const view = captured.current?.attachedView;
    expect(view).not.toBeNull();

    expect((await commandRegistry.execute("view.toggleOutline")).ok).toBe(true);
    expect(await screen.findByTestId("outline-panel")).toBeInTheDocument();
    expect(captured.current?.attachedView).toBe(view);

    expect((await commandRegistry.execute("view.toggleOutline")).ok).toBe(true);
    await waitFor(() => expect(screen.queryByTestId("outline-panel")).not.toBeInTheDocument());
    expect(captured.current?.attachedView).toBe(view);
  });

  it("opens the registry-backed palette with Mod+K and runs a command from the keyboard", async () => {
    const ipc = fileIpc("# Palette\n");
    const { platform } = renderApp(ipc);

    platform.emitMenuAction("file.open");
    expect(await screen.findByTestId("document-session")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    expect(await screen.findByRole("dialog", { name: "命令面板" })).toBeInTheDocument();
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(8);
    expect(options.map((option) => option.textContent)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("新建文件"),
        expect.stringContaining("打开文件"),
        expect.stringContaining("保存文件"),
        expect.stringContaining("切换大纲"),
        expect.stringContaining("切换实时预览"),
        expect.stringContaining("切换主题"),
        expect.stringContaining("检查更新"),
      ]),
    );

    const before = document.documentElement.getAttribute("data-theme");
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "主题" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.documentElement.getAttribute("data-theme")).not.toBe(before);
  });

  it("shows the read-only reason for an MDX document", async () => {
    const ipc = fileIpc("export const A = 1\n", {
      path: "/docs/component.mdx",
      readOnlyReason: "mdx",
    });
    const { platform } = renderApp(ipc);

    platform.emitMenuAction("file.open");

    expect(await screen.findByTestId("read-only-badge")).toHaveTextContent("MDX 暂为只读");
    expect(screen.getByTestId("status-bar")).toHaveTextContent("只读");
    expect(screen.getByTestId("status-bar")).toHaveTextContent("component.mdx");

    const saved = await commandRegistry.execute("file.save");
    expect(saved.ok).toBe(false);
    if (!saved.ok) {
      expect(saved.error.code).toBe("BUSY");
    }
  });

  it("shows the large-document hint and disables preview above the unit budget", async () => {
    const ipc = fileIpc(`# Big\n\n${"a".repeat(2_000_000)}`);
    const { platform } = renderApp(ipc);

    platform.emitMenuAction("file.open");

    expect(await screen.findByTestId("document-session")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("status-bar")).toHaveTextContent("note.md"));
    expect(screen.getByTestId("large-file-hint")).toHaveTextContent("大文档 · 源码模式");
    expect(screen.getByTestId("status-bar")).toHaveTextContent("源码");

    const toggled = await commandRegistry.execute("view.toggleLivePreview");
    expect(toggled.ok).toBe(false);
    if (!toggled.ok) {
      expect(toggled.error.code).toBe("BUSY");
    }
  }, 20_000);

  it("shows an error toast for a rejected open and stays on the untitled editor", async () => {
    const ipc = new FakeIpc({
      files: [{ path: "/docs/note.md", text: "x" }],
      openFile: "/docs/missing.md",
    });
    const { platform } = renderApp(ipc);

    platform.emitMenuAction("file.open");

    expect(await screen.findByText("文件不存在或已被移动。")).toBeInTheDocument();
    expect(screen.getByTestId("untitled-editor")).toBeInTheDocument();
    expect(screen.queryByTestId("document-session")).not.toBeInTheDocument();
  });

  it("stays silent when the native dialog is cancelled", async () => {
    const ipc = new FakeIpc({
      files: [{ path: "/docs/note.md", text: "x" }],
      openFile: null,
    });
    const { platform } = renderApp(ipc);

    platform.emitMenuAction("file.open");
    expect(screen.getByTestId("untitled-editor")).toBeInTheDocument();

    expect(screen.queryByText("操作已取消。")).not.toBeInTheDocument();
    expect(screen.getByTestId("untitled-editor")).toBeInTheDocument();
    expect(screen.queryByTestId("document-session")).not.toBeInTheDocument();
  });

  it("keeps the current document when New opens a native window", async () => {
    const ipc = fileIpc("# Current\n");
    const newSpy = vi.spyOn(ipc, "documentNew").mockResolvedValue("window");
    const writeSpy = vi.spyOn(ipc, "documentWriteAtomic");
    const captured: { current: EditorSession | null } = { current: null };
    const { platform } = renderApp(ipc, {
      onSession: (value) => {
        captured.current = value;
      },
    });

    platform.emitMenuAction("file.open");
    expect(await screen.findByTestId("document-session")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("status-bar")).toHaveTextContent("note.md"));
    await waitFor(() => expect(captured.current?.attachedView).not.toBeNull());
    const view = captured.current?.attachedView;
    if (!view) {
      throw new Error("named editor view is not attached");
    }
    // Press New before the 800ms debounce can save on its own, so the
    // assertion proves the native window path does not flush.
    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: "\nchanged" } });
    });

    platform.emitMenuAction("file.new");

    await waitFor(() => expect(newSpy).toHaveBeenCalledTimes(1));
    expect(writeSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId("document-session")).toBeInTheDocument();
    expect(screen.getByTestId("status-bar")).toHaveTextContent("note.md");
    await waitFor(() => expect(screen.getByTestId("editor-host")).toHaveTextContent("Current"));
  });

  it("resets the current window to a fresh untitled in the browser harness", async () => {
    const ipc = fileIpc("# Named\n");
    const saveAsSpy = vi.spyOn(ipc, "documentSaveAs");
    const captured: { current: EditorSession | null } = { current: null };
    const { router, platform } = renderApp(ipc, {
      onSession: (value) => {
        captured.current = value;
      },
    });

    platform.emitMenuAction("file.open");
    expect(await screen.findByTestId("document-session")).toBeInTheDocument();
    await waitFor(() => expect(captured.current?.isUntitled).toBe(false));

    platform.emitMenuAction("file.new");

    expect(await screen.findByTestId("untitled-editor")).toBeInTheDocument();
    await waitFor(() => expect(captured.current?.isUntitled).toBe(true));
    expect(captured.current?.readText()).toBe("");
    expect(captured.current?.getSnapshot().dirty).toBe(false);
    expect(screen.queryByTestId("document-session")).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/editor");
    expect(saveAsSpy).not.toHaveBeenCalled();
  });

  it("flushes a dirty named document before the browser harness replaces it", async () => {
    const ipc = fileIpc("# Original\n");
    const saveAsSpy = vi.spyOn(ipc, "documentSaveAs");
    const captured: { current: EditorSession | null } = { current: null };
    const { platform } = renderApp(ipc, {
      onSession: (value) => {
        captured.current = value;
      },
    });

    platform.emitMenuAction("file.open");
    expect(await screen.findByTestId("document-session")).toBeInTheDocument();
    await waitFor(() => expect(captured.current?.attachedView).not.toBeNull());
    const view = captured.current?.attachedView;
    if (!view) {
      throw new Error("named editor view is not attached");
    }
    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: "\nchanged" } });
    });

    platform.emitMenuAction("file.new");

    expect(await screen.findByTestId("untitled-editor")).toBeInTheDocument();
    await waitFor(() => expect(ipc.getFile("/docs/note.md")?.text).toBe("# Original\n\nchanged"));
    expect(captured.current?.isUntitled).toBe(true);
    expect(saveAsSpy).not.toHaveBeenCalled();
  });

  it("keeps the current session when the browser flush fails", async () => {
    const ipc = fileIpc("# Original\n");
    const captured: { current: EditorSession | null } = { current: null };
    const { platform } = renderApp(ipc, {
      onSession: (value) => {
        captured.current = value;
      },
    });

    platform.emitMenuAction("file.open");
    expect(await screen.findByTestId("document-session")).toBeInTheDocument();
    await waitFor(() => expect(captured.current?.attachedView).not.toBeNull());
    const view = captured.current?.attachedView;
    if (!view) {
      throw new Error("named editor view is not attached");
    }
    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: "\nchanged" } });
    });
    ipc.failNext(COMMANDS.documentWriteAtomic, "PERMISSION_DENIED", "denied");

    platform.emitMenuAction("file.new");

    expect(await screen.findByText("没有读取或写入该文件的权限。")).toBeInTheDocument();
    expect(screen.getByTestId("document-session")).toBeInTheDocument();
    expect(captured.current?.isUntitled).toBe(false);
    expect(captured.current?.readText()).toContain("changed");
  });

  it("journals a dirty untitled document before the browser harness replaces it", async () => {
    const ipc = fileIpc();
    const captured: { current: EditorSession | null } = { current: null };
    const { platform } = renderApp(ipc, {
      onSession: (value) => {
        captured.current = value;
      },
    });

    await waitFor(() => expect(captured.current?.attachedView).not.toBeNull());
    const view = captured.current?.attachedView;
    if (!view) {
      throw new Error("untitled editor view is not attached");
    }
    act(() => {
      view.dispatch({ changes: { from: 0, insert: "# draft" } });
    });

    platform.emitMenuAction("file.new");

    await waitFor(() =>
      expect(ipc.draftWrites.some((draft) => draft.text.includes("# draft"))).toBe(true),
    );
    expect(await screen.findByTestId("untitled-editor")).toBeInTheDocument();
    expect(captured.current?.readText()).toBe("");
    expect(captured.current?.isUntitled).toBe(true);
  });

  it("replaces a dirty untitled document whose draft already auto-wrote", async () => {
    const ipc = fileIpc();
    const captured: { current: EditorSession | null } = { current: null };
    const { platform } = renderApp(ipc, {
      onSession: (value) => {
        captured.current = value;
      },
    });

    await waitFor(() => expect(captured.current?.attachedView).not.toBeNull());
    const view = captured.current?.attachedView;
    if (!view) {
      throw new Error("untitled editor view is not attached");
    }
    act(() => {
      view.dispatch({ changes: { from: 0, insert: "# draft" } });
    });
    // Let the debounce write the same snapshot New will flush.
    await waitFor(() => expect(ipc.draftWrites).toHaveLength(1), { timeout: 3_000 });

    platform.emitMenuAction("file.new");

    await waitFor(() => expect(captured.current?.isUntitled).toBe(true));
    expect(captured.current?.readText()).toBe("");
    expect(screen.queryByText("读写文件时发生错误。")).not.toBeInTheDocument();
    // The forced flush rewrites the same draft id even though the snapshot
    // itself did not change.
    expect(ipc.draftWrites).toHaveLength(2);
    expect(ipc.draftWrites[1]?.id).toBeDefined();
  });

  it("rewrites an auto-written draft that the global cap already evicted", async () => {
    const ipc = fileIpc();
    const captured: { current: EditorSession | null } = { current: null };
    const { platform } = renderApp(ipc, {
      onSession: (value) => {
        captured.current = value;
      },
    });

    await waitFor(() => expect(captured.current?.attachedView).not.toBeNull());
    const view = captured.current?.attachedView;
    if (!view) {
      throw new Error("untitled editor view is not attached");
    }
    act(() => {
      view.dispatch({ changes: { from: 0, insert: "# draft" } });
    });
    await waitFor(() => expect(ipc.draftWrites).toHaveLength(1), { timeout: 3_000 });
    const original = (await ipc.sessionDraftList())[0]?.id;
    expect(original).toBeDefined();
    // The store keeps at most 20 drafts; 21 newer ones evict ours while the
    // editor still believes its own id is valid.
    for (let index = 0; index < 21; index += 1) {
      await ipc.sessionDraftWrite({
        kind: "untitled",
        title: `filler ${index}`,
        text: "x",
        anchor: 0,
        head: 0,
      });
    }
    expect((await ipc.sessionDraftList()).some((draft) => draft.id === original)).toBe(false);

    platform.emitMenuAction("file.new");

    await waitFor(() => expect(captured.current?.readText()).toBe(""));
    const restored = await ipc.sessionDraftList();
    expect(restored.some((draft) => draft.id === original)).toBe(true);
    expect((await ipc.sessionDraftRead(original!)).text).toBe("# draft");
    expect(screen.queryByText("读写文件时发生错误。")).not.toBeInTheDocument();
  });

  it("serializes an Open that arrives while New is still flushing", async () => {
    const ipc = fileIpc("# Note\n");
    ipc.setCommandDelay(COMMANDS.documentWriteAtomic, 200);
    const captured: { current: EditorSession | null } = { current: null };
    const { platform } = renderApp(ipc, {
      onSession: (value) => {
        captured.current = value;
      },
    });

    platform.emitMenuAction("file.open");
    expect(await screen.findByTestId("document-session")).toBeInTheDocument();
    await waitFor(() => expect(captured.current?.attachedView).not.toBeNull());
    await waitFor(() => expect(captured.current?.isUntitled).toBe(false));
    const view = captured.current?.attachedView;
    if (!view) {
      throw new Error("named editor view is not attached");
    }
    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: "\ndirty" } });
    });

    platform.emitMenuAction("file.new");
    await new Promise((resolve) => setTimeout(resolve, 20));
    platform.emitMenuAction("file.open");

    await waitFor(() => expect(ipc.getFile("/docs/note.md")?.text).toContain("dirty"), {
      timeout: 3_000,
    });
    await waitFor(() => expect(captured.current?.isUntitled).toBe(false));
    expect(captured.current?.readText()).toContain("dirty");
  });

  it("flushes the current untitled document before a harness Open adopts", async () => {
    const ipc = fileIpc("# Note\n");
    const captured: { current: EditorSession | null } = { current: null };
    const { platform } = renderApp(ipc, {
      onSession: (value) => {
        captured.current = value;
      },
    });

    await waitFor(() => expect(captured.current?.attachedView).not.toBeNull());
    const view = captured.current?.attachedView;
    if (!view) {
      throw new Error("untitled editor view is not attached");
    }
    act(() => {
      view.dispatch({ changes: { from: 0, insert: "precious" } });
    });

    platform.emitMenuAction("file.open");

    expect(await screen.findByTestId("document-session")).toBeInTheDocument();
    const drafts = await ipc.sessionDraftList();
    expect(drafts).toHaveLength(1);
    expect((await ipc.sessionDraftRead(drafts[0]!.id)).text).toBe("precious");
    await waitFor(() => expect(captured.current?.readText()).toBe("# Note\n"));
  });

  it("flushes a dirty named document before a harness Open adopts", async () => {
    const ipc = fileIpc("# Note\n");
    const captured: { current: EditorSession | null } = { current: null };
    const { platform } = renderApp(ipc, {
      onSession: (value) => {
        captured.current = value;
      },
    });

    platform.emitMenuAction("file.open");
    expect(await screen.findByTestId("document-session")).toBeInTheDocument();
    await waitFor(() => expect(captured.current?.isUntitled).toBe(false));
    const view = captured.current?.attachedView;
    if (!view) {
      throw new Error("named editor view is not attached");
    }
    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: "\ndirty" } });
    });

    platform.emitMenuAction("file.open");

    await waitFor(() => expect(ipc.getFile("/docs/note.md")?.text).toContain("dirty"));
    await waitFor(() => expect(captured.current?.isUntitled).toBe(false));
    expect(captured.current?.readText()).toContain("dirty");
  });

  it("journals input typed while an untitled Open is in flight", async () => {
    const ipc = fileIpc("# Note\n");
    ipc.setCommandDelay(COMMANDS.documentOpen, 150);
    const captured: { current: EditorSession | null } = { current: null };
    const { platform } = renderApp(ipc, {
      onSession: (value) => {
        captured.current = value;
      },
    });

    await waitFor(() => expect(captured.current?.attachedView).not.toBeNull());
    const view = captured.current?.attachedView;
    if (!view) {
      throw new Error("untitled editor view is not attached");
    }
    act(() => {
      view.dispatch({ changes: { from: 0, insert: "A" } });
    });

    const original = ipc.documentOpen.bind(ipc);
    const openSpy = vi.spyOn(ipc, "documentOpen").mockImplementation(async () => {
      act(() => {
        view.dispatch({ changes: { from: view.state.doc.length, insert: "B" } });
      });
      return original();
    });

    platform.emitMenuAction("file.open");
    await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));

    await waitFor(() => expect(captured.current?.readText()).toBe("# Note\n"));
    const drafts = await ipc.sessionDraftList();
    expect((await ipc.sessionDraftRead(drafts[0]!.id)).text).toBe("AB");
  });

  it("saves late input on a named document before adopting", async () => {
    const ipc = fileIpc("# Note\n");
    const captured: { current: EditorSession | null } = { current: null };
    const { platform } = renderApp(ipc, {
      onSession: (value) => {
        captured.current = value;
      },
    });

    platform.emitMenuAction("file.open");
    expect(await screen.findByTestId("document-session")).toBeInTheDocument();
    await waitFor(() => expect(captured.current?.isUntitled).toBe(false));
    const view = captured.current?.attachedView;
    if (!view) {
      throw new Error("named editor view is not attached");
    }
    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: "\nA" } });
    });

    ipc.setCommandDelay(COMMANDS.documentOpen, 150);
    const original = ipc.documentOpen.bind(ipc);
    // Type in the dialog window itself; polling for the spy can be delayed by
    // the 2 MiB hash and would miss the chance to type into the live view.
    const openSpy = vi.spyOn(ipc, "documentOpen").mockImplementation(async () => {
      act(() => {
        view.dispatch({ changes: { from: view.state.doc.length, insert: "B" } });
      });
      return original();
    });
    const before = captured.current;
    platform.emitMenuAction("file.open");
    await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));

    await waitFor(() => expect(ipc.getFile("/docs/note.md")?.text.endsWith("AB")).toBe(true), {
      timeout: 10_000,
    });
    expect(captured.current).not.toBe(before);
    expect(captured.current?.readText().endsWith("AB")).toBe(true);
  });

  it("saves a late edit on a document above the draft cap to disk", async () => {
    const prefix = "# Note\n";
    const ipc = fileIpc(`${prefix}${"x".repeat(2 * 1024 * 1024)}`);
    const captured: { current: EditorSession | null } = { current: null };
    const { platform } = renderApp(ipc, {
      onSession: (value) => {
        captured.current = value;
      },
    });

    platform.emitMenuAction("file.open");
    expect(await screen.findByTestId("document-session")).toBeInTheDocument();
    await waitFor(() => expect(captured.current?.isUntitled).toBe(false));
    const view = captured.current?.attachedView;
    if (!view) {
      throw new Error("named editor view is not attached");
    }
    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: "A" } });
    });

    ipc.setCommandDelay(COMMANDS.documentOpen, 150);
    const original = ipc.documentOpen.bind(ipc);
    const openSpy = vi.spyOn(ipc, "documentOpen").mockImplementation(async () => {
      act(() => {
        view.dispatch({ changes: { from: view.state.doc.length, insert: "B" } });
      });
      return original();
    });
    platform.emitMenuAction("file.open");
    await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));

    // A crash draft would fail above 2 MiB; the late edit must reach the file.
    // Hashing a 2 MiB fixture several times is slow under a loaded suite.
    await waitFor(() => expect(ipc.getFile("/docs/note.md")?.text.endsWith("AB")).toBe(true), {
      timeout: 10_000,
    });
    expect(captured.current?.readText().endsWith("AB")).toBe(true);
    expect(screen.queryByText("读写文件时发生错误。")).not.toBeInTheDocument();
  });

  it("keeps the session usable when the late draft write fails", async () => {
    const ipc = fileIpc();
    const openSpy = vi.spyOn(ipc, "documentOpen");
    ipc.setCommandDelay(COMMANDS.documentOpen, 200);
    const captured: { current: EditorSession | null } = { current: null };
    const { platform } = renderApp(ipc, {
      onSession: (value) => {
        captured.current = value;
      },
    });

    await waitFor(() => expect(captured.current?.attachedView).not.toBeNull());
    const view = captured.current?.attachedView;
    if (!view) {
      throw new Error("untitled editor view is not attached");
    }
    act(() => {
      view.dispatch({ changes: { from: 0, insert: "A" } });
    });

    platform.emitMenuAction("file.open");
    await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));
    ipc.failNext(COMMANDS.sessionDraftWrite, "IO", "draft storage unavailable");
    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: "B" } });
    });

    // The adoption is abandoned but the session, its text and its token stay.
    await waitFor(() => expect(captured.current?.readText()).toBe("AB"));
    expect(captured.current?.isUntitled).toBe(true);
    expect(await screen.findByText("读写文件时发生错误。")).toBeInTheDocument();

    // A second Open must still reach the dialog and adopt.
    ipc.setCommandDelay(COMMANDS.documentOpen, 0);
    platform.emitMenuAction("file.open");
    await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(captured.current?.isUntitled).toBe(false));
    expect(captured.current?.readText()).toBe("# Hello\n");
  });

  it("keeps a named session saveable when the late save fails", async () => {
    const ipc = fileIpc("# Note\n");
    const captured: { current: EditorSession | null } = { current: null };
    const { platform } = renderApp(ipc, {
      onSession: (value) => {
        captured.current = value;
      },
    });

    platform.emitMenuAction("file.open");
    expect(await screen.findByTestId("document-session")).toBeInTheDocument();
    await waitFor(() => expect(captured.current?.isUntitled).toBe(false));
    const view = captured.current?.attachedView;
    if (!view) {
      throw new Error("named editor view is not attached");
    }
    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: "\nA" } });
    });

    ipc.setCommandDelay(COMMANDS.documentOpen, 150);
    const original = ipc.documentOpen.bind(ipc);
    const openSpy = vi.spyOn(ipc, "documentOpen").mockImplementation(async () => {
      act(() => {
        view.dispatch({ changes: { from: view.state.doc.length, insert: "B" } });
      });
      // Arm only for the late save; the pre-open preserve must succeed.
      ipc.failNext(COMMANDS.documentWriteAtomic, "PERMISSION_DENIED", "locked");

      return original();
    });

    platform.emitMenuAction("file.open");
    await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));

    // Adoption is abandoned, but the old token was restored and still saves.
    expect(await screen.findByText("没有读取或写入该文件的权限。")).toBeInTheDocument();
    expect(captured.current?.readText().endsWith("AB")).toBe(true);
    expect(captured.current?.isUntitled).toBe(false);

    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: "C" } });
    });
    fireEvent.click(await screen.findByTestId("status-retry"));
    await waitFor(() => expect(ipc.getFile("/docs/note.md")?.text.endsWith("ABC")).toBe(true));
  });

  it("keeps a late save on the old file when opening another", async () => {
    const ipc = new FakeIpc({
      files: [
        { path: "/docs/note.md", text: "# Note\n" },
        { path: "/docs/other.md", text: "# Other\n" },
      ],
    });
    const captured: { current: EditorSession | null } = { current: null };
    const { platform } = renderApp(ipc, {
      onSession: (value) => {
        captured.current = value;
      },
    });

    platform.emitMenuAction("file.open");
    expect(await screen.findByTestId("document-session")).toBeInTheDocument();
    await waitFor(() => expect(captured.current?.isUntitled).toBe(false));
    const view = captured.current?.attachedView;
    if (!view) {
      throw new Error("named editor view is not attached");
    }
    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: "\nA" } });
    });

    ipc.setOpenFile("/docs/other.md");
    ipc.setCommandDelay(COMMANDS.documentOpen, 150);
    const original = ipc.documentOpen.bind(ipc);
    const openSpy = vi.spyOn(ipc, "documentOpen").mockImplementation(async () => {
      act(() => {
        view.dispatch({ changes: { from: view.state.doc.length, insert: "B" } });
      });
      return original();
    });
    platform.emitMenuAction("file.open");
    await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));

    await waitFor(() => expect(captured.current?.readText()).toBe("# Other\n"));
    expect(ipc.getFile("/docs/note.md")?.text.endsWith("AB")).toBe(true);
    const opened = captured.current?.attachedView;
    if (!opened) {
      throw new Error("opened editor view is not attached");
    }
    act(() => {
      opened.dispatch({ changes: { from: opened.state.doc.length, insert: "C" } });
    });
    platform.emitMenuAction("file.save");
    await waitFor(() => expect(ipc.getFile("/docs/other.md")?.text.endsWith("C")).toBe(true));
    expect(ipc.getFile("/docs/note.md")?.text.endsWith("AB")).toBe(true);
  });

  it("keeps the current session when the same-path reload fails", async () => {
    const ipc = fileIpc("# Note\n");
    const captured: { current: EditorSession | null } = { current: null };
    const { platform } = renderApp(ipc, {
      onSession: (value) => {
        captured.current = value;
      },
    });

    platform.emitMenuAction("file.open");
    expect(await screen.findByTestId("document-session")).toBeInTheDocument();
    await waitFor(() => expect(captured.current?.isUntitled).toBe(false));
    const view = captured.current?.attachedView;
    if (!view) {
      throw new Error("named editor view is not attached");
    }
    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: "\nA" } });
    });

    ipc.setCommandDelay(COMMANDS.documentOpen, 150);
    const original = ipc.documentOpen.bind(ipc);
    const openSpy = vi.spyOn(ipc, "documentOpen").mockImplementation(async () => {
      act(() => {
        view.dispatch({ changes: { from: view.state.doc.length, insert: "B" } });
      });
      ipc.failNext(COMMANDS.documentReload, "IO", "reload failed");
      return original();
    });
    const before = captured.current;
    platform.emitMenuAction("file.open");
    await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));

    // Adopting the stale payload would overwrite the late save on the next
    // write, so the failed reload keeps the current session instead.
    expect(await screen.findByText("读写文件时发生错误。")).toBeInTheDocument();
    expect(captured.current).toBe(before);
    expect(captured.current?.readText().endsWith("AB")).toBe(true);
    expect(ipc.getFile("/docs/note.md")?.text.endsWith("AB")).toBe(true);

    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: "C" } });
    });
    platform.emitMenuAction("file.save");
    await waitFor(() => expect(ipc.getFile("/docs/note.md")?.text.endsWith("ABC")).toBe(true));
  });

  it("captures input typed while the adopted session is being prepared", async () => {
    const ipc = fileIpc("# Note\n");
    const captured: { current: EditorSession | null } = { current: null };
    const { platform } = renderApp(ipc, {
      onSession: (value) => {
        captured.current = value;
      },
    });

    platform.emitMenuAction("file.open");
    expect(await screen.findByTestId("document-session")).toBeInTheDocument();
    await waitFor(() => expect(captured.current?.isUntitled).toBe(false));
    const view = captured.current?.attachedView;
    if (!view) {
      throw new Error("named editor view is not attached");
    }
    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: "\nA" } });
    });

    ipc.setCommandDelay(COMMANDS.documentOpen, 150);
    ipc.setCommandDelay(COMMANDS.sessionViewStateGet, 150);
    const original = ipc.documentOpen.bind(ipc);
    const openSpy = vi.spyOn(ipc, "documentOpen").mockImplementation(async () => {
      act(() => {
        view.dispatch({ changes: { from: view.state.doc.length, insert: "B" } });
      });
      return original();
    });
    // Type once more while the payload session is being prepared; the view
    // state read makes that window observable.
    let armed = false;
    const viewStateOriginal = ipc.sessionViewStateGet.bind(ipc);
    vi.spyOn(ipc, "sessionViewStateGet").mockImplementation(async (path: string) => {
      if (armed) {
        armed = false;
        act(() => {
          view.dispatch({ changes: { from: view.state.doc.length, insert: "C" } });
        });
      }
      return viewStateOriginal(path);
    });

    const before = captured.current;
    armed = true;
    platform.emitMenuAction("file.open");
    await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));

    await waitFor(() => expect(captured.current).not.toBe(before), { timeout: 5_000 });
    expect(captured.current?.readText()).toBe("# Note\n\nABC");
    expect(captured.current?.isUntitled).toBe(false);
    expect(ipc.getFile("/docs/note.md")?.text).toBe("# Note\n\nABC");
  });

  it("captures input typed through the whole adoption handoff", async () => {
    const ipc = fileIpc("# Note\n");
    const captured: { current: EditorSession | null } = { current: null };
    const { platform } = renderApp(ipc, {
      onSession: (value) => {
        captured.current = value;
      },
    });

    platform.emitMenuAction("file.open");
    expect(await screen.findByTestId("document-session")).toBeInTheDocument();
    await waitFor(() => expect(captured.current?.isUntitled).toBe(false));
    const view = captured.current?.attachedView;
    if (!view) {
      throw new Error("named editor view is not attached");
    }
    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: "\nA" } });
    });

    ipc.setCommandDelay(COMMANDS.documentOpen, 150);
    ipc.setCommandDelay(COMMANDS.sessionViewStateGet, 100);
    const original = ipc.documentOpen.bind(ipc);
    const openSpy = vi.spyOn(ipc, "documentOpen").mockImplementation(async () => {
      act(() => {
        view.dispatch({ changes: { from: view.state.doc.length, insert: "B" } });
      });
      return original();
    });
    // Inject C while the payload session is built and D while the tail
    // rebuild reads the disk: the second tail pass must still catch D.
    let reads = 0;
    const viewStateOriginal = ipc.sessionViewStateGet.bind(ipc);
    vi.spyOn(ipc, "sessionViewStateGet").mockImplementation(async (path: string) => {
      reads += 1;
      if (reads === 1 || reads === 3) {
        const key = reads === 1 ? "C" : "D";
        act(() => {
          view.dispatch({ changes: { from: view.state.doc.length, insert: key } });
        });
      }
      return viewStateOriginal(path);
    });

    const before = captured.current;
    platform.emitMenuAction("file.open");
    await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));

    await waitFor(() => expect(captured.current).not.toBe(before), { timeout: 5_000 });
    expect(captured.current?.readText()).toBe("# Note\n\nABCD");
    expect(ipc.getFile("/docs/note.md")?.text).toBe("# Note\n\nABCD");
  });

  it("maps a failed reload to its own error message", async () => {
    const ipc = fileIpc("# Note\n");
    const captured: { current: EditorSession | null } = { current: null };
    const { platform } = renderApp(ipc, {
      onSession: (value) => {
        captured.current = value;
      },
    });

    platform.emitMenuAction("file.open");
    expect(await screen.findByTestId("document-session")).toBeInTheDocument();
    await waitFor(() => expect(captured.current?.isUntitled).toBe(false));
    const view = captured.current?.attachedView;
    if (!view) {
      throw new Error("named editor view is not attached");
    }
    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: "\nA" } });
    });

    ipc.setCommandDelay(COMMANDS.documentOpen, 150);
    const original = ipc.documentOpen.bind(ipc);
    const openSpy = vi.spyOn(ipc, "documentOpen").mockImplementation(async () => {
      act(() => {
        view.dispatch({ changes: { from: view.state.doc.length, insert: "B" } });
      });
      ipc.failNext(COMMANDS.documentReload, "NOT_FOUND", "file vanished");
      return original();
    });
    const before = captured.current;
    platform.emitMenuAction("file.open");
    await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));

    // The toast names the actual failure, not a generic IO message, and the
    // current session stays in place with its late text on disk.
    expect(await screen.findByText("文件不存在或已被移动。")).toBeInTheDocument();
    expect(screen.queryByText("读写文件时发生错误。")).not.toBeInTheDocument();
    expect(captured.current).toBe(before);
    expect(ipc.getFile("/docs/note.md")?.text.endsWith("AB")).toBe(true);
  });

  it("abandons the adoption instead of dropping input when typing never settles", async () => {
    const ipc = fileIpc("# Note\n");
    const captured: { current: EditorSession | null } = { current: null };
    const { platform } = renderApp(ipc, {
      onSession: (value) => {
        captured.current = value;
      },
    });

    platform.emitMenuAction("file.open");
    expect(await screen.findByTestId("document-session")).toBeInTheDocument();
    await waitFor(() => expect(captured.current?.isUntitled).toBe(false));
    const view = captured.current?.attachedView;
    if (!view) {
      throw new Error("named editor view is not attached");
    }
    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: "\nA" } });
    });

    ipc.setCommandDelay(COMMANDS.documentOpen, 150);
    ipc.setCommandDelay(COMMANDS.sessionViewStateGet, 100);
    const original = ipc.documentOpen.bind(ipc);
    const openSpy = vi.spyOn(ipc, "documentOpen").mockImplementation(async () => {
      act(() => {
        view.dispatch({ changes: { from: view.state.doc.length, insert: "B" } });
      });
      return original();
    });
    // Keep typing through both tail passes: C during the payload build, D
    // during the first rebuild, E inside the second (final) rebuild.
    let reads = 0;
    const viewStateOriginal = ipc.sessionViewStateGet.bind(ipc);
    vi.spyOn(ipc, "sessionViewStateGet").mockImplementation(async (path: string) => {
      reads += 1;
      if (reads === 1 || reads === 3 || reads === 4) {
        const key = reads === 1 ? "C" : reads === 3 ? "D" : "E";
        act(() => {
          view.dispatch({ changes: { from: view.state.doc.length, insert: key } });
        });
      }
      return viewStateOriginal(path);
    });

    const before = captured.current;
    platform.emitMenuAction("file.open");
    await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));

    // The bounded passes were out-typed: keep the session and its newest
    // keystrokes instead of adopting and silently dropping them.
    await waitFor(() =>
      expect(screen.getByText("上一个操作尚未完成，请稍后再试。")).toBeInTheDocument(),
    );
    expect(captured.current).toBe(before);
    expect(captured.current?.readText()).toBe("# Note\n\nABCDE");
    expect(ipc.getFile("/docs/note.md")?.text.endsWith("ABCD")).toBe(true);

    platform.emitMenuAction("file.save");
    await waitFor(() => expect(ipc.getFile("/docs/note.md")?.text.endsWith("ABCDE")).toBe(true));
  });

  it("keeps a dirty untitled document when the draft write fails", async () => {
    const ipc = fileIpc();
    const captured: { current: EditorSession | null } = { current: null };
    const { platform } = renderApp(ipc, {
      onSession: (value) => {
        captured.current = value;
      },
    });

    await waitFor(() => expect(captured.current?.attachedView).not.toBeNull());
    const view = captured.current?.attachedView;
    if (!view) {
      throw new Error("untitled editor view is not attached");
    }
    act(() => {
      view.dispatch({ changes: { from: 0, insert: "# draft" } });
    });
    ipc.failNext(COMMANDS.sessionDraftWrite, "IO", "draft storage unavailable");

    platform.emitMenuAction("file.new");

    expect(await screen.findByText("读写文件时发生错误。")).toBeInTheDocument();
    expect(captured.current?.isUntitled).toBe(true);
    expect(captured.current?.readText()).toContain("# draft");
  });

  it("does not run Save As from a dirty untitled document", async () => {
    const ipc = fileIpc();
    vi.spyOn(ipc, "documentNew").mockResolvedValue("window");
    const saveAsSpy = vi.spyOn(ipc, "documentSaveAs");
    const captured: { current: EditorSession | null } = { current: null };
    const { platform } = renderApp(ipc, {
      onSession: (value) => {
        captured.current = value;
      },
    });

    await waitFor(() => expect(captured.current?.attachedView).not.toBeNull());
    const view = captured.current?.attachedView;
    if (!view) {
      throw new Error("untitled editor view is not attached");
    }
    act(() => {
      view.dispatch({ changes: { from: 0, insert: "# draft" } });
    });
    await waitFor(() => expect(captured.current?.getSnapshot().dirty).toBe(true));

    platform.emitMenuAction("file.new");
    await waitFor(() => expect(ipc.documentNew).toHaveBeenCalledTimes(1));

    expect(saveAsSpy).not.toHaveBeenCalled();
    expect(captured.current?.getSnapshot().dirty).toBe(true);
    expect(screen.getByTestId("untitled-editor")).toBeInTheDocument();
  });

  it("shows an IO toast when New cannot create a window", async () => {
    const ipc = fileIpc();
    const newSpy = vi.spyOn(ipc, "documentNew");
    ipc.failNext(COMMANDS.documentNew, "IO", "window backend failed");
    const { platform } = renderApp(ipc);

    platform.emitMenuAction("file.new");

    expect(await screen.findByText("读写文件时发生错误。")).toBeInTheDocument();
    expect(screen.getByTestId("untitled-editor")).toBeInTheDocument();
    expect(screen.queryByTestId("document-session")).not.toBeInTheDocument();
    expect(newSpy).toHaveBeenCalledTimes(1);
  });

  it("runs file.new from Mod+N and filters key repeats", async () => {
    const ipc = fileIpc();
    const newSpy = vi.spyOn(ipc, "documentNew").mockResolvedValue("window");
    renderApp(ipc);

    fireEvent.keyDown(window, { key: "n", ctrlKey: true });
    await waitFor(() => expect(newSpy).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(window, { key: "n", ctrlKey: true, repeat: true });
    await waitFor(() => expect(newSpy).toHaveBeenCalledTimes(1));
  });

  it("registers file.open exactly once while the blank editor is mounted", () => {
    const { unmount } = render(
      <AppErrorBoundary>
        <ToastProvider>
          <AppServicesProvider
            services={{
              ipc: fileIpc(),
              platform: new FakePlatform(),
              updates: new FakeUpdatePort(),
              logs: new FakeLogPort(),
            }}
          >
            <DocumentSessionProvider>
              <UpdateProvider autoCheck={false}>
                <RouterProvider router={createMemoryRouter(routes, { initialEntries: ["/"] })} />
              </UpdateProvider>
            </DocumentSessionProvider>
          </AppServicesProvider>
        </ToastProvider>
      </AppErrorBoundary>,
    );

    expect(commandRegistry.list().filter((item) => item.id === "file.open")).toHaveLength(1);
    unmount();
    expect(commandRegistry.list().filter((item) => item.id === "file.open")).toHaveLength(0);
  });
});
