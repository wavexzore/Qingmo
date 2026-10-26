import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

import { LP_MAX_UNITS, MAX_LINE_UNITS } from "../limits";

export interface VisibleRange {
  from: number;
  to: number;
}

export type DecorationSpec =
  | { kind: "replace"; from: number; to: number }
  | { kind: "mark"; from: number; to: number; className: string }
  | { kind: "line"; from: number; to: number; className: string };

interface MarkdownNode {
  name: string;
  from: number;
  to: number;
  firstChild: MarkdownNode | null;
  nextSibling: MarkdownNode | null;
  parent: MarkdownNode | null;
}

const HEADING_CLASSES: Record<string, string> = {
  ATXHeading1: "cm-md-h1",
  ATXHeading2: "cm-md-h2",
  ATXHeading3: "cm-md-h3",
  ATXHeading4: "cm-md-h4",
  ATXHeading5: "cm-md-h5",
  ATXHeading6: "cm-md-h6",
};

const LINE_CLASS_PRIORITY: Record<string, number> = {
  "cm-md-h1": 0,
  "cm-md-h2": 0,
  "cm-md-h3": 0,
  "cm-md-h4": 0,
  "cm-md-h5": 0,
  "cm-md-h6": 0,
  "cm-md-quote": 1,
  "cm-md-list": 2,
  "cm-md-code-block": 3,
};

function clamp(value: number, length: number): number {
  return Math.max(0, Math.min(value, length));
}

/**
 * Expands the visible ranges to whole lines and merges overlaps. Only these
 * ranges are ever handed to `syntaxTree.iterate`; the document is never
 * scanned in full.
 */
function expandVisibleRanges(state: EditorState, ranges: readonly VisibleRange[]): VisibleRange[] {
  const doc = state.doc;
  if (doc.length === 0) {
    return [];
  }

  const expanded: VisibleRange[] = [];
  for (const range of ranges) {
    const from = clamp(range.from, doc.length);
    const to = clamp(Math.max(range.to, range.from), doc.length);
    const firstLine = doc.lineAt(from);
    const lastLine = doc.lineAt(to);
    expanded.push({ from: firstLine.from, to: lastLine.to });
  }

  expanded.sort((left, right) => left.from - right.from || left.to - right.to);
  const merged: VisibleRange[] = [];
  for (const range of expanded) {
    const previous = merged[merged.length - 1];
    if (previous && range.from <= previous.to) {
      previous.to = Math.max(previous.to, range.to);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function spansLines(state: EditorState, from: number, to: number): boolean {
  if (to <= from) {
    return false;
  }
  return state.doc.lineAt(from).from !== state.doc.lineAt(to - 1).from;
}

function directChildren(node: MarkdownNode, name: string): MarkdownNode[] {
  const children: MarkdownNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === name) {
      children.push(child);
    }
  }
  return children;
}

function addLineClassesForBlock(
  state: EditorState,
  node: MarkdownNode,
  range: VisibleRange,
  addLineClass: (position: number, className: string) => void,
  className: string,
): void {
  const start = Math.max(node.from, range.from);
  const end = Math.min(node.to, range.to);
  if (start >= end) {
    return;
  }

  let position = start;
  while (position < end) {
    const line = state.doc.lineAt(position);
    addLineClass(line.from, className);
    if (line.to >= end - 1) {
      break;
    }
    position = line.to + 1;
  }
}

/**
 * Pure decoration planner. The caller supplies the visible ranges and all
 * selection ranges, which makes multi-cursor source reveal and cross-line
 * boundaries directly testable without a real viewport.
 */
export function collectDecorationSpecs(
  state: EditorState,
  ranges: readonly VisibleRange[],
  selectionRanges: readonly VisibleRange[],
): DecorationSpec[] {
  const doc = state.doc;
  if (doc.length === 0 || doc.length > LP_MAX_UNITS) {
    return [];
  }

  const expanded = expandVisibleRanges(state, ranges);
  if (expanded.length === 0) {
    return [];
  }

  const specs = new Map<string, DecorationSpec>();
  const lineClasses = new Map<number, Set<string>>();
  const tree = syntaxTree(state);

  const addSpec = (spec: DecorationSpec) => {
    const className = spec.kind === "replace" ? "" : spec.className;
    specs.set(`${spec.kind}:${spec.from}:${spec.to}:${className}`, spec);
  };

  const lineIsSelected = (line: { from: number; to: number }): boolean =>
    selectionRanges.some((range) => range.from <= line.to && range.to >= line.from);

  const addLineClass = (position: number, className: string) => {
    const lineStart = doc.lineAt(clamp(position, doc.length)).from;
    const classes = lineClasses.get(lineStart) ?? new Set<string>();
    classes.add(className);
    lineClasses.set(lineStart, classes);
  };

  const addReplace = (from: number, to: number, parent: MarkdownNode | null | undefined) => {
    if (from >= to) {
      return;
    }
    const line = doc.lineAt(from);
    if (line.length > MAX_LINE_UNITS || lineIsSelected(line)) {
      return;
    }
    // Inline constructs may not be replaced across lines, but block markers
    // (quote/list/heading) belong to multi-line block parents and must still
    // hide on every line.
    if (
      parent &&
      (parent.name === "StrongEmphasis" ||
        parent.name === "Emphasis" ||
        parent.name === "InlineCode" ||
        parent.name === "Link") &&
      spansLines(state, parent.from, parent.to)
    ) {
      return;
    }
    addSpec({ kind: "replace", from, to });
  };

  const addMark = (from: number, to: number, className: string) => {
    if (from < to) {
      addSpec({ kind: "mark", from, to, className });
    }
  };

  const markBetween = (node: MarkdownNode, markName: string, className: string) => {
    const marks = directChildren(node, markName);
    const first = marks[0];
    const last = marks[marks.length - 1];
    if (first && last) {
      addMark(first.to, last.from, className);
    }
  };

  for (const range of expanded) {
    tree.iterate({
      from: range.from,
      to: range.to,
      enter(node) {
        const syntaxNode = node.node;
        const parent = syntaxNode.parent;
        const parentName = parent?.name ?? "";

        switch (node.name) {
          case "ATXHeading1":
          case "ATXHeading2":
          case "ATXHeading3":
          case "ATXHeading4":
          case "ATXHeading5":
          case "ATXHeading6": {
            const className = HEADING_CLASSES[node.name];
            if (className) {
              addLineClass(node.from, className);
            }
            break;
          }
          case "StrongEmphasis":
            markBetween(syntaxNode, "EmphasisMark", "cm-md-strong");
            break;
          case "Emphasis":
            markBetween(syntaxNode, "EmphasisMark", "cm-md-em");
            break;
          case "InlineCode":
            markBetween(syntaxNode, "CodeMark", "cm-md-inline-code");
            break;
          case "Link": {
            const marks = directChildren(syntaxNode, "LinkMark");
            const opening = marks[0];
            const closing = marks[1];
            if (opening && closing) {
              addMark(opening.to, closing.from, "cm-md-link");
            }
            break;
          }
          case "FencedCode":
          case "CodeBlock":
            addLineClassesForBlock(state, syntaxNode, range, addLineClass, "cm-md-code-block");
            break;
          case "HeaderMark":
            if (parentName.startsWith("ATXHeading")) {
              addReplace(node.from, node.to, parent);
            }
            break;
          case "EmphasisMark":
            if (parentName === "StrongEmphasis" || parentName === "Emphasis") {
              addReplace(node.from, node.to, parent);
            }
            break;
          case "CodeMark":
            if (parentName === "InlineCode") {
              addReplace(node.from, node.to, parent);
            }
            break;
          case "LinkMark":
          case "URL":
          case "LinkTitle":
          case "LinkLabel":
            if (parentName === "Link") {
              addReplace(node.from, node.to, parent);
            }
            break;
          case "QuoteMark":
            addLineClass(node.from, "cm-md-quote");
            // Multi-line blockquotes put continuation markers under a
            // Paragraph node, so this must not require a Blockquote parent.
            addReplace(node.from, node.to, parent);
            break;
          case "ListMark":
            addLineClass(node.from, "cm-md-list");
            if (parentName === "ListItem") {
              addReplace(node.from, node.to, parent);
            }
            break;
          default:
            break;
        }
        return true;
      },
    });
  }

  for (const [lineStart, classes] of lineClasses) {
    for (const className of classes) {
      addSpec({ kind: "line", from: lineStart, to: lineStart, className });
    }
  }

  const priority = (spec: DecorationSpec): number => {
    if (spec.kind === "line") {
      return (LINE_CLASS_PRIORITY[spec.className] ?? 9) - 10;
    }
    return spec.kind === "replace" ? 0 : 1;
  };

  return [...specs.values()].sort(
    (left, right) =>
      left.from - right.from ||
      priority(left) - priority(right) ||
      left.to - right.to ||
      (left.kind === "replace" ? "" : left.className).localeCompare(
        right.kind === "replace" ? "" : right.className,
      ),
  );
}
