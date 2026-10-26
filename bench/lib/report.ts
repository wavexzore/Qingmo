import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { BENCH_ROOT } from "./fixtures";

export const RAW_DIR = path.join(BENCH_ROOT, "results", ".raw");

export interface Summary {
  count: number;
  min: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
}

export function percentile(samples: readonly number[], fraction: number): number {
  if (samples.length === 0) {
    return 0;
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] ?? 0;
}

export function summarize(samples: readonly number[]): Summary {
  const total = samples.reduce((sum, value) => sum + value, 0);
  return {
    count: samples.length,
    min: round(Math.min(...samples)),
    p50: round(percentile(samples, 0.5)),
    p95: round(percentile(samples, 0.95)),
    max: round(Math.max(...samples)),
    mean: round(samples.length === 0 ? 0 : total / samples.length),
  };
}

export function timeSync(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

export async function timeAsync(fn: () => Promise<void>): Promise<number> {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

export function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Node reports `maxRSS` in kilobytes (all supported platforms here). */
export function peakRssMb(): number {
  return round(process.resourceUsage().maxRSS / 1024, 1);
}

export function currentRssMb(): number {
  return round(process.memoryUsage().rss / 1024 / 1024, 1);
}

export function writeRaw(fileName: string, payload: unknown): void {
  mkdirSync(RAW_DIR, { recursive: true });
  writeFileSync(path.join(RAW_DIR, fileName), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}
