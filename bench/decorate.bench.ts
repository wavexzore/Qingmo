import { ensureSyntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import {
  buildLivePreviewDecorations,
  createEditorState,
  LP_MAX_UNITS,
  SYNTAX_TREE_BUDGET_MS,
  type VisibleRange,
} from "../packages/editor-core/src/index";
import { iterationsFor, loadFixture, selectedFixtures } from "./lib/fixtures";
import { peakRssMb, summarize, timeSync, writeRaw } from "./lib/report";

const VIEWPORT_LINES = 80;

function viewportFor(state: EditorState): VisibleRange[] {
  const lastLine = Math.min(state.doc.lines, VIEWPORT_LINES);
  return [{ from: 0, to: state.doc.line(lastLine).to }];
}

/** Mirrors the plugin's `buildForView` without relying on jsdom layout. */
function decorateOnce(state: EditorState, ranges: readonly VisibleRange[]): number {
  if (state.doc.length > LP_MAX_UNITS) {
    return buildLivePreviewDecorations(state, ranges, []).size;
  }
  ensureSyntaxTree(state, ranges[0]?.to ?? 0, SYNTAX_TREE_BUDGET_MS);
  return buildLivePreviewDecorations(state, ranges, []).size;
}

function measureDecorate(state: EditorState, ranges: readonly VisibleRange[], count: number) {
  const samples: number[] = [];
  let specs = 0;
  for (let index = 0; index < count + 2; index += 1) {
    const start = performance.now();
    specs = decorateOnce(state, ranges);
    const elapsed = performance.now() - start;
    if (index >= 2) {
      samples.push(elapsed);
    }
  }
  return { samples, specs };
}

function measureKeyWithView(view: EditorView, count: number) {
  const samples: number[] = [];
  view.dispatch({ selection: { anchor: 120 } });
  for (let index = 0; index < count; index += 1) {
    const position = 160 + index;
    samples.push(
      timeSync(() => {
        view.dispatch({
          changes: { from: position, insert: "x" },
          selection: { anchor: position + 1 },
          scrollIntoView: false,
        });
      }),
    );
  }
  return samples;
}

function measureKeyState(state: EditorState, count: number) {
  let current = state;
  const samples: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const position = 160 + index;
    samples.push(
      timeSync(() => {
        current = current.update({
          changes: { from: position, insert: "x" },
          selection: { anchor: position + 1 },
        }).state;
      }),
    );
  }
  return { samples, finalLength: current.doc.length };
}

describe("decorate + key benchmark", () => {
  for (const name of selectedFixtures()) {
    it(`${name}: live preview decorations and key latency`, () => {
      const fixture = loadFixture(name);
      const state = createEditorState({ doc: fixture.text });
      const largeFile = state.doc.length > LP_MAX_UNITS;
      const ranges = viewportFor(state);

      const decorate = measureDecorate(state, ranges, iterationsFor(name, "key") / 4);
      let view: EditorView | undefined;
      let viewMountMs: number | null = null;
      let viewVisibleUnits: number | null = null;
      let keySamples: number[];
      let keySource: string;

      if (largeFile) {
        const key = measureKeyState(state, iterationsFor(name, "key"));
        keySamples = key.samples;
        keySource = "EditorState.update (LP off, no EditorView)";
      } else {
        viewMountMs = timeSync(() => {
          view = new EditorView({ state, parent: document.body });
        });
        const rangesInView = view?.visibleRanges ?? [];
        viewVisibleUnits =
          rangesInView.length === 0
            ? 0
            : (rangesInView[rangesInView.length - 1]?.to ?? 0) - (rangesInView[0]?.from ?? 0);
        keySamples = measureKeyWithView(view as EditorView, iterationsFor(name, "key"));
        keySource = "EditorView.dispatch (real view, LP on)";
      }

      const result = {
        fixture: name,
        bytes: fixture.bytes,
        lines: fixture.lines,
        largeFile,
        viewportLines: VIEWPORT_LINES,
        viewportUnits: ranges[0]?.to ?? 0,
        decorateIterations: decorate.samples.length,
        decorateMs: summarize(decorate.samples),
        decorationSpecs: decorate.specs,
        decorateSkipped: largeFile,
        decorateSkipReason: largeFile ? "document exceeds LP_MAX_UNITS" : null,
        viewMountMs,
        viewVisibleUnits,
        keyIterations: keySamples.length,
        keyMs: summarize(keySamples),
        keySource,
        nodePeakRssMb: peakRssMb(),
      };

      writeRaw(`decorate-${name}.json`, result);
      view?.destroy();

      expect(result.decorateIterations).toBeGreaterThan(0);
      if (largeFile) {
        expect(result.decorationSpecs).toBe(0);
      } else {
        expect(result.decorationSpecs).toBeGreaterThan(0);
      }
      expect(result.keyMs.p95).toBeGreaterThan(0);
    });
  }
});
