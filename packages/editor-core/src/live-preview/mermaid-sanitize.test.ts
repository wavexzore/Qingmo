import { describe, expect, it } from "vitest";

import { sanitizeMermaidSvg } from "./mermaid-sanitize";

describe("sanitizeMermaidSvg", () => {
  it("keeps the safe SVG subset and drops active content", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">' +
      "<style>.node{fill:#eef}</style>" +
      '<g class="node">' +
      '<rect x="0" y="0" width="20" height="20" onload="alert(1)"/>' +
      '<text x="2" y="10" xlink:href="javascript:alert(1)">Hello &amp; welcome</text>' +
      "</g>" +
      '<foreignObject width="10" height="10"><div>html label</div></foreignObject>' +
      "<script>alert(1)</script>" +
      "</svg>";

    const sanitized = sanitizeMermaidSvg(svg);

    expect(sanitized).toContain("<svg");
    expect(sanitized).toContain("<rect");
    expect(sanitized).toContain("Hello &amp; welcome");
    expect(sanitized).not.toContain("foreignObject");
    expect(sanitized).not.toContain("script");
    expect(sanitized).not.toContain("onload");
    expect(sanitized).not.toContain("xlink:href");
  });

  it("strips external URLs and imports from style elements", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg">' +
      '<style>@import url("https://evil.example/x.css"); .a{fill:url(https://evil.example/x)}</style>' +
      '<rect style="fill:url(javascript:alert(1))" fill="url(https://evil.example/y)"/>' +
      "</svg>";

    const sanitized = sanitizeMermaidSvg(svg);

    expect(sanitized).not.toContain("https://evil.example");
    expect(sanitized).not.toContain("javascript:");
    expect(sanitized).toContain("<rect");
  });

  it("rejects input that is not an SVG document", () => {
    expect(sanitizeMermaidSvg("<div>not a diagram</div>")).toBe("");
    expect(sanitizeMermaidSvg("")).toBe("");
  });
});
