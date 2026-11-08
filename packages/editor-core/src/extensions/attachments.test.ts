import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";

import { attachments } from "./attachments";

function imageFile(name = "shot.png", type = "image/png"): File {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type });
}

function mount(onImageFiles: (files: File[]) => Promise<string[]>) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc: "",
      extensions: [attachments({ onImageFiles })],
    }),
    parent,
  });
  return {
    view,
    destroy() {
      view.destroy();
      parent.remove();
    },
  };
}

function dispatch(
  view: EditorView,
  type: "paste" | "drop",
  data: { files: File[]; items?: Array<{ kind: string; type: string; getAsFile(): File | null }> },
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, type === "paste" ? "clipboardData" : "dataTransfer", {
    value: { getData: () => "", ...data },
  });
  view.contentDOM.dispatchEvent(event);
  return event;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("attachments", () => {
  it("persists a pasted image and inserts the returned Markdown", async () => {
    const onImageFiles = vi.fn(async () => ["![shot](assets/shot.png)"]);
    const harness = mount(onImageFiles);
    try {
      const file = imageFile();
      const event = dispatch(harness.view, "paste", { files: [file] });
      expect(event.defaultPrevented).toBe(true);
      await settle();
      expect(onImageFiles).toHaveBeenCalledWith([file]);
      expect(harness.view.state.doc.toString()).toBe("![shot](assets/shot.png)");
    } finally {
      harness.destroy();
    }
  });

  it("leaves non-image paste untouched", () => {
    const onImageFiles = vi.fn(async () => []);
    const harness = mount(onImageFiles);
    try {
      const text = new File(["hello"], "note.txt", { type: "text/plain" });
      dispatch(harness.view, "paste", { files: [text] });
      expect(onImageFiles).not.toHaveBeenCalled();
      expect(harness.view.state.doc.toString()).toBe("");
    } finally {
      harness.destroy();
    }
  });

  it("falls back to clipboard items when files is empty", async () => {
    const onImageFiles = vi.fn(async () => ["![item](assets/item.png)"]);
    const harness = mount(onImageFiles);
    try {
      const file = imageFile("item.png");
      const event = dispatch(harness.view, "paste", {
        files: [],
        items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
      });
      expect(event.defaultPrevented).toBe(true);
      await settle();
      expect(onImageFiles).toHaveBeenCalledWith([file]);
      expect(harness.view.state.doc.toString()).toBe("![item](assets/item.png)");
    } finally {
      harness.destroy();
    }
  });

  it("handles dropped images and joins multiple Markdown snippets", async () => {
    const onImageFiles = vi.fn(async () => ["![a](assets/a.png)", "![b](assets/b.png)"]);
    const harness = mount(onImageFiles);
    try {
      const event = dispatch(harness.view, "drop", {
        files: [imageFile("a.png"), imageFile("b.png")],
      });
      expect(event.defaultPrevented).toBe(true);
      await settle();
      expect(harness.view.state.doc.toString()).toBe("![a](assets/a.png)\n![b](assets/b.png)");
    } finally {
      harness.destroy();
    }
  });

  it("does not modify the document when persistence fails", async () => {
    const onImageFiles = vi.fn(async () => {
      throw new Error("disk full");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const harness = mount(onImageFiles);
    try {
      dispatch(harness.view, "paste", { files: [imageFile()] });
      await settle();
      expect(harness.view.state.doc.toString()).toBe("");
    } finally {
      harness.destroy();
      warn.mockRestore();
    }
  });
});
