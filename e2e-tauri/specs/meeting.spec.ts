import { browser, expect } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  applyMeetingEnv,
  clearMeetingEnv,
  closeCurrentWindow,
  closeMeetingWindow,
  ensureDocumentWindow,
  editorText,
  invoke,
  invokeError,
  invokeHere,
  meetingRequestId,
  resetFixture,
  focusMeetingWindow,
  pinnedLabel,
  rememberPinnedDocument,
  resetMeetingConfig,
  startMeeting,
  tauri,
  waitForMeetingResult,
  root,
} from "./helpers";

const models = process.env.E2E_MODELS ?? process.env.MEETING_E2E_MODELS ?? "";
const twoSpeakers = path.join(root, "..", "fixtures", "meeting-2spk-zh.wav");
const fourSpeakers = path.join(root, "..", "fixtures", "meeting-4spk.wav");
const longWav = path.join(root, "..", "fixtures", "meeting-real-13min.mp3");
const longM4a = path.join(root, "..", "fixtures", "meeting-4h.m4a");
const tenMinutes = process.env.E2E_TEN_MIN || path.join(root, "..", "fixtures", "meeting-ten.wav");
const work = path.join(process.env.TMPDIR ?? "/tmp", "qingmo-meeting-e2e");
const mirror = path.join(work, "mirror");

/** Parks a pack so a spec sees it as missing; restores on demand. */
function parkPack(id: string): () => void {
  const dir = path.join(models, id);
  const parked = `${dir}.off`;
  if (!fs.existsSync(dir) && fs.existsSync(parked)) {
    fs.renameSync(parked, dir);
  }
  fs.rmSync(parked, { recursive: true, force: true });
  fs.renameSync(dir, parked);
  return () => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(parked, dir);
  };
}

/** Parks the segmentation pack so a spec runs without diarization. */
function parkSegmentation(): () => void {
  const segmentation = path.join(models, "pyannote-segmentation-3-int8");
  const parked = `${segmentation}.off`;
  if (!fs.existsSync(segmentation) && fs.existsSync(parked)) {
    fs.renameSync(parked, segmentation);
  }
  fs.rmSync(parked, { recursive: true, force: true });
  fs.renameSync(segmentation, parked);
  return () => fs.renameSync(parked, segmentation);
}

function baseEnv(audio: string) {
  return {
    MEETING_E2E_MODELS: models,
    MEETING_E2E_AUDIO: audio,
    MEETING_E2E_PROFILE: "16g-mac",
  };
}

async function switchToSettings(): Promise<void> {
  let target = "";
  await browser.waitUntil(
    async () => {
      for (const handle of await browser.getWindowHandles()) {
        await browser.switchToWindow(handle);
        if ((await browser.getUrl()).includes("settings.html")) {
          target = handle;
          return true;
        }
      }
      return false;
    },
    { timeout: 30_000, interval: 200, timeoutMsg: "the settings window did not open" },
  );
  await browser.waitUntil(
    () =>
      browser.execute(
        "return Boolean(window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke)",
      ),
    { timeout: 20_000, interval: 100, timeoutMsg: "the Tauri bridge did not become ready" },
  );
  await tauri().switchWindow(target);
}

describe("real Tauri meeting pipeline", () => {
  before(async () => {
    if (!models || !fs.existsSync(models)) {
      throw new Error("E2E_MODELS must point at the seeded meeting models");
    }
    for (const file of [twoSpeakers, fourSpeakers, longWav, longM4a, tenMinutes]) {
      if (!fs.existsSync(file)) {
        throw new Error(`missing fixture ${file}; run scripts/dev/gen-meeting-fixtures.sh`);
      }
    }
    fs.rmSync(mirror, { recursive: true, force: true });
    fs.mkdirSync(mirror, { recursive: true });
    // A killed run can leave a pack parked by `parkPack`; restore it before
    // seeding the mirror.
    fs.rmSync(path.join(models, ".staging"), { recursive: true, force: true });
    for (const id of [
      "paraformer-zh-en-int8",
      "silero-vad",
      "pyannote-segmentation-3-int8",
      "campplus-zh-en-advanced",
    ]) {
      const dir = path.join(models, id);
      if (!fs.existsSync(dir) && fs.existsSync(`${dir}.off`)) {
        fs.renameSync(`${dir}.off`, dir);
      }
      fs.cpSync(dir, path.join(mirror, id), { recursive: true });
    }
    // Paraformer is an archive pack; the mirror needs the tar.bz2 the
    // downloader asks for, not just the unpacked files.
    const archiveRoot = "sherpa-onnx-paraformer-zh-2023-09-14";
    const archiveBuild = path.join(work, "archive-build");
    fs.rmSync(archiveBuild, { recursive: true, force: true });
    fs.cpSync(path.join(models, "paraformer-zh-en-int8"), path.join(archiveBuild, archiveRoot), {
      recursive: true,
    });
    fs.rmSync(path.join(archiveBuild, archiveRoot, ".ready"), { force: true });
    execFileSync("tar", [
      "-cjf",
      path.join(mirror, "paraformer-zh-en-int8", "archive.tar.bz2"),
      "-C",
      archiveBuild,
      archiveRoot,
    ]);
    fs.rmSync(archiveBuild, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    await rememberPinnedDocument();
    await resetFixture();
  });

  beforeEach(async () => {
    await resetMeetingConfig();
  });

  afterEach(async () => {
    const debug: string[] = [];
    for (const handle of await browser.getWindowHandles()) {
      try {
        await browser.switchToWindow(handle);
        debug.push(`${handle} ${await browser.getUrl()}`);
      } catch {
        debug.push(`${handle} <gone>`);
      }
    }
    console.log("MEETING-E2E", pinnedLabel(), debug);
    await closeMeetingWindow().catch(() => undefined);
  });

  it("E2E-002: transcribes the two speaker fixture into five sections", async function () {
    this.timeout(480_000);
    await applyMeetingEnv(baseEnv(twoSpeakers));
    await resetFixture();

    const started = Date.now();
    await startMeeting();
    const text = await waitForMeetingResult(420_000);
    const elapsed = Date.now() - started;

    for (const section of ["摘要", "决议", "待办", "风险", "转录"]) {
      expect(text).toContain(section);
    }
    expect(text).toMatch(/说话人 [12]/);
    // The E2E binary is a debug build; release measurements live in T-013.
    expect(elapsed).toBeLessThan(90_000);
  });

  it("E2E-004: a missing ASR pack opens settings, downloads and retries", async function () {
    // The debug build decompresses a 233 MB bz2 archive; measured around four
    // minutes on this machine.
    this.timeout(900_000);
    fs.rmSync(path.join(models, ".staging", "paraformer-zh-en-int8"), {
      recursive: true,
      force: true,
    });
    const restore = parkPack("paraformer-zh-en-int8");
    try {
      await applyMeetingEnv({
        ...baseEnv(twoSpeakers),
        MEETING_E2E_DOWNLOAD_BASE: mirror,
      });
      await startMeeting();
      const failed = await browser.$('[data-testid="meeting-failed"]');
      await failed.waitForDisplayed({ timeout: 120_000 });
      const url = await browser.getUrl();
      const match = /meeting=([0-9a-f-]{36})/i.exec(url);
      console.log(
        "MEETING-E2E 004",
        await failed.getText(),
        match
          ? JSON.stringify(await invoke("meeting_status", { requestId: match[1] })).slice(0, 300)
          : "no-id",
      );
      await (await browser.$('[data-testid="meeting-open-settings"]')).click();
      await switchToSettings();

      const primary = await browser.$('[data-testid="download-primary-asr"]');
      await primary.waitForClickable({ timeout: 60_000 });
      await primary.click();
      await browser.waitUntil(
        async () => {
          const list =
            await invokeHere<Array<{ id: string; state: string }>>("meeting_models_list");
          return list.find((model) => model.id === "paraformer-zh-en-int8")?.state === "ready";
        },
        { timeout: 600_000, interval: 500, timeoutMsg: "the ASR download did not finish" },
      );

      await focusMeetingWindow();
      await (await browser.$('[data-testid="meeting-retry"]')).click();
      const text = await waitForMeetingResult(420_000);
      expect(text).toContain("转录");
      expect(text).toMatch(/说话人 [12]/);
    } finally {
      restore();
    }
  });

  it("E2E-006: cancel stops the run inside the 60 s diarization subwindow", async function () {
    this.timeout(240_000);
    await applyMeetingEnv(baseEnv(tenMinutes));
    await resetFixture();
    await startMeeting();
    await (
      await browser.$('[data-testid="meeting-progress"]')
    ).waitForDisplayed({ timeout: 60_000 });
    // Wait until the first 10 minute window exists, not the preparation
    // phase, so the cancellation hits diarization/ASR. Diarization subwindows
    // are 60 s, so the first transcribed segment can take a while in a debug
    // build; waiting for it is best-effort.
    await browser.waitUntil(
      async () => {
        const requestId = meetingRequestId();
        if (!requestId) {
          return false;
        }
        const status = await invokeHere<{
          running?: { stage: string; window?: unknown };
        }>("meeting_status", { requestId });
        return status.running?.stage === "transcribing" && Boolean(status.running.window);
      },
      { timeout: 120_000, interval: 500, timeoutMsg: "the first window did not start" },
    );
    await browser
      .waitUntil(
        async () => {
          const status = await invokeHere<{
            running?: { window?: { doneSegments: number } };
          }>("meeting_status", { requestId: meetingRequestId() });
          return (status.running?.window?.doneSegments ?? 0) > 0;
        },
        { timeout: 45_000, interval: 500 },
      )
      .catch(() => undefined);
    const started = Date.now();
    await (await browser.$('[data-testid="meeting-cancel"]')).click();
    await (
      await browser.$('[data-testid="meeting-cancelled"]')
    ).waitForDisplayed({
      timeout: 60_000,
    });
    expect(Date.now() - started).toBeLessThan(60_000);
  });

  it("E2E-007: rejects a four hour recording with AUDIO_TOO_LONG", async function () {
    this.timeout(120_000);
    await applyMeetingEnv(baseEnv(longM4a));
    const error = await invokeError<{ code: string }>("meeting_start");
    expect(error?.code).toBe("AUDIO_TOO_LONG");
  });

  it("E2E-013: a missing segmentation pack degrades to an unlabelled transcript", async function () {
    this.timeout(240_000);
    await applyMeetingEnv(baseEnv(twoSpeakers));
    const restore = parkSegmentation();
    try {
      const list = await invoke<Array<{ id: string; state: string }>>("meeting_models_list");
      console.log(
        "MEETING-E2E segmentation",
        models,
        list.find((model) => model.id.includes("pyannote"))?.state,
      );
      await startMeeting();
      const text = await waitForMeetingResult(420_000);
      expect(text).toContain("未分离说话人");
      expect(text).toContain("转录");
      expect(text).not.toContain("说话人 1");
    } finally {
      restore();
    }
  });

  it("E2E-014: a staged .part resumes instead of restarting", async function () {
    this.timeout(300_000);
    const id = "silero-vad";
    const restore = parkPack(id);
    await applyMeetingEnv({
      ...baseEnv(twoSpeakers),
      MEETING_E2E_DOWNLOAD_BASE: mirror,
    });
    try {
      const part = path.join(models, ".staging", id, "silero_vad.onnx.part");
      fs.mkdirSync(path.dirname(part), { recursive: true });
      const source = fs.readFileSync(path.join(mirror, id, "silero_vad.onnx"));
      const offset = 300_000;
      fs.writeFileSync(part, source.subarray(0, offset));

      // The settings window is the only caller allowed to download.
      await invoke("app_settings_open", { section: "ai" });
      await switchToSettings();
      await browser.execute(() => {
        (window as unknown as { __modelBytes: number[] }).__modelBytes = [];
        void (
          window as unknown as {
            __TAURI__: {
              event: {
                listen(
                  name: string,
                  handler: (event: { payload: { doneBytes?: number } }) => void,
                ): Promise<unknown>;
              };
            };
          }
        ).__TAURI__.event.listen("app://meeting-model-progress", (event) => {
          (window as unknown as { __modelBytes: number[] }).__modelBytes.push(
            event.payload.doneBytes ?? 0,
          );
        });
      });
      await invokeHere("meeting_model_download", { id });
      await browser.waitUntil(
        async () => {
          const list =
            await invokeHere<Array<{ id: string; state: string }>>("meeting_models_list");
          return list.find((model) => model.id === id)?.state === "ready";
        },
        { timeout: 120_000, interval: 200, timeoutMsg: "the VAD download did not finish" },
      );
      const seen = await browser.execute(
        () => (window as unknown as { __modelBytes: number[] }).__modelBytes,
      );
      // A fresh download would emit its first positive offset far below the
      // staged one; a resumed copy starts at the staged byte count.
      const firstPositive = seen.find((value) => value > 0) ?? 0;
      expect(firstPositive).toBeGreaterThan(offset);
      expect(fs.readFileSync(path.join(models, id, "silero_vad.onnx")).length).toBe(source.length);
    } finally {
      restore();
    }
  });

  it("E2E-015: a disk shortfall disables the download button", async function () {
    this.timeout(180_000);
    await applyMeetingEnv({ ...baseEnv(twoSpeakers), MEETING_E2E_FREE_SPACE: "50" });
    await invoke("app_settings_open", { section: "ai" });
    await switchToSettings();
    const banner = (await browser.$('[data-testid="download-banner-asr"]').isExisting())
      ? await browser.$('[data-testid="download-banner-asr"]')
      : await browser.$('[data-testid="download-banner-llm"]');
    await banner.waitForDisplayed({ timeout: 30_000 });
    const primary = await banner.$('[data-testid^="download-primary"]');
    expect(await primary.isEnabled()).toBe(false);
    expect(await banner.getText()).toContain("磁盘不足");
  });

  it("E2E-016: a missing local summary model keeps the extractive transcript", async function () {
    this.timeout(240_000);
    await applyMeetingEnv({ ...baseEnv(twoSpeakers), MEETING_E2E_PROFILE: "32g-mac" });
    await startMeeting();
    const text = await waitForMeetingResult(420_000);
    expect(text).toContain("本地摘要模型未就绪");
    expect(text).toContain("转录");
    expect(text).not.toContain("未检测到语音");
  });

  it("E2E-017: the tier profile drives models, CPU and the 8B gate", async function () {
    this.timeout(180_000);
    await applyMeetingEnv({ ...baseEnv(twoSpeakers), MEETING_E2E_PROFILE: "8g-win" });
    const small = await invoke<{
      preview: { defaults: { asrModel: string; llmModel: string; accel: string; notes: string[] } };
    }>("meeting_config_get");
    expect(small.preview.defaults.asrModel).toBe("paraformer-zh-small-int8");
    expect(small.preview.defaults.llmModel).toBe("qwen3-1.7b-instruct-q4km");
    expect(small.preview.defaults.accel).toBe("cpu");
    expect(small.preview.defaults.notes).toContain("windows_slow_llm");

    await applyMeetingEnv({ ...baseEnv(twoSpeakers), MEETING_E2E_PROFILE: "16g-mac" });
    await invoke("app_settings_open", { section: "ai" });
    await switchToSettings();
    const current = await invokeHere<{ config: { revision: number } }>("meeting_config_get");
    await invokeHere("meeting_config_set", {
      patch: { llmLocalModel: "qwen3-8b-instruct-q4km" },
      expectedRevision: current.config.revision,
    });
    const pinned = await invokeHere<{ preview: { unsupported?: string } }>("meeting_config_get");
    expect(pinned.preview.unsupported).toBe("model_unsupported");

    await applyMeetingEnv({ ...baseEnv(twoSpeakers), MEETING_E2E_PROFILE: "32g-mac" });
    const large = await invoke<{ preview: { resolved?: { llm: string } } }>("meeting_config_get");
    expect(large.preview.resolved?.llm).toBe("qwen3-8b-instruct-q4km");
  });

  it("E2E-018: timestamps keep advancing past the ten minute window boundary", async function () {
    this.timeout(1_800_000);
    await applyMeetingEnv(baseEnv(longWav));
    // Diarization dominates real-audio runtime; timestamps only need ASR.
    const restore = parkSegmentation();
    try {
      await startMeeting();
      const text = await waitForMeetingResult(1_500_000);
      // Cards above the transcript may quote later moments; only the transcript
      // itself has to be monotonic.
      const heading = text.indexOf("## 转录");
      expect(heading).toBeGreaterThan(-1);
      const transcript = text.slice(heading);
      const stamps = [...transcript.matchAll(/\[(\d{2}):(\d{2}):(\d{2})\]/g)].map(
        (match) => Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]),
      );
      expect(stamps.length).toBeGreaterThan(10);
      expect(Math.max(...stamps)).toBeGreaterThanOrEqual(10 * 60);
      for (let index = 1; index < stamps.length; index += 1) {
        expect(stamps[index]).toBeGreaterThanOrEqual(stamps[index - 1]);
      }
    } finally {
      restore();
    }
  });

  it("E2E-011n: four speakers yield at least two stable labels", async function () {
    this.timeout(240_000);
    await applyMeetingEnv(baseEnv(fourSpeakers));
    await startMeeting();
    const text = await waitForMeetingResult(420_000);
    const labels = new Set([...text.matchAll(/说话人 (\d)/g)].map((match) => match[1]));
    expect(labels.size).toBeGreaterThanOrEqual(2);
  });

  it("E2E-019: closing a dirty meeting window keeps the body on cancel", async function () {
    this.timeout(240_000);
    await applyMeetingEnv(baseEnv(twoSpeakers));
    await startMeeting();
    const text = await waitForMeetingResult(420_000);
    expect(text).toContain("转录");

    const before = (await browser.getWindowHandles()).length;
    await closeCurrentWindow();
    const confirm = await browser.$('[data-testid="close-confirm"]');
    await confirm.waitForDisplayed({ timeout: 15_000 });
    await (await browser.$('[data-testid="close-cancel"]')).click();
    await browser.pause(500);
    expect((await browser.getWindowHandles()).length).toBe(before);
    expect(await editorText()).toContain("转录");
  });

  it("E2E-019c: a cancelled Save As keeps the file unwritten", async function () {
    this.timeout(300_000);
    const save = path.join(work, "meeting-019c.md");
    fs.rmSync(save, { force: true });
    await applyMeetingEnv({
      ...baseEnv(twoSpeakers),
      MEETING_E2E_SAVE_AS: save,
      MEETING_E2E_SAVE_CANCEL: "1",
    });
    await startMeeting();
    const text = await waitForMeetingResult(420_000);
    expect(text).toContain("转录");

    await browser.keys(["Meta", "s"]);
    await browser.pause(1_000);
    expect(fs.existsSync(save)).toBe(false);

    await applyMeetingEnv({ ...baseEnv(twoSpeakers), MEETING_E2E_SAVE_AS: save });
    await focusMeetingWindow();
    await browser.keys(["Meta", "s"]);
    await browser.waitUntil(() => fs.existsSync(save), {
      timeout: 30_000,
      interval: 200,
      timeoutMsg: "Save As did not write the file after the cancel",
    });
    expect(fs.readFileSync(save, "utf8")).toContain("转录");
  });

  it("E2E-019b: Save As writes the meeting body through the menu accelerator", async function () {
    this.timeout(240_000);
    const save = path.join(work, "meeting-019.md");
    fs.rmSync(save, { force: true });
    await applyMeetingEnv({ ...baseEnv(twoSpeakers), MEETING_E2E_SAVE_AS: save });
    await startMeeting();
    const text = await waitForMeetingResult(420_000);
    expect(text).toContain("转录");

    await browser.keys(["Meta", "s"]);
    await browser.waitUntil(() => fs.existsSync(save), {
      timeout: 30_000,
      interval: 200,
      timeoutMsg: "Save As did not write the file",
    });
    expect(fs.readFileSync(save, "utf8")).toContain("转录");
  });
});

after(async () => {
  await closeMeetingWindow().catch(() => undefined);
  await ensureDocumentWindow().catch(() => undefined);
  clearMeetingEnv();
});
