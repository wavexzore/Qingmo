import { syntaxTree } from "@codemirror/language";
import { StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

import { editorCopyChanged, editorUiCopy, type EditorUiCopy } from "../i18n";
import { PREVIEW_FULL_MAX_UNITS } from "../limits";
import { readDetailsRanges } from "./details-range";
import { readFrontMatter } from "./frontmatter";
import { renderInlineMarkdown } from "./inline-render";
import type { MarkdownNode } from "./markdown-node";
import { readHeadingOutline } from "./outline";

/** Generating a table of contents means walking every heading in the document. */
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

/**
 * Finds TOC placeholders only at the Document top level. A `[TOC]` inside a
 * blockquote or list stays ordinary source, matching Typora's behavior.
 */
function scanPlaceholders(state: EditorState): readonly TocRange[] {
  const doc = state.doc;
  const root = syntaxTree(state).topNode as unknown as MarkdownNode;
  const frontMatter = readFrontMatter(doc);
  const details = readDetailsRanges(state);
  const ranges: TocRange[] = [];

  for (let child = root.firstChild; child; child = child.nextSibling) {
    if (
      (frontMatter && child.from >= frontMatter.from && child.to <= frontMatter.to) ||
      details.some((range) => child.from >= range.from && child.to <= range.to)
    ) {
      continue;
    }
    if (child.name === "FencedCode" || child.name === "CodeBlock") {
      continue;
    }
    if (
      (child.name === "Paragraph" || child.name === "CommentBlock") &&
      isPlaceholder(doc, child)
    ) {
      ranges.push({ from: child.from, to: child.to });
    }
  }

  return ranges;
}

function buildToc(state: EditorState): TocState {
  if (state.doc.length > PREVIEW_FULL_MAX_UNITS) {
    return emptyState();
  }

  const ranges = scanPlaceholders(state);
  if (ranges.length === 0) {
    return emptyState();
  }

  const headings = readHeadingOutline(state)
    .entries.slice(0, MAX_TOC_ENTRIES)
    .map((entry) => ({
      level: entry.level,
      text: entry.text,
      lineFrom: entry.lineFrom,
    }));

  const decorations: ReturnType<Decoration["range"]>[] = [];
  for (const range of ranges) {
    if (!selectionTouches(state, range)) {
      decorations.push(
        Decoration.replace({
          block: true,
          widget: new TocWidget(state.facet(editorUiCopy), headings, range.from, range.to),
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
    private readonly copy: EditorUiCopy,
    private readonly headings: readonly TocHeading[],
    private readonly from: number,
    private readonly to: number,
  ) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return (
      other instanceof TocWidget &&
      other.copy.version === this.copy.version &&
      other.from === this.from &&
      other.to === this.to &&
      JSON.stringify(other.headings) === JSON.stringify(this.headings)
    );
  }

  override toDOM(view: EditorView): HTMLElement {
    const nav = document.createElement("nav");
    nav.className = "cm-md-toc";
    nav.dataset.blockGap = "";
    nav.title = this.copy.toc.wrapperTitle;

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

    const card = document.createElement("div");
    card.className = "cm-md-toc-card";

    const title = document.createElement("div");
    title.className = "cm-md-toc-title";
    title.textContent = this.copy.toc.title;
    card.append(title);

    if (this.headings.length === 0) {
      const empty = document.createElement("div");
      empty.className = "cm-md-toc-empty";
      empty.textContent = this.copy.toc.empty;
      card.append(empty);
      nav.append(card);
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
      renderInlineMarkdown(label, heading.text, this.copy);
      button.append(label);
      item.append(button);
      list.append(item);
    }

    card.append(list);
    nav.append(card);
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
    if (editorCopyChanged(transaction) || transaction.docChanged || treeChanged) {
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
