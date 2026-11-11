import type {
  AppError,
  MeetingOutcome,
  MeetingProgress,
  MeetingResult,
  MeetingStage,
} from "@qingmo/shared";

import { COMMANDS } from "../lib/ipc/commands";
import type { FakeIpc } from "../lib/ipc/fake";

export type MeetingScenario =
  | "baseline"
  | "llm-unreachable"
  | "remote-fallback"
  | "remote-auth"
  | "remote-too-large"
  | "two-speakers"
  | "speaker-degraded";

const SCENARIO_KEY = "meeting.e2e.scenario";
const STEP_KEY = "meeting.e2e.step";
const STEPS = 4;

function markdown(scenario: MeetingScenario): string {
  const banner: Record<MeetingScenario, string> = {
    baseline: "",
    "two-speakers": "",
    "llm-unreachable": "> 未配置远程摘要",
    "remote-fallback": "> 远程转写失败，已回退本地",
    "remote-auth": "> 远程转写失败，已回退本地\n> 密钥无效",
    "remote-too-large": "> 远程转写失败，已回退本地\n> 响应过大",
    "speaker-degraded": "> 未分离说话人",
  };

  if (scenario === "speaker-degraded") {
    return `# 降级会议

${banner[scenario]}
> 本地转写 · Paraformer 中英 · int8

## 摘要

- [00:00:02] 说话人 —：先确认发布范围
  > 先确认发布范围
  \`已核\`

## 决议

—

## 待办

- [00:00:05] 说话人 —：周五前补齐回归
  > 周五前补齐回归
  \`待核\`

## 风险

—

## 转录

<details>
<summary>转录</summary>

- [00:00:02] 说话人 —：先确认发布范围
- [00:00:05] 说话人 —：周五前补齐回归

</details>
`;
  }

  const speakers = scenario === "two-speakers";
  const first = speakers ? "🟢 说话人 1：" : "说话人 —：";
  const second = speakers ? "🔵 说话人 2：" : "说话人 —：";
  const tags = speakers ? "> 已分离（2 人）" : "";
  return `# 周会

${banner[scenario]}${tags ? `${tags}\n` : ""}
> 本地转写 · Paraformer 中英 · int8

## 摘要

- [00:00:02] ${first}先确认发布范围
  > 先确认发布范围
  \`已核\`

## 决议

- [00:00:12] ${first}决定周五发布
  > 决定周五发布
  \`已核\`

## 待办

- [00:00:25] ${second}周五前补齐回归
  > 周五前补齐回归
  \`待核\`

## 风险

- [00:00:40] ${second}灰度覆盖面不足
  > 灰度覆盖面不足
  \`已核\`

## 转录

<details>
<summary>转录</summary>

- [00:00:02] ${first}先确认发布范围
- [00:00:12] ${first}决定周五发布
- [00:00:25] ${second}周五前补齐回归
- [00:00:40] ${second}灰度覆盖面不足

</details>
`;
}

function result(_requestId: string, scenario: MeetingScenario): MeetingResult {
  return {
    markdown: markdown(scenario),
    audioUrl: "asset://meeting/e2e.wav",
    title: "周会",
    durationMs: 60_000,
    stats: { decisions: 1, actions: 1, risks: 1, unverified: 1, failedSegments: 0 },
    partial: false,
  };
}

function progress(
  requestId: string,
  stage: MeetingStage,
  elapsed: number,
  attempt: number,
): MeetingProgress {
  return {
    requestId,
    attempt,
    stage,
    audioUrl: "",
    window: {
      index: 0,
      total: 1,
      phase: "transcribing",
      doneSegments: stage === "transcribing" ? 1 : 2,
      totalSegments: 2,
    },
    elapsedMs: elapsed,
    sourceName: "周会.wav",
    durationMs: 60_000,
    bytes: 1_920_000,
    actualBackend: { kind: "local" },
    localModel: "paraformer-zh-en-int8",
    llmMode: "local",
    llmModel: "qwen3-4b-instruct-q4km",
    accel: "cpu",
    rtf: 0.4,
    failedSegments: 0,
    degraded: {
      llmModelMissing: false,
      llmUnconfigured: false,
      llmBudgetExceeded: false,
      llmFailed: false,
      partialDecode: false,
      remoteFallback: false,
      remoteKeyMissing: false,
      speakerDegraded: false,
      speakerPartial: false,
      highMemoryModel: false,
      slowMachine: false,
    },
  };
}

const RESULT_KEY = "meeting.e2e.result";
const REQUEST_KEY = "meeting.e2e.request";
const ATTEMPT_KEY = "meeting.e2e.attempt";
const FAILED_KEY = "meeting.e2e.failed";
const TAKEN_KEY = "meeting.e2e.taken";

function read(key: string): string | null {
  return window.localStorage.getItem(key);
}

function storedAttempt(): number {
  return Number(read(ATTEMPT_KEY) ?? "1");
}

function storedError(): AppError | null {
  const raw = read(FAILED_KEY);
  return raw ? (JSON.parse(raw) as AppError) : null;
}

/**
 * Shared-state meeting fake. The request id, scenario, step and failure live
 * in localStorage so the workspace, the meeting document page and a settings
 * page all agree; module state is only the event listener cache.
 */
export class MeetingFake {
  private listeners = new Set<(progress: MeetingProgress) => void>();

  constructor(ipc: FakeIpc) {
    ipc.meetingStart = async () => {
      const requestId = this.start();
      return { requestId };
    };
    ipc.meetingRetry = async (requestId: string) => {
      const attempt = storedAttempt() + 1;
      window.localStorage.setItem(ATTEMPT_KEY, String(attempt));
      window.localStorage.setItem(STEP_KEY, "0");
      window.localStorage.removeItem(FAILED_KEY);
      window.localStorage.removeItem(TAKEN_KEY);
      return { requestId, attempt };
    };
    ipc.meetingStatus = async (requestId: string): Promise<MeetingOutcome> => {
      if (read(REQUEST_KEY) !== requestId) {
        return "gone";
      }
      const error = storedError();
      if (error) {
        return { failed: { attempt: storedAttempt(), error } };
      }
      if (this.step >= STEPS) {
        return { ready: result(requestId, this.scenario) };
      }
      return {
        running: progress(requestId, this.stage(), this.step * 700, storedAttempt()),
      };
    };
    ipc.meetingTakeResult = async (requestId: string) => {
      if (read(TAKEN_KEY) === requestId) {
        return null;
      }
      window.localStorage.setItem(TAKEN_KEY, requestId);
      window.localStorage.setItem(RESULT_KEY, requestId);
      return result(requestId, this.scenario);
    };
    ipc.meetingCancel = async (requestId: string) => {
      const error: AppError = { code: "CANCELLED", message: "e2e cancelled" };
      window.localStorage.setItem(FAILED_KEY, JSON.stringify(error));
      this.emit({ ...progress(requestId, "cancelled", this.step * 700, storedAttempt()), error });
    };
    ipc.onMeetingProgress = (listener) => {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    };
    window.addEventListener("storage", (event) => {
      if (event.key !== STEP_KEY && event.key !== FAILED_KEY) {
        return;
      }
      const requestId = read(REQUEST_KEY);
      if (!requestId) {
        return;
      }
      const error = storedError();
      if (error) {
        this.emit({ ...progress(requestId, "failed", 500, storedAttempt()), error });
      } else {
        this.emit(progress(requestId, this.stage(), this.step * 700, storedAttempt()));
      }
    });
  }

  get scenario(): MeetingScenario {
    return (read(SCENARIO_KEY) as MeetingScenario | null) ?? "baseline";
  }

  get step(): number {
    return Number(read(STEP_KEY) ?? "0");
  }

  setScenario(scenario: MeetingScenario): void {
    window.localStorage.setItem(SCENARIO_KEY, scenario);
  }

  start(): string {
    const requestId = crypto.randomUUID();
    window.localStorage.setItem(REQUEST_KEY, requestId);
    window.localStorage.setItem(SCENARIO_KEY, this.scenario);
    window.localStorage.setItem(STEP_KEY, "0");
    window.localStorage.setItem(ATTEMPT_KEY, "1");
    window.localStorage.removeItem(FAILED_KEY);
    window.localStorage.removeItem(TAKEN_KEY);
    return requestId;
  }

  advance(): void {
    const requestId = read(REQUEST_KEY);
    if (!requestId || storedError()) {
      return;
    }
    const next = Math.min(STEPS, this.step + 1);
    window.localStorage.setItem(STEP_KEY, String(next));
    this.emit(progress(requestId, this.stage(), next * 700, storedAttempt()));
  }

  fail(code: AppError["code"]): void {
    const requestId = read(REQUEST_KEY);
    if (!requestId) {
      return;
    }
    const error: AppError = { code, message: `e2e ${code}` };
    window.localStorage.setItem(FAILED_KEY, JSON.stringify(error));
    this.emit({ ...progress(requestId, "failed", 500, storedAttempt()), error });
  }

  private stage(): MeetingStage {
    return this.step === 0
      ? "preparing"
      : this.step === 1
        ? "transcribing"
        : this.step === 2
          ? "summarizing"
          : "releasing";
  }

  private emit(progress: MeetingProgress): void {
    for (const listener of this.listeners) {
      listener(progress);
    }
  }
}

export function installMeetingFake(ipc: FakeIpc): MeetingFake {
  return new MeetingFake(ipc);
}

export { COMMANDS };
