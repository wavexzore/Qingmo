import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { IpcPort } from "../../lib/ipc/port";
import { EditorSession } from "./EditorSession";
import { useLivePreviewMenu } from "./useLivePreviewMenu";

function harness() {
  const session = EditorSession.createUntitled("未命名");
  const appSetLivePreview = vi.fn(async () => undefined);
  const ipc = { appSetLivePreview } as unknown as IpcPort;
  return { session, ipc, appSetLivePreview };
}

describe("useLivePreviewMenu", () => {
  it("reports the initial mode and every toggle", async () => {
    const { session, ipc, appSetLivePreview } = harness();
    renderHook(() => useLivePreviewMenu(ipc, session));

    await waitFor(() => {
      expect(appSetLivePreview).toHaveBeenCalledWith({ livePreview: true });
    });

    act(() => {
      session.toggleLivePreview();
    });
    await waitFor(() => {
      expect(appSetLivePreview).toHaveBeenLastCalledWith({ livePreview: false });
    });

    act(() => {
      session.toggleLivePreview();
    });
    await waitFor(() => {
      expect(appSetLivePreview).toHaveBeenLastCalledWith({ livePreview: true });
    });

    session.dispose();
  });

  it("stops reporting after unmount", async () => {
    const { session, ipc, appSetLivePreview } = harness();
    const { unmount } = renderHook(() => useLivePreviewMenu(ipc, session));

    await waitFor(() => {
      expect(appSetLivePreview).toHaveBeenCalledTimes(1);
    });

    unmount();
    act(() => {
      session.toggleLivePreview();
    });
    expect(appSetLivePreview).toHaveBeenCalledTimes(1);

    session.dispose();
  });
});
