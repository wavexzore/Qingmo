import { syntaxTree } from "@codemirror/language";
import { StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

import { renderInlineMarkdown } from "./inline-render";
import { readDetailsBlocks } from "./details";
import { readFrontMatter } from "./frontmatter";
import { HtmlTableWidget, readHtmlTables } from "./html-tables";
import { readTable, type ParsedTable, type TableAlignment } from "./specs";
import type { MarkdownNode } from "./markdown-node";

/**
 * Above this size the multi-line table scan is disabled. The table then keeps
 * the lean source styling from the view plugin instead of paying a full-tree
 * block-decoration rebuild on every keystroke.
 */
export const TABLE_BLOCK_MAX_UNITS = 200_000;

interface TableRange {
  from: number;
  to: number;
}

interface TableBlockState {
  ranges: readonly TableRange[];
  /** Tables currently replaced by a block widget; the planner skips their source styling. */
  blocked: readonly TableRange[];
  insideKey: string;
  decorations: DecorationSet;
}

function selectionTouches(state: EditorState, range: TableRange): boolean {
  return state.selection.ranges.some(
    (selection) => selection.from <= range.to && selection.to >= range.from,
  );
}

function insideKey(state: EditorState, ranges: readonly TableRange[]): string {
  return ranges
    .map((range, index) => (selectionTouches(state, range) ? index : ""))
    .filter((value) => value !== "")
    .join(",");
}

function emptyState(): TableBlockState {
  return {
    ranges: [],
    blocked: [],
    insideKey: "",
    decorations: Decoration.none,
  };
}

/**
 * Block decorations may only be provided by a StateField, never by a
 * ViewPlugin. This field owns the whole table lifecycle: it finds tables in
 * the parsed tree, renders the ones whose range does not touch the selection,
 * and leaves the source lines (with line classes) when the user edits them.
 */
function buildTableBlocks(state: EditorState): TableBlockState {
  if (state.doc.length > TABLE_BLOCK_MAX_UNITS) {
    return emptyState();
  }

  const ranges: TableRange[] = [];
  const blocked: TableRange[] = [];
  const decorations: ReturnType<Decoration["range"]>[] = [];
  const frontMatter = readFrontMatter(state.doc);
  const details = readDetailsBlocks(state);

  syntaxTree(state).iterate({
    enter(node) {
      if (
        (frontMatter && node.from >= frontMatter.from && node.to <= frontMatter.to) ||
        details.some((block) => node.from >= block.from && node.to <= block.to)
      ) {
        return false;
      }
      if (node.name === "Table") {
        const table = readTable(state.doc, node.node as unknown as MarkdownNode);
        if (!table) {
          return false;
        }
        const range = { from: table.from, to: table.to };
        ranges.push(range);
        if (!selectionTouches(state, range)) {
          blocked.push(range);
          decorations.push(
            Decoration.replace({
              block: true,
              widget: new TableBlockWidget(table),
            }).range(range.from, range.to),
          );
        }
        return false;
      }

      // Tables are block nodes. Skipping paragraphs and inline nodes keeps
      // the scan proportional to block containers instead of every token.
      return (
        node.name === "Document" ||
        node.name === "Blockquote" ||
        node.name === "BulletList" ||
        node.name === "OrderedList" ||
        node.name === "ListItem"
      );
    },
  });

  // HTML tables may contain blank lines, so they are scanned separately from
  // the Lezer HTMLBlock boundaries and rendered through the structure parser.
  for (const table of readHtmlTables(state)) {
    const range = { from: table.from, to: table.to };
    if (ranges.some((existing) => existing.from < range.to && range.from < existing.to)) {
      continue;
    }
    ranges.push(range);
    if (!selectionTouches(state, range)) {
      blocked.push(range);
      decorations.push(
        Decoration.replace({
          block: true,
          widget: new HtmlTableWidget(table),
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

class TableBlockWidget extends WidgetType {
  constructor(private readonly table: ParsedTable) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return (
      other instanceof TableBlockWidget &&
      JSON.stringify(other.table.header) === JSON.stringify(this.table.header) &&
      JSON.stringify(other.table.align) === JSON.stringify(this.table.align) &&
      JSON.stringify(other.table.rows) === JSON.stringify(this.table.rows)
    );
  }

  override toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "cm-md-table-block";
    wrapper.title = "点击编辑表格源码";

    // A block widget has no editable text. Clicking it reveals the source and
    // puts the caret at the first line of the table.
    wrapper.addEventListener("mousedown", (event) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({
        selection: { anchor: this.table.from },
        scrollIntoView: true,
      });
      view.focus();
    });

    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    for (let index = 0; index < this.table.header.length; index += 1) {
      const cell = document.createElement("th");
      cell.scope = "col";
      applyAlignment(cell, this.table.align[index] ?? null);
      renderInlineMarkdown(cell, this.table.header[index] ?? "");
      headerRow.append(cell);
    }
    thead.append(headerRow);
    table.append(thead);

    if (this.table.rows.length > 0) {
      const tbody = document.createElement("tbody");
      for (const row of this.table.rows) {
        const tr = document.createElement("tr");
        for (let index = 0; index < this.table.header.length; index += 1) {
          const cell = document.createElement("td");
          applyAlignment(cell, this.table.align[index] ?? null);
          renderInlineMarkdown(cell, row[index] ?? "");
          tr.append(cell);
        }
        tbody.append(tr);
      }
      table.append(tbody);
    }

    wrapper.append(table);
    return wrapper;
  }

  override ignoreEvent(): boolean {
    // Let CM6 map a click inside the rendered table to a document position;
    // the resulting selection intersects the table and reveals its source.
    return false;
  }
}

function applyAlignment(element: HTMLElement, align: TableAlignment): void {
  if (align) {
    element.style.textAlign = align;
  }
}

export const tableBlockPreview = StateField.define<TableBlockState>({
  create: buildTableBlocks,
  update(value, transaction) {
    const treeChanged = syntaxTree(transaction.state) !== syntaxTree(transaction.startState);
    if (transaction.docChanged || treeChanged) {
      return buildTableBlocks(transaction.state);
    }

    if (!transaction.newSelection.eq(transaction.startState.selection)) {
      const nextInsideKey = insideKey(transaction.state, value.ranges);
      if (nextInsideKey !== value.insideKey) {
        return buildTableBlocks(transaction.state);
      }
    }

    return value;
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    EditorView.atomicRanges.of((view) => view.state.field(field).decorations),
  ],
});
