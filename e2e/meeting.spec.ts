import { expect, test } from "@playwright/test";

import {
  SAVE_AS_PATH,
  advanceMeeting,
  editorContent,
  failMeeting,
  finishMeeting,
  getFileText,
  modifier,
  openApp,
  openMeetingWindow,
  startMeeting,
} from "./helpers";

test("E2E-001: a baseline meeting shows progress, inserts five sections and is undoable", async ({
  page,
}) => {
  await openApp(page);
  const requestId = await startMeeting(page, "baseline");
  await openMeetingWindow(page, requestId);

  await expect(page.getByTestId("meeting-source")).toHaveText("周会.wav");
  await expect(page.getByTestId("meeting-stage")).toContainText("准备中");
  await advanceMeeting(page);
  await expect(page.getByTestId("meeting-stage")).toContainText("转写中");
  await advanceMeeting(page);
  await expect(page.getByTestId("meeting-stage")).toContainText("生成摘要");
  await advanceMeeting(page);
  await expect(page.getByTestId("meeting-stage")).toContainText("释放资源");

  await finishMeeting(page);

  const editor = editorContent(page);
  for (const section of ["# 周会", "摘要", "决议", "待办", "风险", "转录"]) {
    await expect(editor).toContainText(section);
  }
  await expect(editor).toContainText("决定周五发布");

  await page.keyboard.press(`${modifier()}+s`);
  await expect.poll(() => getFileText(page, SAVE_AS_PATH)).toContain("决定周五发布");

  await page.keyboard.press(`${modifier()}+z`);
  await expect(editor).not.toContainText("决定周五发布");
});

test("E2E-001b: cancelling stops the run and keeps the meeting window", async ({ page }) => {
  await openApp(page);
  const requestId = await startMeeting(page, "baseline");
  await openMeetingWindow(page, requestId);

  await page.getByTestId("meeting-cancel").click();
  await expect(page.getByTestId("meeting-cancelled")).toBeVisible();
  await expect(page.getByTestId("meeting-boot")).toBeVisible();
});

test("E2E-001c: a retryable failure offers retry and recovers on the second attempt", async ({
  page,
}) => {
  await openApp(page);
  const requestId = await startMeeting(page, "baseline");
  await openMeetingWindow(page, requestId);

  await failMeeting(page, "MODEL_NOT_READY");
  await expect(page.getByTestId("meeting-failed")).toBeVisible();
  await expect(page.getByTestId("meeting-open-settings")).toBeVisible();

  await page.getByTestId("meeting-retry").click();
  await expect(page.getByTestId("meeting-progress")).toBeVisible();
  await finishMeeting(page);
  await expect(editorContent(page)).toContainText("决定周五发布");
});
