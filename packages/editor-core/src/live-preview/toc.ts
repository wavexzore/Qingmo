import { syntaxTree } from "@codemirror/language";
import { StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

import { readDetailsBlocks } from "./details";
import { readFrontMatter } from "./frontmatter";
import { headingLevel, headingText, isHeading } from "./heading-text";
import { renderInlineMarkdown } from "./inline-render";
import type { MarkdownNode } from "./markdown-node";

/**
 * Generating a table of contents means walking every heading in the document.
 * Very large files keep the placeholder as source instead.
 */
export const TOC_BLOCK_MAX_UNITS = 200_000;

const MAX_TOC_ENTRIES = 200;
const PLACEHOLDERS = new Set(["[toc]", "[[_toc_]]"]);

interface TocHeading {
  level: number;
  text: string;
  lineFrom: number;
}

interface TocRange {
  from: number;
  to: number;
}

interface TocState {
  headings: readonly TocHeading[];
  ranges: readonly TocRange[];
  /** Placeholder lines always stay plain source; the widget is separate. */
  blocked: readonly TocRange[];
  insideKey: string;
  decorations: DecorationSet;
}

function emptyState(): TocState {
  return {
    headings: [],
    ranges: [],
    blocked: [],
    insideKey: "",
    decorations: Decoration.none,
  };
}

function selectionTouches(state: EditorState, range: TocRange): boolean {
  return state.selection.ranges.some(
    (selection) => selection.from <= range.to && selection.to >= range.from,
  );
}

function insideKey(state: EditorState, ranges: readonly TocRange[]): string {
  return ranges
    .map((range, index) => (selectionTouches(state, range) ? index : ""))
    .filter((value) => value !== "")
    .join(",");
}

function isPlaceholder(doc: EditorState["doc"], node: MarkdownNode): boolean {
  const text = doc.sliceString(node.from, node.to).trim().toLowerCase();
  return PLACEHOLDERS.has(text) || /^<!--\s*toc\s*-->$/.test(text);
}

interface BuildResult {
  headings: TocHeading[];
  ranges: TocRange[];
}

function scanDocument(state: EditorState): BuildResult {
  const doc = state.doc;
  const headings: TocHeading[] = [];
  const ranges: TocRange[] = [];
  const frontMatter = readFrontMatter(doc);
  const details = readDetailsBlocks(state);

  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === "Document") {
        return true;
      }
      if (
        (frontMatter && node.from >= frontMatter.from && node.to <= frontMatter.to) ||
        details.some((block) => node.from >= block.from && node.to <= block.to)
      ) {
        return false;
      }
      if (node.name === "FencedCode" || node.name === "CodeBlock") {
        return false;
      }
      const syntaxNode = node.node as unknown as MarkdownNode;
      if (syntaxNode.parent?.name !== "Document") {
        return false;
      }
      if (isHeading(node.name)) {
        const text = headingText(doc, syntaxNode);
        if (text) {
          headings.push({
            level: headingLevel(node.name),
            text,
            lineFrom: doc.lineAt(node.from).from,
          });
        }
        return false;
      }
      if (node.name === "Paragraph" || node.name === "CommentBlock") {
        if (isPlaceholder(doc, syntaxNode)) {
          ranges.push({ from: node.from, to: node.to });
        }
      }
      return false;
    },
  });

  return { headings, ranges };
}

function buildToc(state: EditorState): TocState {
  if (state.doc.length > TOC_BLOCK_MAX_UNITS) {
    return emptyState();
  }

  const { headings, ranges } = scanDocument(state);
  if (ranges.length === 0) {
    return emptyState();
  }

  const decorations: ReturnType<Decoration["range"]>[] = [];
  for (const range of ranges) {
    if (!selectionTouches(state, range)) {
      decorations.push(
        Decoration.replace({
          block: true,
          widget: new TocWidget(headings.slice(0, MAX_TOC_ENTRIES), range.from, range.to),
        }).range(range.from, range.to),
      );
    }
  }

  return {
    headings,
    ranges,
    blocked: ranges,
    insideKey: insideKey(state, ranges),
    decorations: decorations.length > 0 ? Decoration.set(decorations, true) : Decoration.none,
  };
}

class TocWidget extends WidgetType {
  constructor(
    private readonly headings: readonly TocHeading[],
    private readonly from: number,
    private readonly to: number,
  ) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return (
      other instanceof TocWidget &&
      other.from === this.from &&
      other.to === this.to &&
      JSON.stringify(other.headings) === JSON.stringify(this.headings)
    );
  }

  override toDOM(view: EditorView): HTMLElement {
    const nav = document.createElement("nav");
    nav.className = "cm-md-toc";
    nav.title = "点击目录项跳转，点击空白处编辑占位符";

    nav.addEventListener("mousedown", (event) => {
      if (event.button !== 0) {
        return;
      }
      if ((event.target as Element | null)?.closest(".cm-md-toc-item")) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({ selection: { anchor: this.from }, scrollIntoView: true });
      view.focus();
    });

    const title = document.createElement("div");
    title.className = "cm-md-toc-title";
    title.textContent = "目录";
    nav.append(title);

    if (this.headings.length === 0) {
      const empty = document.createElement("div");
      empty.className = "cm-md-toc-empty";
      empty.textContent = "文档中没有标题";
      nav.append(empty);
      return nav;
    }

    const minimumLevel = Math.min(...this.headings.map((heading) => heading.level));
    const list = document.createElement("ul");
    list.className = "cm-md-toc-list";

    for (const heading of this.headings) {
      const item = document.createElement("li");
      item.className = "cm-md-toc-entry";
      item.style.paddingLeft = `${Math.max(0, heading.level - minimumLevel) * 0.9}em`;

      const button = document.createElement("button");
      button.type = "button";
      button.className = "cm-md-toc-item";
      button.dataset.level = String(heading.level);
      // Keep CodeMirror from translating the press into a document selection,
      // which would rebuild the placeholder as source before `click` fires.
      button.addEventListener("mousedown", (event) => {
        if (event.button !== 0) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
      });
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        view.dispatch({
          selection: { anchor: heading.lineFrom },
          scrollIntoView: true,
        });
        view.focus();
      });

      const label = document.createElement("span");
      label.className = "cm-md-toc-label";
      renderInlineMarkdown(label, heading.text);
      button.append(label);
      item.append(button);
      list.append(item);
    }

    nav.append(list);
    return nav;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

export const tocPreview = StateField.define<TocState>({
  create: buildToc,
  update(value, transaction) {
    const treeChanged = syntaxTree(transaction.state) !== syntaxTree(transaction.startState);
    if (transaction.docChanged || treeChanged) {
      return buildToc(transaction.state);
    }

    if (!transaction.newSelection.eq(transaction.startState.selection)) {
      if (insideKey(transaction.state, value.ranges) !== value.insideKey) {
        return buildToc(transaction.state);
      }
    }

    return value;
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    EditorView.atomicRanges.of((view) => view.state.field(field).decorations),
  ],
});
