import { act, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MeetingProgress, MeetingResult } from "@qingmo/shared";

import { AppServicesProvider } from "../../app/AppServices";
import { ToastProvider } from "../../components/ToastHost";
import { FakeIpc } from "../../lib/ipc/fake";
import { FakeLogPort } from "../../lib/log/fake";
import { FakePlatform } from "../../lib/platform/fake";
import { FakeUpdatePort } from "../../lib/update/fake";
import {
  DocumentSessionProvider,
  resetPendingDocumentForTests,
  useDocumentSession,
} from "../editor/DocumentSessionContext";
import { MeetingBoot } from "./MeetingBoot";
import { resetMeetingResultForTests } from "./meetingResult";
import { useMeetingProgress } from "./useMeetingProgress";

const REQUEST_ID = "11111111-2222-4333-8444-555555555555";

function result(overrides: Partial<MeetingResult> = {}): MeetingResult {
  return {
    markdown: "# 纪要\n\n- 决定\n",
    audioUrl: "asset://voice.wav",
    title: "访谈",
    durationMs: 65_000,
    stats: { decisions: 1, actions: 0, risks: 0, unverified: 0, failedSegments: 0 },
    partial: false,
    ...overrides,
  };
}

function progress(overrides: Partial<MeetingProgress> = {}): MeetingProgress {
  return {
    requestId: REQUEST_ID,
    attempt: 1,
    stage: "transcribing",
    audioUrl: "asset://voice.wav",
    elapsedMs: 1200,
    sourceName: "访谈.m4a",
    durationMs: 65_000,
    bytes: 4096,
    actualBackend: { kind: "local" },
    localModel: "paraformer-zh-en-int8",
    llmMode: "local",
    llmModel: "",
    accel: "cpu",
    failedSegments: 0,
    degraded: {
      llmModelMissing: false,
      llmUnconfigured: false,
      llmBudgetExceeded: false,
      llmFailed: false,
      partialDecode: false,
      remoteFallback: false,
      remoteKeyMissing: false,
      speakerDegraded: false,
      speakerPartial: false,
      highMemoryModel: false,
      slowMachine: false,
    },
    ...overrides,
  };
}

function Boot({ requestId }: { requestId: string }) {
  const meeting = useMeetingProgress(requestId);
  return <MeetingBoot meeting={meeting} />;
}

function Harness({
  onSession,
}: {
  onSession: (session: ReturnType<typeof useDocumentSession>) => void;
}) {
  const value = useDocumentSession();
  useEffect(() => {
    onSession(value);
  }, [onSession, value]);
  return value.session ? <Boot requestId={REQUEST_ID} /> : null;
}

function renderBoot(ipc: FakeIpc) {
  const captured: { session: ReturnType<typeof useDocumentSession>["session"] } = { session: null };
  const view = render(
    <StrictMode>
      <AppServicesProvider
        services={{
          ipc,
          platform: new FakePlatform(),
          updates: new FakeUpdatePort(),
          logs: new FakeLogPort(),
        }}
      >
        <ToastProvider>
          <DocumentSessionProvider>
            <Harness
              onSession={(value) => {
                captured.session = value.session;
              }}
            />
          </DocumentSessionProvider>
        </ToastProvider>
      </AppServicesProvider>
    </StrictMode>,
  );
  return { ...view, captured };
}

beforeEach(() => {
  window.history.replaceState(
    {},
    "",
    `/index.html?window=document&meeting=${REQUEST_ID}&name=%E8%AE%BF%E8%B0%88`,
  );
});

afterEach(() => {
  resetPendingDocumentForTests();
  resetMeetingResultForTests();
  window.history.replaceState({}, "", "/");
});

describe("MeetingBoot", () => {
  it("subscribes before status, takes a Ready result once and inserts it", async () => {
    const ipc = new FakeIpc();
    let subscribed = false;
    const onProgress = ipc.onMeetingProgress.bind(ipc);
    vi.spyOn(ipc, "onMeetingProgress").mockImplementation((callback) => {
      subscribed = true;
      return onProgress(callback);
    });
    vi.spyOn(ipc, "meetingStatus").mockImplementation(async () => {
      expect(subscribed).toBe(true);
      return { ready: result() };
    });
    const take = vi.spyOn(ipc, "meetingTakeResult").mockResolvedValue(result());

    const { captured } = renderBoot(ipc);
    await waitFor(() => {
      expect(captured.session?.readText()).toContain("- 决定");
    });
    expect(take).toHaveBeenCalledTimes(1);
    expect(captured.session?.getSnapshot().saveState).toBe("dirty");
    await waitFor(() => {
      expect(screen.queryByTestId("meeting-boot")).toBeNull();
    });
  });

  it("keeps polling progress events until a terminal state", async () => {
    const ipc = new FakeIpc();
    let resolveStatus: ((value: "gone") => void) | undefined;
    vi.spyOn(ipc, "meetingStatus").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve;
        }),
    );

    renderBoot(ipc);
    await waitFor(() => {
      expect(screen.getByTestId("meeting-preparing")).toBeTruthy();
    });
    act(() => {
      ipc.emitMeetingProgress(progress());
    });
    expect(await screen.findByTestId("meeting-source")).toHaveTextContent("访谈.m4a");

    await act(async () => {
      resolveStatus?.("gone");
    });
    expect(await screen.findByTestId("meeting-gone")).toBeTruthy();
  });

  it("shows retry only for allowlisted errors and opens settings on MODEL_NOT_READY", async () => {
    const ipc = new FakeIpc();
    vi.spyOn(ipc, "meetingStatus").mockResolvedValue({
      failed: {
        error: { code: "MODEL_NOT_READY", message: "missing", details: null },
        attempt: 1,
      },
    });
    const openSettings = vi.spyOn(ipc, "appSettingsOpen").mockResolvedValue();

    renderBoot(ipc);
    expect(await screen.findByTestId("meeting-retry")).toBeTruthy();
    expect(screen.getByTestId("meeting-open-settings")).toBeTruthy();
    await waitFor(() => {
      expect(openSettings).toHaveBeenCalledWith("ai");
    });
    expect(await screen.findByText("会议纪要需要先下载模型")).toBeTruthy();
  });

  it("shows no retry for a non-allowlisted failure", async () => {
    const ipc = new FakeIpc();
    vi.spyOn(ipc, "meetingStatus").mockResolvedValue({
      failed: {
        error: { code: "LLM_FAILED", message: "summary", details: null },
        attempt: 1,
      },
    });

    renderBoot(ipc);
    expect(await screen.findByTestId("meeting-failed")).toBeTruthy();
    expect(screen.queryByTestId("meeting-retry")).toBeNull();
  });

  it("retries only the insertion after a failed insert and keeps the result", async () => {
    const ipc = new FakeIpc();
    let resolveStatus: ((value: { ready: MeetingResult }) => void) | undefined;
    vi.spyOn(ipc, "meetingStatus").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve;
        }),
    );
    const take = vi.spyOn(ipc, "meetingTakeResult").mockResolvedValue(result());

    const { captured } = renderBoot(ipc);
    await waitFor(() => {
      expect(captured.session).not.toBeNull();
    });
    const session = captured.session!;
    const insert = vi.spyOn(session, "insertDocumentText").mockImplementationOnce(() => {
      throw new Error("view detached");
    });

    await act(async () => {
      resolveStatus?.({ ready: result() });
    });
    await waitFor(() => {
      expect(screen.getByTestId("meeting-insert-failed")).toBeTruthy();
    });
    expect(take).toHaveBeenCalledTimes(1);

    screen.getByTestId("meeting-retry-insert").click();
    await waitFor(() => {
      expect(insert).toHaveBeenCalledTimes(2);
    });
    expect(take).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("meeting-insert-failed")).toBeNull();
  });

  it("ignores progress from a stale attempt", async () => {
    const ipc = new FakeIpc();
    vi.spyOn(ipc, "meetingStatus").mockResolvedValue({
      running: progress({ attempt: 2, stage: "transcribing" }),
    });

    renderBoot(ipc);
    await waitFor(() => {
      expect(screen.getByTestId("meeting-source")).toBeTruthy();
    });
    act(() => {
      ipc.emitMeetingProgress(progress({ attempt: 1, sourceName: "old.m4a" }));
    });
    expect(screen.getByTestId("meeting-source")).toHaveTextContent("访谈.m4a");
  });
});
