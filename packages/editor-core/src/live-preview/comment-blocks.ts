import { syntaxTree } from "@codemirror/language";
import { StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

import { editorCopyChanged, editorUiCopy, type EditorUiCopy } from "../i18n";
import { readDetailsBlocks } from "./details";
import type { MarkdownNode } from "./markdown-node";

/**
 * HTML block comments and Obsidian `%% ... %%` comments are hidden in render
 * mode. Live Preview keeps a small badge so they remain discoverable and
 * editable instead of silently swallowing document content.
 */
export const COMMENT_BLOCK_MAX_UNITS = 200_000;

export type CommentKind = "html" | "obsidian";

export interface CommentBlock {
  from: number;
  to: number;
  kind: CommentKind;
  lines: number;
  raw: string;
}

/** Reads top-level multi-line HTML comments and Obsidian comment blocks. */
export function readCommentBlocks(state: EditorState): readonly CommentBlock[] {
  if (state.doc.length > COMMENT_BLOCK_MAX_UNITS) {
    return [];
  }
  const doc = state.doc;
  const root = syntaxTree(state).topNode as unknown as MarkdownNode;
  const details = readDetailsBlocks(state);
  const blocks: CommentBlock[] = [];

  for (let child = root.firstChild; child; child = child.nextSibling) {
    const node = child;
    if (details.some((block) => node.from >= block.from && node.to <= block.to)) {
      continue;
    }

    if (node.name === "CommentBlock") {
      const raw = doc.sliceString(node.from, node.to);
      if (!raw.includes("\n")) {
        // Single-line HTML comments are already collapsed by the planner.
        continue;
      }
      blocks.push({
        from: node.from,
        to: node.to,
        kind: "html",
        lines: raw.split("\n").length,
        raw,
      });
      continue;
    }

    if (node.name === "Paragraph") {
      const raw = doc.sliceString(node.from, node.to);
      const trimmed = raw.trim();
      if (/^%%[\s\S]*%%$/.test(trimmed)) {
        blocks.push({
          from: node.from,
          to: node.to,
          kind: "obsidian",
          lines: raw.split("\n").length,
          raw,
        });
      }
    }
  }

  return blocks;
}

interface CommentState {
  ranges: readonly CommentBlock[];
  blocked: readonly CommentBlock[];
  insideKey: string;
  decorations: DecorationSet;
}

function emptyState(): CommentState {
  return { ranges: [], blocked: [], insideKey: "", decorations: Decoration.none };
}

function selectionTouches(state: EditorState, range: { from: number; to: number }): boolean {
  return state.selection.ranges.some(
    (selection) => selection.from <= range.to && selection.to >= range.from,
  );
}

function insideKey(state: EditorState, ranges: readonly CommentBlock[]): string {
  return ranges
    .map((range, index) => (selectionTouches(state, range) ? index : ""))
    .filter((value) => value !== "")
    .join(",");
}

function buildComments(state: EditorState): CommentState {
  if (state.doc.length > COMMENT_BLOCK_MAX_UNITS) {
    return emptyState();
  }
  const ranges = readCommentBlocks(state);
  if (ranges.length === 0) {
    return emptyState();
  }

  const copy = state.facet(editorUiCopy);
  const decorations: ReturnType<Decoration["range"]>[] = [];
  for (const range of ranges) {
    if (!selectionTouches(state, range)) {
      decorations.push(
        Decoration.replace({
          block: true,
          widget: new CommentWidget(copy, range),
        }).range(range.from, range.to),
      );
    }
  }

  return {
    ranges,
    blocked: ranges,
    insideKey: insideKey(state, ranges),
    decorations: decorations.length > 0 ? Decoration.set(decorations, true) : Decoration.none,
  };
}

class CommentWidget extends WidgetType {
  constructor(
    private readonly copy: EditorUiCopy,
    private readonly block: CommentBlock,
  ) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return (
      other instanceof CommentWidget &&
      other.copy.version === this.copy.version &&
      other.block.raw === this.block.raw &&
      other.block.kind === this.block.kind
    );
  }

  override toDOM(view: EditorView): HTMLElement {
    // Padding-only root; the dashed chip is an inner card so the block's
    // spacing is included in CodeMirror's height measurement.
    const wrapper = document.createElement("div");
    wrapper.className = "cm-md-comment-widget";
    wrapper.dataset.blockGap = "";
    wrapper.title = this.copy.comments.wrapperTitle;

    const chip = document.createElement("div");
    chip.className = `cm-md-comment cm-md-comment-${this.block.kind}`;

    const icon = document.createElement("span");
    icon.className = "cm-md-comment-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "✎";

    const badge = document.createElement("span");
    badge.className = "cm-md-comment-badge";
    badge.textContent =
      this.block.kind === "html" ? this.copy.comments.html : this.copy.comments.obsidian;

    const meta = document.createElement("span");
    meta.className = "cm-md-comment-meta";
    meta.textContent = this.copy.comments.hiddenLines(this.block.lines);

    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "cm-md-comment-edit";
    edit.textContent = this.copy.comments.source;
    edit.title = this.copy.comments.editSource;

    const editSource = (event: MouseEvent) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({ selection: { anchor: this.block.from }, scrollIntoView: true });
      view.focus();
    };
    edit.addEventListener("mousedown", editSource);
    wrapper.addEventListener("mousedown", editSource);

    chip.append(icon, badge, meta, edit);
    wrapper.append(chip);
    return wrapper;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

export const commentBlockPreview = StateField.define<CommentState>({
  create: buildComments,
  update(value, transaction) {
    const treeChanged = syntaxTree(transaction.state) !== syntaxTree(transaction.startState);
    if (editorCopyChanged(transaction) || transaction.docChanged || treeChanged) {
      return buildComments(transaction.state);
    }
    if (!transaction.newSelection.eq(transaction.startState.selection)) {
      if (insideKey(transaction.state, value.ranges) !== value.insideKey) {
        return buildComments(transaction.state);
      }
    }
    return value;
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    EditorView.atomicRanges.of((view) => view.state.field(field).decorations),
  ],
});
