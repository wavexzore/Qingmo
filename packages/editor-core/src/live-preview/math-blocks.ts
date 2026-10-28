import { syntaxTree } from "@codemirror/language";
import { StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

import { editorCopyChanged, editorUiCopy, type EditorUiCopy } from "../i18n";
import { renderTeX } from "./widgets";
import { readDetailsBlocks } from "./details";
import { readFrontMatter } from "./frontmatter";
import type { MarkdownNode } from "./markdown-node";

/**
 * Above this size the scan is disabled and `$$` / ` ```math ` blocks keep
 * their source styling, matching the table preview's degradation strategy.
 */
export const MATH_BLOCK_MAX_UNITS = 200_000;

interface MathRange {
  from: number;
  to: number;
  tex: string;
}

interface MathBlockState {
  ranges: readonly MathRange[];
  /** Blocks currently replaced by a widget; the planner skips their source. */
  blocked: readonly MathRange[];
  insideKey: string;
  decorations: DecorationSet;
}

function emptyState(): MathBlockState {
  return { ranges: [], blocked: [], insideKey: "", decorations: Decoration.none };
}

function selectionTouches(state: EditorState, range: { from: number; to: number }): boolean {
  return state.selection.ranges.some(
    (selection) => selection.from <= range.to && selection.to >= range.from,
  );
}

function insideKey(state: EditorState, ranges: readonly MathRange[]): string {
  return ranges
    .map((range, index) => (selectionTouches(state, range) ? index : ""))
    .filter((value) => value !== "")
    .join(",");
}

/** Code ranges must never be scanned for `$$` fences. */
function codeRanges(state: EditorState): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  const frontMatter = readFrontMatter(state.doc);
  if (frontMatter) {
    ranges.push({ from: frontMatter.from, to: frontMatter.to });
  }
  for (const details of readDetailsBlocks(state)) {
    ranges.push({ from: details.from, to: details.to });
  }
  syntaxTree(state).iterate({
    enter(node) {
      if (
        node.name === "FencedCode" ||
        node.name === "CodeBlock" ||
        node.name === "HTMLBlock" ||
        node.name === "CommentBlock"
      ) {
        ranges.push({ from: node.from, to: node.to });
        return false;
      }
      return (
        node.name === "Document" ||
        node.name === "Blockquote" ||
        node.name === "BulletList" ||
        node.name === "OrderedList" ||
        node.name === "ListItem"
      );
    },
  });
  return ranges;
}

function directChild(node: MarkdownNode, name: string): MarkdownNode | null {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === name) {
      return child;
    }
  }
  return null;
}

/**
 * Reads a top-level ```` ```math ```` fence. GitHub renders this fence as
 * display math, so it shares the `$$` widget instead of staying a code block.
 */
function readMathFence(
  doc: EditorState["doc"],
  node: MarkdownNode,
): { from: number; to: number; tex: string } | null {
  if (node.name !== "FencedCode" || node.parent?.name !== "Document") {
    return null;
  }
  const info = directChild(node, "CodeInfo");
  if (!info) {
    return null;
  }
  const language = doc.sliceString(info.from, info.to).trim().split(/\s+/)[0]?.toLowerCase();
  if (language !== "math" && language !== "latex") {
    return null;
  }

  let tex = "";
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "CodeText") {
      tex += doc.sliceString(child.from, child.to);
    }
  }
  return tex.trim() ? { from: node.from, to: node.to, tex: tex.trim() } : null;
}

function buildMathBlocks(state: EditorState): MathBlockState {
  if (state.doc.length > MATH_BLOCK_MAX_UNITS) {
    return emptyState();
  }

  const doc = state.doc;
  const copy = state.facet(editorUiCopy);
  const code = codeRanges(state);
  const inCode = (from: number, to: number) =>
    code.some((range) => from >= range.from && to <= range.to);
  const ranges: MathRange[] = [];
  const blocked: MathRange[] = [];
  const decorations: ReturnType<Decoration["range"]>[] = [];

  for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber += 1) {
    const line = doc.line(lineNumber);
    if (line.text.trim() !== "$$" || inCode(line.from, line.to)) {
      continue;
    }

    let closing: typeof line | null = null;
    for (let next = lineNumber + 1; next <= doc.lines; next += 1) {
      const candidate = doc.line(next);
      if (inCode(candidate.from, candidate.to)) {
        continue;
      }
      if (candidate.text.trim() === "$$") {
        closing = candidate;
        break;
      }
    }
    if (!closing) {
      continue;
    }

    const range: MathRange = {
      from: line.from,
      to: closing.to,
      tex: doc.sliceString(line.to, closing.from).trim(),
    };
    ranges.push(range);
    if (!selectionTouches(state, range)) {
      blocked.push(range);
      decorations.push(
        Decoration.replace({
          block: true,
          widget: new MathBlockWidget(copy, range.tex, range.from, range.to),
        }).range(range.from, range.to),
      );
    }
    lineNumber = closing.number;
  }

  const root = syntaxTree(state).topNode as unknown as MarkdownNode;
  for (let child = root.firstChild; child; child = child.nextSibling) {
    const fence = readMathFence(doc, child);
    if (!fence) {
      continue;
    }
    const range: MathRange = {
      from: fence.from,
      to: fence.to,
      tex: fence.tex,
    };
    ranges.push(range);
    if (!selectionTouches(state, range)) {
      blocked.push(range);
      decorations.push(
        Decoration.replace({
          block: true,
          widget: new MathBlockWidget(copy, range.tex, range.from, range.to),
        }).range(range.from, range.to),
      );
    }
  }

  return {
    ranges,
    blocked,
    insideKey: insideKey(state, ranges),
    decorations: decorations.length > 0 ? Decoration.set(decorations, true) : Decoration.none,
  };
}

class MathBlockWidget extends WidgetType {
  constructor(
    private readonly copy: EditorUiCopy,
    private readonly tex: string,
    private readonly from: number,
    private readonly to: number,
  ) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return (
      other instanceof MathBlockWidget &&
      other.copy.version === this.copy.version &&
      other.tex === this.tex &&
      other.from === this.from &&
      other.to === this.to
    );
  }

  override toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "cm-md-math-block";
    wrapper.title = this.copy.math.editSource;

    wrapper.addEventListener("mousedown", (event) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({
        selection: { anchor: this.from },
        scrollIntoView: true,
      });
      view.focus();
    });

    const rendered = document.createElement("div");
    rendered.className = "cm-md-math-block-render";
    wrapper.append(rendered);
    renderTeX(rendered, this.tex, true);
    return wrapper;
  }

  override ignoreEvent(): boolean {
    // Let CM6 map clicks to the source position as well; the handler above
    // already places the caret on the opening `$$`.
    return false;
  }
}

export const mathBlockPreview = StateField.define<MathBlockState>({
  create: buildMathBlocks,
  update(value, transaction) {
    const treeChanged = syntaxTree(transaction.state) !== syntaxTree(transaction.startState);
    if (editorCopyChanged(transaction) || transaction.docChanged || treeChanged) {
      return buildMathBlocks(transaction.state);
    }

    if (!transaction.newSelection.eq(transaction.startState.selection)) {
      if (insideKey(transaction.state, value.ranges) !== value.insideKey) {
        return buildMathBlocks(transaction.state);
      }
    }

    return value;
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    EditorView.atomicRanges.of((view) => view.state.field(field).decorations),
  ],
});
