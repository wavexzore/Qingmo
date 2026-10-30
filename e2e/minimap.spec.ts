import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import {
  NOTE_PATH,
  emitMenuAction,
  editorContent,
  openApp,
  openSeededFile,
  setDiskText,
} from "./helpers";

const LONG_TEXT = readFileSync(path.join(__dirname, "fixtures", "long.md"), "utf8");

function numberedDocument(lines: number, prefix = "line"): string {
  return Array.from({ length: lines }, (_, index) => `${prefix} ${index + 1}`).join("\n");
}

function variedDocument(repeats = 10): string {
  const block = [
    "# Structure",
    "",
    "Paragraph with enough text to create a visible density bar.",
    "",
    "```ts",
    "const value = 1;",
    "const next = value + 1;",
    "```",
    "",
    "| A | B |",
    "|---|---|",
    "| 1 | 2 |",
    "| 3 | 4 |",
    "",
    "> quoted line",
    "- list item",
    "",
    "---",
    "",
  ];
  return Array.from({ length: repeats }, () => block.join("\n")).join("\n");
}

function headingDocument(): string {
  return Array.from({ length: 300 }, (_, index) =>
    index % 25 === 0 ? `## Section ${index / 25}` : `paragraph ${index}`,
  ).join("\n");
}

async function openFile(page: Page, fileName: string, text = LONG_TEXT): Promise<void> {
  const filePath = `/docs/${fileName}`;
  await openApp(page, [{ path: filePath, text }]);
  await openSeededFile(page, fileName);
}

function rail(page: Page) {
  return page.locator(".cm-editor").first().locator("> .qm-minimap");
}

async function waitOn(page: Page): Promise<void> {
  await expect(rail(page)).toHaveAttribute("data-minimap-state", "on");
  // A padding/ResizeObserver cycle schedules one more measurement; wait for
  // that short pending phase to settle before sampling canvas/DOM geometry.
  await page.waitForTimeout(300);
  await expect(rail(page)).toHaveAttribute("data-minimap-state", "on");
}

async function scrollTop(page: Page): Promise<number> {
  return page
    .locator(".cm-scroller")
    .first()
    .evaluate((element) => element.scrollTop);
}

async function canvasColors(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(".cm-editor > .qm-minimap canvas");
    if (!canvas) {
      return [];
    }
    const context = canvas.getContext("2d");
    if (!context) {
      return [];
    }
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const colors = new Set<string>();
    for (let index = 0; index < data.length; index += 4) {
      if (data[index + 3] === 0) {
        continue;
      }
      colors.add(`${data[index]},${data[index + 1]},${data[index + 2]}`);
    }
    return [...colors];
  });
}

async function canvasHash(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(".cm-editor > .qm-minimap canvas");
    const context = canvas?.getContext("2d");
    if (!canvas || !context) {
      return 0;
    }
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let hash = 2166136261;
    for (let index = 0; index < data.length; index += 1) {
      hash ^= data[index] ?? 0;
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  });
}

/** Rightmost inked column (CSS px) inside a horizontal slice of the rail canvas. */
async function rightmostInk(page: Page, startY: number, height: number): Promise<number> {
  return page.evaluate(
    ({ startY, height }) => {
      const canvas = document.querySelector<HTMLCanvasElement>(".cm-editor > .qm-minimap canvas");
      const context = canvas?.getContext("2d");
      if (!canvas || !context) {
        return -1;
      }
      const cssWidth = Number.parseFloat(canvas.style.width) || canvas.width;
      const dpr = canvas.width / cssWidth;
      const y = Math.max(0, Math.round(startY * dpr));
      const rows = Math.max(1, Math.round(height * dpr));
      if (y >= canvas.height) {
        return -1;
      }
      const data = context.getImageData(0, y, canvas.width, Math.min(rows, canvas.height - y)).data;
      let right = -1;
      for (let row = 0; row < rows; row += 1) {
        for (let x = 0; x < canvas.width; x += 1) {
          if ((data[(row * canvas.width + x) * 4 + 3] ?? 0) > 12) {
            right = Math.max(right, x);
          }
        }
      }
      return right < 0 ? -1 : right / dpr;
    },
    { startY, height },
  );
}

test("E2E-001 long documents show a non-empty right rail", async ({ page }) => {
  await openFile(page, "long.md");
  await waitOn(page);

  const info = await page.evaluate(() => {
    const editor = document.querySelector<HTMLElement>(".cm-editor")!;
    const rail = editor.querySelector<HTMLElement>(":scope > .qm-minimap")!;
    const canvas = rail.querySelector<HTMLCanvasElement>("canvas")!;
    const rect = rail.getBoundingClientRect();
    return {
      state: rail.dataset.minimapState,
      display: getComputedStyle(rail).display,
      visibility: getComputedStyle(rail).visibility,
      paddingRight: editor.style.paddingRight,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      railWidth: rect.width,
      railHeight: rect.height,
      dpr: window.devicePixelRatio,
      render: rail.dataset.minimapRender,
      lineHeight: rail.dataset.minimapLineHeight,
      charWidth: rail.dataset.minimapCharWidth,
    };
  });
  expect(info.state).toBe("on");
  expect(info.display).not.toBe("none");
  expect(info.visibility).toBe("visible");
  expect(info.paddingRight).toBe("88px");
  expect(info.render).toBe("rendered");
  expect(Number(info.lineHeight)).toBeGreaterThanOrEqual(2);
  expect(Number(info.charWidth)).toBeGreaterThanOrEqual(1);
  expect(info.canvasWidth).toBeGreaterThan(1);
  expect(info.canvasHeight).toBeGreaterThan(1);
  expect(Math.abs(info.canvasWidth - Math.round(info.railWidth * info.dpr))).toBeLessThanOrEqual(1);
  expect(Math.abs(info.canvasHeight - Math.round(info.railHeight * info.dpr))).toBeLessThanOrEqual(
    1,
  );
  expect(await canvasColors(page)).not.toHaveLength(0);
});

test("E2E-002 short documents keep the existing layout untouched", async ({ page }) => {
  await openApp(page, [
    { path: NOTE_PATH, text: readFileSync(path.join(__dirname, "fixtures", "note.md"), "utf8") },
  ]);
  await openSeededFile(page, "note.md");
  await expect(rail(page)).toHaveAttribute("data-minimap-state", "off");

  const result = await page.evaluate(() => {
    const editor = document.querySelector<HTMLElement>(".cm-editor")!;
    const rail = editor.querySelector<HTMLElement>(":scope > .qm-minimap")!;
    return {
      state: rail.dataset.minimapState,
      display: getComputedStyle(rail).display,
      paddingRight: editor.style.paddingRight,
      contentInset: Number.parseFloat(
        getComputedStyle(document.querySelector(".cm-content")!).paddingLeft,
      ),
      scrollbarReplaced: document
        .querySelector(".cm-scroller")!
        .hasAttribute("data-minimap-scrollbar"),
      scrollbarWidth: getComputedStyle(document.querySelector(".cm-scroller")!).scrollbarWidth,
    };
  });
  expect(result.state).toBe("off");
  expect(result.display).toBe("none");
  expect(result.paddingRight).toBe("");
  expect(result.contentInset).toBe(20);
  expect(result.scrollbarReplaced).toBe(false);
  expect(result.scrollbarWidth).not.toBe("none");
});

test("E2E-003 clicking the track navigates monotonically", async ({ page }) => {
  await openFile(page, "navigation.md", numberedDocument(300));
  await waitOn(page);
  const box = await rail(page).boundingBox();
  expect(box).not.toBeNull();
  const trackTop = box!.y + 6;
  const trackHeight = box!.height - 12;

  const values: number[] = [];
  for (const ratio of [0.25, 0.5, 0.75]) {
    await page.mouse.click(box!.x + box!.width / 2, trackTop + trackHeight * ratio);
    await page.waitForTimeout(200);
    values.push(await scrollTop(page));
  }
  expect(values[0]).toBeGreaterThan(0);
  expect(values[1]).toBeGreaterThan(values[0]!);
  expect(values[2]).toBeGreaterThan(values[1]!);
  const max = await page
    .locator(".cm-scroller")
    .first()
    .evaluate((element) => element.scrollHeight - element.clientHeight);
  expect(values[2]).toBeLessThanOrEqual(max);
});

test("E2E-004 dragging the slider reaches both ends without leaving the track", async ({
  page,
}) => {
  await openFile(page, "drag.md", numberedDocument(400));
  await waitOn(page);
  const box = await rail(page).boundingBox();
  const slider = page.locator(".cm-editor > .qm-minimap > .qm-minimap-slider");
  const sliderBox = await slider.boundingBox();
  expect(box).not.toBeNull();
  expect(sliderBox).not.toBeNull();

  await page.mouse.move(sliderBox!.x + sliderBox!.width / 2, sliderBox!.y + sliderBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + 6, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const topScroll = await scrollTop(page);
  expect(topScroll).toBeLessThan(100);

  const topSlider = await slider.boundingBox();
  expect(topSlider!.y).toBeGreaterThanOrEqual(box!.y + 5);
  expect(topSlider!.y).toBeLessThanOrEqual(box!.y + 8);

  const current = await slider.boundingBox();
  await page.mouse.move(current!.x + current!.width / 2, current!.y + current!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height - 6, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const bottomScroll = await scrollTop(page);
  expect(bottomScroll).toBeGreaterThan(topScroll);

  const bottomSlider = await slider.boundingBox();
  expect(bottomSlider!.y + bottomSlider!.height).toBeLessThanOrEqual(box!.y + box!.height - 5);
  expect(bottomSlider!.y + bottomSlider!.height).toBeGreaterThanOrEqual(box!.y + box!.height - 9);
});

test("E2E-005 the wheel scrolls the editor while the pointer is over the rail", async ({
  page,
}) => {
  await openFile(page, "wheel.md", numberedDocument(300));
  await waitOn(page);
  const before = await scrollTop(page);
  await rail(page).hover();
  await page.mouse.wheel(0, 600);
  await expect.poll(() => scrollTop(page)).toBeGreaterThan(before);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test("E2E-006 theme switching repaints the same canvas", async ({ page }) => {
  await openFile(page, "palette.md", variedDocument());
  await waitOn(page);
  const beforeColors = await canvasColors(page);
  const canvasHandle = await page.locator(".cm-editor > .qm-minimap > canvas").elementHandle();
  expect(canvasHandle).not.toBeNull();

  await emitMenuAction(page, "view.toggleTheme");
  await expect.poll(() => canvasColors(page)).not.toEqual(beforeColors);
  const afterColors = await canvasColors(page);
  expect(beforeColors.length).toBeGreaterThanOrEqual(4);
  expect(afterColors.length).toBeGreaterThanOrEqual(4);
  expect(afterColors).not.toEqual(beforeColors);
  const sameCanvas = await page.evaluate((handle) => {
    return document.querySelector(".cm-editor > .qm-minimap > canvas") === handle;
  }, canvasHandle);
  expect(sameCanvas).toBe(true);
});

test("E2E-007 source and live preview both keep a working rail", async ({ page }) => {
  await openFile(page, "modes.md", numberedDocument(220));
  await waitOn(page);
  const paddingBefore = await page
    .locator(".cm-editor")
    .first()
    .evaluate((element) => element.style.paddingRight);
  expect(paddingBefore).toBe("88px");

  await emitMenuAction(page, "view.toggleLivePreview");
  await waitOn(page);
  expect(
    await page
      .locator(".cm-editor")
      .first()
      .evaluate((element) => element.style.paddingRight),
  ).toBe("88px");
  expect(await rail(page).getAttribute("data-minimap-render")).toBe("text");
  expect(await page.locator(".cm-scroller").first().getAttribute("data-minimap-scrollbar")).toBe(
    "hidden",
  );

  const box = await rail(page).boundingBox();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height * 0.5);
  await expect.poll(() => scrollTop(page)).toBeGreaterThan(0);

  await emitMenuAction(page, "view.toggleLivePreview");
  await waitOn(page);
  expect(
    await page
      .locator(".cm-editor")
      .first()
      .evaluate((element) => element.style.paddingRight),
  ).toBe("88px");
  expect(await rail(page).getAttribute("data-minimap-render")).toBe("rendered");
  expect(await page.locator(".cm-scroller").first().getAttribute("data-minimap-scrollbar")).toBe(
    "hidden",
  );
});

test("E2E-008 resize adds and removes the reserve without overflow", async ({ page }) => {
  await openFile(page, "resize.md", numberedDocument(220));
  await waitOn(page);
  const measure = () =>
    page.evaluate(() => {
      const editor = document.querySelector<HTMLElement>(".cm-editor")!;
      const rail = editor.querySelector<HTMLElement>(":scope > .qm-minimap")!;
      return {
        viewport: window.innerWidth,
        editorWidth: editor.getBoundingClientRect().width,
        paddingRight: editor.style.paddingRight,
        railLeft: rail.getBoundingClientRect().left,
        scrollerRight: document.querySelector(".cm-scroller")!.getBoundingClientRect().right,
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        state: rail.dataset.minimapState,
        scrollbarReplaced: document
          .querySelector(".cm-scroller")!
          .hasAttribute("data-minimap-scrollbar"),
        scrollbarWidth: getComputedStyle(document.querySelector(".cm-scroller")!).scrollbarWidth,
      };
    });

  await page.setViewportSize({ width: 800, height: 720 });
  await waitOn(page);
  const wide = await measure();
  expect(wide.editorWidth).toBe(wide.viewport);
  expect(wide.paddingRight).toBe("88px");
  expect(wide.railLeft).toBeGreaterThanOrEqual(wide.scrollerRight - 1);
  expect(wide.overflow).toBeLessThanOrEqual(1);
  expect(wide.scrollbarReplaced).toBe(true);
  expect(wide.scrollbarWidth).toBe("none");

  await page.setViewportSize({ width: 600, height: 720 });
  await expect(rail(page)).toHaveAttribute("data-minimap-state", "off");
  const narrow = await measure();
  expect(narrow.paddingRight).toBe("");
  expect(narrow.overflow).toBeLessThanOrEqual(1);
  expect(narrow.scrollbarReplaced).toBe(false);
  expect(narrow.scrollbarWidth).not.toBe("none");

  await page.setViewportSize({ width: 1200, height: 720 });
  await waitOn(page);
  const restored = await measure();
  expect(restored.paddingRight).toBe("88px");
  expect(restored.overflow).toBeLessThanOrEqual(1);
  expect(restored.scrollbarReplaced).toBe(true);
  expect(restored.scrollbarWidth).toBe("none");
});

test("E2E-009 navigation stays stable across a large table widget", async ({ page }) => {
  const table = [
    "| A | B |",
    "|---|---|",
    ...Array.from({ length: 30 }, (_, index) => `| ${index} | ${index + 1} |`),
  ].join("\n");
  const text = `${numberedDocument(80)}\n\n${table}\n\n${numberedDocument(80, "tail")}`;
  await openFile(page, "widget.md", text);
  await waitOn(page);
  const box = await rail(page).boundingBox();
  const values: number[] = [];
  for (const ratio of [0.4, 0.55, 0.7]) {
    await page.mouse.click(box!.x + box!.width / 2, box!.y + 6 + (box!.height - 12) * ratio);
    await page.waitForTimeout(200);
    values.push(await scrollTop(page));
  }
  expect(values[0]).toBeGreaterThan(0);
  expect(values[1]).toBeGreaterThan(values[0]!);
  expect(values[2]).toBeGreaterThan(values[1]!);
  expect(await page.locator(".cm-editor").count()).toBeGreaterThanOrEqual(1);
});

test("E2E-010 a clean external reload keeps exactly one rail", async ({ page }) => {
  await openFile(page, "reload.md", numberedDocument(200));
  await waitOn(page);
  await setDiskText(page, "/docs/reload.md", `${numberedDocument(220, "reloaded")}\n`);
  await expect(page.locator(".cm-content")).toContainText("reloaded 1");
  await expect(page.locator(".cm-editor > .qm-minimap")).toHaveCount(1);
  await waitOn(page);
  const max = await page
    .locator(".cm-scroller")
    .first()
    .evaluate((element) => element.scrollHeight - element.clientHeight);
  const top = await scrollTop(page);
  expect(top).toBeGreaterThanOrEqual(0);
  expect(top).toBeLessThanOrEqual(max);
});

test("E2E-011 documents over the line limit hide the rail", async ({ page }) => {
  test.setTimeout(120_000);
  await openFile(page, "huge.md", numberedDocument(100_001, "x"));
  await expect(rail(page)).toHaveAttribute("data-minimap-state", "off");
  expect(
    await page
      .locator(".cm-editor")
      .first()
      .evaluate((element) => element.style.paddingRight),
  ).toBe("");
});

test("E2E-012 the rail is decorative and native keyboard scrolling still works", async ({
  page,
}) => {
  await openFile(page, "a11y.md", numberedDocument(220));
  await waitOn(page);
  const attributes = await rail(page).evaluate((element) => ({
    ariaHidden: element.getAttribute("aria-hidden"),
    tabindex: element.getAttribute("tabindex"),
    tabIndex: element.tabIndex,
  }));
  expect(attributes.ariaHidden).toBe("true");
  expect(attributes.tabindex).toBeNull();
  expect(attributes.tabIndex).toBe(-1);
  expect(await page.locator(".cm-scroller").first().getAttribute("data-minimap-scrollbar")).toBe(
    "hidden",
  );

  await editorContent(page).click();
  const before = await scrollTop(page);
  await page.keyboard.press("PageDown");
  await expect.poll(() => scrollTop(page)).toBeGreaterThan(before);
});

test("E2E-013 the canvas carries multiple structural colours", async ({ page }) => {
  await openFile(page, "structure.md", variedDocument());
  await waitOn(page);
  const colors = await canvasColors(page);
  expect(colors.length).toBeGreaterThanOrEqual(4);
});

test("E2E-014 clicking the rail brings a known heading into view", async ({ page }) => {
  await openFile(page, "headings.md", headingDocument());
  await waitOn(page);
  const box = await rail(page).boundingBox();
  const ratio = 150 / 300;
  await page.mouse.click(box!.x + box!.width / 2, box!.y + 6 + (box!.height - 12) * ratio);
  await page.waitForTimeout(250);

  const heading = page.locator(".cm-line").filter({ hasText: "Section 6" }).first();
  await expect(heading).toBeVisible();
  const inView = await heading.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < window.innerHeight;
  });
  expect(inView).toBe(true);
});

test("E2E-015 source mode preserves real line lengths in its miniature", async ({ page }) => {
  const longLine = "long ".repeat(30);
  await openFile(page, "scale.md", `short\n${longLine}\n${numberedDocument(90)}`);
  await waitOn(page);
  await emitMenuAction(page, "view.toggleLivePreview");
  await waitOn(page);

  expect(await rail(page).getAttribute("data-minimap-render")).toBe("text");
  const lineHeight = Number(await rail(page).getAttribute("data-minimap-line-height"));
  expect(lineHeight).toBeGreaterThanOrEqual(2);

  const shortRight = await rightmostInk(page, 6, lineHeight);
  const longRight = await rightmostInk(page, 6 + lineHeight, lineHeight);
  expect(shortRight).toBeGreaterThan(0);
  expect(longRight).toBeGreaterThan(shortRight + 20);
});

test("E2E-016 live preview draws rendered blocks while source keeps raw text", async ({ page }) => {
  const text = [
    "# Rendered heading",
    "",
    "A paragraph with **bold** and [a link](https://example.com).",
    "",
    "```ts",
    "const value = 1;",
    "const next = value + 1;",
    "```",
    "",
    "| A | B | C |",
    "|---|---|---|",
    "| 1 | 2 | 3 |",
    "",
    ...Array.from({ length: 90 }, (_, index) => `Paragraph ${index + 1}: the quick brown fox.`),
  ].join("\n");
  await openFile(page, "rendered.md", text);
  await waitOn(page);
  expect(await rail(page).getAttribute("data-minimap-render")).toBe("rendered");
  const rendered = await canvasHash(page);

  await emitMenuAction(page, "view.toggleLivePreview");
  await waitOn(page);
  expect(await rail(page).getAttribute("data-minimap-render")).toBe("text");
  const source = await canvasHash(page);
  expect(source).not.toBe(rendered);
});

test("E2E-017 the rail replaces the native vertical scrollbar", async ({ page }) => {
  await openFile(page, "scrollbar.md", numberedDocument(260));
  await waitOn(page);

  const metrics = () =>
    page
      .locator(".cm-scroller")
      .first()
      .evaluate((element) => {
        const pseudo = getComputedStyle(element, "::-webkit-scrollbar");
        const rail = document.querySelector<HTMLElement>(".cm-editor > .qm-minimap")!;
        return {
          attr: element.getAttribute("data-minimap-scrollbar"),
          scrollbarWidth: getComputedStyle(element).scrollbarWidth,
          pseudoWidth: pseudo.width,
          overflowY: getComputedStyle(element).overflowY,
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
          scrollerRight: element.getBoundingClientRect().right,
          railLeft: rail.getBoundingClientRect().left,
        };
      });

  const hidden = await metrics();
  expect(hidden.attr).toBe("hidden");
  expect(hidden.scrollbarWidth).toBe("none");
  expect(hidden.pseudoWidth).toBe("0px");
  // `overflow: auto` must stay: the scroller is still the single scroll source.
  expect(hidden.overflowY).toBe("auto");
  expect(hidden.scrollHeight).toBeGreaterThan(hidden.clientHeight);
  expect(hidden.railLeft).toBeGreaterThanOrEqual(hidden.scrollerRight);

  const box = await rail(page).boundingBox();
  expect(box).not.toBeNull();
  const sliderBefore = await page
    .locator(".cm-editor > .qm-minimap > .qm-minimap-slider")
    .first()
    .evaluate((element) => element.style.transform);
  const beforeWheel = await scrollTop(page);
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, 600);
  await expect.poll(() => scrollTop(page)).toBeGreaterThan(beforeWheel);
  expect(
    await page
      .locator(".cm-editor > .qm-minimap > .qm-minimap-slider")
      .first()
      .evaluate((element) => element.style.transform),
  ).not.toBe(sliderBefore);

  await emitMenuAction(page, "view.toggleLivePreview");
  await waitOn(page);
  expect((await metrics()).attr).toBe("hidden");
});
