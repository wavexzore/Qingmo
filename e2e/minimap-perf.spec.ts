import { expect, test } from "@playwright/test";

import { editorContent, modifier, openApp, openSeededFile } from "./helpers";

const PATH = "/docs/perf-100k.md";
const LINE_COUNT = 100_000;
const WARMUP = 2;
const ITERATIONS = 20;

test.skip(!process.env.MINIMAP_PERF, "set MINIMAP_PERF=1 to run the 100k rebuild sample");

interface BuildSample {
  ms: number;
  cpuMs: number;
  scanMs: number;
  readMs: number;
  writeMs: number;
  waitMs: number;
}

function percentile(samples: readonly number[], fraction: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

test("C-011 records 100k minimap rebuild p50/p95", async ({ page }) => {
  test.setTimeout(180_000);
  const text = Array.from({ length: LINE_COUNT }, (_, index) => `line ${index + 1}`).join("\n");

  await openApp(page, [{ path: PATH, text }]);
  await page.evaluate(() => {
    const samples: BuildSample[] = [];
    (window as unknown as { __MINIMAP_PERF__: BuildSample[] }).__MINIMAP_PERF__ = samples;
    document.addEventListener("qm-minimap-build", (event) => {
      const detail = (event as CustomEvent<BuildSample>).detail;
      if (detail && Number.isFinite(detail.cpuMs)) {
        samples.push(detail);
      }
    });
  });

  await openSeededFile(page, "perf-100k.md");
  await expect(page.locator(".cm-editor > .qm-minimap")).toHaveAttribute(
    "data-minimap-state",
    "on",
  );

  for (let index = 0; index < WARMUP + ITERATIONS; index += 1) {
    await editorContent(page).click();
    await page.keyboard.press(`${modifier()}+End`);
    await page.keyboard.type("x");
    await page.waitForTimeout(280);
  }

  const samples = await page.evaluate(
    () => (window as unknown as { __MINIMAP_PERF__: BuildSample[] }).__MINIMAP_PERF__,
  );
  // The first builds include cold-start/JIT and the initial viewport jump.
  const steady = samples.slice(WARMUP);
  expect(steady.length).toBeGreaterThanOrEqual(ITERATIONS - 2);

  const cpu = steady.map((sample) => sample.cpuMs);
  const wall = steady.map((sample) => sample.ms);
  const cpuP50 = percentile(cpu, 0.5);
  const cpuP95 = percentile(cpu, 0.95);
  const wallP50 = percentile(wall, 0.5);
  const wallP95 = percentile(wall, 0.95);
  const maxAnchors = Math.max(...steady.map((sample) => sample.readMs));

  console.log(`minimap 100k cpu samples: ${cpu.map((value) => value.toFixed(2)).join(", ")}`);
  console.log(
    `minimap 100k rebuild: cpu p50=${cpuP50.toFixed(2)}ms p95=${cpuP95.toFixed(2)}ms; ` +
      `wall p50=${wallP50.toFixed(2)}ms p95=${wallP95.toFixed(2)}ms`,
  );
  console.log(`minimap 100k slowest read phase: ${maxAnchors.toFixed(2)}ms`);

  expect(cpuP50).toBeGreaterThan(0);
  // CPU work must fit one frame. Wall time also includes CM6's next measure
  // cycle and is therefore only bounded loosely.
  expect(cpuP95).toBeLessThan(16);
  expect(wallP95).toBeLessThan(250);
});
