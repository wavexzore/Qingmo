import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FakeSettings } from "../lib/settings/fake";
import { EDITOR_TYPOGRAPHY_STORAGE_KEY, LANGUAGE_STORAGE_KEY, uiStore } from "../stores/uiStore";
import { MeetingSettings } from "./MeetingSettings";
import { SettingsWindow } from "./SettingsWindow";

function renderMeeting(settings = new FakeSettings()) {
  const onToast = vi.fn();
  render(<MeetingSettings settings={settings} onToast={onToast} />);
  return { settings, onToast };
}

function renderWindow(settings = new FakeSettings(), initialSection: "general" | "ai" = "ai") {
  render(<SettingsWindow settings={settings} initialSection={initialSection} />);
  return settings;
}

afterEach(async () => {
  window.localStorage.removeItem(LANGUAGE_STORAGE_KEY);
  window.localStorage.removeItem(EDITOR_TYPOGRAPHY_STORAGE_KEY);
  uiStore.syncFromStorage(null);
});

describe("MeetingSettings", () => {
  it("renders the three AI sections and only two rail entries", async () => {
    renderWindow();
    expect(await screen.findByRole("heading", { name: "AI 设置" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "转写模型" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "摘要模型" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "范围与产物" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /通用|AI/ }).length).toBeGreaterThanOrEqual(2);
  });

  it("shows the first-use banner with the auto-recommended size", async () => {
    renderMeeting();
    const banner = await screen.findByTestId("download-banner-asr");
    expect(banner).toHaveTextContent("首次使用");
    expect(banner).toHaveTextContent("253 MB");
    expect(screen.getByTestId("download-primary-asr")).toHaveTextContent("下载转写组合");
  });

  it("disables the primary button when the disk is too small", async () => {
    const settings = new FakeSettings();
    settings.setDisk(1024);
    renderMeeting(settings);
    await screen.findByTestId("download-banner-asr");
    expect(screen.getByTestId("download-primary-asr")).toBeDisabled();
    expect(screen.getByTestId("download-banner-asr")).toHaveTextContent("磁盘不足");
  });

  it("downloads the transcription set in order, one member at a time", async () => {
    const { settings } = renderMeeting();
    await screen.findByTestId("download-primary-asr");
    fireEvent.click(screen.getByTestId("download-primary-asr"));

    await waitFor(() => expect(settings.activeModelId).toBe("paraformer-zh-en-int8"));
    settings.finishActiveDownload();
    await waitFor(() => expect(settings.activeModelId).toBe("silero-vad"));
    settings.finishActiveDownload();
    await waitFor(() => expect(settings.activeModelId).toBe("pyannote-segmentation-3-int8"));
    settings.finishActiveDownload();
    await waitFor(() => expect(settings.activeModelId).toBe("campplus-zh-en-advanced"));
    settings.finishActiveDownload();

    await waitFor(() =>
      expect(screen.queryByTestId("download-banner-asr")).not.toBeInTheDocument(),
    );
  });

  it("shows 994 MB when FireRed joins the default set", async () => {
    renderMeeting();
    await screen.findByTestId("asr-model-select");
    fireEvent.change(screen.getByTestId("asr-model-select"), {
      target: { value: "fireredasr2-ctc-int8" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("download-banner-asr")).toHaveTextContent("994 MB"),
    );
  });

  it("counts only the remaining VAD and speaker pack when ASR is ready", async () => {
    const settings = new FakeSettings();
    settings.setModelState("paraformer-zh-en-int8", "ready");
    renderMeeting(settings);
    await waitFor(() =>
      expect(screen.getByTestId("download-banner-asr")).toHaveTextContent("30 MB"),
    );
    expect(screen.getByTestId("download-secondary-asr")).toBeDisabled();
    expect(screen.getByTestId("download-secondary-asr")).toHaveTextContent("已就绪");
    expect(screen.getByTestId("download-primary-asr")).toHaveTextContent("继续下载剩余 3 项");
  });

  it("counts 28.9 MB when the default ASR and segmentation are ready", async () => {
    const settings = new FakeSettings();
    settings.setModelState("paraformer-zh-en-int8", "ready");
    settings.setModelState("pyannote-segmentation-3-int8", "ready");
    renderMeeting(settings);
    await waitFor(() =>
      expect(screen.getByTestId("download-banner-asr")).toHaveTextContent("29 MB"),
    );
  });

  it("keeps each panel's draft while switching modes", async () => {
    const settings = new FakeSettings();
    renderMeeting(settings);
    await screen.findByTestId("asr-local-panel");
    fireEvent.click(screen.getByTestId("asr-mode-remote"));
    await screen.findByTestId("asr-remote-panel");
    fireEvent.change(screen.getByTestId("asr-model"), { target: { value: "whisper-large" } });

    fireEvent.click(screen.getByTestId("llm-mode-remote"));
    await screen.findByTestId("llm-remote-panel");
    fireEvent.change(screen.getByTestId("llm-base-url"), {
      target: { value: "https://example.test/v1" },
    });
    fireEvent.click(screen.getByTestId("asr-mode-remote"));
    await screen.findByTestId("asr-remote-panel");
    await waitFor(() => expect(screen.getByTestId("asr-model")).toHaveValue("whisper-large"));
    expect(screen.getByTestId("llm-base-url")).toHaveValue("https://example.test/v1");
  });

  it("shows all three key states and saves/clears a key", async () => {
    const settings = new FakeSettings();
    renderMeeting(settings);
    await screen.findByTestId("asr-local-panel");
    fireEvent.click(screen.getByTestId("asr-mode-remote"));
    await screen.findByTestId("asr-remote-panel");
    expect(screen.getByText("未配置")).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("key-input-asr"), { target: { value: "sk-test" } });
    fireEvent.click(screen.getByTestId("key-save-asr"));
    await waitFor(() => expect(screen.getByText("已保存")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("key-clear-asr"));
    await waitFor(() => expect(screen.getByText("未配置")).toBeInTheDocument());

    settings.setKeyStatus("asr", "keyring_unavailable");
    fireEvent.change(screen.getByTestId("key-input-asr"), { target: { value: "sk-again" } });
    fireEvent.click(screen.getByTestId("key-save-asr"));
    expect(await screen.findByText("旧密钥读取失败 · 仅本次会话")).toBeInTheDocument();
  });

  it("shows the merged speaker-pack row with partial state", async () => {
    const settings = new FakeSettings();
    settings.setModelState("pyannote-segmentation-3-int8", "ready");
    renderMeeting(settings);
    const row = await screen.findByTestId("model-row-speaker-pack");
    expect(row).toHaveTextContent("部分就绪 1/2");
    expect(row).toHaveTextContent("pyannote segmentation");
    expect(row).toHaveTextContent("CAM++");
  });

  it("points high-memory hints at FireRed and 8B", async () => {
    renderMeeting();
    await screen.findByTestId("model-row-fireredasr2-ctc-int8");
    expect(screen.getByTestId("model-row-fireredasr2-ctc-int8")).toHaveTextContent("高内存");
    expect(screen.getByTestId("model-row-qwen3-8b-instruct-q4km")).toHaveTextContent("需 ≥32 GiB");
  });

  it("removes a pinned model and falls back to auto", async () => {
    const settings = new FakeSettings();
    settings.setModelState("fireredasr2-ctc-int8", "ready");
    renderMeeting(settings);
    await screen.findByTestId("asr-model-select");
    fireEvent.change(screen.getByTestId("asr-model-select"), {
      target: { value: "fireredasr2-ctc-int8" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("asr-model-select")).toHaveValue("fireredasr2-ctc-int8"),
    );

    fireEvent.click(screen.getByTestId("model-remove-fireredasr2-ctc-int8"));
    fireEvent.click(screen.getByTestId("model-confirm-fireredasr2-ctc-int8"));
    await waitFor(() => expect(screen.getByTestId("asr-model-select")).toHaveValue(""));
  });

  it("reloads on a revision conflict instead of overwriting", async () => {
    const { settings, onToast } = renderMeeting();
    await screen.findByTestId("asr-local-panel");
    await settings.meetingConfigSet({}, 0);
    fireEvent.click(screen.getByTestId("asr-mode-remote"));
    await waitFor(() => expect(onToast).toHaveBeenCalledWith(expect.stringContaining("重新读取")));
    expect(screen.getByTestId("asr-remote-panel")).toBeInTheDocument();
  });

  it("does not store meeting config in localStorage", async () => {
    const { settings } = renderMeeting();
    await screen.findByTestId("asr-local-panel");
    fireEvent.click(screen.getByTestId("asr-mode-remote"));
    await waitFor(() =>
      expect(settings.activeModelId === null || settings.activeModelId === undefined).toBe(true),
    );
    const keys = Object.keys(window.localStorage);
    expect(keys.every((key) => !key.toLowerCase().includes("meeting"))).toBe(true);
  });

  it("marks the LLM section CPU-only under the cpu runtime", async () => {
    renderMeeting();
    await screen.findByTestId("runtime-local");
    fireEvent.click(screen.getByTestId("runtime-remote"));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /^摘要模型/, level: 2 })).toHaveTextContent("CPU"),
    );
  });
});
