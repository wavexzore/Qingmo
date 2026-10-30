import { describe, expect, it } from "vitest";

import { resolveMinimapPalette } from "./theme";

function rootWithTheme(theme: "light" | "dark"): HTMLDivElement {
  const root = document.createElement("div");
  root.dataset.theme = theme;
  const values =
    theme === "light"
      ? {
          "--qm-ink": "rgb(1, 1, 1)",
          "--qm-accent": "rgb(2, 2, 2)",
          "--qm-ink-muted": "rgb(3, 3, 3)",
          "--qm-diagram-accent-2": "rgb(4, 4, 4)",
          "--qm-diagram-accent-3": "rgb(5, 5, 5)",
          "--qm-diagram-accent-4": "rgb(6, 6, 6)",
          "--qm-ink-faint": "rgb(7, 7, 7)",
          "--qm-accent-strong": "rgb(8, 8, 8)",
        }
      : {
          "--qm-ink": "rgb(101, 101, 101)",
          "--qm-accent": "rgb(102, 102, 102)",
          "--qm-ink-muted": "rgb(103, 103, 103)",
          "--qm-diagram-accent-2": "rgb(104, 104, 104)",
          "--qm-diagram-accent-3": "rgb(105, 105, 105)",
          "--qm-diagram-accent-4": "rgb(106, 106, 106)",
          "--qm-ink-faint": "rgb(107, 107, 107)",
          "--qm-accent-strong": "rgb(108, 108, 108)",
        };
  for (const [token, value] of Object.entries(values)) {
    root.style.setProperty(token, value);
  }
  document.body.append(root);
  return root;
}

describe("resolveMinimapPalette", () => {
  it("resolves the six structural families from scoped CSS tokens", () => {
    const root = rootWithTheme("light");
    const palette = resolveMinimapPalette(root);
    expect(palette).toEqual({
      text: "#010101",
      heading: "#020202",
      muted: "#030303",
      code: "#050505",
      diagram: "#060606",
      table: "#040404",
      rule: "#070707",
      selection: "#080808",
    });
    expect(root.querySelectorAll("[aria-hidden='true']").length).toBe(0);
    root.remove();
  });

  it("resolves a different palette in a dark scoped root", () => {
    const light = rootWithTheme("light");
    const dark = rootWithTheme("dark");
    expect(resolveMinimapPalette(light)?.text).not.toBe(resolveMinimapPalette(dark)?.text);
    expect(resolveMinimapPalette(dark)?.text).toBe("#656565");
    light.remove();
    dark.remove();
  });
});
