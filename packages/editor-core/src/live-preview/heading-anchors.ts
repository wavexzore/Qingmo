import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

import { headingText, isHeading } from "./heading-text";
import type { MarkdownNode } from "./markdown-node";

export interface HeadingAnchor {
  slug: string;
  text: string;
  level: number;
  lineFrom: number;
}

export interface AnchorRange {
  from: number;
  to: number;
}

/**
 * Strips the inline Markdown marks that do not contribute to a heading anchor.
 * The result feeds the GitHub-compatible slugger below.
 */
export function plainInlineText(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~^=])/g, "$1")
    .replace(/[*_~=]{1,3}/g, "")
    .trim();
}

/**
 * GitHub-style anchor: lowercase, keep letters/numbers/marks/spaces/hyphens,
 * then turn whitespace runs into hyphens. CJK characters are preserved.
 */
export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

const HTML_ANCHOR_TAG = /<a\b[^>]*\b(?:id|name)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
const HTML_ANCHOR_OPEN = /^<a\b[^>]*\b(?:id|name)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>$/i;
const EMPTY_ANCHOR_PARAGRAPH = /^(?:\s*<a\b[^>]*>\s*<\/a>\s*)+$/i;

function anchorIdFromMatch(match: RegExpExecArray): string {
  return (match[1] ?? match[2] ?? match[3] ?? "").trim();
}

/** Extracts all explicit HTML anchor ids from a fragment. */
export function htmlAnchorIds(raw: string): string[] {
  const ids: string[] = [];
  HTML_ANCHOR_TAG.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HTML_ANCHOR_TAG.exec(raw))) {
    const id = anchorIdFromMatch(match);
    if (id) {
      ids.push(id);
    }
  }
  return ids;
}

/** Reads an opening `<a id="…">` / `<a name="…">` tag. */
export function htmlAnchorId(raw: string): string | null {
  const match = HTML_ANCHOR_OPEN.exec(raw);
  if (!match) {
    return null;
  }
  const id = anchorIdFromMatch(match);
  return id || null;
}

/** Returns ids when a block contains nothing but empty HTML anchors. */
export function readAnchorOnlyBlock(raw: string): string[] | null {
  return EMPTY_ANCHOR_PARAGRAPH.test(raw.trim()) ? htmlAnchorIds(raw) : null;
}

function nextNonBlankLine(doc: EditorState["doc"], node: MarkdownNode): number | null {
  const lastLine = doc.lineAt(Math.max(node.from, node.to - 1)).number;
  for (let lineNumber = lastLine + 1; lineNumber <= doc.lines; lineNumber += 1) {
    const line = doc.line(lineNumber);
    if (line.text.trim()) {
      return line.from;
    }
  }
  return null;
}

/**
 * Collects explicit HTML anchors such as `<a id="install"></a>`. An anchor
 * paragraph before a heading targets the heading line, while an inline anchor
 * inside a heading targets that heading. Explicit anchors override generated
 * slugs when both use the same id.
 */
export function readHtmlAnchors(
  state: EditorState,
  blocked: readonly AnchorRange[] = [],
): Map<string, HeadingAnchor> {
  const doc = state.doc;
  const root = syntaxTree(state).topNode as unknown as MarkdownNode;
  const anchors = new Map<string, HeadingAnchor>();

  for (let child = root.firstChild; child; child = child.nextSibling) {
    const node = child;
    if (node.name !== "Paragraph" && !isHeading(node.name)) {
      continue;
    }
    if (blocked.some((range) => node.from >= range.from && node.to <= range.to)) {
      continue;
    }
    const raw = doc.sliceString(node.from, node.to);
    const ids: string[] = [];
    HTML_ANCHOR_TAG.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = HTML_ANCHOR_TAG.exec(raw))) {
      const id = (match[1] ?? match[2] ?? match[3] ?? "").trim();
      if (id) {
        ids.push(id);
      }
    }
    if (ids.length === 0) {
      continue;
    }

    const emptyBlock = EMPTY_ANCHOR_PARAGRAPH.test(raw);
    const target = emptyBlock ? nextNonBlankLine(doc, node) : null;
    const lineFrom = target ?? doc.lineAt(node.from).from;
    for (const id of ids) {
      const slug = id.toLowerCase();
      anchors.set(slug, { slug, text: id, level: 0, lineFrom });
    }
  }

  return anchors;
}

export function resolveHeadingAnchor(
  anchors: ReadonlyMap<string, HeadingAnchor>,
  href: string,
): HeadingAnchor | null {
  if (!href.startsWith("#")) {
    return null;
  }
  let decoded = href.slice(1);
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Keep the raw fragment when it is not valid percent-encoding.
  }
  decoded = decoded.toLowerCase();
  return anchors.get(decoded) ?? null;
}

/**
 * Collects top-level headings and deduplicates slugs the same way GitHub does.
 * Ranges already owned by a block widget are skipped so links never jump into
 * hidden front matter or details bodies.
 */
export function readHeadingAnchors(
  state: EditorState,
  blocked: readonly AnchorRange[] = [],
): Map<string, HeadingAnchor> {
  const doc = state.doc;
  const root = syntaxTree(state).topNode as unknown as MarkdownNode;
  const anchors = new Map<string, HeadingAnchor>();
  const occurrences = new Map<string, number>();

  for (let child = root.firstChild; child; child = child.nextSibling) {
    if (!isHeading(child.name)) {
      continue;
    }
    const node = child;
    if (blocked.some((range) => node.from >= range.from && node.to <= range.to)) {
      continue;
    }
    const text = plainInlineText(headingText(doc, node));
    const base = slugifyHeading(text);
    if (!base) {
      continue;
    }
    const count = occurrences.get(base) ?? 0;
    occurrences.set(base, count + 1);
    const slug = count === 0 ? base : `${base}-${count}`;
    if (!anchors.has(slug)) {
      anchors.set(slug, {
        slug,
        text,
        level: Number(child.name.slice(-1)),
        lineFrom: doc.lineAt(child.from).from,
      });
    }
  }

  return anchors;
}
