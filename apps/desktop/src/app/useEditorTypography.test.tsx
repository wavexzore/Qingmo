import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EditorSession } from "../features/editor/EditorSession";
import { EDITOR_TYPOGRAPHY_STORAGE_KEY, uiStore } from "../stores/uiStore";
import { useEditorTypography } from "./useEditorTypography";

afterEach(() => {
  window.localStorage.removeItem(EDITOR_TYPOGRAPHY_STORAGE_KEY);
  act(() => {
    uiStore.syncFromStorage(null);
  });
});

function fakeSession() {
  return { applyTypography: vi.fn() } as unknown as EditorSession;
}

describe("useEditorTypography", () => {
  it("does nothing without a session", () => {
    expect(() => renderHook(() => useEditorTypography(null))).not.toThrow();
  });

  it("seeds the current snapshot value on mount", () => {
    act(() => {
      uiStore.setTypography({ fontSize: 21, fontFamily: "serif" });
    });
    const session = fakeSession();

    renderHook(() => useEditorTypography(session));

    expect(session.applyTypography).toHaveBeenCalledTimes(1);
    expect(session.applyTypography).toHaveBeenCalledWith({ fontSize: 21, fontFamily: "serif" });
  });

  it("forwards store changes and ignores equal values", () => {
    const session = fakeSession();
    renderHook(() => useEditorTypography(session));

    act(() => {
      uiStore.setTypography({ fontSize: 24, fontFamily: "sans" });
    });
    expect(session.applyTypography).toHaveBeenLastCalledWith({
      fontSize: 24,
      fontFamily: "sans",
    });

    act(() => {
      uiStore.setTypography({ fontSize: 24, fontFamily: "sans" });
    });
    expect(session.applyTypography).toHaveBeenCalledTimes(2);
  });

  it("re-applies to a replacement session", () => {
    const first = fakeSession();
    const second = fakeSession();
    const { rerender } = renderHook(({ session }) => useEditorTypography(session), {
      initialProps: { session: first },
    });

    rerender({ session: second });

    expect(second.applyTypography).toHaveBeenCalledTimes(1);
    expect(first.applyTypography).toHaveBeenCalledTimes(1);
  });
});
