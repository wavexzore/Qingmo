import { describe, expect, it } from "vitest";

import { EditorSession } from "../apps/desktop/src/features/editor/EditorSession";
import { FakeIpc } from "../apps/desktop/src/lib/ipc/fake";
import { iterationsFor, loadFixture, selectedFixtures, type FixtureName } from "./lib/fixtures";
import { currentRssMb, peakRssMb, summarize, timeAsync, writeRaw } from "./lib/report";

/**
 * Fake-adapter save cost. The authoritative atomic-write numbers come from
 * `src-tauri/examples/atomic_bench.rs` and are merged by `bench/run.mjs`; this
 * run only measures the JS-side read/hash/copy path and metadata update.
 */
async function measureSave(name: FixtureName, text: string) {
  const ipc = new FakeIpc({ files: [{ path: `/bench/${name}.md`, text }] });
  const payload = await ipc.documentOpen();
  const session = EditorSession.create(payload);
  const readSamples: number[] = [];
  const saveSamples: number[] = [];
  const count = iterationsFor(name, "save");

  for (let index = 0; index < count + 1; index += 1) {
    const readStart = performance.now();
    const body = session.readText();
    const readMs = performance.now() - readStart;

    // Keep the byte size constant: the 10 MiB fixture is exactly at the P1
    // limit, so appending would (correctly) be rejected by the fake adapter.
    const marker = index.toString(36).padStart(3, "0");
    const next = `${body.slice(0, body.length - 4)}${marker}${body.slice(body.length - 1)}`;
    const saveMs = await timeAsync(async () => {
      const result = await ipc.documentWriteAtomic({
        docToken: payload.docToken,
        text: next,
      });
      session.applySaveResult(result);
    });

    if (index === 0) {
      continue;
    }
    readSamples.push(readMs);
    saveSamples.push(saveMs);
  }

  session.dispose();
  return {
    read: summarize(readSamples),
    save: summarize(saveSamples),
  };
}

describe("save benchmark (fake adapter)", () => {
  for (const name of selectedFixtures()) {
    it(`${name}: readText + fake documentWriteAtomic`, async () => {
      const fixture = loadFixture(name);
      const result = await measureSave(name, fixture.text);

      writeRaw(`save-${name}.json`, {
        fixture: name,
        bytes: fixture.bytes,
        iterations: result.save.count,
        readTextMs: result.read,
        fakeSaveMs: result.save,
        nodeCurrentRssMb: currentRssMb(),
        nodePeakRssMb: peakRssMb(),
        sources: {
          readTextMs: "EditorSession.readText (full document toString)",
          fakeSaveMs: "FakeIpc.documentWriteAtomic (encode + FNV hash + copy)",
        },
      });

      expect(result.save.count).toBe(iterationsFor(name, "save"));
      expect(result.save.p50).toBeGreaterThan(0);
    });
  }
});
