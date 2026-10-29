import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DraftRecord } from "@qingmo/shared";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { AppServicesProvider } from "../../../app/AppServices";
import { routes } from "../../../app/routes";
import { AppErrorBoundary } from "../../../components/AppErrorBoundary";
import { ToastProvider } from "../../../components/ToastHost";
import { FakeIpc } from "../../../lib/ipc/fake";
import { FakeLogPort } from "../../../lib/log/fake";
import { FakePlatform } from "../../../lib/platform/fake";
import { FakeUpdatePort } from "../../../lib/update/fake";
import { DocumentSessionProvider, useDocumentSession } from "../DocumentSessionContext";
import type { EditorSession } from "../EditorSession";
import { UpdateProvider } from "../../update/UpdateProvider";

function draft(overrides: Partial<DraftRecord> = {}): DraftRecord {
  return {
    schemaVersion: 1,
    id: "00000000-0000-4000-8000-0000000000aa",
    kind: "untitled",
    path: null,
    title: "恢复稿",
    text: "# Restored\n\nbody\n",
    textUnits: 18,
    sizeBytes: 18,
    anchor: 2,
    head: 2,
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_100_000,
    appVersion: "test",
    ...overrides,
  };
}

function SessionProbe({ onSession }: { onSession: (session: EditorSession | null) => void }) {
  onSession(useDocumentSession().session);
  return null;
}

function renderApp(ipc: FakeIpc, onSession?: (session: EditorSession | null) => void) {
  const router = createMemoryRouter(routes, { initialEntries: ["/"] });
  render(
    <AppErrorBoundary>
      <ToastProvider>
        <AppServicesProvider
          services={{
            ipc,
            platform: new FakePlatform(),
            updates: new FakeUpdatePort(),
            logs: new FakeLogPort(),
          }}
        >
          <DocumentSessionProvider>
            {onSession ? <SessionProbe onSession={onSession} /> : null}
            <UpdateProvider autoCheck={false}>
              <RouterProvider router={router} />
            </UpdateProvider>
          </DocumentSessionProvider>
        </AppServicesProvider>
      </ToastProvider>
    </AppErrorBoundary>,
  );
  return router;
}

describe("recovery UI", () => {
  it("lists a draft, restores it as a new untitled session, and never writes the original path", async () => {
    const record = draft({
      kind: "named",
      path: "/docs/note.md",
      anchor: 2,
      head: 2,
    });
    const ipc = new FakeIpc({ files: [{ path: "/docs/note.md", text: "original\n" }] });
    ipc.seedDraft(record);
    const latest: { current: EditorSession | null } = { current: null };

    renderApp(ipc, (next) => {
      latest.current = next;
    });

    expect(await screen.findByTestId("recovery-banner")).toHaveTextContent("1");
    fireEvent.click(screen.getByTestId("recovery-open"));
    expect(await screen.findByTestId("recovery-list")).toHaveTextContent("恢复稿");

    await act(async () => {
      fireEvent.click(screen.getByTestId(`recovery-restore-${record.id}`));
    });

    await waitFor(() => {
      expect(latest.current?.readText()).toBe(record.text);
    });
    expect(latest.current?.isUntitled).toBe(true);
    expect(latest.current?.getSnapshot()).toMatchObject({
      saveState: "dirty",
      selection: { anchor: 2, head: 2 },
    });
    expect(ipc.getFile("/docs/note.md")?.text).toBe("original\n");
    await waitFor(() => {
      expect(screen.queryByTestId("recovery-banner")).not.toBeInTheDocument();
    });
    // The restored session now owns the draft, so a crash after restore still
    // has a copy; only the banner entry disappears.
    const remaining = await ipc.sessionDraftList();
    expect(remaining.map((entry) => entry.id)).toEqual([record.id]);
  });

  it("blocks restore while the current untitled document has content", async () => {
    const record = draft();
    const ipc = new FakeIpc();
    ipc.seedDraft(record);
    const latest: { current: EditorSession | null } = { current: null };

    renderApp(ipc, (next) => {
      latest.current = next;
    });
    await waitFor(() => expect(latest.current?.attachedView).not.toBeNull());

    act(() => {
      latest.current?.attachedView?.dispatch({ changes: { from: 0, insert: "mine" } });
    });

    fireEvent.click(await screen.findByTestId("recovery-open"));
    expect(await screen.findByTestId("recovery-blocked")).toBeInTheDocument();
    expect(screen.getByTestId(`recovery-restore-${record.id}`)).toBeDisabled();
  });

  it("discards a draft and removes the banner", async () => {
    const record = draft();
    const ipc = new FakeIpc();
    ipc.seedDraft(record);
    renderApp(ipc);

    fireEvent.click(await screen.findByTestId("recovery-open"));
    await act(async () => {
      fireEvent.click(screen.getByTestId(`recovery-discard-${record.id}`));
    });

    await waitFor(() => {
      expect(screen.queryByTestId("recovery-banner")).not.toBeInTheDocument();
    });
    expect(await ipc.sessionDraftList()).toHaveLength(0);
  });
});
