import { render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";

import { AppServicesProvider } from "../../app/AppServices";
import { routes } from "../../app/routes";
import { AppErrorBoundary } from "../../components/AppErrorBoundary";
import { ToastProvider } from "../../components/ToastHost";
import { FakeIpc } from "../../lib/ipc/fake";
import { FakePlatform } from "../../lib/platform/fake";
import { FakeLogPort } from "../../lib/log/fake";
import { FakeUpdatePort } from "../../lib/update/fake";
import { LANGUAGE_STORAGE_KEY, THEME_STORAGE_KEY, uiStore } from "../../stores/uiStore";
import { commandRegistry } from "../commands/CommandRegistry";
import { DocumentSessionProvider } from "../editor/DocumentSessionContext";
import { UpdateProvider } from "../update/UpdateProvider";

function renderApp() {
  const platform = new FakePlatform();
  const ipc = new FakeIpc({ files: [{ path: "/docs/note.md", text: "# Note\n" }] });
  const router = createMemoryRouter(routes, { initialEntries: ["/"] });
  render(
    <AppErrorBoundary>
      <ToastProvider>
        <AppServicesProvider
          services={{ ipc, platform, updates: new FakeUpdatePort(), logs: new FakeLogPort() }}
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
  return { ipc, platform, router };
}

afterEach(() => {
  commandRegistry.unregister("file.open");
  commandRegistry.unregister("file.save");
  commandRegistry.unregister("view.toggleLivePreview");
  commandRegistry.unregister("view.toggleTheme");
  uiStore.setTheme("system");
  uiStore.setLanguage("zh-CN");
});

describe("native menu actions", () => {
  it("opens the command palette from the native menu", async () => {
    const { platform } = renderApp();

    platform.emitMenuAction("palette.open");

    expect(await screen.findByRole("dialog", { name: "命令面板" })).toBeInTheDocument();
  });

  it("applies the three theme menu items", async () => {
    const { platform } = renderApp();

    platform.emitMenuAction("theme.dark");
    await waitFor(() => expect(document.documentElement.getAttribute("data-theme")).toBe("dark"));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

    platform.emitMenuAction("theme.light");
    await waitFor(() => expect(document.documentElement.getAttribute("data-theme")).toBe("light"));

    platform.emitMenuAction("theme.system");
    await waitFor(() => expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("system"));
  });

  it("applies the two language menu items", async () => {
    const { platform } = renderApp();

    platform.emitMenuAction("language.en");
    await waitFor(() => expect(uiStore.getSnapshot().language).toBe("en"));
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("en");

    platform.emitMenuAction("language.zh-CN");
    await waitFor(() => expect(uiStore.getSnapshot().language).toBe("zh-CN"));
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("zh-CN");
  });

  it("opens a document and saves it through the menu", async () => {
    const { ipc, platform } = renderApp();

    platform.emitMenuAction("file.open");
    expect(await screen.findByTestId("document-session")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("status-bar")).toHaveTextContent("note.md"));

    platform.emitMenuAction("file.save");
    await waitFor(() => expect(ipc.getFile("/docs/note.md")?.text).toBe("# Note\n"));
  });
});
