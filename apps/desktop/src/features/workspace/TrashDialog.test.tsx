import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { TrashEntry } from "@qingmo/shared";
import { describe, expect, it, vi } from "vitest";

import { TrashDialog } from "./TrashDialog";

const entry: TrashEntry = {
  id: "3f2a0b1c-1111-4222-8333-444455556666",
  relativePath: "notes/gone.md",
  deletedAtMs: 1762401600000,
  sizeBytes: 12,
  state: "active",
};

describe("TrashDialog", () => {
  it("lists entries and restores the original path", async () => {
    const ipc = {
      workspaceTrashList: vi.fn(async () => [entry]),
      workspaceTrashRestore: vi.fn(async () => ({
        relativePath: entry.relativePath,
        mode: "original" as const,
      })),
      workspaceTrashPurge: vi.fn(async () => undefined),
    };
    const onChanged = vi.fn();
    render(
      <TrashDialog
        open
        workspaceToken="workspace"
        ipc={ipc}
        onClose={vi.fn()}
        onChanged={onChanged}
      />,
    );

    expect(await screen.findByText("notes/gone.md")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "恢复" }));

    await waitFor(() => {
      expect(ipc.workspaceTrashRestore).toHaveBeenCalledWith("workspace", entry.id, "original");
      expect(onChanged).toHaveBeenCalled();
    });
  });

  it("permanently deletes an entry and refreshes the list", async () => {
    const ipc = {
      workspaceTrashList: vi.fn().mockResolvedValueOnce([entry]).mockResolvedValueOnce([]),
      workspaceTrashRestore: vi.fn(),
      workspaceTrashPurge: vi.fn(async () => undefined),
    };
    render(
      <TrashDialog
        open
        workspaceToken="workspace"
        ipc={ipc}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "永久删除" }));
    await waitFor(() => {
      expect(ipc.workspaceTrashPurge).toHaveBeenCalledWith("workspace", entry.id);
      expect(ipc.workspaceTrashList).toHaveBeenCalledTimes(2);
    });
  });

  it("surfaces restore failures without hiding the entry", async () => {
    const ipc = {
      workspaceTrashList: vi.fn(async () => [entry]),
      workspaceTrashRestore: vi.fn(async () => {
        throw new Error("destination exists");
      }),
      workspaceTrashPurge: vi.fn(),
    };
    render(
      <TrashDialog
        open
        workspaceToken="workspace"
        ipc={ipc}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "恢复" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("destination exists");
    expect(screen.getByText("notes/gone.md")).toBeVisible();
  });

  it("marks orphaned entries in the list", async () => {
    const ipc = {
      workspaceTrashList: vi.fn(async () => [{ ...entry, state: "orphaned" as const }]),
      workspaceTrashRestore: vi.fn(),
      workspaceTrashPurge: vi.fn(),
    };
    render(
      <TrashDialog
        open
        workspaceToken="workspace"
        ipc={ipc}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    expect(await screen.findByText(/孤立条目/)).toBeVisible();
  });
});
