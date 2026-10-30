import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";

import { minimapExtension, renderedLineText, type MinimapGeometry } from "./minimap";
import { KIND } from "./model";

const geometry: MinimapGeometry = {
  editorWidth: 900,
  railWidth: 76,
  railHeight: 400,
  trackTop: 6,
  trackHeight: 388,
  contentHeight: 10_000,
  documentPadding: { top: 28, bottom: 28 },
  clientHeight: 400,
  scrollHeight: 10_028,
};

function longText(lines = 120): string {
  return Array.from({ length: lines }, (_, index) => `line ${index + 1}`).join("\n");
}

function mount(
  doc: string,
  options: Parameters<typeof minimapExtension>[0] = {},
): { view: EditorView; parent: HTMLDivElement } {
  const parent = document.createElement("div");
  document.body.append(parent);
  const state = EditorState.create({
    doc,
    extensions: [minimapExtension({ geometry: () => geometry, ...options })],
  });
  const view = new EditorView({ state, parent });
  return { view, parent };
}

function contextStub() {
  return {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    drawImage: vi.fn(),
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    fillStyle: "#000000",
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

let cleanup: (() => void) | undefined;

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.restoreAllMocks();
});

describe("minimap ViewPlugin", () => {
  it("mounts one rail, draws a frame and restores the editor on destroy", async () => {
    const context = contextStub();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
      return context as unknown as CanvasRenderingContext2D;
    });
    const { view, parent } = mount(longText(), {
      minLines: 1,
      minEditorWidth: 1,
      rebuildDebounceMs: 0,
    });
    cleanup = () => {
      view.destroy();
      parent.remove();
    };

    await settle();

    const rail = parent.querySelector<HTMLDivElement>(".qm-minimap");
    const canvas = parent.querySelector<HTMLCanvasElement>(".qm-minimap-canvas");
    expect(rail).not.toBeNull();
    expect(parent.querySelectorAll(".qm-minimap")).toHaveLength(1);
    expect(rail?.getAttribute("aria-hidden")).toBe("true");
    expect(rail?.getAttribute("data-minimap-state")).toBe("on");
    expect(rail?.dataset.minimapRender).toBe("text");
    expect(Number(rail?.dataset.minimapLineHeight)).toBeGreaterThanOrEqual(2);
    expect(rail?.style.display).toBe("block");
    expect(rail?.style.visibility).toBe("visible");
    expect(view.dom.style.paddingRight).toBe("88px");
    expect(view.scrollDOM.dataset.minimapScrollbar).toBe("hidden");
    expect(canvas?.width).toBeGreaterThan(1);
    expect(canvas?.height).toBeGreaterThan(1);
    expect(context.fillRect).toHaveBeenCalled();
    expect(context.drawImage).toHaveBeenCalled();
    expect(parent.querySelector<HTMLDivElement>(".qm-minimap-slider")?.style.height).toBe("24px");

    view.destroy();
    cleanup = undefined;
    expect(parent.querySelector(".qm-minimap")).toBeNull();
    expect(view.dom.style.paddingRight).toBe("");
    expect(view.scrollDOM.dataset.minimapScrollbar).toBeUndefined();
    parent.remove();
  });

  it("keeps short documents untouched", async () => {
    const context = contextStub();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
      return context as unknown as CanvasRenderingContext2D;
    });
    const { view, parent } = mount(longText(20), { rebuildDebounceMs: 0 });
    cleanup = () => {
      view.destroy();
      parent.remove();
    };

    await settle();

    const rail = parent.querySelector<HTMLDivElement>(".qm-minimap");
    expect(rail).not.toBeNull();
    expect(rail?.getAttribute("data-minimap-state")).toBe("off");
    expect(rail?.style.display).toBe("none");
    expect(view.dom.style.paddingRight).toBe("");
    expect(view.scrollDOM.hasAttribute("data-minimap-scrollbar")).toBe(false);
    expect(context.fillRect).not.toHaveBeenCalled();
  });

  it("degrades to unsupported when a 2D context is unavailable", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const { view, parent } = mount(longText(), {
      minLines: 1,
      minEditorWidth: 1,
      rebuildDebounceMs: 0,
    });
    cleanup = () => {
      view.destroy();
      parent.remove();
    };

    await settle();

    const rail = parent.querySelector<HTMLDivElement>(".qm-minimap");
    expect(rail?.getAttribute("data-minimap-state")).toBe("unsupported");
    expect(rail?.style.display).toBe("none");
    expect(view.dom.style.paddingRight).toBe("");
    expect(view.scrollDOM.hasAttribute("data-minimap-scrollbar")).toBe(false);
  });

  it("hides oversized documents before scanning or drawing", async () => {
    const context = contextStub();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
      return context as unknown as CanvasRenderingContext2D;
    });
    const { view, parent } = mount(longText(100_001), {
      minLines: 1,
      minEditorWidth: 1,
      rebuildDebounceMs: 0,
    });
    cleanup = () => {
      view.destroy();
      parent.remove();
    };

    await settle();

    const rail = parent.querySelector<HTMLDivElement>(".qm-minimap");
    expect(rail?.getAttribute("data-minimap-state")).toBe("off");
    expect(context.fillRect).not.toHaveBeenCalled();
  });
});

describe("renderedLineText", () => {
  it("flattens Markdown markers for Live Preview", () => {
    expect(renderedLineText("# Title **bold**", KIND.heading)).toBe("Title bold");
    expect(renderedLineText("> [quote](https://example.com)", KIND.quote)).toBe("quote");
    expect(renderedLineText("- [x] task `code`", KIND.list)).toBe("task code");
    expect(renderedLineText("![alt](image.png)", KIND.text)).toBe("alt");
    expect(renderedLineText("```ts", KIND.code)).toBe("");
    expect(renderedLineText("| a | b |", KIND.table)).toBe("");
  });
});
