import { describe, expect, it } from "vitest";

import { buildEditorUiCopy } from "./editorCopy";

const HAN = /[\u4e00-\u9fff]/;

describe("buildEditorUiCopy", () => {
  it("keys the version by language and schema", () => {
    const zh = buildEditorUiCopy("zh-CN");
    const en = buildEditorUiCopy("en");

    expect(zh.version).toBe("zh-CN:1");
    expect(en.version).toBe("en:1");
    expect(zh.version).not.toBe(en.version);
  });

  it("fills every string field for both languages", () => {
    for (const language of ["zh-CN", "en"] as const) {
      const copy = buildEditorUiCopy(language);
      const strings = [
        copy.widgets.externalRender,
        copy.widgets.externalRenderHint("PlantUML"),
        copy.widgets.attributes,
        copy.widgets.footnoteJump,
        copy.widgets.inlineFootnote("content"),
        copy.widgets.inlineFootnoteLabel(1),
        copy.widgets.abbreviation,
        copy.widgets.wikiEmbed("Note"),
        copy.widgets.wikiLink("Note"),
        copy.widgets.htmlAnchor("anchor"),
        copy.widgets.anchorJump("#anchor"),
        copy.widgets.taskToggle,
        copy.details.summary,
        copy.details.empty,
        copy.details.tooLarge,
        copy.details.edit,
        copy.details.editTitle,
        copy.details.wrapperTitle,
        copy.toc.title,
        copy.toc.empty,
        copy.toc.wrapperTitle,
        copy.frontmatter.title,
        copy.frontmatter.wrapperTitle,
        copy.frontmatter.entries(1),
        copy.frontmatter.entries(2),
        copy.frontmatter.empty,
        copy.frontmatter.more(3),
        copy.media.video,
        copy.media.audio,
        copy.media.gallery,
        copy.media.figure,
        copy.media.image,
        copy.media.centeredImage,
        copy.media.embed,
        copy.media.imageEmbedTitle("arch.png"),
        copy.media.externalPage,
        copy.media.externalBlocked,
        copy.media.source,
        copy.media.editSource,
        copy.mermaid.edit,
        copy.mermaid.editTitle,
        copy.mermaid.zoomOut,
        copy.mermaid.zoomReset,
        copy.mermaid.zoomIn,
        copy.mermaid.fitWidth,
        copy.mermaid.fitTitle,
        copy.mermaid.source,
        copy.mermaid.sourceTitle,
        copy.mermaid.hintEdit,
        copy.mermaid.hintScroll,
        copy.mermaid.renderFailed,
        copy.mermaid.unsafeSvg,
        copy.mermaid.invalidSvg,
        copy.mermaid.unavailable,
        copy.mermaid.readyTimeout,
        copy.mermaid.renderTimeout,
        copy.math.editSource,
        copy.table.editSource,
        copy.definitionList.editSource,
        copy.comments.wrapperTitle,
        copy.comments.html,
        copy.comments.obsidian,
        copy.comments.hiddenLines(1),
        copy.comments.hiddenLines(2),
        copy.comments.source,
        copy.comments.editSource,
        ...Object.values(copy.diagramKinds),
      ];

      for (const value of strings) {
        expect(value.trim(), `${language} copy`).not.toBe("");
        expect(value, `${language} copy`).not.toContain("{{");
      }
    }
  });

  it("serves the Chinese product copy and a Han-free English copy", () => {
    const zh = buildEditorUiCopy("zh-CN");
    const en = buildEditorUiCopy("en");

    expect(zh.widgets.inlineFootnoteLabel(1)).toBe("注1");
    expect(zh.media.imageEmbedTitle("arch.png")).toBe("嵌入图片：arch.png");
    expect(zh.frontmatter.wrapperTitle).toBe("点击编辑 Front Matter");
    expect(zh.diagramKinds.flowchart).toBe("流程图");
    expect(zh.diagramKinds.unknown).toBe("图表");

    expect(en.widgets.inlineFootnoteLabel(1)).toBe("Note 1");
    expect(en.media.imageEmbedTitle("arch.png")).toBe("Embedded image: arch.png");
    expect(en.frontmatter.wrapperTitle).toBe("Click to edit Front Matter");
    expect(en.diagramKinds.flowchart).toBe("Flowchart");

    for (const value of [
      ...Object.values(en.widgets),
      ...Object.values(en.details),
      ...Object.values(en.toc),
      ...Object.values(en.frontmatter),
      ...Object.values(en.media),
      ...Object.values(en.mermaid),
      ...Object.values(en.comments),
      ...Object.values(en.diagramKinds),
    ]) {
      if (typeof value === "string") {
        expect(value, "English copy must not contain Han characters").not.toMatch(HAN);
      }
    }
  });
});
