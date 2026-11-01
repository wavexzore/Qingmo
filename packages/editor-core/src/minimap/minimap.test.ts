import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ensureSyntaxTree } from "@codemirror/language";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createEditorState } from "../index";
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
    strokeRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    drawImage: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    fillStyle: "#000000",
    strokeStyle: "#000000",
    lineWidth: 1,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitFor(predicate: () => boolean, timeout = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate() && Date.now() - started < timeout) {
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

  it("keeps documents that fit the viewport untouched", async () => {
    const context = contextStub();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
      return context as unknown as CanvasRenderingContext2D;
    });
    const { view, parent } = mount(longText(20), {
      geometry: () => ({ ...geometry, contentHeight: 200, scrollHeight: 200 }),
      rebuildDebounceMs: 0,
    });
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

  it("shows the rail for short documents once they overflow the viewport", async () => {
    const context = contextStub();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
      return context as unknown as CanvasRenderingContext2D;
    });
    const { view, parent } = mount(longText(8), {
      minEditorWidth: 1,
      rebuildDebounceMs: 0,
    });
    cleanup = () => {
      view.destroy();
      parent.remove();
    };

    await settle();

    const rail = parent.querySelector<HTMLDivElement>(".qm-minimap");
    expect(rail?.getAttribute("data-minimap-state")).toBe("on");
    expect(view.dom.style.paddingRight).toBe("88px");
    expect(view.scrollDOM.dataset.minimapScrollbar).toBe("hidden");
  });

  it("paints a loaded image over its media band", async () => {
    const context = contextStub();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
      return context as unknown as CanvasRenderingContext2D;
    });
    Object.defineProperty(HTMLImageElement.prototype, "complete", {
      configurable: true,
      get: () => true,
    });
    Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", {
      configurable: true,
      get: () => 400,
    });
    vi.spyOn(HTMLImageElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLImageElement,
    ) {
      const block = view.lineBlockAt(view.posAtDOM(this));
      const top = view.documentTop + block.top;
      const bottom = view.documentTop + block.bottom;
      return {
        top,
        bottom,
        left: 0,
        right: 300,
        width: 300,
        height: bottom - top,
        x: 0,
        y: top,
        toJSON: () => ({}),
      } as DOMRect;
    });

    const doc = `# 标题\n\n![示意图](pic.png)\n\n${longText(60)}`;
    const parent = document.createElement("div");
    document.body.append(parent);
    const state = createEditorState({
      doc,
      previewEnabled: true,
      selection: { anchor: 0, head: 0 },
      extraExtensions: [
        minimapExtension({ geometry: () => geometry, minEditorWidth: 1, rebuildDebounceMs: 0 }),
      ],
    });
    ensureSyntaxTree(state, state.doc.length, 10_000);
    const view = new EditorView({ state: state.update({}).state, parent });
    cleanup = () => {
      view.destroy();
      parent.remove();
    };

    await settle();

    const image = parent.querySelector("img");
    expect(image).not.toBeNull();
    expect(
      context.drawImage.mock.calls.some(([source]) => source instanceof HTMLImageElement),
    ).toBe(true);
  });

  it("repaints after an SVG thumbnail finishes loading", async () => {
    const context = contextStub();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
      return context as unknown as CanvasRenderingContext2D;
    });
    const created: FakeImage[] = [];
    class FakeImage {
      src = "";
      readonly listeners = new Map<string, () => void>();
      addEventListener(type: string, listener: () => void): void {
        this.listeners.set(type, listener);
      }
      emit(type: string): void {
        this.listeners.get(type)?.();
      }
      constructor() {
        created.push(this);
      }
    }
    vi.stubGlobal("Image", FakeImage);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:svg");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

    const doc = "```mermaid\ngraph TD; A-->B;\n```\n\n" + longText(60);
    const parent = document.createElement("div");
    document.body.append(parent);
    const state = createEditorState({
      doc,
      previewEnabled: true,
      extraExtensions: [
        minimapExtension({ geometry: () => geometry, minEditorWidth: 1, rebuildDebounceMs: 0 }),
      ],
    });
    ensureSyntaxTree(state, state.doc.length, 10_000);
    const view = new EditorView({ state: state.update({}).state, parent });
    cleanup = () => {
      view.destroy();
      parent.remove();
      vi.unstubAllGlobals();
    };
    await settle();

    // Move the cursor out of the block so Live Preview renders the widget.
    view.dispatch({ selection: { anchor: doc.length } });
    await settle();

    const host = view.contentDOM.querySelector(".cm-md-mermaid");
    expect(host).not.toBeNull();
    const canvasHost = document.createElement("div");
    canvasHost.className = "cm-md-mermaid-canvas";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    canvasHost.append(svg);
    host?.append(canvasHost);
    vi.spyOn(SVGSVGElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: SVGSVGElement,
    ) {
      const block = view.lineBlockAt(view.posAtDOM(this));
      const top = view.documentTop + block.top;
      const bottom = view.documentTop + block.bottom;
      return {
        top,
        bottom,
        left: 0,
        right: 300,
        width: 300,
        height: bottom - top,
        x: 0,
        y: top,
        toJSON: () => ({}),
      } as DOMRect;
    });

    // Force a rebuild so the new DOM node is picked up.
    view.dispatch({ changes: { from: doc.length, insert: "\n" } });
    await settle();
    expect(created.length).toBeGreaterThan(0);

    const thumbnail = created.find((image) => image.src === "blob:svg");
    expect(thumbnail).toBeDefined();
    const before = context.drawImage.mock.calls.length;

    // No scroll, resize or selection change happens here: only the load
    // callback can schedule the repaint.
    thumbnail?.emit("load");
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(context.drawImage.mock.calls.length).toBeGreaterThan(before);
  });

  it("recovers when the first frames cannot draw", async () => {
    const context = contextStub();
    let failures = 2;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
      if (failures > 0) {
        failures -= 1;
        return null;
      }
      return context as unknown as CanvasRenderingContext2D;
    });
    const { view, parent } = mount(longText(), {
      minEditorWidth: 1,
      rebuildDebounceMs: 0,
    });
    cleanup = () => {
      view.destroy();
      parent.remove();
    };

    const rail = parent.querySelector<HTMLDivElement>(".qm-minimap");
    await waitFor(() => rail?.getAttribute("data-minimap-state") === "on");

    expect(rail?.getAttribute("data-minimap-state")).toBe("on");
    expect(context.fillRect).toHaveBeenCalled();
  });

  it("degrades to unsupported when a 2D context is unavailable", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const { view, parent } = mount(longText(), {
      minEditorWidth: 1,
      rebuildDebounceMs: 0,
    });
    cleanup = () => {
      view.destroy();
      parent.remove();
    };

    await settle();

    const rail = parent.querySelector<HTMLDivElement>(".qm-minimap");
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (rail?.getAttribute("data-minimap-state") === "unsupported") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
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
