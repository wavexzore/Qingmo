import type {
  BlockContext,
  LeafBlock,
  LeafBlockParser,
  Line,
  MarkdownConfig,
} from "@lezer/markdown";

const EQ = 61; /* = */
const DASH = 45; /* - */

/** Mirrors Lezer's internal whitespace test for setext underlines. */
function isSpace(ch: number): boolean {
  return ch === 32 || ch === 9 || ch === 10 || ch === 13;
}

/**
 * Returns the end of a setext underline inside `line`, or -1 when the line is
 * not one. Unlike Lezer's built-in check, a single `-` or `=` is not enough:
 * Typora requires at least two characters before it rewrites the paragraph
 * above into a heading.
 */
function setextUnderlineEnd(line: Line): number {
  if ((line.next !== EQ && line.next !== DASH) || line.indent >= line.baseIndent + 4) {
    return -1;
  }
  let pos = line.pos + 1;
  while (pos < line.text.length && line.text.charCodeAt(pos) === line.next) {
    pos += 1;
  }
  if (pos - line.pos < 2) {
    return -1;
  }
  const end = pos;
  while (pos < line.text.length && isSpace(line.text.charCodeAt(pos))) {
    pos += 1;
  }
  return pos === line.text.length ? end : -1;
}

/**
 * A line that the built-in parser would accept as a setext underline but
 * Typora rejects: a single `-` or `=` with only trailing whitespace.
 */
function isLoneSetextMarker(line: Line): boolean {
  return (
    (line.next === EQ || line.next === DASH) &&
    line.indent < line.baseIndent + 4 &&
    line.skipSpace(line.pos + 1) === line.text.length
  );
}

class MinimumSetextHeadingParser implements LeafBlockParser {
  nextLine(cx: BlockContext, line: Line, leaf: LeafBlock): boolean {
    // `Line.depth` is part of the runtime API used by the built-in parser but
    // is not declared in `@lezer/markdown`'s public types.
    const depth = (line as Line & { depth: number }).depth;
    if (depth >= cx.depth) {
      const underline = setextUnderlineEnd(line);
      if (underline >= 0) {
        const next = line.next;
        const headerMark = cx.elt("HeaderMark", cx.lineStart + line.pos, cx.lineStart + underline);
        cx.nextLine();
        cx.addLeafElement(
          leaf,
          cx.elt(next === EQ ? "SetextHeading1" : "SetextHeading2", leaf.start, cx.prevLineEnd(), [
            ...cx.parser.parseInline(leaf.content, leaf.start),
            headerMark,
          ]),
        );
        return true;
      }
      if (isLoneSetextMarker(line)) {
        // The built-in SetextHeading parser stays registered so that `---`
        // keeps its setext precedence over thematic breaks. Hide the lone
        // marker from it by clearing the cached "next character" code; the
        // line text is still appended to the paragraph below, and `readLine`
        // recomputes `next` for every following line.
        line.next = 0;
      }
    }
    return false;
  }

  finish(): boolean {
    return false;
  }
}

/**
 * Typora only recognises `==` / `--` (or longer) as setext underlines.
 * CommonMark accepts a single character, which turns the line above into a
 * heading the moment the user starts a list, so this replaces the built-in
 * leaf parser with the stricter Typora rule while keeping the built-in
 * parser registered for its horizontal-rule precedence.
 */
export const typoraSetextExtension: MarkdownConfig = {
  parseBlock: [
    {
      name: "QingmoSetextHeading",
      before: "SetextHeading",
      leaf() {
        return new MinimumSetextHeadingParser();
      },
    },
  ],
};
