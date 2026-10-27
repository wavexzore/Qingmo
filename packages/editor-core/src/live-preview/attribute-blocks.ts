import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

import type { MarkdownNode } from "./markdown-node";

export interface ParsedAttributes {
  raw: string;
  values: ReadonlyMap<string, string>;
  classes: readonly string[];
  id: string | null;
}

export interface AttributeRange extends ParsedAttributes {
  from: number;
  to: number;
}

export interface AttributeAnchor {
  id: string;
  lineFrom: number;
}

const CLASS = /(?:^|\s)\.([A-Za-z0-9_-]+)/g;
const ID = /(?:^|\s)#([A-Za-z0-9_-]+)/g;
const VALUE = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s}]+))/g;

/** Parses the inside of `{...}` or `{: ...}` attribute blocks. */
export function parseAttributes(raw: string): ParsedAttributes {
  const values = new Map<string, string>();
  VALUE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = VALUE.exec(raw))) {
    values.set((match[1] ?? "").toLowerCase(), match[2] ?? match[3] ?? match[4] ?? "");
  }

  const classes: string[] = [];
  CLASS.lastIndex = 0;
  while ((match = CLASS.exec(raw))) {
    const name = match[1] ?? "";
    if (name && !classes.includes(name)) {
      classes.push(name);
    }
  }

  ID.lastIndex = 0;
  const idMatch = ID.exec(raw);
  return {
    raw: raw.trim(),
    values,
    classes,
    id: idMatch?.[1] ?? null,
  };
}

/**
 * Reads `{width=200 height=100}` immediately after an inline image. Only the
 * same line is considered so a later paragraph is never consumed.
 */
export function readTrailingAttributes(
  doc: EditorState["doc"],
  node: MarkdownNode,
): AttributeRange | null {
  const line = doc.lineAt(node.to);
  const text = doc.sliceString(node.to, line.to);
  const match = /^\s*\{([^{}\n]+)\}/.exec(text);
  if (!match) {
    return null;
  }
  return {
    ...parseAttributes(match[1] ?? ""),
    from: node.to,
    to: node.to + match[0].length,
  };
}

/** Reads a standalone `{: .warning #custom-id}` paragraph line. */
export function readAttributeLine(
  doc: EditorState["doc"],
  node: MarkdownNode,
): AttributeRange | null {
  const text = doc.sliceString(node.from, node.to);
  const lines = text.split("\n");
  const last = lines[lines.length - 1] ?? "";
  const match = /^\s*\{:\s*([^{}\n]*)\}\s*$/.exec(last);
  if (!match) {
    return null;
  }
  const lineFrom = node.to - last.length;
  return {
    ...parseAttributes(match[1] ?? ""),
    from: lineFrom,
    to: node.to,
  };
}

/**
 * Collects paragraph-level `#id` anchors so `[text](#id)` links can jump to
 * the paragraph carrying `{: #id}`. Heading anchors take precedence when both
 * use the same id.
 */
export function readAttributeAnchors(
  state: EditorState,
  blocked: readonly { from: number; to: number }[] = [],
): Map<string, AttributeAnchor> {
  const doc = state.doc;
  const root = syntaxTree(state).topNode as unknown as MarkdownNode;
  const anchors = new Map<string, AttributeAnchor>();

  for (let child = root.firstChild; child; child = child.nextSibling) {
    const node = child;
    if (node.name !== "Paragraph") {
      continue;
    }
    if (blocked.some((range) => node.from >= range.from && node.to <= range.to)) {
      continue;
    }
    const attributes = readAttributeLine(doc, node);
    const id = attributes?.id?.toLowerCase();
    if (id && !anchors.has(id)) {
      anchors.set(id, { id, lineFrom: doc.lineAt(node.from).from });
    }
  }

  return anchors;
}
