import { describe, expect, it } from "vitest";

import { EditorSession } from "../apps/desktop/src/features/editor/EditorSession";
import { FakeIpc } from "../apps/desktop/src/lib/ipc/fake";
import { iterationsFor, loadFixture, selectedFixtures, type FixtureName } from "./lib/fixtures";
import { peakRssMb, summarize, timeSync, writeRaw } from "./lib/report";

/**
 * Open latency is split deliberately:
 * - `ipc_open_ms` is the fake adapter's async dialog/read hand-off.
 * - `session_open_ms` is the real CM6 state construction used by the app.
 * - `ipc_copy_ms` is a JSON round-trip of the FilePayload, a proxy for the
 *   string crossing into the webview. It is not the Tauri transport itself.
 */
async function measureOpen(name: FixtureName, text: string) {
  const ipc = new FakeIpc({ files: [{ path: `/bench/${name}.md`, text }] });
  const ipcSamples: number[] = [];
  const sessionSamples: number[] = [];
  const copySamples: number[] = [];
  const count = iterationsFor(name, "open");

  for (let index = 0; index < count + 1; index += 1) {
    const ipcStart = performance.now();
    const payload = await ipc.documentOpen();
    const ipcMs = performance.now() - ipcStart;

    const copyMs = timeSync(() => {
      JSON.parse(JSON.stringify(payload));
    });

    const sessionStart = performance.now();
    const session = EditorSession.create(payload);
    const sessionMs = performance.now() - sessionStart;
    const sourceTier = session.getSnapshot().previewTier === "source";
    session.dispose();

    if (index === 0) {
      expect(sourceTier).toBe(name === "large");
      continue;
    }

    ipcSamples.push(ipcMs);
    sessionSamples.push(sessionMs);
    copySamples.push(copyMs);
  }

  return {
    ipc: summarize(ipcSamples),
    session: summarize(sessionSamples),
    copy: summarize(copySamples),
  };
}

describe("open benchmark", () => {
  for (const name of selectedFixtures()) {
    it(`${name}: fake IPC + EditorSession`, async () => {
      const fixture = loadFixture(name);
      const result = await measureOpen(name, fixture.text);

      writeRaw(`open-${name}.json`, {
        fixture: name,
        bytes: fixture.bytes,
        lines: fixture.lines,
        iterations: result.session.count,
        ipcOpenMs: result.ipc,
        sessionOpenMs: result.session,
        ipcCopyMs: result.copy,
        nodePeakRssMb: peakRssMb(),
        sources: {
          ipcOpenMs: "FakeIpc.documentOpen",
          sessionOpenMs: "EditorSession.create -> createEditorState",
          ipcCopyMs: "JSON.stringify(JSON.parse) FilePayload",
        },
      });

      expect(result.session.count).toBe(iterationsFor(name, "open"));
      expect(result.session.p50).toBeGreaterThan(0);
    });
  }
});
