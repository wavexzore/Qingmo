import { expect, test } from "@playwright/test";

import { modifier, openApp, openSeededFile } from "./helpers";

const SOURCE_DOC = `\`\`\`mermaid
graph TB
  A[开始] --> B[处理]
  B --> C[完成]
\`\`\`
`;

test("source-mode multi-line selection inverts every selected line", async ({ page }) => {
  await openApp(page, [{ path: "/docs/selection.md", text: SOURCE_DOC }]);
  await openSeededFile(page, "selection.md");

  const selectLines = async (): Promise<void> => {
    await page.locator(".cm-line").filter({ hasText: "graph TB" }).click();
    await page.keyboard.press("Home");
    await page.keyboard.down("Shift");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("End");
    await page.keyboard.up("Shift");
    await expect(page.locator(".cm-selectionBackground").first()).toBeVisible();
    await expect(page.locator(".cm-selectedText")).toHaveCount(3);
  };

  const selectionStyles = () =>
    page.evaluate(() => {
      const selected = [...document.querySelectorAll(".cm-selectedText")];
      const layers = [...document.querySelectorAll(".cm-selectionBackground")];
      const activeSelected = document.querySelector(".cm-activeLine.cm-selectedLine");
      const probe = document.createElement("span");
      probe.style.color = "var(--qm-surface)";
      probe.style.backgroundColor = "var(--qm-accent)";
      document.body.append(probe);
      const surface = getComputedStyle(probe).color;
      const accent = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return {
        selectedColors: selected.map((element) => getComputedStyle(element).color),
        selectionBackgrounds: layers.map((element) => getComputedStyle(element).backgroundColor),
        activeBackground: activeSelected ? getComputedStyle(activeSelected).backgroundColor : null,
        markerHeight: Math.max(
          0,
          ...layers.map((element) => element.getBoundingClientRect().height),
        ),
        surface,
        accent,
      };
    });

  await selectLines();
  const light = await selectionStyles();
  expect(light.selectedColors).toEqual([light.surface, light.surface, light.surface]);
  expect(new Set(light.selectionBackgrounds)).toEqual(new Set([light.accent]));
  expect(light.activeBackground).toBe("rgba(0, 0, 0, 0)");
  expect(light.markerHeight).toBeGreaterThan(30);

  await page.keyboard.press(`${modifier()}+k`);
  const palette = page.getByRole("dialog", { name: "命令面板" });
  await palette.getByRole("combobox").fill("主题");
  await palette.getByRole("combobox").press("Enter");
  await expect(palette).toBeHidden();

  await selectLines();
  const dark = await selectionStyles();
  expect(dark.selectedColors).toEqual([dark.surface, dark.surface, dark.surface]);
  expect(new Set(dark.selectionBackgrounds)).toEqual(new Set([dark.accent]));
  expect(dark.activeBackground).toBe("rgba(0, 0, 0, 0)");
  expect(dark.markerHeight).toBeGreaterThan(30);
  expect(dark.accent).not.toBe(light.accent);
});
