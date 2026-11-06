import { expect, test } from "@playwright/test";

import {
  addWorkspaceFile,
  deleteDiskFile,
  emitFocus,
  emitMenuAction,
  emitWorkspaceChanged,
  getFileText,
  getWorkspaceCalls,
  openApp,
  openWorkspaceApp,
  typeInEditor,
  workspaceRow,
} from "./helpers";

const WORKSPACE = {
  root: "/work",
  name: "work",
  files: [
    { path: "/work/notes/a.md", text: "# A\n" },
    { path: "/work/readme.md", text: "# Readme\n" },
  ],
};

test("browses the seeded workspace and opens a file from the tree", async ({ page }) => {
  await openWorkspaceApp(page, WORKSPACE);

  await expect(page.getByTestId("workspace-sidebar")).toContainText("work");
  await expect(workspaceRow(page, "notes")).toBeVisible();
  await expect(workspaceRow(page, "readme.md")).toBeVisible();

  await workspaceRow(page, "notes").click();
  await expect(workspaceRow(page, "notes/a.md")).toBeVisible();

  // A single click opens the file in this window.
  await workspaceRow(page, "readme.md").click();
  await expect(page.getByTestId("document-session")).toBeVisible();
  await expect(page.getByTestId("status-bar")).toContainText("readme.md");
  await expect(workspaceRow(page, "readme.md")).toHaveAttribute("aria-selected", "true");
  await expect(workspaceRow(page, "readme.md")).toHaveAttribute("data-workspace-current", "true");

  // Switching another file replaces the document instead of opening a window.
  await workspaceRow(page, "notes/a.md").click();
  await expect(page.getByTestId("status-bar")).toContainText("a.md");
  await expect(page.getByTestId("document-session")).toHaveCount(1);
  await expect(workspaceRow(page, "notes/a.md")).toHaveAttribute("data-workspace-current", "true");
});

test("saves the current file before switching from the tree", async ({ page }) => {
  await openWorkspaceApp(page, WORKSPACE);

  await workspaceRow(page, "readme.md").click();
  await expect(page.getByTestId("status-bar")).toContainText("readme.md");
  await typeInEditor(page, "\nswitched away");

  await workspaceRow(page, "notes").click();
  await expect(workspaceRow(page, "notes/a.md")).toBeVisible();
  await workspaceRow(page, "notes/a.md").click();
  await expect(page.getByTestId("status-bar")).toContainText("a.md");
  await expect(page.getByTestId("document-session")).toHaveCount(1);
  await expect.poll(() => getFileText(page, "/work/readme.md")).toContain("switched away");
});

test("navigates and opens with the keyboard", async ({ page }) => {
  await openWorkspaceApp(page, WORKSPACE);

  await workspaceRow(page, "notes").focus();
  await page.keyboard.press("ArrowRight");
  await expect(workspaceRow(page, "notes/a.md")).toBeVisible();

  await page.keyboard.press("ArrowRight");
  await expect(workspaceRow(page, "notes/a.md")).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(page.getByTestId("document-session")).toBeVisible();
  await expect(page.getByTestId("status-bar")).toContainText("a.md");
});

test("manual refresh picks up created and deleted files", async ({ page }) => {
  await openWorkspaceApp(page, WORKSPACE);
  await addWorkspaceFile(page, "/work/new.md", "# New\n");

  await page.getByRole("button", { name: "刷新工作区" }).click();
  await expect(workspaceRow(page, "new.md")).toBeVisible();

  await deleteDiskFile(page, "/work/new.md");
  await page.getByRole("button", { name: "刷新工作区" }).click();
  await expect(workspaceRow(page, "new.md")).toHaveCount(0);
});

test("focus refresh picks up an external change", async ({ page }) => {
  await openWorkspaceApp(page, WORKSPACE);
  await addWorkspaceFile(page, "/work/focused.md", "# Focus\n");

  await emitFocus(page);
  await expect(workspaceRow(page, "focused.md")).toBeVisible();
});

test("merges consecutive watcher events into one refresh", async ({ page }) => {
  await openWorkspaceApp(page, WORKSPACE);
  const listCalls = async () =>
    (await getWorkspaceCalls(page)).filter((call) => call.command === "workspace_list").length;
  const before = await listCalls();

  await addWorkspaceFile(page, "/work/watched.md", "# Watched\n");
  await emitWorkspaceChanged(page);
  await emitWorkspaceChanged(page);
  await emitWorkspaceChanged(page);

  await expect(workspaceRow(page, "watched.md")).toBeVisible();
  await expect.poll(listCalls).toBe(before + 1);
});

test("watcher events while the dock is closed only mark it stale", async ({ page }) => {
  await openWorkspaceApp(page, WORKSPACE);
  await page.getByRole("button", { name: "隐藏侧栏" }).click();
  await expect(page.getByTestId("sidebar-dock")).toHaveAttribute("data-open", "false");

  await addWorkspaceFile(page, "/work/closed-event.md", "# Closed\n");
  await emitWorkspaceChanged(page);
  await page.waitForTimeout(700);
  await expect(workspaceRow(page, "closed-event.md")).toHaveCount(0);

  await page.getByRole("button", { name: "显示侧栏" }).click();
  await expect(workspaceRow(page, "closed-event.md")).toBeVisible();
});

test("a closed dock stays stale and flushes when reopened", async ({ page }) => {
  await openWorkspaceApp(page, WORKSPACE);
  await page.getByRole("button", { name: "隐藏侧栏" }).click();
  await expect(page.getByTestId("sidebar-dock")).toHaveAttribute("data-open", "false");

  await addWorkspaceFile(page, "/work/while-closed.md", "# Closed\n");
  await emitFocus(page);
  await page.waitForTimeout(700);
  await expect(workspaceRow(page, "while-closed.md")).toHaveCount(0);

  await page.getByRole("button", { name: "显示侧栏" }).click();
  await expect(page.getByTestId("sidebar-dock")).toHaveAttribute("data-open", "true");
  await expect(workspaceRow(page, "while-closed.md")).toBeVisible();
});

test("opens a folder from the native menu and keeps the no-workspace path intact", async ({
  page,
}) => {
  await openApp(page);
  // The outline-only dock exists for the untitled session but starts closed.
  await expect(page.getByTestId("sidebar-dock")).toHaveAttribute("data-open", "false");
  await expect(page.getByTestId("workspace-sidebar")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "显示侧栏" })).toHaveCount(0);

  await addWorkspaceFile(page, "/work/readme.md", "# Readme\n");
  await page.evaluate(() => {
    window.__QINGMO_E2E__?.setWorkspaceFolder("/work");
  });
  await emitMenuAction(page, "file.openFolder");

  await expect(page.getByTestId("sidebar-dock")).toHaveAttribute("data-open", "true");
  await expect(page.getByTestId("workspace-sidebar")).toContainText("work");
  await expect(workspaceRow(page, "readme.md")).toBeVisible();

  const calls = await page.evaluate(() => window.__QINGMO_E2E__?.getWorkspaceCalls() ?? []);
  expect(calls.some((call) => call.command === "workspace_open")).toBe(true);
  expect(calls.some((call) => call.command === "workspace_list")).toBe(true);
});

test("cancelling the folder dialog leaves the blank editor untouched", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => {
    window.__QINGMO_E2E__?.setWorkspaceFolder(null);
  });
  await emitMenuAction(page, "file.openFolder");

  await expect(page.getByTestId("sidebar-dock")).toHaveAttribute("data-open", "false");
  await expect(page.getByTestId("workspace-sidebar")).toHaveCount(0);
  await expect(page.getByTestId("untitled-editor")).toBeVisible();
});
