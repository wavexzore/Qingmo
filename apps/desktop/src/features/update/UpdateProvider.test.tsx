import { render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it } from "vitest";

import type { UpdateSnapshot } from "@qingmo/shared";

import { FakeUpdatePort } from "../../lib/update/fake";
import { UpdateController } from "./UpdateController";
import { UpdateProvider, useUpdateSnapshot } from "./UpdateProvider";

function Probe() {
  const snapshot = useUpdateSnapshot();
  return <span data-testid="phase">{snapshot?.phase ?? "none"}</span>;
}

function snapshot(phase: UpdateSnapshot["phase"]): UpdateSnapshot {
  return {
    phase,
    generation: 2,
    currentVersion: "0.1.0",
    update: { version: "0.2.0", date: null, body: null },
    progress: null,
  };
}

describe("UpdateProvider", () => {
  it("starts the controller and mirrors snapshots through useSyncExternalStore", async () => {
    const updates = new FakeUpdatePort();
    const controller = new UpdateController(updates, { autoCheck: false });

    render(
      <UpdateProvider controller={controller} autoCheck={false}>
        <Probe />
      </UpdateProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("phase").textContent).toBe("idle"));
    updates.emitState(snapshot("available"));
    await waitFor(() => expect(screen.getByTestId("phase").textContent).toBe("available"));
  });

  it("survives StrictMode effect replay with one active subscription", async () => {
    const updates = new FakeUpdatePort();
    const controller = new UpdateController(updates, { autoCheck: false });

    render(
      <StrictMode>
        <UpdateProvider controller={controller} autoCheck={false}>
          <Probe />
        </UpdateProvider>
      </StrictMode>,
    );

    await waitFor(() => expect(screen.getByTestId("phase").textContent).toBe("idle"));
    updates.emitState(snapshot("available"));
    await waitFor(() => expect(screen.getByTestId("phase").textContent).toBe("available"));
  });

  it("throws when the hook is used outside the provider", () => {
    expect(() => render(<Probe />)).toThrow(/UpdateProvider/);
  });
});
