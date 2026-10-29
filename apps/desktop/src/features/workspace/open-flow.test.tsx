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
import { UpdateProvider } from "../update/UpdateProvider";
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
  commandRegistry.unregister("file.open");
  commandRegistry.unregister("file.save");
  commandRegistry.unregister("view.toggleLivePreview");
  commandRegistry.unregister("view.toggleTheme");
  uiStore.setTheme("system");
  localStorage.removeItem(THEME_STORAGE_KEY);
  document.documentElement.removeAttribute("data-theme");
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
      documentTakePending: vi.fn(),
      documentReload: vi.fn(),
      documentSaveAs: vi.fn(),
      documentWriteAtomic: vi.fn(),
      onDocumentChanged: vi.fn(() => () => undefined),
      appCloseConfirm: vi.fn(),
      appSetLivePreview: vi.fn(),
      appApplyLocale: vi.fn(),
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
    expect(
      screen.queryByText("请先处理当前文档的冲突或保存错误，再打开其他文件。"),
    ).not.toBeInTheDocument();
  });

  it("opens the registry-backed palette with Mod+K and runs a command from the keyboard", async () => {
    const ipc = fileIpc("# Palette\n");
    const { platform } = renderApp(ipc);

    platform.emitMenuAction("file.open");
    expect(await screen.findByTestId("document-session")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    expect(await screen.findByRole("dialog", { name: "命令面板" })).toBeInTheDocument();
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(6);
    expect(options.map((option) => option.textContent)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("打开文件"),
        expect.stringContaining("保存文件"),
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
