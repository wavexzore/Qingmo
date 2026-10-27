import { expect, test } from "@playwright/test";

import { openApp, openSeededFile } from "./helpers";

const FLOW_DOC = `# Mermaid 图版

\`\`\`mermaid
flowchart TB
  A[想法] --> B[草稿]
  B --> C{可以发布?}
  C -- 是 --> D[完成]
  C -- 否 --> B
\`\`\`

结尾段落
`;

const BROKEN_DOC = `# 损坏的图表

\`\`\`mermaid
flowchart TB
  A[Start] -->
\`\`\`

结尾段落
`;

const WIDE_DOC = `# 宽图与长行

这是一段刻意写得很长的说明文字，用来模拟真实文档中不会自动断行的长段落。它包含中文、英文 Mixed Content、行内代码与链接，长度足以在没有软换行时把编辑器内容撑到窗口宽度之外。这是一段刻意写得很长的说明文字，用来模拟真实文档中不会自动断行的长段落。它包含中文、英文 Mixed Content、行内代码与链接，长度足以在没有软换行时把编辑器内容撑到窗口宽度之外。

\`\`\`mermaid
flowchart LR
  A[第一步] --> B[第二步] --> C[第三步] --> D[第四步] --> E[第五步] --> F[第六步] --> G[第七步] --> H[第八步]
\`\`\`

结尾段落
`;

const OVERSIZED_DOC = `# 超大图表

\`\`\`mermaid
flowchart LR
  ${Array.from({ length: 12 }, (_, index) => `W${index}["第 ${index + 1} 步 · 处理传输数据"]`).join(" --> ")}
\`\`\`

\`\`\`mermaid
flowchart TB
  ${Array.from({ length: 16 }, (_, index) => `T${index}[节点 ${index + 1}]`).join("\n  ")}
  ${Array.from({ length: 15 }, (_, index) => `T${index} --> T${index + 1}`).join("\n  ")}
\`\`\`

结尾段落
`;

const STATE_DOC = `# 状态图

\`\`\`mermaid
stateDiagram-v2
  [*] --> 空闲
  空闲 --> 写入中 : 收到请求
  写入中 --> 完成 : 成功
  写入中 --> 失败 : 失败
  完成 --> [*]
  失败 --> [*]
\`\`\`

结尾段落
`;

const MERGED_ARROWS_DOC = `# 汇合箭头

\`\`\`mermaid
stateDiagram-v2
  state "等待审核" as Pending
  [*] --> Pending
  Pending --> Approved : 通过
  Pending --> Rejected : 驳回
  Approved --> [*]
  Rejected --> [*]
\`\`\`

结尾段落
`;

test("card chrome exposes the kind, hover tools and working zoom", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openApp(page, [{ path: "/docs/mermaid-card.md", text: FLOW_DOC }]);
  await openSeededFile(page, "mermaid-card.md");

  const card = page.locator(".cm-md-mermaid").first();
  await expect(card.locator("svg")).toBeVisible({ timeout: 30_000 });
  await expect(card).toHaveAttribute("role", "group");
  await expect(card).toHaveAttribute("data-mermaid-kind", "flowchart");
  await expect(card.locator(".cm-md-mermaid-badge")).toHaveText("MERMAID");
  await expect(card.locator(".cm-md-mermaid-kind")).toHaveText("流程图");
  await expect(card.locator(".cm-md-mermaid-hint")).toHaveText("点击「源码」编辑");
  await expect(card.locator("svg")).toHaveAttribute("data-routed-back-edges", "1");

  await card.hover();
  const zoomIn = card.getByRole("button", { name: "放大图表" });
  const zoomReset = card.locator(".cm-md-mermaid-tool").nth(1);
  await expect(zoomIn).toBeVisible();
  await expect(zoomReset).toHaveText("100%");
  await expect(zoomReset).toHaveCSS("white-space", "nowrap");

  const before = await card.locator("svg").evaluate((svg) => svg.getBoundingClientRect().width);
  await zoomIn.click();
  await zoomIn.click();
  await expect(zoomReset).toHaveText("120%");
  const after = await card.locator("svg").evaluate((svg) => svg.getBoundingClientRect().width);
  expect(after).toBeGreaterThan(before);

  await zoomReset.click();
  await expect(zoomReset).toHaveText("100%");
  const reset = await card.locator("svg").evaluate((svg) => svg.getBoundingClientRect().width);
  expect(reset).toBeCloseTo(before, 0);

  const zoomOut = card.getByRole("button", { name: "缩小图表" });
  for (let index = 0; index < 10; index += 1) {
    await zoomOut.click();
  }
  await expect(zoomReset).toHaveText("1%");
  await expect(zoomOut).toBeDisabled();

  await card.getByRole("button", { name: "编辑 Mermaid 源码" }).click();
  await expect(card).toHaveCount(0);
  await expect(page.locator(".cm-line").filter({ hasText: "flowchart TB" }).first()).toBeVisible();
});

test("state diagram keeps its terminal marker clear of the card edge", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openApp(page, [{ path: "/docs/state-card.md", text: STATE_DOC }]);
  await openSeededFile(page, "state-card.md");

  const card = page.locator(".cm-md-mermaid").first();
  await expect(card.locator("svg")).toBeVisible({ timeout: 30_000 });

  const geometry = await card.evaluate((element) => {
    const svg = element.querySelector("svg");
    const canvas = element.querySelector(".cm-md-mermaid-canvas");
    if (!svg || !canvas) {
      return null;
    }
    const viewBox = svg.viewBox.baseVal;
    const content = svg.getBBox();
    const canvasBottom = canvas.getBoundingClientRect().bottom;
    const ends = [...svg.querySelectorAll('g[id*="root_end"]')].map(
      (end) => canvasBottom - end.getBoundingClientRect().bottom,
    );
    return {
      terminalCount: ends.length,
      terminalClearance: ends.length > 0 ? Math.min(...ends) : 0,
      viewBoxBottom: viewBox.y + viewBox.height - (content.y + content.height),
      svgInsideCanvas: svg.getBoundingClientRect().bottom <= canvasBottom + 1,
    };
  });

  // Mermaid's hard-coded 8px state frame leaves the final bullseye touching
  // the card border. Production uses an 18px frame plus the canvas padding.
  expect(geometry?.terminalCount).toBeGreaterThan(0);
  expect(geometry?.viewBoxBottom ?? 0).toBeGreaterThanOrEqual(16);
  expect(geometry?.terminalClearance ?? 0).toBeGreaterThanOrEqual(36);
  expect(geometry?.svgInsideCanvas).toBe(true);
});

test("overlapping terminal arrows keep a single arrowhead and all labels", async ({ page }) => {
  await openApp(page, [{ path: "/docs/merged-arrows.md", text: MERGED_ARROWS_DOC }]);
  await openSeededFile(page, "merged-arrows.md");

  const card = page.locator(".cm-md-mermaid").first();
  await expect(card.locator("svg")).toBeVisible({ timeout: 30_000 });

  const result = await card.evaluate((element) => {
    const svg = element.querySelector("svg");
    if (!svg) {
      return null;
    }
    const paths = [...svg.querySelectorAll<SVGPathElement>("g.edgePaths path")];
    const merged = paths.filter((path) => path.getAttribute("data-merged-arrowhead") === "true");
    const decode = (path: SVGPathElement): Array<{ x: number; y: number }> | null => {
      try {
        return JSON.parse(atob(path.getAttribute("data-points") ?? ""));
      } catch {
        return null;
      }
    };
    const mergedPoints = merged[0] ? decode(merged[0]) : null;
    const mergedEnd = mergedPoints?.[mergedPoints.length - 1] ?? null;
    const keptEnd =
      mergedEnd === null
        ? null
        : (paths
            .filter((path) => path !== merged[0])
            .map((path) => decode(path)?.at(-1) ?? null)
            .filter(
              (end): end is { x: number; y: number } =>
                end !== null && Math.hypot(end.x - mergedEnd.x, end.y - mergedEnd.y) < 6,
            )
            .sort(
              (a, b) =>
                Math.hypot(a.x - mergedEnd.x, a.y - mergedEnd.y) -
                Math.hypot(b.x - mergedEnd.x, b.y - mergedEnd.y),
            )[0] ?? null);
    return {
      attribute: svg.getAttribute("data-merged-arrowheads"),
      merged: merged.length,
      hidden: merged.every((path) => getComputedStyle(path).markerEnd === "none"),
      visible: paths.filter((path) => getComputedStyle(path).markerEnd !== "none").length,
      total: paths.length,
      tailGap:
        mergedEnd && keptEnd
          ? { x: Math.abs(mergedEnd.x - keptEnd.x), y: Math.abs(mergedEnd.y - keptEnd.y) }
          : null,
    };
  });

  expect(result?.attribute).toBe("1");
  expect(result?.merged).toBe(1);
  expect(result?.hidden).toBe(true);
  expect(result?.visible).toBe((result?.total ?? 0) - 1);
  expect(result?.tailGap?.x ?? Number.POSITIVE_INFINITY).toBeLessThan(0.01);
  expect(result?.tailGap?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(0.01);
  await expect(card.locator("svg")).toContainText("通过");
  await expect(card.locator("svg")).toContainText("驳回");
});

test("clicking or scrolling the plate keeps it rendered until 源码 is used", async ({ page }) => {
  await openApp(page, [{ path: "/docs/wide-mermaid.md", text: WIDE_DOC }]);
  await openSeededFile(page, "wide-mermaid.md");

  const card = page.locator(".cm-md-mermaid").first();
  const canvas = card.locator(".cm-md-mermaid-canvas");
  await expect(card.locator("svg")).toBeVisible({ timeout: 30_000 });

  // Clicking the diagram must not map the editor selection into the fence.
  await canvas.click();
  await expect(card.locator("svg")).toBeVisible();
  await card.focus();
  await page.keyboard.press("Enter");
  await expect(card).toHaveCount(1);

  // Zooming makes the canvas horizontally scrollable; wheel scrolling and
  // dragging the scrollbar must not reveal the source either.
  await card.hover();
  const zoomIn = card.getByRole("button", { name: "放大图表" });
  for (let step = 0; step < 10; step += 1) {
    await zoomIn.click();
  }
  await expect(card.locator(".cm-md-mermaid-tool").nth(1)).toHaveText("200%");
  const scrollable = await canvas.evaluate((element) => element.scrollWidth > element.clientWidth);
  expect(scrollable).toBe(true);

  await canvas.hover();
  await page.mouse.wheel(240, 0);
  await page.waitForTimeout(200);
  expect(await canvas.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await expect(card.locator("svg")).toBeVisible();

  await canvas.click();
  await expect(card).toHaveCount(1);

  await card.getByRole("button", { name: "编辑 Mermaid 源码" }).click();
  await expect(card).toHaveCount(0);
  await expect(page.locator(".cm-line").filter({ hasText: "flowchart LR" }).first()).toBeVisible();
});

test("zooming keeps the horizontally scrolled diagram anchored", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page, [{ path: "/docs/oversized-mermaid.md", text: OVERSIZED_DOC }]);
  await openSeededFile(page, "oversized-mermaid.md");

  const card = page.locator(".cm-md-mermaid").first();
  const canvas = card.locator(".cm-md-mermaid-canvas");
  const zoomLabel = card.locator(".cm-md-mermaid-tool").nth(1);
  await expect(card.locator("svg")).toBeVisible({ timeout: 30_000 });

  await card.hover();
  const zoomIn = card.getByRole("button", { name: "放大图表" });
  const zoomOut = card.getByRole("button", { name: "缩小图表" });
  for (let step = 0; step < 10; step += 1) {
    await zoomIn.click();
  }
  await expect(zoomLabel).toHaveText("200%");

  await canvas.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  const before = await canvas.evaluate((element) => ({
    left: element.scrollLeft,
    max: element.scrollWidth - element.clientWidth,
  }));
  expect(before.left).toBeGreaterThan(0);

  // Shrinking below the readable floor clamps the canvas offset; growing
  // again must return to the right edge instead of leaving the view stuck
  // near the left, blank part of the diagram.
  for (let step = 0; step < 10; step += 1) {
    await zoomOut.click();
  }
  await expect(zoomLabel).toHaveText("100%");
  for (let step = 0; step < 10; step += 1) {
    await zoomIn.click();
  }
  await expect(zoomLabel).toHaveText("200%");

  const after = await canvas.evaluate((element) => ({
    left: element.scrollLeft,
    max: element.scrollWidth - element.clientWidth,
  }));
  expect(after.max).toBeCloseTo(before.max, 0);
  expect(after.left).toBeGreaterThan(before.left * 0.9);
});

test("render failure keeps the plate and returns to source", async ({ page }) => {
  await openApp(page, [{ path: "/docs/broken-mermaid.md", text: BROKEN_DOC }]);
  await openSeededFile(page, "broken-mermaid.md");

  const card = page.locator(".cm-md-mermaid").first();
  await expect(card.locator(".cm-md-mermaid-error")).toBeVisible({ timeout: 30_000 });
  await expect(card.locator(".cm-md-mermaid-kind")).toHaveText("渲染失败");
  await expect(card.locator(".cm-md-mermaid-error-message")).not.toHaveText("");
  await expect(card.locator(".cm-md-mermaid-edit")).toBeVisible();

  await card.locator(".cm-md-mermaid-edit").click();
  await expect(card).toHaveCount(0);
  await expect(page.locator(".cm-line").filter({ hasText: "flowchart TB" }).first()).toBeVisible();
});

test("long lines and wide diagrams stay inside the window", async ({ page }) => {
  await openApp(page, [{ path: "/docs/wide-mermaid.md", text: WIDE_DOC }]);
  await openSeededFile(page, "wide-mermaid.md");

  const card = page.locator(".cm-md-mermaid").first();
  await expect(card.locator("svg")).toBeVisible({ timeout: 30_000 });

  const metrics = await page.evaluate(() => {
    const scroller = document.querySelector(".cm-scroller");
    const plate = document.querySelector(".cm-md-mermaid");
    return {
      viewport: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      scrollerClient: scroller?.clientWidth ?? 0,
      scrollerScroll: scroller?.scrollWidth ?? 0,
      plateRight: plate?.getBoundingClientRect().right ?? 0,
    };
  });

  expect(metrics.documentWidth).toBe(metrics.viewport);
  expect(metrics.scrollerScroll).toBe(metrics.scrollerClient);
  expect(metrics.plateRight).toBeLessThanOrEqual(metrics.viewport);
});

test("oversized diagrams keep a readable width and only scroll horizontally", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page, [{ path: "/docs/oversized-mermaid.md", text: OVERSIZED_DOC }]);
  await openSeededFile(page, "oversized-mermaid.md");

  const cards = page.locator(".cm-md-mermaid");
  const wide = cards.nth(0);
  const tall = cards.nth(1);
  await expect(wide.locator("svg")).toBeVisible({ timeout: 30_000 });
  await expect(tall.locator("svg")).toBeVisible({ timeout: 30_000 });

  const wideCanvas = wide.locator(".cm-md-mermaid-canvas");
  const beforeFit = await wideCanvas.evaluate((element) => ({
    client: element.clientWidth,
    scroll: element.scrollWidth,
  }));
  expect(beforeFit.scroll).toBeGreaterThan(beforeFit.client);
  expect(
    await wide.locator("svg").evaluate((svg) => svg.getBoundingClientRect().width),
  ).toBeGreaterThan(beforeFit.client);

  const zoomLabel = wide.locator(".cm-md-mermaid-tool").nth(1);
  await expect(zoomLabel).toHaveText("100%");
  await wide.hover();
  const fit = wide.getByRole("button", { name: "适应画布宽度" });
  await expect(fit).toBeVisible();
  await fit.click();
  await expect(zoomLabel).not.toHaveText("100%");
  await expect(fit).toHaveClass(/is-active/);
  const afterFit = await wideCanvas.evaluate((element) => ({
    client: element.clientWidth,
    scroll: element.scrollWidth,
  }));
  expect(afterFit.scroll).toBeLessThanOrEqual(afterFit.client + 1);

  const tallCanvas = tall.locator(".cm-md-mermaid-canvas");
  const tallMetrics = await tallCanvas.evaluate((element) => ({
    client: element.clientHeight,
    scroll: element.scrollHeight,
  }));
  expect(tallMetrics.scroll).toBeLessThanOrEqual(tallMetrics.client + 1);
  expect((await tall.boundingBox())?.height ?? 0).toBeGreaterThan(700);
});
