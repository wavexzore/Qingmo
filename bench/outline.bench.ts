import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import {
  OUTLINE_SCAN_MAX_UNITS,
  buildHeadingOutline,
  createEditorState,
  readHeadingOutline,
} from "../packages/editor-core/src/index";
import { readHeadingAnchors } from "../packages/editor-core/src/live-preview/heading-anchors";
import { summarize, timeSync, writeRaw } from "./lib/report";

const ITERATIONS = 50;
const WARMUP = 5;

interface BenchSpec {
  id: string;
  units: number;
  headings: number;
  details?: number;
}

const SPECS: readonly BenchSpec[] = [
  { id: "BENCH-001", units: 10_000, headings: 50 },
  { id: "BENCH-002", units: 100_000, headings: 200 },
  { id: "BENCH-003", units: 200_000, headings: 500 },
  { id: "BENCH-004", units: 200_000, headings: 5_000 },
  { id: "BENCH-005", units: 200_000, headings: 0 },
  { id: "BENCH-006", units: 200_000, headings: 100, details: 100 },
];

/**
 * Builds a deterministic short-line document. The heading/details blocks come
 * first so every measured tree walk has to cross the expensive structures,
 * then paragraphs fill the document to the requested UTF-16 size.
 */
function syntheticDocument(spec: BenchSpec): string {
  const parts: string[] = [];
  for (let index = 0; index < spec.headings; index += 1) {
    parts.push(`## H${index}`);
  }
  for (let index = 0; index < (spec.details ?? 0); index += 1) {
    parts.push(
      [
        "<details>",
        `<summary>Section ${index}</summary>`,
        "",
        `### Hidden ${index}`,
        "",
        `body ${index}`,
        "",
        "</details>",
      ].join("\n"),
    );
  }

  let text = parts.length > 0 ? `${parts.join("\n\n")}\n\n` : "";
  if (text.length > spec.units) {
    throw new Error(`${spec.id} prelude is ${text.length} units, over ${spec.units}`);
  }
  const paragraph = "benchmark filler line for a bounded outline scan";
  let index = 0;
  while (text.length + paragraph.length + 2 <= spec.units) {
    text += `${paragraph} ${index}\n\n`;
    index += 1;
  }
  if (text.length < spec.units) {
    text += "x".repeat(spec.units - text.length);
  }
  return text;
}

function parsedState(doc: string): EditorState {
  let state = createEditorState({ doc });
  const limit = Math.min(state.doc.length, OUTLINE_SCAN_MAX_UNITS);
  let attempts = 0;
  while (syntaxTree(state).length < limit && attempts < 100) {
    const before = syntaxTree(state).length;
    ensureSyntaxTree(state, limit, 50);
    state = state.update({}).state;
    attempts = syntaxTree(state).length > before ? 0 : attempts + 1;
  }
  if (syntaxTree(state).length < limit) {
    throw new Error(`bench tree stopped at ${syntaxTree(state).length}/${limit}`);
  }
  return state;
}

describe("outline benchmark", () => {
  for (const spec of SPECS) {
    it(`${spec.id}: ${spec.units} units / ${spec.headings} headings`, () => {
      const doc = syntheticDocument(spec);
      const state = parsedState(doc);
      const samples: number[] = [];

      for (let index = 0; index < WARMUP + ITERATIONS; index += 1) {
        const elapsed = timeSync(() => {
          buildHeadingOutline(state);
        });
        if (index >= WARMUP) {
          samples.push(elapsed);
        }
      }

      const outline = readHeadingOutline(state);
      const anchors = spec.id === "BENCH-004" ? readHeadingAnchors(state) : null;
      const build = summarize(samples);
      const result = {
        id: spec.id,
        units: doc.length,
        headings: spec.headings,
        details: spec.details ?? 0,
        iterations: samples.length,
        entries: outline.entries.length,
        status: outline.status,
        limitReason: outline.limitReason,
        anchors: anchors?.size ?? null,
        buildMs: build,
      };
      writeRaw(`outline-${spec.id.toLowerCase()}.json`, result);

      expect(build.count).toBe(ITERATIONS);
      expect(build.p50).toBeGreaterThan(0);
      expect(build.p95).toBeGreaterThan(0);
      expect(outline.entries.length).toBe(Math.min(spec.headings, 5_000));
      if (spec.id === "BENCH-003") {
        expect(build.p95).toBeLessThanOrEqual(4);
      }
      if (spec.id === "BENCH-004") {
        expect(outline.status).toBe("complete");
        expect(outline.limitReason).toBeNull();
        expect(anchors?.size).toBe(5_000);
        expect(anchors?.has("h4999")).toBe(true);
        expect(anchors?.has("h5000")).toBe(false);
        expect(build.p95).toBeLessThanOrEqual(12);
      }
    });
  }
});
