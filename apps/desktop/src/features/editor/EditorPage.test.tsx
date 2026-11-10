import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppServicesProvider } from "../../app/AppServices";
import { ToastProvider } from "../../components/ToastHost";
import { FakeIpc } from "../../lib/ipc/fake";
import { FakeLogPort } from "../../lib/log/fake";
import { FakePlatform } from "../../lib/platform/fake";
import { FakeUpdatePort } from "../../lib/update/fake";
import { DocumentSessionProvider, resetPendingDocumentForTests } from "./DocumentSessionContext";
import { EditorPage } from "./EditorPage";

const REQUEST_ID = "11111111-2222-4333-8444-555555555555";

function renderPage(ipc: FakeIpc) {
  return render(
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
          <EditorPage />
        </DocumentSessionProvider>
      </ToastProvider>
    </AppServicesProvider>,
  );
}

beforeEach(() => {
  resetPendingDocumentForTests();
});

afterEach(() => {
  resetPendingDocumentForTests();
  window.history.replaceState({}, "", "/");
});

describe("EditorPage meeting mode", () => {
  it("replaces the editor with MeetingBoot and keeps the status bar visible", async () => {
    window.history.replaceState(
      {},
      "",
      `/index.html?window=document&meeting=${REQUEST_ID}&name=%E8%AE%BF%E8%B0%88`,
    );
    const ipc = new FakeIpc();
    vi.spyOn(ipc, "meetingStatus").mockImplementation(
      () =>
        new Promise(() => {
          /* stays running until unmount */
        }),
    );

    renderPage(ipc);

    expect(await screen.findByTestId("meeting-boot")).toBeInTheDocument();
    expect(screen.getByTestId("status-bar")).toBeInTheDocument();
    expect(document.querySelector(".cm-editor")).toBeNull();
  });

  it("keeps a clean untitled document window free of the status bar", async () => {
    window.history.replaceState({}, "", "/index.html?window=document");
    const ipc = new FakeIpc();

    renderPage(ipc);

    await waitFor(() => {
      expect(screen.getByTestId("untitled-editor")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("status-bar")).not.toBeInTheDocument();
  });

  it("hands the view back to the editor once the result is inserted", async () => {
    window.history.replaceState({}, "", `/index.html?window=document&meeting=${REQUEST_ID}&name=x`);
    const ipc = new FakeIpc();
    vi.spyOn(ipc, "meetingStatus").mockResolvedValue({
      ready: {
        markdown: "# 纪要\n",
        audioUrl: "asset://voice.wav",
        title: "访谈",
        durationMs: 65_000,
        stats: { decisions: 0, actions: 0, risks: 0, unverified: 0, failedSegments: 0 },
        partial: true,
      },
    });
    vi.spyOn(ipc, "meetingTakeResult").mockResolvedValue({
      markdown: "# 纪要\n",
      audioUrl: "asset://voice.wav",
      title: "访谈",
      durationMs: 65_000,
      stats: { decisions: 0, actions: 0, risks: 0, unverified: 0, failedSegments: 0 },
      partial: true,
    });

    renderPage(ipc);

    await waitFor(() => {
      expect(document.querySelector(".cm-editor")).not.toBeNull();
    });
    expect(screen.queryByTestId("meeting-boot")).not.toBeInTheDocument();
    expect(screen.getByTestId("status-bar")).toBeInTheDocument();
    expect(screen.getByTestId("status-meeting-stage")).toHaveTextContent("部分完成");
  });
});
