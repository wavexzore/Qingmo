import { beforeEach, describe, expect, it, vi } from "vitest";

import { sidebarDockStore } from "./sidebarDockStore";

beforeEach(() => {
  sidebarDockStore.resetForTests();
});

describe("sidebarDockStore", () => {
  it("starts hidden and remembers that the window opened it", () => {
    expect(sidebarDockStore.getSnapshot()).toMatchObject({ open: false, everOpened: false });
    const listener = vi.fn();
    const unsubscribe = sidebarDockStore.subscribe(listener);

    sidebarDockStore.show("outline");
    expect(sidebarDockStore.getSnapshot()).toMatchObject({
      open: true,
      view: "outline",
      everOpened: true,
    });

    sidebarDockStore.setOpen(false);
    expect(sidebarDockStore.getSnapshot()).toMatchObject({
      open: false,
      view: "outline",
      everOpened: true,
    });
    unsubscribe();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("does not notify for a no-op show or close", () => {
    sidebarDockStore.show("workspace");
    const listener = vi.fn();
    const unsubscribe = sidebarDockStore.subscribe(listener);

    sidebarDockStore.show("workspace");
    sidebarDockStore.setOpen(true);
    expect(listener).not.toHaveBeenCalled();

    sidebarDockStore.setOpen(false);
    sidebarDockStore.setOpen(false);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("implements the toggleView fallback rules", () => {
    sidebarDockStore.toggleView("outline", null);
    expect(sidebarDockStore.getSnapshot()).toMatchObject({ open: true, view: "outline" });

    sidebarDockStore.toggleView("outline", "workspace");
    expect(sidebarDockStore.getSnapshot()).toMatchObject({ open: true, view: "workspace" });

    sidebarDockStore.toggleView("workspace", null);
    expect(sidebarDockStore.getSnapshot().open).toBe(false);

    sidebarDockStore.toggleView("outline", "workspace");
    expect(sidebarDockStore.getSnapshot()).toMatchObject({ open: true, view: "outline" });
  });

  it("reopens the last view, or the fallback when it is unavailable", () => {
    sidebarDockStore.show("outline");
    sidebarDockStore.setOpen(false);

    sidebarDockStore.openLast("workspace");
    expect(sidebarDockStore.getSnapshot()).toMatchObject({
      open: true,
      view: "workspace",
      everOpened: true,
    });
  });

  it("resetForTests clears visibility and the ever-opened mark", () => {
    sidebarDockStore.show("workspace");
    sidebarDockStore.resetForTests();
    expect(sidebarDockStore.getSnapshot()).toMatchObject({
      open: false,
      view: "workspace",
      everOpened: false,
    });
  });
});
