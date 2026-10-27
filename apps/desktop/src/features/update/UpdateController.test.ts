import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UpdateSnapshot } from "@qingmo/shared";

import { AppError } from "../../lib/ipc/errors";
import type { UpdatePort } from "../../lib/update/port";
import { FakeUpdatePort } from "../../lib/update/fake";
import { UpdateController } from "./UpdateController";

const update = { version: "0.2.0", date: "2026-10-27T12:00:00Z", body: "Notes" };

function snapshot(
  phase: UpdateSnapshot["phase"],
  generation: number,
  progress: UpdateSnapshot["progress"] = null,
): UpdateSnapshot {
  return {
    phase,
    generation,
    currentVersion: "0.1.0",
    update: phase === "idle" ? null : update,
    progress,
  };
}

async function flushPromises() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("UpdateController", () => {
  it("subscribes before reading status and mirrors state/progress events", async () => {
    const updates = new FakeUpdatePort();
    const controller = new UpdateController(updates, { autoCheck: false });
    controller.start();
    await flushPromises();

    expect(updates.calls.status).toBe(1);
    expect(controller.getSnapshot()?.phase).toBe("idle");

    const observed: Array<UpdateSnapshot | null> = [];
    const unsubscribe = controller.subscribe(() => observed.push(controller.getSnapshot()));

    updates.emitState(snapshot("available", 2));
    expect(controller.getSnapshot()?.phase).toBe("available");

    updates.emitState(snapshot("downloading", 3, { downloaded: 0, total: 100 }));
    updates.emitProgress({ generation: 3, downloaded: 40, total: 100 });
    expect(controller.getSnapshot()?.progress?.downloaded).toBe(40);

    updates.emitProgress({ generation: 2, downloaded: 90, total: 100 });
    expect(controller.getSnapshot()?.progress?.downloaded).toBe(40);

    updates.emitState(snapshot("checking", 1));
    expect(controller.getSnapshot()?.phase).toBe("downloading");

    expect(observed.length).toBeGreaterThan(0);
    unsubscribe();
    controller.stop();
  });

  it("runs the delayed silent check only in Idle and only when enabled", async () => {
    vi.useFakeTimers();
    const updates = new FakeUpdatePort();
    const controller = new UpdateController(updates, {
      autoCheck: true,
      autoCheckDelayMs: 8_000,
    });
    controller.start();
    await flushPromises();
    expect(updates.calls.check).toBe(0);

    await vi.advanceTimersByTimeAsync(7_999);
    expect(updates.calls.check).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(updates.calls.check).toBe(1);

    controller.stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(updates.calls.check).toBe(1);
  });

  it("flushes the document before install and fails closed on a conflict", async () => {
    const updates = new FakeUpdatePort({ update });
    const controller = new UpdateController(updates, { autoCheck: false });
    controller.start();
    await flushPromises();
    await controller.check();
    await controller.download();

    const prepare = vi.fn().mockResolvedValue({ ok: true, state: "clean" });
    const unregister = controller.registerPrepareInstall(prepare);
    await controller.install();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(updates.calls.install).toBe(1);

    updates.resetCalls();
    await updates.check();
    await updates.download();
    prepare.mockResolvedValue({
      ok: false,
      state: "conflict",
      failure: "conflict",
      error: new AppError("CONFLICT", "file changed"),
    });
    await expect(controller.install()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(updates.calls.install).toBe(0);

    unregister();
    controller.stop();
  });

  it("rejects install without a save gate and prevents double install", async () => {
    const updates = new FakeUpdatePort({ update });
    const controller = new UpdateController(updates, { autoCheck: false });
    controller.start();
    await flushPromises();
    await controller.check();
    await controller.download();

    await expect(controller.install()).rejects.toMatchObject({ code: "BUSY" });

    let release!: (value: { ok: boolean; state: "clean" }) => void;
    const pending = new Promise<{ ok: boolean; state: "clean" }>((resolve) => {
      release = resolve;
    });
    controller.registerPrepareInstall(() => pending);
    const first = controller.install();
    await expect(controller.install()).rejects.toMatchObject({ code: "BUSY" });
    release({ ok: true, state: "clean" });
    await first;
    expect(updates.calls.install).toBe(1);
    controller.stop();
  });

  it("reconciles after a command failure and keeps silent checks silent", async () => {
    const checkError = new AppError("UPDATE_CHECK_FAILED", "offline");
    const updates = new FakeUpdatePort({ checkError });
    const controller = new UpdateController(updates, { autoCheck: false });
    controller.start();
    await flushPromises();

    await expect(controller.check()).rejects.toBe(checkError);
    expect(controller.getSnapshot()?.phase).toBe("idle");

    await expect(controller.check({ silent: true })).resolves.toMatchObject({ phase: "idle" });
    controller.stop();
  });

  it("cancels a subscription that resolves after stop", async () => {
    let resolveState!: (unlisten: () => void) => void;
    const offState = vi.fn();
    const status = vi.fn().mockResolvedValue(snapshot("idle", 0));
    const port: UpdatePort = {
      status,
      check: vi.fn(),
      download: vi.fn(),
      install: vi.fn(),
      onState: () =>
        new Promise<() => void>((resolve) => {
          resolveState = resolve;
        }),
      onProgress: () => Promise.resolve(vi.fn()),
    };
    const controller = new UpdateController(port, { autoCheck: false });
    controller.start();
    controller.stop();
    resolveState(offState);
    await flushPromises();

    expect(offState).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
  });

  it("unsubscribes on stop", async () => {
    const updates = new FakeUpdatePort();
    const controller = new UpdateController(updates, { autoCheck: false });
    controller.start();
    await flushPromises();
    controller.stop();

    updates.emitState(snapshot("available", 4));
    expect(controller.getSnapshot()?.phase).toBe("idle");
  });
});
