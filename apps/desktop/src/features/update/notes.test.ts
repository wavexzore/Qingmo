import { describe, expect, it } from "vitest";

import { localizedNotes, resolveNotes } from "./notes";

const marked = [
  "Qingmo 0.1.1 (2026-10-28)",
  "",
  "[zh-CN]",
  "中文",
  "- 修复甲",
  "- 修复乙",
  "",
  "[en-US]",
  "English",
  "- Fix one",
  "- Fix two",
].join("\n");

describe("localizedNotes", () => {
  it("picks the section matching the UI language", () => {
    expect(localizedNotes(marked, "zh-CN")).toBe("- 修复甲\n- 修复乙");
    expect(localizedNotes(marked, "en")).toBe("- Fix one\n- Fix two");
  });

  it("understands the legacy plain headings", () => {
    const legacy = ["中文", "- 中文说明", "", "English", "- English note"].join("\n");
    expect(localizedNotes(legacy, "zh")).toBe("- 中文说明");
    expect(localizedNotes(legacy, "en-US")).toBe("- English note");
  });

  it("leaves a single-language body untouched", () => {
    const body = "Qingmo 0.2.0\n\n- one\n- two\n";
    expect(localizedNotes(body, "zh-CN")).toBe("Qingmo 0.2.0\n\n- one\n- two");
  });

  it("falls back to the other language when a section is empty", () => {
    const body = ["[zh-CN]", "中文", "", "[en-US]", "English", "- notes"].join("\n");
    expect(localizedNotes(body, "zh-CN")).toBe("- notes");
  });

  it("prefers structured notesByLocale and falls back to the body", () => {
    expect(
      resolveNotes({ body: "legacy", notesByLocale: { "zh-CN": "结构化中文" } }, "zh-CN"),
    ).toBe("结构化中文");
    expect(resolveNotes({ body: marked }, "en")).toBe("- Fix one\n- Fix two");
    expect(resolveNotes({ body: null }, "zh")).toBeNull();
  });

  it("normalises CRLF line endings", () => {
    expect(localizedNotes("[zh-CN]\r\n- 甲\r\n[en-US]\r\n- A\r\n", "zh")).toBe("- 甲");
  });
});
