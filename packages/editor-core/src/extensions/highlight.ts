import type { MarkdownConfig } from "@lezer/markdown";

const highlightDelimiter = { resolve: "Highlight", mark: "HighlightMark" };

/**
 * `==text==` highlight is a common Markdown dialect extension (Obsidian,
 * Typora, Bear) but is not part of CommonMark or GFM. Lezer ships Subscript
 * and Superscript extensions but no highlight parser, so this mirrors the
 * built-in Strikethrough delimiter logic: the delimiters are resolved by the
 * regular inline parser, which means nested emphasis inside the highlight
 * keeps working.
 */
export const highlightExtension: MarkdownConfig = {
  defineNodes: [{ name: "Highlight" }, { name: "HighlightMark" }],
  parseInline: [
    {
      name: "Highlight",
      parse(cx, next, pos) {
        if (next !== 61 /* = */ || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61) {
          return -1;
        }
        const before = cx.slice(pos - 1, pos);
        const after = cx.slice(pos + 2, pos + 3);
        const spaceBefore = /\s|^$/.test(before);
        const spaceAfter = /\s|^$/.test(after);
        return cx.addDelimiter(highlightDelimiter, pos, pos + 2, !spaceAfter, !spaceBefore);
      },
      after: "Emphasis",
    },
  ],
};
