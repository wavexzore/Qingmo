import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FakeIpc } from "../../lib/ipc/fake";
import { FakeLogPort } from "../../lib/log/fake";
import { FakePlatform } from "../../lib/platform/fake";
import { FakeUpdatePort } from "../../lib/update/fake";
import { AppServicesProvider } from "../../app/AppServices";
import { ToastProvider } from "../../components/ToastHost";
import { LogDialog } from "./LogDialog";

function setup() {
  const logs = new FakeLogPort();
  const onClose = vi.fn();
  render(
    <ToastProvider>
      <AppServicesProvider
        services={{
          ipc: new FakeIpc(),
          platform: new FakePlatform(),
          updates: new FakeUpdatePort(),
          logs,
        }}
      >
        <LogDialog open onClose={onClose} />
      </AppServicesProvider>
    </ToastProvider>,
  );
  return { logs, onClose };
}

describe("LogDialog", () => {
  it("lists parsed entries newest first with statistics", async () => {
    const { logs } = setup();

    expect(await screen.findByText("failed to emit update state")).toBeInTheDocument();
    expect(screen.getByTestId("logs-stats")).toHaveTextContent("3 条");
    expect(screen.getByTestId("logs-stats")).toHaveTextContent("1 错误");
    expect(screen.getByTestId("logs-stats")).toHaveTextContent("1 警告");
    expect(screen.getByTestId("logs-list")).toHaveTextContent("arming close request");
    expect(logs.calls.list).toBeGreaterThan(0);
  });

  it("filters by minimum severity", async () => {
    const { logs } = setup();
    await screen.findByText("failed to emit update state");

    fireEvent.click(screen.getByTestId("logs-filter-warn"));

    await waitFor(() => expect(screen.queryByText("arming close request")).not.toBeInTheDocument());
    expect(screen.getByText("failed to emit update state")).toBeInTheDocument();
    expect(logs.calls.list).toBeGreaterThan(1);
  });

  it("exports the current filter and reports the path", async () => {
    const { logs } = setup();
    await screen.findByText("failed to emit update state");

    fireEvent.click(screen.getByTestId("logs-filter-error"));
    fireEvent.click(screen.getByTestId("logs-export"));

    expect(
      await screen.findByText(/日志已导出到 \/Users\/test\/Downloads\/qingmo-logs-error\.txt/),
    ).toBeInTheDocument();
    expect(logs.calls.export).toBe(1);
  });

  it("asks before clearing old files, then reloads the empty state", async () => {
    const { logs } = setup();
    await screen.findByText("failed to emit update state");

    fireEvent.click(screen.getByTestId("logs-clear"));
    expect(screen.getByTestId("logs-confirm")).toHaveTextContent("删除 7 天前的日志？");
    expect(logs.calls.clear).toBe(0);

    fireEvent.click(screen.getByTestId("logs-clear-confirm"));

    expect(await screen.findByText("这一页是空的")).toBeInTheDocument();
    expect(logs.calls.clear).toBe(1);
  });

  it("cancels the clear confirmation without deleting", async () => {
    const { logs } = setup();
    await screen.findByText("failed to emit update state");

    fireEvent.click(screen.getByTestId("logs-clear"));
    fireEvent.click(screen.getByTestId("logs-clear-cancel"));

    expect(screen.queryByTestId("logs-confirm")).not.toBeInTheDocument();
    expect(logs.calls.clear).toBe(0);
  });

  it("copies an entry when its row is clicked", async () => {
    setup();
    const row = (await screen.findByText("failed to emit update state")).closest("li");
    expect(row).not.toBeNull();

    fireEvent.click(row as HTMLElement);

    expect(await screen.findByText("已复制这一条")).toBeInTheDocument();
  });

  it("opens the log directory and closes on Escape", async () => {
    const { logs, onClose } = setup();
    await screen.findByText("failed to emit update state");

    fireEvent.click(screen.getByTestId("logs-open-dir"));
    await waitFor(() => expect(logs.calls.openDir).toBe(1));

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
