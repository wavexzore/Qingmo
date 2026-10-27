import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, type Page } from "@playwright/test";

import type { SeedFile } from "./types";

export const NOTE_PATH = "/docs/note.md";
export const CONFLICT_PATH = "/docs/conflict.md";
export const READONLY_PATH = "/docs/readonly.mdx";
export const SAVE_AS_PATH = "/docs/untitled.md";

function fixture(name: string): string {
  return readFileSync(path.join(__dirname, "fixtures", name), "utf8");
}

export const NOTE_TEXT = fixture("note.md");
export const CONFLICT_TEXT = fixture("conflict.md");
export const READONLY_TEXT = fixture("readonly.mdx");

export const BASE_FILES: SeedFile[] = [
  {
    path: NOTE_PATH,
    text: NOTE_TEXT,
  },
];

export function modifier(): "Meta" | "Control" {
  return process.platform === "darwin" ? "Meta" : "Control";
}

export async function openApp(page: Page, files: SeedFile[] = BASE_FILES): Promise<void> {
  await page.addInitScript((seed) => {
    window.__QINGMO_E2E_SEED__ = seed;
  }, files);
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.__QINGMO_E2E__));
  await expect(page.getByRole("button", { name: "打开 Markdown 文件" })).toBeVisible();
}

export async function openSeededFile(page: Page, fileName: string): Promise<void> {
  await page.getByRole("button", { name: "打开 Markdown 文件" }).click();
  await expect(page.getByTestId("document-session")).toBeVisible();
  await expect(page.getByRole("heading", { name: fileName })).toBeVisible();
}

export async function typeInEditor(page: Page, text: string): Promise<void> {
  await page.locator(".cm-content").click();
  await page.keyboard.press(`${modifier()}+End`);
  await page.keyboard.type(text);
}

export async function getFileText(page: Page, path: string): Promise<string | null> {
  return page.evaluate((filePath) => window.__QINGMO_E2E__?.getFile(filePath)?.text ?? null, path);
}

export async function getFileSize(page: Page, path: string): Promise<number | null> {
  return page.evaluate((filePath) => window.__QINGMO_E2E__?.getFile(filePath)?.size ?? null, path);
}

export async function setDiskText(page: Page, path: string, text: string): Promise<void> {
  await page.evaluate(
    ({ filePath, next }) => {
      window.__QINGMO_E2E__?.setDiskText(filePath, next);
    },
    { filePath: path, next: text },
  );
}

export async function setOpenFile(page: Page, path: string | null): Promise<void> {
  await page.evaluate((next) => {
    window.__QINGMO_E2E__?.setOpenFile(next);
  }, path);
}

export async function setSaveAsFile(page: Page, path: string | null): Promise<void> {
  await page.evaluate((next) => {
    window.__QINGMO_E2E__?.setSaveAsFile(next);
  }, path);
}

export async function emitClose(page: Page, reason: "window" | "exit" = "window"): Promise<void> {
  await page.evaluate((next) => {
    window.__QINGMO_E2E__?.emitClose(next);
  }, reason);
}

export async function emitBlur(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__QINGMO_E2E__?.emitBlur();
  });
}

export async function setComposing(page: Page, composing: boolean): Promise<void> {
  await page.evaluate((next) => {
    window.__QINGMO_E2E__?.setComposing(next);
  }, composing);
}

export async function endComposition(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__QINGMO_E2E__?.setComposing(false);
    window.dispatchEvent(new CompositionEvent("compositionend"));
  });
}

export async function getCloseConfirms(page: Page): Promise<Array<{ allow: boolean }>> {
  return page.evaluate(() => window.__QINGMO_E2E__?.getCloseConfirms() ?? []);
}

export async function failSaveAlways(page: Page, code = "IO"): Promise<void> {
  await page.evaluate((next) => {
    window.__QINGMO_E2E__?.failSaveAlways(next);
  }, code);
}

export async function clearErrors(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__QINGMO_E2E__?.clearErrors();
  });
}
