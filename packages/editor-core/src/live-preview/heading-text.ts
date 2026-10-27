import type { EditorState } from "@codemirror/state";

import type { MarkdownNode } from "./markdown-node";

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
