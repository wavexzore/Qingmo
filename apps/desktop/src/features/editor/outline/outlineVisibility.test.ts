import { describe, expect, it, vi } from "vitest";

import { outlineVisibilityStore } from "./outlineVisibility";

describe("outlineVisibilityStore", () => {
  it("starts hidden, toggles, and notifies only on changes", () => {
    outlineVisibilityStore.resetForTests();
    const listener = vi.fn();
    const unsubscribe = outlineVisibilityStore.subscribe(listener);

    expect(outlineVisibilityStore.getSnapshot().open).toBe(false);
    expect(outlineVisibilityStore.toggle()).toBe(true);
    expect(outlineVisibilityStore.getSnapshot().open).toBe(true);
    expect(outlineVisibilityStore.toggle()).toBe(false);
    expect(outlineVisibilityStore.getSnapshot().open).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);

    outlineVisibilityStore.setOpen(false);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    outlineVisibilityStore.setOpen(true);
    expect(listener).toHaveBeenCalledTimes(2);
    outlineVisibilityStore.resetForTests();
  });
});
