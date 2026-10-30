import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import {
  buildMinimapBuckets,
  createAnchorMap,
  scanMinimapDocument,
  type AnchorSample,
} from "../packages/editor-core/src/minimap/model";
import { summarize, timeSync, writeRaw } from "./lib/report";

const LINE_COUNT = 100_000;
const ITERATIONS = 8;

function syntheticText(): Text {
  return Text.of(
    Array.from({ length: LINE_COUNT }, (_, index) =>
      index % 50 === 0 ? `## Section ${index / 50}` : `line ${index + 1}`,
    ),
  );
}

function syntheticAnchors(): AnchorSample[] {
  const stride = Math.max(40, Math.ceil(LINE_COUNT / 1_200));
  const samples: AnchorSample[] = [];
  for (let line = 0; line < LINE_COUNT; line += stride) {
    samples.push({ line, docY: line * 24 });
  }
  samples.push({ line: LINE_COUNT, docY: LINE_COUNT * 24 });
  return samples;
}

describe("minimap benchmark", () => {
  it("records scan/anchor/bucket/build for 100k lines", () => {
    const text = syntheticText();
    const anchors = syntheticAnchors();
    const scanSamples: number[] = [];
    const anchorSamples: number[] = [];
    const bucketSamples: number[] = [];
    const buildSamples: number[] = [];

    let last: ReturnType<typeof scanMinimapDocument> | null = null;
    for (let index = 0; index < ITERATIONS; index += 1) {
      const scanMs = timeSync(() => {
        last = scanMinimapDocument(text, 4);
      });
      scanSamples.push(scanMs);

      const anchorMs = timeSync(() => {
        createAnchorMap(anchors, LINE_COUNT, LINE_COUNT * 24, 6, 800);
      });
      anchorSamples.push(anchorMs);

      const map = createAnchorMap(anchors, LINE_COUNT, LINE_COUNT * 24, 6, 800);
      const bucketMs = timeSync(() => {
        buildMinimapBuckets(last!.lines, map.lineDocY, map, 6, 800, 76);
      });
      bucketSamples.push(bucketMs);

      buildSamples.push(scanMs + anchorMs + bucketMs);
    }

    const scan = summarize(scanSamples);
    const anchor = summarize(anchorSamples);
    const bucket = summarize(bucketSamples);
    const build = summarize(buildSamples);
    writeRaw("minimap-100k.json", {
      lines: LINE_COUNT,
      iterations: ITERATIONS,
      scan,
      anchor,
      bucket,
      build,
      nodePeakRssMb: process.memoryUsage().rss / 1024 / 1024,
    });

    expect(scan.count).toBe(ITERATIONS);
    expect(scan.p50).toBeGreaterThan(0);
    expect(build.p50).toBeGreaterThan(0);
  });
});
