import { fireEvent, render, screen } from "@testing-library/react";
import type { SearchResponse } from "@qingmo/shared";
import { describe, expect, it, vi } from "vitest";

import { SearchPanel } from "./SearchPanel";

const response: SearchResponse = {
  results: [
    {
      path: "notes/a.md",
      title: "A note",
      snippet: "…alpha…",
      score: 1,
      mtimeMs: 2,
    },
    {
      path: "notes/b.md",
      title: "B note",
      snippet: "…alpha…",
      score: 0.5,
      mtimeMs: 1,
    },
  ],
  hasMore: false,
  indexing: false,
  truncated: false,
  tookMs: 4,
  mode: "short",
};

function mount(search = vi.fn(async () => response), onOpenFile = vi.fn()) {
  render(
    <SearchPanel
      ipc={{ workspaceSearch: search }}
      workspaceToken="workspace"
      active
      focusRequest={0}
      onOpenFile={onOpenFile}
    />,
  );
  return { search, onOpenFile };
}

describe("SearchPanel", () => {
  it("debounces the query and renders results", async () => {
    const { search } = mount();
    const input = screen.getByRole("searchbox");
    fireEvent.change(input, { target: { value: "alpha" } });

    expect(search).not.toHaveBeenCalled();
    expect(await screen.findByText("A note")).toBeVisible();
    expect(search).toHaveBeenCalledWith("workspace", "alpha", 30, 0);
    expect(screen.getByText("notes/a.md")).toBeVisible();
  });

  it("opens the selected result with arrows and Enter", async () => {
    const { onOpenFile } = mount();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "alpha" } });
    await screen.findByText("A note");

    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Enter" });
    expect(onOpenFile).toHaveBeenCalledWith(["notes", "b.md"]);
  });

  it("shows an index error and can clear it with Escape", async () => {
    const failing = vi.fn(async () => ({
      ...response,
      results: [],
      error: "搜索索引不可用",
    }));
    mount(failing);
    const input = screen.getByRole("searchbox");
    fireEvent.change(input, { target: { value: "alpha" } });

    expect(await screen.findByRole("alert")).toHaveTextContent("搜索索引不可用");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(input).toHaveValue("");
  });

  it("shows the empty state for a query without matches", async () => {
    const empty = vi.fn(async () => ({ ...response, results: [] }));
    mount(empty);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "none" } });
    expect(await screen.findByText("没有匹配的文档。")).toBeVisible();
  });
});
