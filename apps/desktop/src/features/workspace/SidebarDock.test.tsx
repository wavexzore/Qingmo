import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";

import { SidebarDock, SidebarReopenHandle, type SidebarDockHandle } from "./SidebarDock";

interface RenderOptions {
  open?: boolean;
  view?: "workspace" | "outline";
  hasWorkspace?: boolean;
  hasOutline?: boolean;
}

function renderDock(options: RenderOptions = {}) {
  const ref = createRef<SidebarDockHandle>();
  const onSelectView = vi.fn();
  const onClose = vi.fn();
  const workspacePanel = vi.fn(
    ({ active, focusRequest }: { active: boolean; focusRequest: number }) => (
      <div
        data-testid="workspace-panel"
        data-active={active ? "true" : "false"}
        data-focus-request={focusRequest}
      />
    ),
  );
  const outlinePanel = vi.fn(
    ({ active, focusRequest }: { active: boolean; focusRequest: number }) => (
      <div
        data-testid="outline-panel-content"
        data-active={active ? "true" : "false"}
        data-focus-request={focusRequest}
      />
    ),
  );
  const renderResult = render(
    <SidebarDock
      ref={ref}
      open={options.open ?? true}
      view={options.view ?? "workspace"}
      hasWorkspace={options.hasWorkspace ?? true}
      hasOutline={options.hasOutline ?? true}
      onSelectView={onSelectView}
      onClose={onClose}
      workspacePanel={workspacePanel}
      outlinePanel={outlinePanel}
      outlineBadge={<span data-testid="outline-badge">3</span>}
    />,
  );
  return { ...renderResult, ref, onSelectView, onClose, workspacePanel, outlinePanel };
}

describe("SidebarDock", () => {
  it("renders both tabs with correct ARIA and keeps both panels mounted", () => {
    renderDock({ view: "workspace" });

    const workspaceTab = screen.getByRole("tab", { name: "工作区" });
    const outlineTab = screen.getByRole("tab", { name: /大纲/ });
    expect(workspaceTab).toHaveAttribute("aria-selected", "true");
    expect(workspaceTab).toHaveAttribute("tabindex", "0");
    expect(outlineTab).toHaveAttribute("aria-selected", "false");
    expect(outlineTab).toHaveAttribute("tabindex", "-1");
    expect(screen.getByTestId("outline-badge")).toHaveTextContent("3");

    expect(screen.getByTestId("workspace-panel")).toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("outline-panel-content")).toHaveAttribute("data-active", "false");
    expect(document.getElementById("sidebar-dock-panel-workspace")).not.toHaveAttribute("hidden");
    expect(document.getElementById("sidebar-dock-panel-outline")).toHaveAttribute("hidden");
  });

  it("switches views from tab clicks", () => {
    const { onSelectView } = renderDock({ view: "workspace" });
    fireEvent.click(screen.getByRole("tab", { name: /大纲/ }));
    expect(onSelectView).toHaveBeenCalledWith("outline");
    fireEvent.click(screen.getByRole("tab", { name: "工作区" }));
    expect(onSelectView).toHaveBeenCalledWith("workspace");
  });

  it("moves between tabs with arrow, Home and End keys", () => {
    const { onSelectView } = renderDock({ view: "workspace" });
    const tablist = screen.getByRole("tablist");

    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    expect(onSelectView).toHaveBeenLastCalledWith("outline");

    fireEvent.keyDown(tablist, { key: "End" });
    expect(onSelectView).toHaveBeenLastCalledWith("outline");

    fireEvent.keyDown(tablist, { key: "Home" });
    expect(onSelectView).toHaveBeenLastCalledWith("workspace");
  });

  it("wraps tab navigation in both directions", () => {
    const first = renderDock({ view: "outline" });
    fireEvent.keyDown(screen.getByRole("tablist"), { key: "ArrowRight" });
    expect(first.onSelectView).toHaveBeenLastCalledWith("workspace");
    first.unmount();

    const second = renderDock({ view: "workspace" });
    fireEvent.keyDown(screen.getByRole("tablist"), { key: "ArrowLeft" });
    expect(second.onSelectView).toHaveBeenLastCalledWith("outline");
  });

  it("shows a plain heading when only one panel is available", () => {
    renderDock({ hasWorkspace: true, hasOutline: false, view: "workspace" });
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "工作区" })).toBeInTheDocument();
    expect(screen.queryByTestId("outline-panel-content")).not.toBeInTheDocument();
  });

  it("closes on Escape from the workspace view and switches back from outline", () => {
    const first = renderDock({ view: "workspace" });
    fireEvent.keyDown(screen.getByTestId("sidebar-dock"), { key: "Escape" });
    expect(first.onClose).toHaveBeenCalledTimes(1);
    expect(first.onSelectView).not.toHaveBeenCalled();
    first.unmount();

    const second = renderDock({ view: "outline" });
    fireEvent.keyDown(screen.getByTestId("sidebar-dock"), { key: "Escape" });
    expect(second.onSelectView).toHaveBeenCalledWith("workspace");
    expect(second.onClose).not.toHaveBeenCalled();
  });

  it("closes on Escape from outline when no workspace exists", () => {
    const { onClose } = renderDock({ view: "outline", hasWorkspace: false });
    fireEvent.keyDown(screen.getByTestId("sidebar-dock"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("hides from the header button and reopens from the handle", () => {
    const { onClose } = renderDock();
    fireEvent.click(screen.getByRole("button", { name: "隐藏侧栏" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    const onReopen = vi.fn();
    render(<SidebarReopenHandle onClick={onReopen} />);
    fireEvent.click(screen.getByRole("button", { name: "显示侧栏" }));
    expect(onReopen).toHaveBeenCalledTimes(1);
  });

  it("focuses the active panel only while open and only on request", () => {
    const { ref, workspacePanel, rerender, outlinePanel, onSelectView, onClose } = renderDock({
      open: true,
    });
    expect(workspacePanel).toHaveBeenLastCalledWith(
      expect.objectContaining({ active: true, focusRequest: 0 }),
    );

    act(() => ref.current?.focusActivePanel());
    expect(workspacePanel).toHaveBeenLastCalledWith(
      expect.objectContaining({ active: true, focusRequest: 1 }),
    );

    rerender(
      <SidebarDock
        ref={ref}
        open={false}
        view="workspace"
        hasWorkspace
        hasOutline
        onSelectView={onSelectView}
        onClose={onClose}
        workspacePanel={workspacePanel}
        outlinePanel={outlinePanel}
      />,
    );
    act(() => ref.current?.focusActivePanel());
    expect(workspacePanel).toHaveBeenLastCalledWith(
      expect.objectContaining({ active: false, focusRequest: 0 }),
    );
  });

  it("focuses the active tab through the handle", () => {
    const { ref } = renderDock({ view: "outline" });
    act(() => ref.current?.focusTab());
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: /大纲/ }));
  });

  it("marks the dock inert and aria-hidden while closed", () => {
    renderDock({ open: false });
    const dock = screen.getByTestId("sidebar-dock");
    expect(dock).toHaveAttribute("aria-hidden", "true");
    expect(dock).toHaveAttribute("data-open", "false");
    expect(dock).toHaveAttribute("inert");
    expect(screen.getByTestId("workspace-panel")).toHaveAttribute("data-active", "false");
  });
});
