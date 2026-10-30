import type { EditorState } from "@codemirror/state";

import type { MarkdownNode } from "./markdown-node";

/** Characters that can start any inline Markdown construct we strip. */
const INLINE_MARKDOWN = /[\\`*_{}[\]()#+\-.!|>~^=<]/;

/**
 * Strips the inline Markdown marks that do not contribute to a heading anchor.
 * The result feeds the GitHub-compatible slugger and the outline's plain text.
 * Plain headings take the fast path: the common case allocates no replacements.
 */
export function plainInlineText(markdown: string): string {
  if (!INLINE_MARKDOWN.test(markdown)) {
    return markdown.trim();
  }
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~^=])/g, "$1")
    .replace(/[*_~=]{1,3}/g, "")
    .trim();
}

export function isHeading(name: string): boolean {
  return /^(?:ATX|Setext)Heading[1-6]$/.test(name);
}

export function headingLevel(name: string): number {
  return Number(name.slice(-1));
}

function directHeaderMarks(node: MarkdownNode): {
  first: MarkdownNode | null;
  last: MarkdownNode | null;
} {
  let first: MarkdownNode | null = null;
  let last: MarkdownNode | null = null;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "HeaderMark") {
      first ??= child;
      last = child;
    }
  }
  return { first, last };
}

/** Returns heading text without the ATX/Setext marker characters. */
export function headingText(doc: EditorState["doc"], node: MarkdownNode): string {
  const { first, last } = directHeaderMarks(node);
  if (node.name.startsWith("ATX")) {
    const from = first ? first.to : node.from;
    return doc
      .sliceString(from, node.to)
      .replace(/\s+#+\s*$/, "")
      .trim();
  }
  const to = last ? last.from : node.to;
  return doc.sliceString(node.from, to).trim();
}
