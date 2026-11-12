import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { MeetingProgress } from "@qingmo/shared";

import i18n from "../i18n";
import { EMPTY_STATUS_SNAPSHOT, StatusBar, type StatusBarSnapshot } from "./StatusBar";

const snapshot: StatusBarSnapshot = {
  ...EMPTY_STATUS_SNAPSHOT,
  fileName: "note.md",
  encoding: "utf16Le",
  eol: "crlf",
  size: 1536,
};

afterEach(async () => {
  await i18n.changeLanguage("zh-CN");
});

describe("StatusBar formatting", () => {
  it("shows canonical encoding/EOL labels and the shared byte formatter", () => {
    render(<StatusBar snapshot={snapshot} />);

    expect(screen.getByText("UTF-16 LE")).toBeInTheDocument();
    expect(screen.getByText("CRLF")).toBeInTheDocument();
    expect(screen.getByText("1.5 KB")).toBeInTheDocument();
    expect(screen.queryByText("utf16Le")).not.toBeInTheDocument();
    expect(screen.queryByText("crlf")).not.toBeInTheDocument();
  });

  it("renders a dash for missing size and identifiers", () => {
    render(
      <StatusBar
        snapshot={{ ...EMPTY_STATUS_SNAPSHOT, encoding: "utf8", eol: "lf", size: null }}
      />,
    );

    expect(screen.getByText("UTF-8")).toBeInTheDocument();
    expect(screen.getByText("LF")).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("keeps labels on one line and lets narrow panes hide secondary items", () => {
    render(<StatusBar snapshot={snapshot} />);

    for (const id of [
      "status-save",
      "status-cursor",
      "status-encoding",
      "status-eol",
      "status-size",
    ]) {
      expect(screen.getByTestId(`${id}-label`)).toHaveClass("whitespace-nowrap");
    }
    expect(screen.getByTestId("status-cursor")).toHaveClass("hidden", "@md:inline-flex");
    expect(screen.getByTestId("status-eol")).toHaveClass("hidden", "@xl:inline-flex");
    expect(screen.getByTestId("status-size")).toHaveClass("hidden", "@2xl:inline-flex");
  });

  it("shows meeting stage, speakers and the audio player", () => {
    const meeting: MeetingProgress = {
      requestId: "11111111-2222-4333-8444-555555555555",
      attempt: 1,
      stage: "transcribing",
      audioUrl: "asset://voice.wav",
      elapsedMs: 1000,
      sourceName: "访谈.m4a",
      durationMs: 65_000,
      bytes: 4096,
      actualBackend: { kind: "local" },
      localModel: "paraformer-zh-en-int8",
      llmMode: "local",
      llmModel: "",
      accel: "cpu",
      speakerCount: 3,
      failedSegments: 1,
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
    render(<StatusBar snapshot={snapshot} meeting={meeting} meetingAudioUrl={meeting.audioUrl} />);

    expect(screen.getByTestId("status-meeting-stage")).toBeInTheDocument();
    expect(screen.getByText("转写中")).toBeInTheDocument();
    expect(screen.getByTestId("status-meeting-speakers")).toHaveTextContent("3");
    const audio = screen.getByTestId("meeting-audio") as HTMLAudioElement;
    expect(audio).toHaveAttribute("src", "asset://voice.wav");
    Object.defineProperty(audio, "duration", { configurable: true, value: 65 });
    fireEvent.loadedMetadata(audio);
    expect(screen.getByTestId("meeting-audio-player")).toHaveTextContent("0:00 / 1:05");

    const toggle = screen.getByTestId("meeting-audio-toggle");
    fireEvent.play(audio);
    expect(toggle).toHaveAttribute("aria-label", "暂停");
    fireEvent.pause(audio);
    expect(toggle).toHaveAttribute("aria-label", "播放");

    audio.currentTime = 30;
    fireEvent.timeUpdate(audio);
    expect(screen.getByTestId("meeting-audio-player")).toHaveTextContent("0:30 / 1:05");
    fireEvent.change(screen.getByTestId("meeting-audio-seek"), { target: { value: "42" } });
    expect(audio.currentTime).toBe(42);
  });
});
