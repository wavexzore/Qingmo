import type { UpdateProgressPayload, UpdateSnapshot } from "@qingmo/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMocks.invoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: tauriMocks.listen,
}));

import { COMMANDS, EVENTS } from "../ipc/commands";
import { AppError } from "../ipc/errors";
import { FakeUpdatePort } from "./fake";
import { createTauriUpdatePort } from "./tauri";

const update = {
  version: "0.2.0",
  date: "2026-10-27T12:00:00Z",
  body: "Notes",
};

function snapshot(phase: UpdateSnapshot["phase"]): UpdateSnapshot {
  return {
    phase,
    generation: 1,
    currentVersion: "0.1.0",
    update: null,
    progress: null,
  };
}

beforeEach(() => {
  tauriMocks.invoke.mockReset();
  tauriMocks.listen.mockReset();
});

describe("FakeUpdatePort", () => {
  it("walks check -> download -> install without network", async () => {
    const updates = new FakeUpdatePort({ update });
    const states: UpdateSnapshot[] = [];
    const progress: UpdateProgressPayload[] = [];
    const offState = await updates.onState((value) => states.push(value));
    const offProgress = await updates.onProgress((value) => progress.push(value));

    const checked = await updates.check();
    expect(checked.phase).toBe("available");
    expect(checked.update?.version).toBe("0.2.0");

    const ready = await updates.download();
    expect(ready.phase).toBe("ready");
    expect(ready.progress?.downloaded).toBe(ready.progress?.total);
    expect(progress.length).toBeGreaterThan(0);

    await updates.install();
    expect(updates.currentSnapshot.phase).toBe("installing");
    expect(updates.calls).toEqual({ status: 0, check: 1, download: 1, install: 1 });
    expect(states.map((state) => state.phase)).toEqual([
      "available",
      "downloading",
      "ready",
      "installing",
    ]);

    offState();
    offProgress();
  });

  it("returns Idle when no update exists and fails closed on errors", async () => {
    const upToDate = new FakeUpdatePort();
    expect((await upToDate.check()).phase).toBe("idle");

    const checkError = new AppError("UPDATE_CHECK_FAILED", "offline");
    const failingCheck = new FakeUpdatePort({ update, checkError });
    await expect(failingCheck.check()).rejects.toBe(checkError);

    const downloadError = new AppError("UPDATE_DOWNLOAD_FAILED", "offline");
    const failingDownload = new FakeUpdatePort({ update, downloadError });
    await failingDownload.check();
    await expect(failingDownload.download()).rejects.toBe(downloadError);
    expect(failingDownload.currentSnapshot.phase).toBe("available");
  });

  it("never invents a download without an available update", async () => {
    const updates = new FakeUpdatePort();
    await expect(updates.download()).rejects.toMatchObject({ code: "UPDATE_NOT_READY" });
  });
});

describe("Tauri update adapter", () => {
  it("maps commands and events to the contract names", async () => {
    tauriMocks.invoke.mockResolvedValue(snapshot("idle"));
    tauriMocks.listen.mockResolvedValue(vi.fn());
    const updates = createTauriUpdatePort();

    await updates.status();
    await updates.check();
    await updates.download();
    await updates.install();

    expect(tauriMocks.invoke.mock.calls).toEqual([
      [COMMANDS.appUpdateStatus, {}],
      [COMMANDS.appUpdateCheck, {}],
      [COMMANDS.appUpdateDownload, {}],
      [COMMANDS.appUpdateInstall, {}],
    ]);

    await updates.onState(vi.fn());
    await updates.onProgress(vi.fn());
    expect(tauriMocks.listen.mock.calls.map(([event]) => event)).toEqual([
      EVENTS.updateState,
      EVENTS.updateProgress,
    ]);
  });

  it("normalizes invoke rejections to AppError", async () => {
    tauriMocks.invoke.mockRejectedValue({ code: "UPDATE_NOT_READY", message: "not ready" });
    const updates = createTauriUpdatePort();
    await expect(updates.install()).rejects.toBeInstanceOf(AppError);
  });
});
