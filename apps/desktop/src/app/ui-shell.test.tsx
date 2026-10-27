import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { AppErrorBoundary } from "../components/AppErrorBoundary";
import { ToastProvider } from "../components/ToastHost";
import { AppServicesProvider } from "./AppServices";
import { DocumentSessionProvider } from "../features/editor/DocumentSessionContext";
import { UpdateProvider } from "../features/update/UpdateProvider";
import { routes } from "./routes";

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <AppErrorBoundary>
      <ToastProvider>
        <AppServicesProvider>
          <UpdateProvider autoCheck={false}>
            <DocumentSessionProvider>
              <RouterProvider router={router} />
            </DocumentSessionProvider>
          </UpdateProvider>
        </AppServicesProvider>
      </ToastProvider>
    </AppErrorBoundary>,
  );
  return router;
}

describe("App Shell", () => {
  it("renders an editable untitled document at the root route", () => {
    renderAt("/");

    expect(screen.getByTestId("untitled-editor")).toBeInTheDocument();
    expect(screen.getByTestId("editor-host")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveAttribute("contenteditable", "true");
    expect(screen.getByRole("textbox")).toHaveAttribute("aria-placeholder", "开始写作…");
    expect(screen.queryByRole("heading", { name: "未命名" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "打开 Markdown 文件" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "最近文件" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("status-bar")).not.toBeInTheDocument();
  });

  it("renders the same editable untitled document at /editor", () => {
    renderAt("/editor");

    expect(screen.getByTestId("untitled-editor")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "未命名" })).not.toBeInTheDocument();
  });

  it("keeps both routes on the editor surface", async () => {
    const router = renderAt("/");

    await router.navigate("/editor");
    expect(await screen.findByTestId("untitled-editor")).toBeInTheDocument();

    await router.navigate("/");
    expect(await screen.findByTestId("untitled-editor")).toBeInTheDocument();
  });
});
