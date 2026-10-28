import { describe, expect, it } from "vitest";

import { DEFAULT_EDITOR_UI_COPY, type EditorUiCopy } from "../i18n";
import { mermaidErrorMessage } from "./mermaid-blocks";
import { MermaidRenderError, type MermaidRenderErrorCode } from "./mermaid-render";

const CODES: MermaidRenderErrorCode[] = [
  "unavailable",
  "ready-timeout",
  "render-timeout",
  "render-failed",
  "unsafe-svg",
  "invalid-svg",
];

const zhCopy: EditorUiCopy = {
  ...DEFAULT_EDITOR_UI_COPY,
  version: "zh-CN:1",
  language: "zh-CN",
  mermaid: {
    ...DEFAULT_EDITOR_UI_COPY.mermaid,
    renderFailed: "渲染失败",
    unsafeSvg: "图表内容未通过安全过滤",
    invalidSvg: "图表 SVG 无效",
    unavailable: "Mermaid 渲染器不可用",
    readyTimeout: "Mermaid 渲染器加载超时",
    renderTimeout: "Mermaid 图表渲染超时",
  },
};

describe("mermaidErrorMessage", () => {
  it("maps every internal failure code to localized copy", () => {
    for (const code of CODES) {
      const english = mermaidErrorMessage(DEFAULT_EDITOR_UI_COPY, new MermaidRenderError(code));
      const chinese = mermaidErrorMessage(zhCopy, new MermaidRenderError(code));

      expect(english.trim(), code).not.toBe("");
      expect(english, code).not.toMatch(/[\u4e00-\u9fff]/);
      expect(english, code).not.toBe(code);
      expect(chinese.trim(), code).not.toBe("");
    }

    expect(mermaidErrorMessage(zhCopy, new MermaidRenderError("render-timeout"))).toBe(
      "Mermaid 图表渲染超时",
    );
    expect(mermaidErrorMessage(zhCopy, new MermaidRenderError("invalid-svg"))).toBe(
      "图表 SVG 无效",
    );
  });

  it("falls back to the generic render failure for unknown errors", () => {
    expect(mermaidErrorMessage(DEFAULT_EDITOR_UI_COPY, new Error("raw detail"))).toBe(
      DEFAULT_EDITOR_UI_COPY.mermaid.renderFailed,
    );
  });
});
