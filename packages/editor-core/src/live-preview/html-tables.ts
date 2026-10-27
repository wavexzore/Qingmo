import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { EditorView, WidgetType } from "@codemirror/view";

import { renderInlineMarkdown } from "./inline-render";
import type { MarkdownNode } from "./markdown-node";
import type { TableAlignment } from "./specs";

/**
 * HTML tables are rendered through a strict structural parser. Only table
 * structure, numeric spanning and alignment attributes are read; every other
 * tag or attribute stays inert text, and cell content goes through the shared
 * Markdown renderer (which never uses innerHTML).
 */
export const HTML_TABLE_MAX_UNITS = 200_000;
export const HTML_TABLE_MAX_ROWS = 500;
export const HTML_TABLE_MAX_CELLS = 5_000;
const MAX_SPAN = 1_000;

export type HtmlSection = "head" | "body" | "foot";
export type HtmlTableCellTag = "th" | "td";

export interface HtmlTableCell {
  tag: HtmlTableCellTag;
  content: string;
  colspan: number;
  rowspan: number;
  align: TableAlignment;
  scope: "col" | "row" | "colgroup" | "rowgroup" | null;
}

export interface HtmlTableRow {
  section: HtmlSection;
  cells: readonly HtmlTableCell[];
}

export interface HtmlTable {
  from: number;
  to: number;
  caption: string | null;
  rows: readonly HtmlTableRow[];
}

const STRUCTURAL_TAG = /^(?:table|caption|thead|tbody|tfoot|tr|th|td)$/i;
const TABLE_TAG = /<(\/?)table\b[^>]*>/gi;
const ATTRIBUTE = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

function parseHtmlAttributes(raw: string): Map<string, string> {
  const attributes = new Map<string, string>();
  ATTRIBUTE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTRIBUTE.exec(raw))) {
    attributes.set((match[1] ?? "").toLowerCase(), match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

function span(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 1;
  }
  return Math.min(parsed, MAX_SPAN);
}

function alignment(value: string | undefined): TableAlignment {
  switch (value?.trim().toLowerCase()) {
    case "center":
      return "center";
    case "right":
      return "right";
    case "left":
      return "left";
    default:
      return null;
  }
}

function scope(value: string | undefined): HtmlTableCell["scope"] {
  switch (value?.trim().toLowerCase()) {
    case "col":
      return "col";
    case "row":
      return "row";
    case "colgroup":
      return "colgroup";
    case "rowgroup":
      return "rowgroup";
    default:
      return null;
  }
}

interface CellDraft {
  tag: HtmlTableCellTag;
  attributes: Map<string, string>;
  content: string;
}

interface RowDraft {
  section: HtmlSection;
  cells: CellDraft[];
}

/**
 * Parses a complete `<table>…</table>` fragment. Malformed rows are still
 * rendered (cells close implicitly), but nesting is kept as inert text and
 * documents without a single table row fall back to source styling.
 */
export function parseHtmlTable(raw: string): Omit<HtmlTable, "from" | "to"> | null {
  const rows: RowDraft[] = [];
  let section: HtmlSection = "body";
  let caption: string | null = null;
  let captionBuffer: string | null = null;
  let row: CellDraft[] | null = null;
  let cell: CellDraft | null = null;
  let depth = 0;
  let cellCount = 0;

  const append = (text: string) => {
    if (!text) {
      return;
    }
    if (captionBuffer !== null) {
      captionBuffer += text;
    } else if (cell) {
      cell.content += text;
    }
  };

  const closeCell = () => {
    if (!cell || !row) {
      return;
    }
    row.push(cell);
    cell = null;
  };

  const closeRow = () => {
    closeCell();
    if (!row) {
      return;
    }
    if (row.length > 0) {
      rows.push({ section, cells: row });
    }
    row = null;
  };

  const tagPattern = /<(\/?)([A-Za-z][\w:-]*)([^>]*)>/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(raw))) {
    append(raw.slice(cursor, match.index));
    cursor = tagPattern.lastIndex;

    const closing = match[1] === "/";
    const name = (match[2] ?? "").toLowerCase();
    const attributeSource = match[3] ?? "";

    if (!STRUCTURAL_TAG.test(name)) {
      append(match[0]);
      continue;
    }

    if (name === "table") {
      if (closing) {
        if (depth > 1) {
          depth -= 1;
          append(match[0]);
          continue;
        }
        depth = 0;
        closeRow();
        continue;
      }
      depth += 1;
      if (depth > 1) {
        // Nested tables are not part of the supported preview structure.
        append(match[0]);
      }
      continue;
    }

    if (depth > 1) {
      append(match[0]);
      continue;
    }

    switch (name) {
      case "caption":
        if (closing) {
          if (captionBuffer !== null) {
            caption = captionBuffer.trim() || null;
            captionBuffer = null;
          }
        } else {
          closeRow();
          captionBuffer = "";
        }
        break;
      case "thead":
        closeRow();
        section = "head";
        break;
      case "tbody":
        closeRow();
        section = "body";
        break;
      case "tfoot":
        closeRow();
        section = "foot";
        break;
      case "tr":
        if (closing) {
          closeRow();
        } else {
          closeRow();
          row = [];
        }
        break;
      case "th":
      case "td":
        if (closing) {
          closeCell();
        } else {
          if (!row) {
            row = [];
          }
          closeCell();
          cell = {
            tag: name,
            attributes: parseHtmlAttributes(attributeSource),
            content: "",
          };
          cellCount += 1;
        }
        break;
      default:
        break;
    }
  }
  append(raw.slice(cursor));
  closeRow();

  if (cellCount === 0 || cellCount > HTML_TABLE_MAX_CELLS || rows.length > HTML_TABLE_MAX_ROWS) {
    return null;
  }

  return {
    caption,
    rows: rows.map((tableRow) => ({
      section: tableRow.section,
      cells: tableRow.cells.map((draft) => ({
        tag: draft.tag,
        content: draft.content.trim(),
        colspan: span(draft.attributes.get("colspan")),
        rowspan: span(draft.attributes.get("rowspan")),
        align: alignment(draft.attributes.get("align")),
        scope: scope(draft.attributes.get("scope")),
      })),
    })),
  };
}

/** Locates the matching `</table>` while accounting for nested tables. */
function tableEnd(raw: string): number | null {
  TABLE_TAG.lastIndex = 0;
  let depth = 0;
  let match: RegExpExecArray | null;
  while ((match = TABLE_TAG.exec(raw))) {
    if (match[1] === "/") {
      depth -= 1;
      if (depth === 0) {
        return match.index + match[0].length;
      }
    } else {
      depth += 1;
    }
  }
  return null;
}

function linePrefixIsBlank(state: EditorState, from: number): boolean {
  const line = state.doc.lineAt(from);
  return state.doc.sliceString(line.from, from).trim() === "";
}

/**
 * Reads top-level HTML table blocks. A table may contain blank lines, so the
 * range extends from the first line to the matching closing tag instead of
 * relying on Lezer's blank-line-delimited HTMLBlock alone.
 */
export function readHtmlTables(state: EditorState): readonly HtmlTable[] {
  if (state.doc.length > HTML_TABLE_MAX_UNITS) {
    return [];
  }

  const doc = state.doc;
  const root = syntaxTree(state).topNode as unknown as MarkdownNode;
  const tables: HtmlTable[] = [];

  for (let child = root.firstChild; child; child = child.nextSibling) {
    if (child.name !== "HTMLBlock") {
      continue;
    }
    const node = child;
    const head = doc.sliceString(node.from, node.to);
    if (!/^\s*<table\b/i.test(head) || !linePrefixIsBlank(state, node.from)) {
      continue;
    }

    const rest = doc.sliceString(node.from);
    const endOffset = tableEnd(rest);
    if (endOffset === null) {
      continue;
    }
    const end = node.from + endOffset;
    const endLine = doc.lineAt(Math.max(node.from, end - 1));
    const after = doc.sliceString(end, endLine.to);
    if (after.trim()) {
      continue;
    }

    const fromLine = doc.lineAt(node.from);
    const raw = doc.sliceString(fromLine.from, endLine.to);
    if (!/<\/table\s*>\s*$/i.test(raw)) {
      continue;
    }
    const parsed = parseHtmlTable(raw);
    if (!parsed) {
      continue;
    }

    tables.push({
      from: fromLine.from,
      to: endLine.to,
      caption: parsed.caption,
      rows: parsed.rows,
    });
  }

  return tables;
}

function sectionElementName(section: HtmlSection): "thead" | "tbody" | "tfoot" {
  return section === "head" ? "thead" : section === "foot" ? "tfoot" : "tbody";
}

function applyCellStructure(cell: HTMLTableCellElement, value: HtmlTableCell): void {
  if (value.colspan > 1) {
    cell.colSpan = value.colspan;
  }
  if (value.rowspan > 1) {
    cell.rowSpan = value.rowspan;
  }
  if (value.align) {
    cell.style.textAlign = value.align;
  }
  if (value.scope) {
    cell.scope = value.scope;
  } else if (value.tag === "th") {
    cell.scope = "col";
  }
}

/** Builds the rendered DOM for one parsed HTML table. */
export function renderHtmlTable(table: HtmlTable): HTMLTableElement {
  const element = document.createElement("table");

  if (table.caption) {
    const caption = document.createElement("caption");
    renderInlineMarkdown(caption, table.caption);
    element.append(caption);
  }

  let currentSection: HtmlSection | null = null;
  let sectionElement: HTMLTableSectionElement | null = null;
  for (const row of table.rows) {
    if (row.section !== currentSection || !sectionElement) {
      currentSection = row.section;
      sectionElement = document.createElement(sectionElementName(row.section));
      element.append(sectionElement);
    }

    const tr = document.createElement("tr");
    for (const value of row.cells) {
      const cell = document.createElement(value.tag);
      applyCellStructure(cell, value);
      renderInlineMarkdown(cell, value.content);
      tr.append(cell);
    }
    sectionElement.append(tr);
  }

  return element;
}

class HtmlTableWidget extends WidgetType {
  constructor(private readonly table: HtmlTable) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return (
      other instanceof HtmlTableWidget &&
      other.table.from === this.table.from &&
      other.table.to === this.table.to &&
      JSON.stringify(other.table.rows) === JSON.stringify(this.table.rows) &&
      other.table.caption === this.table.caption
    );
  }

  override toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "cm-md-table-block cm-md-html-table-block";
    wrapper.title = "点击编辑 HTML 表格源码";
    wrapper.append(renderHtmlTable(this.table));

    // The widget has no editable text: clicking it reveals the source and
    // places the caret on the opening line.
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

    return wrapper;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

export { HtmlTableWidget };
