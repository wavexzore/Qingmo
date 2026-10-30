import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

import { PREVIEW_FULL_MAX_UNITS } from "../limits";
import { readFrontMatter } from "./frontmatter";
import type { MarkdownNode } from "./markdown-node";

export interface DetailsTag {
  closing: boolean;
  selfClosing: boolean;
  attributes: string;
  /** Offset relative to the HTML block that owns the tag. */
  from: number;
  /** End offset relative to the HTML block that owns the tag. */
  to: number;
  text: string;
}

export interface DetailsRange {
  from: number;
  to: number;
}

const DETAILS_TAG = /<(\/?)\s*details\b([^>]*)>/gi;

/**
 * Scans `<details>` tags without depending on the preview renderer. This is
 * intentionally a lexical pass: Lezer gives us HTMLBlock ranges, while nested
 * tags may share one block.
 */
export function scanDetailsTags(html: string): readonly DetailsTag[] {
  const tags: DetailsTag[] = [];
  DETAILS_TAG.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DETAILS_TAG.exec(html))) {
    const text = match[0];
    tags.push({
      closing: match[1] === "/",
      selfClosing: /\/\s*>$/.test(text),
      attributes: match[2] ?? "",
      from: match.index,
      to: match.index + text.length,
      text,
    });
  }
  return tags;
}

/**
 * Returns closed top-level `<details>` ranges. Headings inside these ranges
 * are owned by the preview widget, so TOC/outline/anchor consumers must skip
 * them just like the old direct scans did.
 *
 * The cap matches `PREVIEW_FULL_MAX_UNITS`: above it Live Preview does not
 * render details widgets, so keeping the source visible and its headings in
 * the outline is the consistent behavior.
 */
export function readDetailsRanges(state: EditorState): readonly DetailsRange[] {
  if (state.doc.length > PREVIEW_FULL_MAX_UNITS) {
    return [];
  }

  const doc = state.doc;
  const root = syntaxTree(state).topNode as unknown as MarkdownNode;
  const frontMatter = readFrontMatter(doc);
  const roots: DetailsRange[] = [];
  const stack: Array<{ from: number; to: number | null }> = [];

  for (let child = root.firstChild; child; child = child.nextSibling) {
    if (frontMatter && child.from >= frontMatter.from && child.to <= frontMatter.to) {
      continue;
    }
    if (child.name !== "HTMLBlock") {
      continue;
    }

    const html = doc.sliceString(child.from, child.to);
    for (const tag of scanDetailsTags(html)) {
      const from = child.from + tag.from;
      const to = child.from + tag.to;

      if (tag.closing) {
        const block = stack.pop();
        if (!block) {
          continue;
        }
        block.to = to;
        if (stack.length === 0) {
          roots.push({ from: block.from, to });
        }
        continue;
      }
      if (tag.selfClosing) {
        continue;
      }
      stack.push({ from, to: null });
    }
  }

  return roots;
}
