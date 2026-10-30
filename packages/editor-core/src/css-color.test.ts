import { describe, expect, it } from "vitest";

import { createTokenReader, normalizeCssColor } from "./css-color";

describe("css-color", () => {
  it("normalizes opaque rgb/rgba values to hex and preserves alpha", () => {
    expect(normalizeCssColor("rgb(255, 0, 16)")).toBe("#ff0010");
    expect(normalizeCssColor("rgba(255, 0, 16, 0.5)")).toBe("rgba(255, 0, 16, 0.5)");
    expect(normalizeCssColor("var(--qm-ink)")).toBe("var(--qm-ink)");
  });

  it("resolves plain tokens and removes the probe on dispose", () => {
    const root = document.createElement("div");
    root.style.setProperty("--qm-test", "rgb(12, 34, 56)");
    document.body.append(root);
    const before = root.querySelectorAll("[aria-hidden='true']").length;
    const reader = createTokenReader(root);

    expect(reader).not.toBeNull();
    expect(reader!.color("--qm-test", "#808080")).toBe("#0c2238");
    expect(root.querySelectorAll("[aria-hidden='true']").length).toBe(before + 1);

    reader!.dispose();
    expect(root.querySelectorAll("[aria-hidden='true']").length).toBe(before);
    root.remove();
  });
});
