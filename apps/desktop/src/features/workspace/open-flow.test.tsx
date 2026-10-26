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
import { commandRegistry } from "../commands/CommandRegistry";
import { DocumentSessionProvider } from "../editor/DocumentSessionContext";
import { openFile } from "./openFile";

function renderApp(ipc: IpcPort) {
  const router = createMemoryRouter(routes, { initialEntries: ["/"] });
  render(
    <AppErrorBoundary>
      <ToastProvider>
        <AppServicesProvider services={{ ipc, platform: new FakePlatform() }}>
          <DocumentSessionProvider>
            <RouterProvider router={router} />
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

describe("welcome -> editor open flow", () => {
  it("opens a file, creates the session, and renders the editor host", async () => {
    const ipc = fileIpc("# Hello\n\nsecret body\n");
    const router = renderApp(ipc);

    fireEvent.click(screen.getByRole("button", { name: "打开 Markdown 文件" }));

    expect(await screen.findByRole("heading", { name: "note.md" })).toBeInTheDocument();
    expect(screen.getByTestId("document-session")).toHaveTextContent("/docs/note.md");
    expect(screen.getByTestId("status-bar")).toHaveTextContent("note.md");
    // The body lives in CM6's DOM, never in the React metadata snapshot
    // (editor-session.test.ts asserts JSON.stringify(snapshot) has no text).
    expect(screen.getByTestId("editor-host")).toHaveTextContent("secret body");
    expect(router.state.location.pathname).toBe("/editor");
    expect(commandRegistry.list().filter((item) => item.id === "file.open")).toHaveLength(1);
    expect(commandRegistry.list().filter((item) => item.id === "file.save")).toHaveLength(1);

    const saved = await commandRegistry.execute("file.save");
    expect(saved.ok).toBe(true);
    expect(ipc.getFile("/docs/note.md")?.text).toBe("# Hello\n\nsecret body\n");
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

  it("shows an error toast for a rejected open and stays on the welcome page", async () => {
    const ipc = new FakeIpc({
      files: [{ path: "/docs/note.md", text: "x" }],
      openFile: "/docs/missing.md",
    });
    renderApp(ipc);

    fireEvent.click(screen.getByRole("button", { name: "打开 Markdown 文件" }));

    expect(await screen.findByText("文件不存在或已被移动。")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "青墨" })).toBeInTheDocument();
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
    expect(screen.getByRole("heading", { name: "青墨" })).toBeInTheDocument();
  });

  it("registers file.open exactly once while the welcome page is mounted", () => {
    const { unmount } = render(
      <AppErrorBoundary>
        <ToastProvider>
          <AppServicesProvider services={{ ipc: fileIpc(), platform: new FakePlatform() }}>
            <DocumentSessionProvider>
              <RouterProvider router={createMemoryRouter(routes, { initialEntries: ["/"] })} />
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
