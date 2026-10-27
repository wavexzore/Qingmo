import type { MarkdownConfig } from "@lezer/markdown";

import "katex/dist/katex.min.css";

/**
 * Inline `$...$` math. KaTeX rendering happens in the widget layer; the parser
 * only needs to expose the opaque span so the live preview can replace it.
 *
 * Deliberately conservative:
 * - `$$` is left to the block math field.
 * - escaped `\$`, a leading/trailing space, or a line break cancels the span,
 *   which keeps currency like `$5 and $10` as text.
 */
export const mathExtension: MarkdownConfig = {
  defineNodes: [{ name: "InlineMath" }],
  parseInline: [
    {
      name: "InlineMath",
      parse(cx, next, pos) {
        if (next !== 36 /* $ */ || cx.char(pos + 1) === 36) {
          return -1;
        }
        if (pos > 0 && cx.char(pos - 1) === 92 /* \ */) {
          return -1;
        }
        const first = cx.char(pos + 1);
        if (first === 32 || first === 9 || first === 10) {
          return -1;
        }

        let end = pos + 1;
        while (end < cx.end) {
          const ch = cx.char(end);
          if (ch === 92) {
            end += 2;
            continue;
          }
          if (ch === 10) {
            return -1;
          }
          if (ch === 36) {
            break;
          }
          end += 1;
        }

        if (end >= cx.end || end === pos + 1 || cx.char(end + 1) === 36) {
          return -1;
        }
        const before = cx.char(end - 1);
        if (before === 32 || before === 9) {
          return -1;
        }
        return cx.addElement(cx.elt("InlineMath", pos, end + 1));
      },
      after: "Emphasis",
    },
  ],
};
