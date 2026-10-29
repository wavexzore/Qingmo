import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import {
  PREVIEW_FULL_MAX_UNITS,
  PREVIEW_PARTIAL_MAX_UNITS,
  collectDecorationSpecs,
  createEditorState,
  livePreviewPlugin,
  previewTierFor,
  type PreviewTier,
} from "./index";

function withView(doc: string, run: (view: EditorView) => void): void {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: createEditorState({ doc }), parent });
  try {
    run(view);
  } finally {
    view.destroy();
    parent.remove();
  }
}

describe("previewTierFor", () => {
  const cases: ReadonlyArray<readonly [number, PreviewTier]> = [
    [-1, "source"],
    [Number.NaN, "source"],
    [Number.POSITIVE_INFINITY, "source"],
    [Number.NEGATIVE_INFINITY, "source"],
    [0, "full"],
    [PREVIEW_FULL_MAX_UNITS, "full"],
    [PREVIEW_FULL_MAX_UNITS + 1, "partial"],
    [PREVIEW_PARTIAL_MAX_UNITS, "partial"],
    [PREVIEW_PARTIAL_MAX_UNITS + 1, "source"],
  ];

  for (const [units, tier] of cases) {
    it(`maps ${units} to ${tier}`, () => {
      expect(previewTierFor(units)).toBe(tier);
    });
  }
});

describe("createEditorState preview mode", () => {
  it("keeps Live Preview on through full and partial, and off at source", () => {
    withView("a".repeat(PREVIEW_FULL_MAX_UNITS), (view) => {
      expect(view.plugin(livePreviewPlugin)).not.toBeNull();
      expect(view.dom.dataset.livePreview).toBe("true");
    });

    withView("a".repeat(PREVIEW_FULL_MAX_UNITS + 1), (view) => {
      expect(view.plugin(livePreviewPlugin)).not.toBeNull();
    });

    withView("a".repeat(PREVIEW_PARTIAL_MAX_UNITS), (view) => {
      expect(view.plugin(livePreviewPlugin)).not.toBeNull();
    });

    withView("a".repeat(PREVIEW_PARTIAL_MAX_UNITS + 1), (view) => {
      expect(view.plugin(livePreviewPlugin)).toBeNull();
      expect(view.dom.dataset.livePreview).toBeUndefined();
    });
  });

  it("honors an explicit effective mode override", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      state: createEditorState({ doc: "hello", previewEnabled: false }),
      parent,
    });
    try {
      expect(view.plugin(livePreviewPlugin)).toBeNull();
      expect(view.dom.dataset.livePreview).toBeUndefined();
    } finally {
      view.destroy();
      parent.remove();
    }
  });
});

describe("source tier decoration guard", () => {
  it("returns no decoration specs above the partial boundary", () => {
    const state = createEditorState({ doc: "a".repeat(PREVIEW_PARTIAL_MAX_UNITS + 1) });
    expect(collectDecorationSpecs(state, [{ from: 0, to: state.doc.length }], [])).toEqual([]);
  });
});
