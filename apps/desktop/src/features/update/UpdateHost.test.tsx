import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { UpdateInfo, UpdateSnapshot } from "@qingmo/shared";

import { ToastProvider } from "../../components/ToastHost";
import { AppError } from "../../lib/ipc/errors";
import { FakeUpdatePort } from "../../lib/update/fake";
import { commandRegistry } from "../commands/CommandRegistry";
import { UpdateController } from "./UpdateController";
import { UpdateHost } from "./UpdateHost";
import { UpdateProvider } from "./UpdateProvider";

const update: UpdateInfo = {
  version: "0.2.0",
  date: "2026-10-27T12:00:00Z",
  body: "Fixed the update banner.\n\n- one\n- two",
};

function snapshot(
  phase: UpdateSnapshot["phase"],
  generation = 3,
  info: UpdateInfo | null = update,
): UpdateSnapshot {
  return {
    phase,
    generation,
    currentVersion: "0.1.0",
    update: info,
    progress: phase === "downloading" ? { downloaded: 40, total: 100 } : null,
  };
}

function Harness({
  blocked = false,
  initialOpen = false,
}: {
  blocked?: boolean;
  initialOpen?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  return <UpdateHost blocked={blocked} dialogOpen={open} onDialogOpenChange={setOpen} />;
}

function setup(
  options: {
    port?: FakeUpdatePort;
    blocked?: boolean;
    initialOpen?: boolean;
  } = {},
) {
  const port = options.port ?? new FakeUpdatePort({ update });
  const controller = new UpdateController(port, { autoCheck: false });
  render(
    <ToastProvider>
      <UpdateProvider controller={controller} autoCheck={false}>
        <Harness blocked={options.blocked ?? false} initialOpen={options.initialOpen ?? false} />
      </UpdateProvider>
    </ToastProvider>,
  );
  return { port, controller };
}

describe("UpdateHost", () => {
  it("checks from the palette command and opens the details dialog", async () => {
    const { port } = setup();
    expect(screen.queryByTestId("update-banner")).not.toBeInTheDocument();

    await waitFor(() =>
      expect(commandRegistry.list().some((item) => item.id === "app.checkForUpdates")).toBe(true),
    );
    await commandRegistry.execute("app.checkForUpdates");

    const banner = await screen.findByTestId("update-banner");
    expect(banner).toHaveTextContent("青墨 0.2.0 已发布");
    expect(commandRegistry.list().filter((item) => item.id === "app.checkForUpdates")).toHaveLength(
      1,
    );
    expect(await screen.findByRole("dialog", { name: "更新青墨" })).toBeInTheDocument();
    expect(screen.getByText(/Fixed the update banner\./)).toBeInTheDocument();
    expect(screen.getByText("v0.2.0")).toBeInTheDocument();
    expect(port.calls.check).toBe(1);

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByTestId("update-dialog-overlay")).not.toBeInTheDocument(),
    );
  });

  it("downloads, then flushes before installing from the banner", async () => {
    const port = new FakeUpdatePort({ update });
    const controller = new UpdateController(port, { autoCheck: false });
    const order: string[] = [];
    controller.registerPrepareInstall(async () => {
      order.push("flush");
      return { ok: true, state: "clean" };
    });
    vi.spyOn(port, "install").mockImplementation(async () => {
      order.push("install");
      port.emitState(snapshot("installing", 6));
    });

    render(
      <ToastProvider>
        <UpdateProvider controller={controller} autoCheck={false}>
          <Harness />
        </UpdateProvider>
      </ToastProvider>,
    );

    await waitFor(() => expect(controller.getSnapshot()?.phase).toBe("idle"));
    await controller.check();
    await controller.download();
    expect(await screen.findByTestId("update-banner-install")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("update-banner-install"));
    await waitFor(() => expect(order).toEqual(["flush", "install"]));
    expect(await screen.findByText("请保持青墨打开")).toBeInTheDocument();
  });

  it("blocks install when the document flush fails", async () => {
    const port = new FakeUpdatePort({ update });
    const controller = new UpdateController(port, { autoCheck: false });
    controller.registerPrepareInstall(async () => ({
      ok: false,
      state: "conflict",
      failure: "conflict",
      error: new AppError("CONFLICT", "file changed"),
    }));

    render(
      <ToastProvider>
        <UpdateProvider controller={controller} autoCheck={false}>
          <Harness initialOpen />
        </UpdateProvider>
      </ToastProvider>,
    );

    port.emitState(snapshot("ready", 5));
    fireEvent.click(await screen.findByTestId("update-install"));

    expect(await screen.findByTestId("update-error")).toHaveTextContent(
      "文件已被外部修改，请先确认版本。",
    );
    await waitFor(() => expect(port.calls.install).toBe(0));
  });

  it("hides the banner and dialog while a close guard owns the UI", async () => {
    const port = new FakeUpdatePort({ update });
    port.emitState(snapshot("available", 4));
    setup({ port, blocked: true, initialOpen: true });

    expect(screen.queryByTestId("update-banner")).not.toBeInTheDocument();
    expect(screen.queryByTestId("update-dialog-overlay")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        commandRegistry
          .list()
          .find((item) => item.id === "app.checkForUpdates")
          ?.when?.(),
      ).toBe(false),
    );
  });

  it("renders release notes as text and disables actions while installing", async () => {
    const port = new FakeUpdatePort({
      update: { ...update, body: "<script>alert(1)</script>" },
    });
    const { container } = render(
      <ToastProvider>
        <UpdateProvider
          controller={new UpdateController(port, { autoCheck: false })}
          autoCheck={false}
        >
          <Harness initialOpen />
        </UpdateProvider>
      </ToastProvider>,
    );

    port.emitState(snapshot("installing", 5, { ...update, body: "<script>alert(1)</script>" }));

    expect(await screen.findByText("<script>alert(1)</script>")).toBeInTheDocument();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByTestId("update-later")).toBeDisabled();
    expect(screen.queryByTestId("update-install")).not.toBeInTheDocument();
    expect(screen.queryByTestId("update-download")).not.toBeInTheDocument();
  });

  it("shows an up-to-date toast when a manual check finds nothing", async () => {
    setup({ port: new FakeUpdatePort() });

    await waitFor(() =>
      expect(commandRegistry.list().some((item) => item.id === "app.checkForUpdates")).toBe(true),
    );
    await commandRegistry.execute("app.checkForUpdates");

    expect(await screen.findByText("已是最新版本。")).toBeInTheDocument();
    expect(screen.queryByTestId("update-banner")).not.toBeInTheDocument();
    expect(screen.queryByTestId("update-dialog-overlay")).not.toBeInTheDocument();
  });

  it("reports a busy phase instead of queueing another check", async () => {
    const port = new FakeUpdatePort({ update });
    port.emitState(snapshot("downloading", 4));
    setup({ port });

    expect(await screen.findByRole("progressbar")).toHaveAttribute("aria-valuenow", "40");

    await waitFor(() =>
      expect(commandRegistry.list().some((item) => item.id === "app.checkForUpdates")).toBe(true),
    );
    await commandRegistry.execute("app.checkForUpdates");

    expect(await screen.findByText("更新操作正在进行，请稍后再试。")).toBeInTheDocument();
    expect(port.calls.check).toBe(0);
  });
});
