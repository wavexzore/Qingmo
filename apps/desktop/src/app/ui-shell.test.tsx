import { fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { AppErrorBoundary } from "../components/AppErrorBoundary";
import { ToastProvider } from "../components/ToastHost";
import { routes } from "./routes";

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <AppErrorBoundary>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </AppErrorBoundary>,
  );
  return router;
}

describe("App Shell", () => {
  it("renders the welcome page and its primary action", () => {
    renderAt("/");

    expect(screen.getByRole("heading", { name: "青墨" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开 Markdown 文件" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "最近文件" })).toBeInTheDocument();
  });

  it("shows the editor empty state and static status bar", () => {
    renderAt("/editor");

    expect(screen.getByRole("heading", { name: "还没有打开的文档" })).toBeInTheDocument();
    expect(screen.getByTestId("status-bar")).toHaveTextContent("未打开文档");
    expect(screen.getByRole("link", { name: "返回欢迎页" })).toBeInTheDocument();
  });

  it("navigates between the welcome and editor routes", async () => {
    const router = renderAt("/");
    await router.navigate("/editor");

    expect(await screen.findByRole("heading", { name: "还没有打开的文档" })).toBeInTheDocument();
    await router.navigate("/");
    expect(await screen.findByRole("heading", { name: "最近文件" })).toBeInTheDocument();
  });

  it("shows a toast for the not-yet-wired open action", () => {
    renderAt("/");
    fireEvent.click(screen.getByRole("button", { name: "打开 Markdown 文件" }));

    expect(screen.getByText("文件打开将在 T-008 接入。")).toBeInTheDocument();
  });
});
