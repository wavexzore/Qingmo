import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FilePayload, HistoryEntry, HistoryRecord } from "@qingmo/shared";
import { describe, expect, it, vi } from "vitest";

import { HistoryDialog } from "./HistoryDialog";

const entry: HistoryEntry = {
  id: "1762401600000-1a2b3c4d",
  hash: "a".repeat(64),
  sizeBytes: 4,
  createdAtMs: 1762401600000,
  appVersion: "0.1.4",
};

const record: HistoryRecord = {
  id: entry.id,
  text: "old\n",
  format: { encoding: "utf8", hasBom: false, eol: "lf" },
  hash: entry.hash,
  createdAtMs: entry.createdAtMs,
};

const payload: FilePayload = {
  docToken: "token",
  path: "/docs/note.md",
  text: "old\n",
  format: record.format,
  mixedEol: false,
  hash: entry.hash,
  size: 4,
  textUnits: 4,
  mtimeMs: 1,
  readOnly: false,
  readOnlyReason: null,
};

describe("HistoryDialog", () => {
  it("lists versions, previews one and restores it", async () => {
    const ipc = {
      documentHistoryList: vi.fn(async () => [entry]),
      documentHistoryRead: vi.fn(async () => record),
      documentHistoryRestore: vi.fn(async () => payload),
    };
    const onRestore = vi.fn();
    const onClose = vi.fn();
    render(
      <HistoryDialog open docToken="token" ipc={ipc} onClose={onClose} onRestore={onRestore} />,
    );

    const dateText = new Date(entry.createdAtMs).toLocaleString();
    expect(await screen.findByText(dateText)).toBeVisible();
    fireEvent.click(screen.getByText(dateText).closest("button")!);

    expect(await screen.findByText("old")).toBeVisible();
    const restore = screen.getByRole("button", { name: "恢复此版本" });
    expect(restore).toBeEnabled();
    fireEvent.click(restore);

    await waitFor(() => {
      expect(ipc.documentHistoryRestore).toHaveBeenCalledWith("token", entry.id);
      expect(onRestore).toHaveBeenCalledWith(payload);
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("stays closed and does not query while closed", () => {
    const ipc = {
      documentHistoryList: vi.fn(async () => []),
      documentHistoryRead: vi.fn(),
      documentHistoryRestore: vi.fn(),
    };
    render(
      <HistoryDialog
        open={false}
        docToken="token"
        ipc={ipc}
        onClose={vi.fn()}
        onRestore={vi.fn()}
      />,
    );
    expect(ipc.documentHistoryList).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows a read failure as an alert", async () => {
    const ipc = {
      documentHistoryList: vi.fn(async () => [entry]),
      documentHistoryRead: vi.fn(async () => {
        throw new Error("history unavailable");
      }),
      documentHistoryRestore: vi.fn(),
    };
    render(<HistoryDialog open docToken="token" ipc={ipc} onClose={vi.fn()} onRestore={vi.fn()} />);
    const dateText = new Date(entry.createdAtMs).toLocaleString();
    fireEvent.click((await screen.findByText(dateText)).closest("button")!);
    expect(await screen.findByRole("alert")).toHaveTextContent("history unavailable");
  });
});
