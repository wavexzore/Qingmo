import { ensureSyntaxTree } from "@codemirror/language";
import { describe, expect, it } from "vitest";

import { createEditorState } from "../index";
import { readMediaBlocks } from "./media-blocks";

function stateFor(doc: string) {
  const state = createEditorState({ doc });
  ensureSyntaxTree(state, state.doc.length, 2_000);
  return state;
}

describe("readMediaBlocks", () => {
  it("reads video attributes and source children", () => {
    const blocks = readMediaBlocks(
      stateFor(
        '<video src="./demo.mp4" poster="./cover.png" controls width="480" title="Demo">\n' +
          '<source src="./demo.webm" type="video/webm" />\n' +
          "</video>\n",
      ),
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe("video");
    expect(blocks[0]?.src).toBe("./demo.mp4");
    expect(blocks[0]?.poster).toBe("./cover.png");
    expect(blocks[0]?.width).toBe("480");
    expect(blocks[0]?.title).toBe("Demo");
    expect(blocks[0]?.sources).toEqual([
      { src: "./demo.webm", srcset: null, type: "video/webm", media: null },
    ]);
  });

  it("reads audio without an inline src and picture sources", () => {
    const audio = readMediaBlocks(
      stateFor('<audio controls>\n<source src="./demo.mp3" type="audio/mpeg" />\n</audio>\n'),
    );
    expect(audio[0]?.kind).toBe("audio");
    expect(audio[0]?.src).toBeNull();
    expect(audio[0]?.sources[0]?.src).toBe("./demo.mp3");

    const picture = readMediaBlocks(
      stateFor(
        "<picture>\n" +
          '<source srcset="./dark.png" media="(prefers-color-scheme: dark)" />\n' +
          '<img src="./light.png" alt="Logo" width="200" />\n' +
          "</picture>\n",
      ),
    );
    expect(picture[0]?.kind).toBe("picture");
    expect(picture[0]?.src).toBe("./light.png");
    expect(picture[0]?.alt).toBe("Logo");
    expect(picture[0]?.width).toBe("200");
    expect(picture[0]?.sources[0]?.srcset).toBe("./dark.png");
    expect(picture[0]?.sources[0]?.media).toBe("(prefers-color-scheme: dark)");
  });

  it("reads iframe embeds as inert cards", () => {
    const blocks = readMediaBlocks(
      stateFor(
        '<iframe src="https://example.com/demo" width="480" height="270" title="Demo"></iframe>\n',
      ),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe("iframe");
    expect(blocks[0]?.src).toBe("https://example.com/demo");
    expect(blocks[0]?.width).toBe("480");
    expect(blocks[0]?.height).toBe("270");
    expect(blocks[0]?.alt).toBe("https://example.com/demo");
    expect(blocks[0]?.title).toBe("Demo");
  });

  it("reads figures, standalone images and centered image containers", () => {
    const figure = readMediaBlocks(
      stateFor(
        "<figure>\n" +
          '<img src="./arch.png" alt="架构图" width="400" height="200" title="架构" />\n' +
          "<figcaption>图 1：**系统**架构示意</figcaption>\n" +
          "</figure>\n",
      ),
    );
    expect(figure).toHaveLength(1);
    expect(figure[0]).toMatchObject({
      kind: "figure",
      src: "./arch.png",
      alt: "架构图",
      width: "400",
      height: "200",
      title: "架构",
      caption: "图 1：**系统**架构示意",
    });

    const image = readMediaBlocks(
      stateFor('<img src="./pic.png" alt="示例" width="50%" height="150" />\n'),
    );
    expect(image[0]).toMatchObject({
      kind: "img",
      src: "./pic.png",
      alt: "示例",
      width: "50%",
      height: "150",
    });

    const center = readMediaBlocks(
      stateFor(
        '<div align="center">\n<img src="./center.png" alt="居中图片" width="320" />\n</div>\n',
      ),
    );
    expect(center[0]).toMatchObject({
      kind: "center",
      src: "./center.png",
      alt: "居中图片",
      width: "320",
    });
  });

  it("rejects unsafe URLs and incomplete tags", () => {
    const blocks = readMediaBlocks(
      stateFor('<video src="javascript:alert(1)" controls></video>\n\n<video src="./x.mp4">\n'),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.src).toBeNull();
  });

  it("ignores code fences and media nested inside details", () => {
    expect(
      readMediaBlocks(stateFor('```html\n<video src="./demo.mp4" controls></video>\n```\n')),
    ).toEqual([]);
    expect(
      readMediaBlocks(
        stateFor(
          "<details>\n<summary>x</summary>\n\n" +
            '<video src="./demo.mp4" controls></video>\n\n' +
            "</details>\n",
        ),
      ),
    ).toEqual([]);
  });
});
