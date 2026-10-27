import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
import { FakeUpdatePort } from "../../lib/update/fake";
import { THEME_STORAGE_KEY, uiStore } from "../../stores/uiStore";
import { commandRegistry } from "../commands/CommandRegistry";
import { DocumentSessionProvider } from "../editor/DocumentSessionContext";
import { UpdateProvider } from "../update/UpdateProvider";
import { openFile } from "./openFile";

function renderApp(ipc: IpcPort) {
  const router = createMemoryRouter(routes, { initialEntries: ["/"] });
  render(
    <AppErrorBoundary>
      <ToastProvider>
        <AppServicesProvider
          services={{ ipc, platform: new FakePlatform(), updates: new FakeUpdatePort() }}
        >
          <DocumentSessionProvider>
            <UpdateProvider autoCheck={false}>
              <RouterProvider router={router} />
            </UpdateProvider>
          </DocumentSessionProvider>
        </AppServicesProvider>
      </ToastProvider>
    </AppErrorBoundary>,
  );
  return router;
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
      expect(result.value.path).toBe("/docs/note.md");
      expect(result.value.text).toBe("# Hi\n");
      expect(result.value.docToken).toBeTruthy();
    }
    expect(spy).toHaveBeenCalledWith();
    expect(spy).toHaveBeenCalledTimes(1);
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
      documentReload: vi.fn(),
      documentSaveAs: vi.fn(),
      documentWriteAtomic: vi.fn(),
      appCloseConfirm: vi.fn(),
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
    const router = renderApp(ipc);

    fireEvent.click(screen.getByRole("button", { name: "打开 Markdown 文件" }));

    expect(await screen.findByRole("heading", { name: "note.md" })).toBeInTheDocument();
    expect(screen.getByTestId("document-session")).toHaveTextContent("/docs/note.md");
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

  it("opens the registry-backed palette with Mod+K and runs a command from the keyboard", async () => {
    const ipc = fileIpc("# Palette\n");
    renderApp(ipc);

    fireEvent.click(screen.getByRole("button", { name: "打开 Markdown 文件" }));
    expect(await screen.findByRole("heading", { name: "note.md" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    expect(await screen.findByRole("dialog", { name: "命令面板" })).toBeInTheDocument();
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(5);
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
    renderApp(ipc);

    fireEvent.click(screen.getByRole("button", { name: "打开 Markdown 文件" }));

    expect(await screen.findByTestId("read-only-badge")).toHaveTextContent("MDX 暂为只读");
    expect(screen.getByTestId("status-bar")).toHaveTextContent("只读");
    expect(screen.getByRole("heading", { name: "component.mdx" })).toBeInTheDocument();

    const saved = await commandRegistry.execute("file.save");
    expect(saved.ok).toBe(false);
    if (!saved.ok) {
      expect(saved.error.code).toBe("BUSY");
    }
  });

  it("shows the large-document hint and disables preview above the unit budget", async () => {
    const ipc = fileIpc(`# Big\n\n${"a".repeat(2_000_000)}`);
    renderApp(ipc);

    fireEvent.click(screen.getByRole("button", { name: "打开 Markdown 文件" }));

    expect(await screen.findByRole("heading", { name: "note.md" })).toBeInTheDocument();
    expect(screen.getByTestId("large-file-hint")).toHaveTextContent("大文档 · 预览关闭");
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
    renderApp(ipc);

    fireEvent.click(screen.getByRole("button", { name: "打开 Markdown 文件" }));

    expect(await screen.findByText("文件不存在或已被移动。")).toBeInTheDocument();
    expect(screen.getByTestId("untitled-editor")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "未命名" })).toBeInTheDocument();
    expect(screen.queryByTestId("document-session")).not.toBeInTheDocument();
  });

  it("stays silent when the native dialog is cancelled", async () => {
    const ipc = new FakeIpc({
      files: [{ path: "/docs/note.md", text: "x" }],
      openFile: null,
    });
    renderApp(ipc);
    const button = screen.getByRole("button", { name: "打开 Markdown 文件" });

    fireEvent.click(button);
    await waitFor(() => expect(button).toBeEnabled());

    expect(screen.queryByText("操作已取消。")).not.toBeInTheDocument();
    expect(screen.getByTestId("untitled-editor")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "未命名" })).toBeInTheDocument();
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
