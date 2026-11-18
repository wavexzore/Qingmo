import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AppServicesProvider } from "../../app/AppServices";
import { ToastProvider } from "../../components/ToastHost";
import { FakeIpc } from "../../lib/ipc/fake";
import { FakeLogPort } from "../../lib/log/fake";
import { FakePlatform } from "../../lib/platform/fake";
import { FakeUpdatePort } from "../../lib/update/fake";
import { DocumentSessionProvider, resetPendingDocumentForTests } from "./DocumentSessionContext";
import { EditorPage } from "./EditorPage";

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

describe("EditorPage", () => {
  it("keeps a clean untitled document window free of the status bar", async () => {
    window.history.replaceState({}, "", "/index.html?window=document");
    const ipc = new FakeIpc();

    renderPage(ipc);

    await waitFor(() => {
      expect(screen.getByTestId("untitled-editor")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("status-bar")).not.toBeInTheDocument();
  });
});
