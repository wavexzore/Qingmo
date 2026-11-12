import type {
  AppErrorCode,
  KeyStatus,
  MeetingConfigGetResponse,
  MeetingConfigPatch,
  MeetingConfigSetResponse,
  MeetingConfigView,
  ModelProgress,
  ModelState,
  ModelView,
  RuntimePreview,
} from "@qingmo/shared";

import { AppError } from "../ipc/errors";
import type { KeySlot, SettingsPort } from "./port";

const MB = 1024 * 1024;

interface FakeModelSeed {
  id: string;
  display: string;
  kind: ModelView["kind"];
  family?: ModelView["family"];
  license: string;
  bytes: number;
  peakMemoryMb: number;
  group?: string;
}

function seeds(): FakeModelSeed[] {
  return [
    {
      id: "paraformer-zh-en-int8",
      display: "Paraformer zh-en · int8",
      kind: "asr",
      family: "paraformer",
      license: "Apache-2.0",
      bytes: 223 * MB,
      peakMemoryMb: 1200,
    },
    {
      id: "paraformer-zh-small-int8",
      display: "Paraformer zh small · int8",
      kind: "asr",
      family: "paraformer",
      license: "Apache-2.0",
      bytes: 82 * MB,
      peakMemoryMb: 700,
    },
    {
      id: "sensevoice-small-int8",
      display: "SenseVoice Small · int8",
      kind: "asr",
      family: "sense_voice",
      license: "FunASR",
      bytes: 239 * MB,
      peakMemoryMb: 1000,
    },
    {
      id: "zipformer-zh-en-int8",
      display: "Zipformer zh-en · int8",
      kind: "asr",
      family: "zipformer_transducer",
      license: "Apache-2.0",
      bytes: 312 * MB,
      peakMemoryMb: 1400,
    },
    {
      id: "fireredasr2-ctc-int8",
      display: "FireRedASR2-CTC · int8",
      kind: "asr",
      family: "fire_red_ctc",
      license: "Apache-2.0",
      bytes: 741 * MB,
      peakMemoryMb: 2000,
    },
    {
      id: "pyannote-segmentation-3-int8",
      display: "pyannote segmentation 3.0 · int8",
      kind: "segmentation",
      license: "MIT",
      bytes: 1.5 * MB,
      peakMemoryMb: 40,
      group: "speaker-pack",
    },
    {
      id: "campplus-zh-en-advanced",
      display: "CAM++ zh_en · advanced",
      kind: "embedding",
      license: "Apache-2.0",
      bytes: 28.3 * MB,
      peakMemoryMb: 60,
      group: "speaker-pack",
    },
    {
      id: "silero-vad",
      display: "Silero VAD",
      kind: "vad",
      license: "MIT",
      bytes: 0.6 * MB,
      peakMemoryMb: 20,
    },
    {
      id: "qwen3-1.7b-instruct-q4km",
      display: "Qwen3 1.7B Instruct · Q4_K_M",
      kind: "llm",
      license: "Apache-2.0",
      bytes: 1100 * MB,
      peakMemoryMb: 2050,
    },
    {
      id: "qwen3-4b-instruct-q4km",
      display: "Qwen3 4B Instruct · Q4_K_M",
      kind: "llm",
      license: "Apache-2.0",
      bytes: 2500 * MB,
      peakMemoryMb: 3560,
    },
    {
      id: "qwen3-8b-instruct-q4km",
      display: "Qwen3 8B Instruct · Q4_K_M",
      kind: "llm",
      license: "Apache-2.0",
      bytes: 4900 * MB,
      peakMemoryMb: 6000,
    },
  ];
}

function defaultPreview(): RuntimePreview {
  return {
    defaults: {
      asrModel: "paraformer-zh-en-int8",
      llmModel: "qwen3-4b-instruct-q4km",
      threads: 4,
      accel: "cpu",
      notes: [],
    },
    resolved: {
      asr: "paraformer-zh-en-int8",
      llm: "qwen3-4b-instruct-q4km",
      asrOrigin: "auto",
      llmOrigin: "auto",
    },
    asrBudgetMb: 3072,
    llmBudgetMb: 6144,
  };
}

function defaultConfig(): MeetingConfigView {
  return {
    runtime: { mode: "auto" },
    asr: {
      mode: "local",
      provider: "openai",
      model: "",
      apiKeyRef: "",
      keyStatus: "absent",
    },
    llm: {
      mode: "local",
      baseUrl: "",
      model: "",
      apiKeyRef: "",
      keyStatus: "absent",
    },
    keepTranscript: true,
    maxMinutes: 180,
    revision: 0,
  };
}

/** In-memory settings adapter with explicit state helpers for tests. */
export class FakeSettings implements SettingsPort {
  closed = false;
  readonly openedLinks: string[] = [];
  private readonly version: string;
  private config = defaultConfig();
  private preview = defaultPreview();
  private disk = {
    freeBytes: 100 * 1024 * MB,
    asrRequiredBytes: 600 * MB,
    llmRequiredBytes: 3000 * MB,
  };
  private readonly models = new Map<string, ModelView>(
    seeds().map((seed): [string, ModelView] => [
      seed.id,
      {
        id: seed.id,
        display: seed.display,
        kind: seed.kind,
        ...(seed.family ? { family: seed.family } : {}),
        license: seed.license,
        licenseUrl: `https://licenses.test/${seed.id}`,
        languages: seed.kind === "asr" ? ["zh", "en"] : [],
        downloadBytes: seed.bytes,
        installBytes: seed.bytes,
        localBytes: 0,
        peakMemoryMb: seed.peakMemoryMb,
        peakBasis: "estimated",
        ...(seed.group ? { group: seed.group } : {}),
        state: "not_downloaded",
      },
    ]),
  );
  private readonly keys = new Map<KeySlot, KeyStatus>([
    ["asr", "absent"],
    ["llm", "absent"],
  ]);
  private readonly progressListeners = new Set<(progress: ModelProgress) => void>();
  private active: { downloadId: string; modelId: string } | null = null;
  private nextId = 1;

  constructor(version = "0.1.2") {
    this.version = version;
  }

  get activeModelId(): string | null {
    return this.active?.modelId ?? null;
  }

  async info(): Promise<string> {
    return this.version;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async meetingConfigGet(): Promise<MeetingConfigGetResponse> {
    const config = structuredClone(this.config);
    config.asr.keyStatus = this.keys.get("asr") ?? "absent";
    config.llm.keyStatus = this.keys.get("llm") ?? "absent";
    return {
      config,
      preview: structuredClone(this.preview),
      disk: { ...this.disk },
    };
  }

  async meetingConfigSet(
    patch: MeetingConfigPatch,
    expectedRevision: number,
  ): Promise<MeetingConfigSetResponse> {
    if (expectedRevision !== this.config.revision) {
      throw new AppError("CONFLICT", "config revision changed");
    }
    const next = structuredClone(this.config);
    if (patch.asrProvider !== undefined && patch.asrProvider !== next.asr.provider) {
      next.asr.provider = patch.asrProvider;
      next.asr.model = "";
    }
    if (patch.runtimeMode !== undefined) {
      next.runtime.mode = patch.runtimeMode;
    }
    if (patch.asrMode !== undefined) {
      next.asr.mode = patch.asrMode;
    }
    if (patch.asrLocalModel !== undefined) {
      if (patch.asrLocalModel) {
        next.asr.localModel = patch.asrLocalModel;
      } else {
        delete next.asr.localModel;
      }
    }
    if (patch.asrModel !== undefined) {
      next.asr.model = patch.asrModel;
    }
    if (patch.asrApiKeyRef !== undefined) {
      next.asr.apiKeyRef = patch.asrApiKeyRef;
    }
    if (patch.llmMode !== undefined) {
      next.llm.mode = patch.llmMode;
    }
    if (patch.llmLocalModel !== undefined) {
      if (patch.llmLocalModel) {
        next.llm.localModel = patch.llmLocalModel;
      } else {
        delete next.llm.localModel;
      }
    }
    if (patch.llmBaseUrl !== undefined) {
      next.llm.baseUrl = patch.llmBaseUrl;
    }
    if (patch.llmModel !== undefined) {
      next.llm.model = patch.llmModel;
    }
    if (patch.llmApiKeyRef !== undefined) {
      next.llm.apiKeyRef = patch.llmApiKeyRef;
    }
    if (patch.keepTranscript !== undefined) {
      next.keepTranscript = patch.keepTranscript;
    }
    if (patch.maxMinutes !== undefined) {
      next.maxMinutes = patch.maxMinutes;
    }
    next.revision += 1;
    this.config = next;
    return { revision: next.revision };
  }

  async meetingKeyStatus(slot: KeySlot): Promise<KeyStatus> {
    return this.keys.get(slot) ?? "absent";
  }

  async meetingKeySet(slot: KeySlot, value: string): Promise<void> {
    void value;
    if (this.keys.get(slot) !== "keyring_unavailable") {
      this.keys.set(slot, "present");
    }
  }

  async meetingKeyClear(slot: KeySlot, all?: boolean): Promise<void> {
    if (all) {
      this.keys.set("asr", "absent");
      this.keys.set("llm", "absent");
    } else {
      this.keys.set(slot, "absent");
    }
  }

  async meetingModelsList(): Promise<ModelView[]> {
    return [...this.models.values()].map((model) => structuredClone(model));
  }

  async meetingModelDownload(id: string): Promise<{ downloadId: string }> {
    if (this.active) {
      throw new AppError("MODEL_BUSY", "another model download is active");
    }
    const model = this.models.get(id);
    if (!model) {
      throw new AppError("MODEL_NOT_READY", "unknown model");
    }
    const downloadId = `fake-download-${this.nextId}`;
    this.nextId += 1;
    this.active = { downloadId, modelId: id };
    this.setModelState(id, "downloading");
    this.emit({
      downloadId,
      modelId: id,
      doneBytes: 0,
      totalBytes: model.downloadBytes,
      state: "downloading",
    });
    return { downloadId };
  }

  async meetingModelDownloadCancel(downloadId: string): Promise<void> {
    if (this.active?.downloadId !== downloadId) {
      return;
    }
    this.setModelState(this.active.modelId, "not_downloaded");
    this.emit({
      downloadId,
      modelId: this.active.modelId,
      doneBytes: 0,
      totalBytes: 0,
      state: "cancelled",
    });
    this.active = null;
  }

  async meetingModelRemove(id: string): Promise<void> {
    const model = this.models.get(id);
    if (!model || model.state === "not_downloaded") {
      throw new AppError("MODEL_NOT_READY", "model is not downloaded");
    }
    this.setModelState(id, "not_downloaded");
    if (this.config.asr.localModel === id) {
      delete this.config.asr.localModel;
      this.config.revision += 1;
    }
    if (this.config.llm.localModel === id) {
      delete this.config.llm.localModel;
      this.config.revision += 1;
    }
  }

  onModelProgress(handler: (progress: ModelProgress) => void): () => void {
    this.progressListeners.add(handler);
    return () => {
      this.progressListeners.delete(handler);
    };
  }

  async openExternal(href: string): Promise<void> {
    this.openedLinks.push(href);
  }

  // Test helpers -----------------------------------------------------------

  setModelState(id: string, state: ModelState): void {
    const model = this.models.get(id);
    if (model) {
      model.state = state;
      model.localBytes = state === "ready" ? model.installBytes : 0;
    }
  }

  emitProgress(doneBytes: number, totalBytes = 100): void {
    if (!this.active) {
      return;
    }
    this.emit({
      downloadId: this.active.downloadId,
      modelId: this.active.modelId,
      doneBytes,
      totalBytes,
      state: "downloading",
    });
  }

  progressActiveDownload(doneBytes: number, totalBytes: number): void {
    if (!this.active) {
      return;
    }
    this.emit({
      downloadId: this.active.downloadId,
      modelId: this.active.modelId,
      doneBytes,
      totalBytes,
      state: "downloading",
    });
  }

  finishActiveDownload(): void {
    if (!this.active) {
      return;
    }
    const { downloadId, modelId } = this.active;
    this.setModelState(modelId, "ready");
    this.emit({
      downloadId,
      modelId,
      doneBytes: 1,
      totalBytes: 1,
      state: "done",
    });
    this.active = null;
  }

  failActiveDownload(code: AppErrorCode = "MODEL_DOWNLOAD_FAILED"): void {
    if (!this.active) {
      return;
    }
    const { downloadId, modelId } = this.active;
    this.setModelState(modelId, "failed");
    this.emit({
      downloadId,
      modelId,
      doneBytes: 0,
      totalBytes: 0,
      state: "failed",
      error: { code, message: "fake failure", details: null },
    });
    this.active = null;
  }

  setDisk(freeBytes: number): void {
    this.disk.freeBytes = freeBytes;
  }

  setPreview(preview: RuntimePreview): void {
    this.preview = preview;
  }

  setKeyStatus(slot: KeySlot, status: KeyStatus): void {
    this.keys.set(slot, status);
  }

  private emit(progress: ModelProgress): void {
    for (const listener of this.progressListeners) {
      listener(progress);
    }
  }
}
