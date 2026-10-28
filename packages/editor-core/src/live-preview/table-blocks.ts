import { syntaxTree } from "@codemirror/language";
import { ChangeSet, StateField, type EditorState } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";

import { editorCopyChanged, editorUiCopy, type EditorUiCopy } from "../i18n";
import { renderInlineMarkdown } from "./inline-render";
import { readDetailsBlocks } from "./details";
import { readFrontMatter } from "./frontmatter";
import { HtmlTableWidget, readHtmlTables } from "./html-tables";
import { readTable, type ParsedTable, type TableAlignment, type TableCellRange } from "./specs";
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
  /** Tables replaced by a block widget; the planner skips their source styling. */
  blocked: readonly TableRange[];
  /** HTML tables still reveal their source when touched by the selection. */
  gated: readonly TableRange[];
  selectionKey: string;
  decorations: DecorationSet;
}

function selectionTouches(state: EditorState, range: TableRange): boolean {
  return state.selection.ranges.some(
    (selection) => selection.from <= range.to && selection.to >= range.from,
  );
}

function selectionKey(state: EditorState, ranges: readonly TableRange[]): string {
  return ranges
    .map((range, index) => (selectionTouches(state, range) ? index : ""))
    .filter((value) => value !== "")
    .join(",");
}

function emptyState(): TableBlockState {
  return {
    ranges: [],
    blocked: [],
    gated: [],
    selectionKey: "",
    decorations: Decoration.none,
  };
}

/**
 * Block decorations may only be provided by a StateField, never by a
 * ViewPlugin. This field owns the whole table lifecycle: it finds tables in
 * the parsed tree and renders them. Markdown tables are always rendered and
 * edited in place, matching Typora's hybrid mode; HTML tables still reveal
 * their source when the selection touches them because their editable shape
 * is not modelled yet.
 */
function buildTableBlocks(state: EditorState): TableBlockState {
  if (state.doc.length > TABLE_BLOCK_MAX_UNITS) {
    return emptyState();
  }

  const ranges: TableRange[] = [];
  const blocked: TableRange[] = [];
  const gated: TableRange[] = [];
  const decorations: ReturnType<Decoration["range"]>[] = [];
  const copy = state.facet(editorUiCopy);
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
        blocked.push(range);
        decorations.push(
          Decoration.replace({
            block: true,
            widget: new TableBlockWidget(
              copy,
              table,
              state.doc.sliceString(table.from, table.to),
              state.readOnly,
            ),
          }).range(range.from, range.to),
        );
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
    gated.push(range);
    if (!selectionTouches(state, range)) {
      blocked.push(range);
      decorations.push(
        Decoration.replace({
          block: true,
          widget: new HtmlTableWidget(copy, table),
        }).range(range.from, range.to),
      );
    }
  }

  return {
    ranges,
    blocked,
    gated,
    selectionKey: selectionKey(state, gated),
    decorations: decorations.length > 0 ? Decoration.set(decorations, true) : Decoration.none,
  };
}

interface CellEditor {
  input: HTMLInputElement;
  range: TableCellRange;
  original: string;
}

interface CellChange {
  from: number;
  to: number;
  insert: string;
}

/**
 * A Markdown cell cannot contain an unescaped pipe. Preserve already-escaped
 * pipes and newlines from pasted text so the serialized table stays valid.
 */
function escapeTableCell(value: string): string {
  let result = "";
  let lineBreaks = 0;
  for (const character of value) {
    if (character === "\r" || character === "\n") {
      if (lineBreaks === 0) {
        result += " ";
      }
      lineBreaks += 1;
      continue;
    }
    lineBreaks = 0;
    if (character === "|") {
      let backslashes = 0;
      for (let index = result.length - 1; index >= 0 && result[index] === "\\"; index -= 1) {
        backslashes += 1;
      }
      if (backslashes % 2 === 0) {
        result += "\\";
      }
    }
    result += character;
  }
  return result;
}

/**
 * Prefix used for an inserted row. Deriving it from the first cell keeps block
 * quotes and indentation intact and handles tables that omit the outer pipes.
 */
function rowPrefix(doc: EditorState["doc"], table: ParsedTable): string {
  const lastRow = table.rowCells[table.rowCells.length - 1];
  const first = lastRow?.[0] ?? table.headerCells[0];
  if (!first) {
    return "";
  }
  const line = doc.lineAt(first.from);
  return line.text.slice(0, first.from - line.from).replace(/\|\s*$/, "");
}

class TableBlockWidget extends WidgetType {
  private destroyed = false;

  constructor(
    private readonly copy: EditorUiCopy,
    private readonly table: ParsedTable,
    private readonly source: string,
    private readonly readOnly: boolean,
  ) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return (
      other instanceof TableBlockWidget &&
      other.copy.version === this.copy.version &&
      other.source === this.source &&
      other.readOnly === this.readOnly &&
      other.table.from === this.table.from &&
      other.table.to === this.table.to &&
      JSON.stringify(other.table.header) === JSON.stringify(this.table.header) &&
      JSON.stringify(other.table.align) === JSON.stringify(this.table.align) &&
      JSON.stringify(other.table.rows) === JSON.stringify(this.table.rows) &&
      JSON.stringify(other.table.headerCells) === JSON.stringify(this.table.headerCells) &&
      JSON.stringify(other.table.rowCells) === JSON.stringify(this.table.rowCells)
    );
  }

  override destroy(): void {
    this.destroyed = true;
  }

  override toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "cm-md-table-block";
    wrapper.dataset.tableFrom = String(this.table.from);
    wrapper.title = this.readOnly ? "" : this.copy.table.editSource;

    const editable = !this.readOnly;
    let originalSource = this.source;
    const editors: CellEditor[] = [];
    let committing = false;

    const collectChanges = (): CellChange[] | null => {
      const doc = view.state.doc;
      // A reload or an external edit replaced the table while the widget was
      // focused. Its cached ranges are stale; let the new widget win.
      if (doc.sliceString(this.table.from, this.table.to) !== originalSource) {
        return null;
      }
      const changes: CellChange[] = [];
      for (const editor of editors) {
        if (editor.input.value === editor.original) {
          continue;
        }
        const raw = doc.sliceString(editor.range.from, editor.range.to);
        const leading = raw.length - raw.trimStart().length;
        const trailing = raw.length - raw.trimEnd().length;
        changes.push({
          from: editor.range.from + leading,
          to: editor.range.to - trailing,
          insert: escapeTableCell(editor.input.value),
        });
      }
      return changes.sort((left, right) => left.from - right.from);
    };

    const commit = (selectAfter = false): boolean => {
      if (this.destroyed || committing) {
        return false;
      }
      const changes = collectChanges();
      if (!changes || changes.length === 0) {
        return false;
      }
      committing = true;
      const changeSet = ChangeSet.of(changes, view.state.doc.length);
      // Map the caret just past the table through the edit; the table grows or
      // shrinks with the edited cell text.
      const anchor = changeSet.mapPos(Math.min(this.table.to + 1, view.state.doc.length), 1);
      view.dispatch({
        changes: changeSet,
        selection: selectAfter ? { anchor } : undefined,
        userEvent: "input",
      });
      committing = false;
      // If CodeMirror keeps this widget (for example when the edit only added
      // insignificant padding), rebase the editors on the new source.
      const tableTo = changeSet.mapPos(this.table.to, 1);
      originalSource = view.state.doc.sliceString(this.table.from, tableTo);
      for (const editor of editors) {
        editor.original = editor.input.value;
      }
      return true;
    };

    const addRow = (): void => {
      if (this.destroyed || committing) {
        return;
      }
      const changes = collectChanges();
      if (!changes) {
        return;
      }
      const doc = view.state.doc;
      const columns = this.table.header.length;
      const cells = Array.from({ length: columns }, () => "").join(" | ");
      const insert = `\n${rowPrefix(doc, this.table)}| ${cells} |`;
      changes.push({ from: this.table.to, to: this.table.to, insert });
      committing = true;
      view.dispatch({ changes, userEvent: "input" });
      committing = false;

      const tableFrom = this.table.from;
      const rowIndex = this.table.rows.length;
      requestAnimationFrame(() => {
        const block = view.dom.querySelector<HTMLElement>(
          `.cm-md-table-block[data-table-from="${tableFrom}"]`,
        );
        block
          ?.querySelector<HTMLInputElement>(
            `.cm-md-table-cell-input[data-row="${rowIndex}"][data-col="0"]`,
          )
          ?.focus();
      });
    };

    const makeCell = (
      tag: "th" | "td",
      text: string,
      range: TableCellRange | null,
      align: TableAlignment,
      row: number,
      column: number,
    ): HTMLElement => {
      const cell = document.createElement(tag);
      if (tag === "th") {
        cell.scope = "col";
      }
      applyAlignment(cell, align);
      cell.classList.add("cm-md-table-cell");

      const rendered = document.createElement("span");
      rendered.className = "cm-md-table-cell-view";
      renderInlineMarkdown(rendered, text, this.copy);
      cell.append(rendered);

      if (range && editable) {
        const input = document.createElement("input");
        input.type = "text";
        input.className = "cm-md-table-cell-input";
        input.value = range.text;
        input.dataset.row = String(row);
        input.dataset.col = String(column);
        input.spellcheck = false;
        input.setAttribute(
          "aria-label",
          `${this.copy.table.editSource} (${row < 0 ? 1 : row + 2}, ${column + 1})`,
        );
        cell.append(input);
        editors.push({ input, range, original: range.text });
      }

      return cell;
    };

    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    for (let index = 0; index < this.table.header.length; index += 1) {
      headerRow.append(
        makeCell(
          "th",
          this.table.header[index] ?? "",
          this.table.headerCells[index] ?? null,
          this.table.align[index] ?? null,
          -1,
          index,
        ),
      );
    }
    thead.append(headerRow);
    table.append(thead);

    if (this.table.rows.length > 0) {
      const tbody = document.createElement("tbody");
      for (let rowIndex = 0; rowIndex < this.table.rows.length; rowIndex += 1) {
        const row = this.table.rows[rowIndex] ?? [];
        const ranges = this.table.rowCells[rowIndex] ?? [];
        const tr = document.createElement("tr");
        for (let index = 0; index < this.table.header.length; index += 1) {
          tr.append(
            makeCell(
              "td",
              row[index] ?? "",
              ranges[index] ?? null,
              this.table.align[index] ?? null,
              rowIndex,
              index,
            ),
          );
        }
        tbody.append(tr);
      }
      table.append(tbody);
    }

    wrapper.append(table);

    if (!editable) {
      return wrapper;
    }

    // The transparent cell inputs cover the content box; clicks on a cell
    // border or the table frame would otherwise fall through to CodeMirror
    // and put the document selection inside the hidden Markdown source.
    wrapper.addEventListener("mousedown", (event) => {
      if (event.button !== 0 || event.target instanceof HTMLInputElement) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const cell = event.target instanceof Element ? event.target.closest("th, td") : null;
      const input = cell?.querySelector<HTMLInputElement>(".cm-md-table-cell-input");
      if (input) {
        input.focus();
        const end = input.value.length;
        input.setSelectionRange(end, end);
      }
    });

    wrapper.addEventListener("focusout", (event) => {
      const next = event.relatedTarget as Node | null;
      if (next && wrapper.contains(next)) {
        return;
      }
      commit();
    });

    wrapper.addEventListener("keydown", (event) => {
      if (!(event.target instanceof HTMLInputElement) || event.isComposing) {
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        if (!commit(true)) {
          view.dispatch({
            selection: { anchor: Math.min(this.table.to + 1, view.state.doc.length) },
          });
        }
        view.focus();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        for (const editor of editors) {
          editor.input.value = editor.original;
        }
        view.dispatch({
          selection: { anchor: Math.min(this.table.to + 1, view.state.doc.length) },
        });
        view.focus();
        return;
      }
      if (
        event.key === "Tab" &&
        !event.shiftKey &&
        editors[editors.length - 1]?.input === event.target
      ) {
        event.preventDefault();
        addRow();
      }
    });

    return wrapper;
  }
}

function applyAlignment(element: HTMLElement, align: TableAlignment): void {
  if (align) {
    element.style.textAlign = align;
  }
}

/**
 * A rendered table hides its Markdown source. If a click, search result or
 * go-to-line lands the document selection inside that hidden range, typing
 * would edit invisible text. Move the caret just past the table unless the
 * DOM focus is already inside one of its cell editors.
 */
export const tableSelectionGuard = ViewPlugin.fromClass(
  class {
    private destroyed = false;

    constructor(private readonly view: EditorView) {}

    destroy(): void {
      this.destroyed = true;
    }

    update(update: ViewUpdate): void {
      // Typing can legitimately put the caret inside a table that just became
      // parseable; only moves without an edit (click, search, go-to-line) are
      // redirected out of the hidden source.
      if (!update.selectionSet || update.docChanged) {
        return;
      }
      const field = update.state.field(tableBlockPreview, false);
      if (!field || field.blocked.length === 0) {
        return;
      }
      const head = update.state.selection.main.head;
      if (!field.blocked.some((range) => head >= range.from && head <= range.to)) {
        return;
      }

      queueMicrotask(() => {
        if (this.destroyed) {
          return;
        }
        const currentField = this.view.state.field(tableBlockPreview, false);
        const selection = this.view.state.selection.main;
        const table = currentField?.blocked.find(
          (range) => selection.head >= range.from && selection.head <= range.to,
        );
        if (!table) {
          return;
        }
        const block = this.view.dom.querySelector<HTMLElement>(
          `.cm-md-table-block[data-table-from="${table.from}"]`,
        );
        if (block?.contains(this.view.dom.ownerDocument.activeElement)) {
          return;
        }
        const target = Math.min(table.to + 1, this.view.state.doc.length);
        // A caret already at the very end of the document cannot be moved;
        // dispatching the same selection again would loop forever.
        if (target === selection.head) {
          return;
        }
        this.view.dispatch({ selection: { anchor: target } });
      });
    }
  },
);

export const tableBlockPreview = StateField.define<TableBlockState>({
  create: buildTableBlocks,
  update(value, transaction) {
    const treeChanged = syntaxTree(transaction.state) !== syntaxTree(transaction.startState);
    const readOnlyChanged = transaction.startState.readOnly !== transaction.state.readOnly;
    if (
      editorCopyChanged(transaction) ||
      transaction.docChanged ||
      treeChanged ||
      readOnlyChanged
    ) {
      return buildTableBlocks(transaction.state);
    }

    if (!transaction.newSelection.eq(transaction.startState.selection)) {
      const nextKey = selectionKey(transaction.state, value.gated);
      if (nextKey !== value.selectionKey) {
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
