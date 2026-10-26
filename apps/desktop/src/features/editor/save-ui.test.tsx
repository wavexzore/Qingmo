import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ConflictDetails } from "@qingmo/shared";
import { describe, expect, it, vi } from "vitest";

import { EMPTY_STATUS_SNAPSHOT, StatusBar } from "../../components/StatusBar";
import { ConflictBanner } from "./ConflictBanner";

const conflict: ConflictDetails = {
  currentHash: "a".repeat(64),
  currentMtimeMs: 1_700_000_000_000,
  currentSize: 42,
};

describe("StatusBar save actions", () => {
  it("offers a retry action only for a terminal save error", () => {
    const retry = vi.fn();
    const { rerender } = render(
      <StatusBar snapshot={{ ...EMPTY_STATUS_SNAPSHOT, saveState: "clean" }} onRetry={retry} />,
    );
    expect(screen.queryByTestId("status-retry")).not.toBeInTheDocument();

    rerender(
      <StatusBar snapshot={{ ...EMPTY_STATUS_SNAPSHOT, saveState: "error" }} onRetry={retry} />,
    );
    fireEvent.click(screen.getByTestId("status-retry"));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("renders every save-state label", () => {
    const states = [
      "clean",
      "dirty",
      "scheduled",
      "saving",
      "error",
      "conflict",
      "readonly",
    ] as const;
    const labels = ["已同步", "未保存", "等待保存", "保存中", "保存失败", "有冲突", "只读"];

    states.forEach((saveState, index) => {
      const { unmount } = render(<StatusBar snapshot={{ ...EMPTY_STATUS_SNAPSHOT, saveState }} />);
      expect(screen.getByTestId("status-bar")).toHaveTextContent(labels[index] ?? "");
      unmount();
    });
  });
});

describe("ConflictBanner", () => {
  it("requires a second confirmation before reloading", () => {
    const onReload = vi.fn();
    render(
      <ConflictBanner
        conflict={conflict}
        onReload={onReload}
        onOverwrite={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.queryByText(/操作未完成/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("conflict-reload"));
    expect(onReload).not.toHaveBeenCalled();
    expect(screen.getByTestId("conflict-confirm")).toHaveTextContent("确认重新加载？");

    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("requires a second confirmation before overwriting", async () => {
    const onOverwrite = vi.fn();
    render(
      <ConflictBanner
        conflict={conflict}
        onReload={vi.fn()}
        onOverwrite={onOverwrite}
        onDismiss={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("conflict-overwrite"));
    expect(onOverwrite).not.toHaveBeenCalled();
    expect(screen.getByTestId("conflict-confirm")).toHaveTextContent("确认覆盖？");

    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    await waitFor(() => {
      expect(onOverwrite).toHaveBeenCalledTimes(1);
    });
  });

  it("cancels confirmation without invoking the action and can be dismissed", () => {
    const onReload = vi.fn();
    const onDismiss = vi.fn();
    render(
      <ConflictBanner
        conflict={conflict}
        onReload={onReload}
        onOverwrite={vi.fn()}
        onDismiss={onDismiss}
      />,
    );

    fireEvent.click(screen.getByTestId("conflict-reload"));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onReload).not.toHaveBeenCalled();
    expect(screen.queryByTestId("conflict-confirm")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("conflict-later"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("shows the disk hash and save error code", () => {
    render(
      <ConflictBanner
        conflict={conflict}
        errorCode="IO"
        onReload={vi.fn()}
        onOverwrite={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByTestId("conflict-banner")).toHaveTextContent("aaaaaaaaaaaa");
    expect(screen.getByTestId("conflict-banner")).toHaveTextContent("42 B");
    expect(screen.getByTestId("conflict-banner")).toHaveTextContent("IO");
  });
});
