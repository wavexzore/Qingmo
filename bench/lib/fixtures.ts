import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BENCH_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const FIXTURE_DIR = path.join(BENCH_ROOT, "fixtures");

export const FIXTURE_NAMES = ["small", "medium", "large"] as const;
export type FixtureName = (typeof FIXTURE_NAMES)[number];

export interface FixtureSpec {
  name: FixtureName;
  file: string;
  bytes: number;
  sha256: string;
  lines: number;
  text: string;
}

interface Manifest {
  fixtures: Record<FixtureName, Omit<FixtureSpec, "name" | "text">>;
}

function loadManifest(): Manifest {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, "manifest.json"), "utf8")) as Manifest;
}

export function selectedFixtures(): FixtureName[] {
  const requested = process.env.BENCH_FIXTURE;
  if (!requested) {
    return [...FIXTURE_NAMES];
  }
  if (!FIXTURE_NAMES.includes(requested as FixtureName)) {
    throw new Error(`unknown BENCH_FIXTURE: ${requested}`);
  }
  return [requested as FixtureName];
}

export function loadFixture(name: FixtureName): FixtureSpec {
  const entry = loadManifest().fixtures[name];
  if (!entry) {
    throw new Error(`fixture ${name} is missing from manifest.json`);
  }
  const text = readFileSync(path.join(FIXTURE_DIR, entry.file), "utf8");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes !== entry.bytes) {
    throw new Error(
      `fixture ${name} is ${bytes} bytes, expected ${entry.bytes}; run pnpm bench:fixtures`,
    );
  }
  return { name, text, ...entry };
}

/** Deliberately small iteration counts for the 10 MiB case. */
export function iterationsFor(name: FixtureName, kind: "open" | "key" | "save"): number {
  const table = {
    open: { small: 20, medium: 8, large: 4 },
    key: { small: 80, medium: 40, large: 20 },
    save: { small: 30, medium: 12, large: 5 },
  } as const;
  return table[kind][name];
}
