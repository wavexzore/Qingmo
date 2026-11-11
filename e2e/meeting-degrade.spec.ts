import { expect, test } from "@playwright/test";

import { editorContent, finishMeeting, openApp, openMeetingWindow, startMeeting } from "./helpers";

const DEGRADATIONS = [
  {
    id: "E2E-003",
    scenario: "llm-unreachable",
    line: "未配置远程摘要",
  },
  {
    id: "E2E-005",
    scenario: "remote-fallback",
    line: "远程转写失败，已回退本地",
  },
  {
    id: "E2E-008",
    scenario: "remote-auth",
    line: "密钥无效",
  },
  {
    id: "E2E-009",
    scenario: "remote-too-large",
    line: "响应过大",
  },
] as const;

for (const entry of DEGRADATIONS) {
  test(`${entry.id}: ${entry.line} is visible while the transcript survives`, async ({ page }) => {
    await openApp(page);
    const requestId = await startMeeting(page, entry.scenario);
    await openMeetingWindow(page, requestId);
    await finishMeeting(page);

    const editor = editorContent(page);
    await expect(editor).toContainText(entry.line);
    await expect(editor).toContainText("决定周五发布");
    await expect(editor).toContainText("转录");
  });
}

test("E2E-011: two speakers keep stable colours and labels", async ({ page }) => {
  await openApp(page);
  const requestId = await startMeeting(page, "two-speakers");
  await openMeetingWindow(page, requestId);
  await finishMeeting(page);

  const editor = editorContent(page);
  await expect(editor).toContainText("已分离（2 人）");
  await expect(editor).toContainText("🟢 说话人 1");
  await expect(editor).toContainText("🔵 说话人 2");
  await expect(editor).not.toContainText("说话人 —");
  const text = (await editor.textContent()) ?? "";
  expect(text.match(/🟢 说话人 1/g)).toHaveLength(4);
  expect(text.match(/🔵 说话人 2/g)).toHaveLength(4);
});

test("E2E-012: a first-window diarization failure still produces an unlabelled transcript", async ({
  page,
}) => {
  await openApp(page);
  const requestId = await startMeeting(page, "speaker-degraded");
  await openMeetingWindow(page, requestId);
  await finishMeeting(page);

  const editor = editorContent(page);
  await expect(editor).toContainText("未分离说话人");
  await expect(editor).not.toContainText("说话人 1");
  await expect(editor).toContainText("周五前补齐回归");
});
