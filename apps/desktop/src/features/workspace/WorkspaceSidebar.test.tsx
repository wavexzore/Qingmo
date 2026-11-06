import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { FlatRow } from "./workspaceTree";
import type { WorkspaceNavigation } from "./useWorkspaceNavigation";
import { WorkspaceSidebar } from "./WorkspaceSidebar";

function row(
  segments: string[],
  kind: FlatRow["kind"] = "file",
  extra: Partial<FlatRow> = {},
): FlatRow {
  return {
    key: segments.join("/"),
    segments,
    name: segments[segments.length - 1] ?? "",
    kind,
    depth: segments.length - 1,
    expandable: kind === "directory",
    openable: kind === "file",
    expanded: false,
    posInSet: 1,
    setSize: 1,
    loadState: "loaded",
    stale: false,
    errorCode: null,
    truncated: false,
    truncationReason: null,
    ...extra,
  };
}

function navigation(overrides: Partial<WorkspaceNavigation> = {}): WorkspaceNavigation {
  return {
    workspace: { token: "workspace-1", root: "/docs", name: "docs" },
    rows: [],
    expanded: {},
    rootLoading: false,
    rootError: null,
    rootTruncated: false,
    rootTruncationReason: null,
    focusedKey: null,
    selectedKey: null,
    currentKey: null,
    openWorkspace: vi.fn().mockResolvedValue(null),
    ensureLoaded: vi.fn().mockResolvedValue(undefined),
    toggle: vi.fn(),
    retry: vi.fn(),
    refresh: vi.fn().mockResolvedValue(undefined),
    collapseAll: vi.fn(),
    flushStale: vi.fn(),
    setFocusedKey: vi.fn(),
    setSelectedKey: vi.fn(),
    ...overrides,
  };
}

describe("WorkspaceSidebar", () => {
  it("shows the workspace name, root and the empty state", () => {
    render(
      <WorkspaceSidebar navigation={navigation()} active focusRequest={0} onOpenFile={vi.fn()} />,
    );

    expect(screen.getByRole("heading", { name: "docs" })).toBeInTheDocument();
    expect(screen.getByText("/docs")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("空文件夹");
  });

  it("shows the loading state without an empty flash", () => {
    render(
      <WorkspaceSidebar
        navigation={navigation({ rootLoading: true })}
        active
        focusRequest={0}
        onOpenFile={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("正在读取工作区…");
  });

  it("shows a localized root error and retries the root", () => {
    const retry = vi.fn();
    render(
      <WorkspaceSidebar
        navigation={navigation({ rootError: "PERMISSION_DENIED", retry })}
        active
        focusRequest={0}
        onOpenFile={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("没有访问这个位置的权限。");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(retry).toHaveBeenCalledWith([]);
  });

  it("renders the tree and forwards refresh, collapse and open actions", () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const collapseAll = vi.fn();
    const onOpenFile = vi.fn();
    const rows = [row(["docs"], "directory"), row(["readme.md"])];
    render(
      <WorkspaceSidebar
        navigation={navigation({ rows, refresh, collapseAll })}
        active
        focusRequest={0}
        onOpenFile={onOpenFile}
      />,
    );

    expect(screen.getByTestId("workspace-tree")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "刷新工作区" }));
    expect(refresh).toHaveBeenCalledWith({ manual: true });
    fireEvent.click(screen.getByRole("button", { name: "折叠全部目录" }));
    expect(collapseAll).toHaveBeenCalledTimes(1);

    fireEvent.click(document.querySelector('[data-workspace-key="readme.md"]') as HTMLElement);
    expect(onOpenFile).toHaveBeenCalledWith(["readme.md"]);
  });

  it("disables refresh while the root is loading", () => {
    render(
      <WorkspaceSidebar
        navigation={navigation({ rootLoading: true })}
        active
        focusRequest={0}
        onOpenFile={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "刷新工作区" })).toBeDisabled();
  });

  it("reports truncation in the footer", () => {
    const { rerender } = render(
      <WorkspaceSidebar
        navigation={navigation({
          rows: [row(["readme.md"])],
          rootTruncated: true,
          rootTruncationReason: "listed",
        })}
        active
        focusRequest={0}
        onOpenFile={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("仅显示前 10,000 项");

    rerender(
      <WorkspaceSidebar
        navigation={navigation({
          rows: [row(["readme.md"])],
          rootTruncated: true,
          rootTruncationReason: "scanned",
        })}
        active
        focusRequest={0}
        onOpenFile={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("目录项过多");
  });

  it("focuses the current row when the dock forwards a focus request", () => {
    render(
      <WorkspaceSidebar
        navigation={navigation({
          rows: [row(["docs"], "directory"), row(["docs", "note.md"])],
          currentKey: "docs/note.md",
        })}
        active
        focusRequest={1}
        onOpenFile={vi.fn()}
      />,
    );
    expect(document.activeElement).toBe(
      document.querySelector('[data-workspace-key="docs/note.md"]'),
    );
  });

  it("falls back to the first row when there is no current document", () => {
    render(
      <WorkspaceSidebar
        navigation={navigation({ rows: [row(["readme.md"])] })}
        active
        focusRequest={1}
        onOpenFile={vi.fn()}
      />,
    );
    expect(document.activeElement).toBe(document.querySelector('[data-workspace-key="readme.md"]'));
  });

  it("does not steal focus while inactive", () => {
    render(
      <WorkspaceSidebar
        navigation={navigation({ rows: [row(["readme.md"])] })}
        active={false}
        focusRequest={1}
        onOpenFile={vi.fn()}
      />,
    );
    expect(document.activeElement).toBe(document.body);
  });
});
