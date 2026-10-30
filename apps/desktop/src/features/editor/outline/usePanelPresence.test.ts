import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OUTLINE_PANEL_ANIMATION_MS, usePanelPresence } from "./usePanelPresence";

function mockFrames() {
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
  return {
    flush() {
      for (const frame of frames.splice(0)) {
        frame(performance.now());
      }
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("usePanelPresence", () => {
  it("mounts collapsed and becomes visible on the next frame", () => {
    const frames = mockFrames();
    const { result, rerender } = renderHook(({ open }) => usePanelPresence(open), {
      initialProps: { open: false },
    });
    expect(result.current).toEqual({ mounted: false, visible: false });

    rerender({ open: true });
    expect(result.current).toEqual({ mounted: true, visible: false });

    act(() => frames.flush());
    expect(result.current).toEqual({ mounted: true, visible: true });
  });

  it("keeps the panel mounted through the closing transition", () => {
    vi.useFakeTimers();
    mockFrames();
    const { result, rerender } = renderHook(({ open }) => usePanelPresence(open), {
      initialProps: { open: true },
    });

    rerender({ open: false });
    expect(result.current).toEqual({ mounted: true, visible: false });

    act(() => {
      vi.advanceTimersByTime(OUTLINE_PANEL_ANIMATION_MS);
    });
    expect(result.current).toEqual({ mounted: false, visible: false });
  });

  it("reopens during the closing transition without unmounting", () => {
    vi.useFakeTimers();
    const frames = mockFrames();
    const { result, rerender } = renderHook(({ open }) => usePanelPresence(open), {
      initialProps: { open: true },
    });

    rerender({ open: false });
    expect(result.current.visible).toBe(false);

    rerender({ open: true });
    act(() => frames.flush());
    expect(result.current).toEqual({ mounted: true, visible: true });

    act(() => {
      vi.advanceTimersByTime(OUTLINE_PANEL_ANIMATION_MS * 2);
    });
    expect(result.current.mounted).toBe(true);
  });

  it("skips the transition when reduced motion is requested", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
    const { result, rerender } = renderHook(({ open }) => usePanelPresence(open), {
      initialProps: { open: false },
    });

    rerender({ open: true });
    expect(result.current).toEqual({ mounted: true, visible: true });

    rerender({ open: false });
    expect(result.current).toEqual({ mounted: false, visible: false });
  });
});
