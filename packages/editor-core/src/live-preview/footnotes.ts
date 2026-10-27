import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

import type { MarkdownNode } from "./markdown-node";

export const FOOTNOTE_DEFINITION = /^\[\^([^\]\n]+)\]:\s*/;
const INLINE_FOOTNOTE = /\^\[([^\]\n]+)\]/g;
const INLINE_LITERAL_NODES = new Set([
  "InlineCode",
  "Link",
  "Image",
  "Autolink",
  "URL",
  "HTMLTag",
  "HTMLBlock",
  "FencedCode",
  "CodeBlock",
  "Comment",
  "CommentBlock",
  "LinkReference",
  "InlineMath",
]);

export interface FootnoteDefinition {
  label: string;
  lineFrom: number;
  lineTo: number;
}

export interface InlineFootnote {
  from: number;
  to: number;
  content: string;
  index: number;
}

export interface FootnoteBlockedRange {
  from: number;
  to: number;
}

function collectLiteralRanges(node: MarkdownNode): FootnoteBlockedRange[] {
  const ranges: FootnoteBlockedRange[] = [];
  let child = node.firstChild;
  while (child) {
    if (INLINE_LITERAL_NODES.has(child.name)) {
      ranges.push({ from: child.from, to: child.to });
    } else {
      ranges.push(...collectLiteralRanges(child));
    }
    child = child.nextSibling;
  }
  return ranges;
}

function isEscaped(doc: EditorState["doc"], position: number): boolean {
  let backslashes = 0;
  for (let index = position - 1; index >= 0; index -= 1) {
    if (doc.sliceString(index, index + 1) !== "\\") {
      break;
    }
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function isInsideInlineComment(doc: EditorState["doc"], position: number): boolean {
  const line = doc.lineAt(position);
  const before = doc.sliceString(line.from, position);
  return (before.match(/%%/g)?.length ?? 0) % 2 === 1;
}

/**
 * Collects Pandoc-style inline footnotes (`^[content]`) in document order.
 * The scan skips code, links, HTML and escaped markers so only prose is
 * rewritten. Numbering is stable across scrolling because the map is built
 * from the whole document once and reused for the visible paragraphs.
 */
export function readInlineFootnotes(
  state: EditorState,
  blocked: readonly FootnoteBlockedRange[] = [],
): Map<number, InlineFootnote> {
  const doc = state.doc;
  const tree = syntaxTree(state);
  const notes = new Map<number, InlineFootnote>();
  let index = 0;

  tree.iterate({
    from: 0,
    to: Math.min(doc.length, tree.length),
    enter(node) {
      if (node.name === "Document") {
        return true;
      }
      const prose = node.name === "Paragraph" || /^(?:ATX|Setext)Heading[1-6]$/.test(node.name);
      if (!prose) {
        return true;
      }
      if (blocked.some((range) => node.from >= range.from && node.to <= range.to)) {
        return false;
      }

      const syntaxNode = node.node as unknown as MarkdownNode;
      const excluded = collectLiteralRanges(syntaxNode);
      const text = doc.sliceString(node.from, node.to);
      INLINE_FOOTNOTE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = INLINE_FOOTNOTE.exec(text))) {
        const from = node.from + match.index;
        const to = from + match[0].length;
        const content = (match[1] ?? "").trim();
        if (!content || isEscaped(doc, from) || isInsideInlineComment(doc, from)) {
          continue;
        }
        // Lezer parses the `[content]` part of `^[content]` as a plain Link.
        // That Link is the inline footnote itself, not a literal destination
        // that should suppress the match; every other excluded subtree still
        // wins.
        const literal = excluded.some(
          (range) =>
            !(range.from === from + 1 && range.to === to) && from < range.to && to > range.from,
        );
        if (literal) {
          continue;
        }
        index += 1;
        notes.set(from, { from, to, content, index });
      }
      return false;
    },
  });

  return notes;
}

/**
 * Collects footnote definitions from top-level paragraphs. A definition can
 * live far away from its reference, so the map is built lazily by the planner
 * and then reused for every visible reference.
 */
export function readFootnoteDefinitions(
  state: EditorState,
  blocked: readonly FootnoteBlockedRange[] = [],
): Map<string, FootnoteDefinition> {
  const doc = state.doc;
  const root = syntaxTree(state).topNode as unknown as MarkdownNode;
  const definitions = new Map<string, FootnoteDefinition>();

  for (let child = root.firstChild; child; child = child.nextSibling) {
    const node = child;
    if (node.name !== "Paragraph" && node.name !== "LinkReference") {
      continue;
    }
    if (blocked.some((range) => node.from >= range.from && node.to <= range.to)) {
      continue;
    }
    if (node.name === "LinkReference") {
      const line = doc.lineAt(node.from);
      const match = FOOTNOTE_DEFINITION.exec(doc.sliceString(line.from, line.to));
      const label = match?.[1] ?? "";
      if (label && !definitions.has(label)) {
        definitions.set(label, { label, lineFrom: line.from, lineTo: line.to });
      }
      continue;
    }
    let position = node.from;
    while (position <= node.to) {
      const line = doc.lineAt(position);
      const match = FOOTNOTE_DEFINITION.exec(doc.sliceString(line.from, line.to));
      if (match) {
        const label = match[1] ?? "";
        if (label && !definitions.has(label)) {
          definitions.set(label, { label, lineFrom: line.from, lineTo: line.to });
        }
      }
      if (line.to >= node.to) {
        break;
      }
      position = line.to + 1;
    }
  }

  return definitions;
}
