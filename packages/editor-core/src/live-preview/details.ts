import { syntaxTree } from "@codemirror/language";
import { StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

import { editorCopyChanged, editorUiCopy, type EditorUiCopy } from "../i18n";
import { readFrontMatter } from "./frontmatter";
import { headingLevel, headingText, isHeading } from "./heading-text";
import { renderInlineMarkdown } from "./inline-render";
import { readTable } from "./specs";
import type { MarkdownNode } from "./markdown-node";

/**
 * `<details>` blocks are common in Markdown guides and READMEs. Their content
 * is Markdown, so a single HTML tag replacement is not enough: the whole block
 * is rendered as a read-only preview with a collapsible header. Clicking the
 * content or the “Source” button returns the caret to the opening tag.
 */
export const DETAILS_BLOCK_MAX_UNITS = 200_000;
const MAX_BODY_LENGTH = 100_000;

export interface DetailsBlock {
  from: number;
  to: number;
  bodyFrom: number;
  bodyTo: number;
  summary: string;
  open: boolean;
  raw: string;
  children: readonly DetailsBlock[];
}

interface MutableDetailsBlock {
  from: number;
  to: number | null;
  bodyFrom: number;
  bodyTo: number | null;
  summary: string;
  open: boolean;
  children: MutableDetailsBlock[];
}

function directChild(node: MarkdownNode, name: string): MarkdownNode | null {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === name) {
      return child;
    }
  }
  return null;
}

function summaryText(inner: string, copy: EditorUiCopy): string {
  if (typeof DOMParser === "undefined") {
    return inner.replace(/<[^>]+>/g, "").trim() || copy.details.summary;
  }
  const parsed = new DOMParser().parseFromString(inner, "text/html");
  return (parsed.body.textContent ?? "").trim() || copy.details.summary;
}

/**
 * Reads `<summary>` immediately after an opening tag. A summary separated by a
 * blank line is a separate HTML block in Lezer's tree, so it is intentionally
 * not consumed here; the body nevertheless starts after the opening tag.
 */
function readSummary(
  html: string,
  start: number,
  copy: EditorUiCopy,
): { summary: string; bodyStart: number } {
  const rest = html.slice(start);
  // A summary belongs to this block only until the next nested `<details>`
  // starts; otherwise an outer block would inherit the inner summary.
  const nested = rest.search(/<details\b/i);
  const candidate = nested < 0 ? rest : rest.slice(0, nested);
  const match = /<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/i.exec(candidate);
  if (!match) {
    return { summary: copy.details.summary, bodyStart: start };
  }
  return {
    summary: summaryText(match[1] ?? "", copy),
    bodyStart: start + (match.index ?? 0) + match[0].length,
  };
}

function hasOpenAttribute(attributes: string): boolean {
  return /(?:^|\s)open(?:\s|=|$)/i.test(attributes);
}

const DETAILS_TAG = /<(\/?)\s*details\b([^>]*)>/gi;

/**
 * Pairs `<details>` tags by scanning HTML blocks. One HTML block can contain the
 * opening tag, summary, body and closing tag when the author omits blank lines,
 * and nested `<details>` elements share the same block. A stack keeps both
 * cases consistent without treating Markdown code fences as HTML.
 */
export function readDetailsBlocks(state: EditorState): readonly DetailsBlock[] {
  if (state.doc.length > DETAILS_BLOCK_MAX_UNITS) {
    return [];
  }
  const copy = state.facet(editorUiCopy);
  const doc = state.doc;
  const root = syntaxTree(state).topNode as unknown as MarkdownNode;
  const frontMatter = readFrontMatter(doc);
  const roots: MutableDetailsBlock[] = [];
  const stack: MutableDetailsBlock[] = [];

  for (let child = root.firstChild; child; child = child.nextSibling) {
    if (frontMatter && child.from >= frontMatter.from && child.to <= frontMatter.to) {
      continue;
    }
    if (child.name !== "HTMLBlock") {
      continue;
    }

    const html = doc.sliceString(child.from, child.to);
    DETAILS_TAG.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = DETAILS_TAG.exec(html))) {
      const closing = match[1] === "/";
      const tagStart = child.from + match.index;
      const tagEnd = tagStart + match[0].length;

      if (closing) {
        const block = stack.pop();
        if (!block) {
          continue;
        }
        block.to = tagEnd;
        block.bodyTo = Math.max(block.bodyFrom, tagStart);
        if (stack.length === 0) {
          roots.push(block);
        }
        continue;
      }

      // `<details />` has no body and is left as source.
      if (/\/\s*>$/.test(match[0])) {
        continue;
      }

      const { summary, bodyStart } = readSummary(html, match.index + match[0].length, copy);
      const block: MutableDetailsBlock = {
        from: tagStart,
        to: null,
        bodyFrom: child.from + bodyStart,
        bodyTo: null,
        summary,
        open: hasOpenAttribute(match[2] ?? ""),
        children: [],
      };
      const parent = stack[stack.length - 1];
      if (parent) {
        parent.children.push(block);
      }
      stack.push(block);
    }
  }

  const finalize = (block: MutableDetailsBlock): DetailsBlock | null => {
    if (block.to === null || block.bodyTo === null) {
      return null;
    }
    const children: DetailsBlock[] = [];
    for (const child of block.children) {
      const finalized = finalize(child);
      if (finalized) {
        children.push(finalized);
      }
    }
    return {
      from: block.from,
      to: block.to,
      bodyFrom: block.bodyFrom,
      bodyTo: block.bodyTo,
      summary: block.summary,
      open: block.open,
      raw: doc.sliceString(block.from, block.to),
      children,
    };
  };

  const blocks: DetailsBlock[] = [];
  for (const block of roots) {
    const finalized = finalize(block);
    if (finalized) {
      blocks.push(finalized);
    }
  }
  return blocks;
}

function appendTextBlock(
  parent: HTMLElement,
  tag: string,
  className: string,
  text: string,
  copy: EditorUiCopy,
): void {
  const element = document.createElement(tag);
  element.className = className;
  renderInlineMarkdown(element, text, copy);
  parent.append(element);
}

function codeText(doc: EditorState["doc"], node: MarkdownNode): string {
  let code = "";
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "CodeText") {
      code += doc.sliceString(child.from, child.to);
    }
  }
  return code;
}

function renderCode(parent: HTMLElement, state: EditorState, node: MarkdownNode): void {
  const wrapper = document.createElement("div");
  wrapper.className = "cm-md-details-code";
  const info = directChild(node, "CodeInfo");
  const language = info
    ? (state.doc.sliceString(info.from, info.to).trim().split(/\s+/)[0] ?? "")
    : "";
  if (language) {
    const badge = document.createElement("span");
    badge.className = "cm-md-details-code-lang";
    badge.textContent = language;
    wrapper.append(badge);
  }
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.textContent = codeText(state.doc, node);
  pre.append(code);
  wrapper.append(pre);
  parent.append(wrapper);
}

function renderList(
  parent: HTMLElement,
  state: EditorState,
  node: MarkdownNode,
  ordered: boolean,
): void {
  const list = document.createElement(ordered ? "ol" : "ul");
  list.className = "cm-md-details-list";
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name !== "ListItem") {
      continue;
    }
    const item = document.createElement("li");
    for (let part = child.firstChild; part; part = part.nextSibling) {
      if (part.name === "ListMark") {
        continue;
      }
      if (part.name === "Paragraph") {
        appendTextBlock(
          item,
          "div",
          "cm-md-details-li-text",
          state.doc.sliceString(part.from, part.to),
          state.facet(editorUiCopy),
        );
        continue;
      }
      if (part.name === "BulletList" || part.name === "OrderedList") {
        renderList(item, state, part, part.name === "OrderedList");
        continue;
      }
      renderBlock(item, state, part);
    }
    list.append(item);
  }
  parent.append(list);
}

function renderTable(parent: HTMLElement, state: EditorState, node: MarkdownNode): void {
  const table = readTable(state.doc, node);
  if (!table) {
    return;
  }
  const copy = state.facet(editorUiCopy);
  const element = document.createElement("table");
  element.className = "cm-md-details-table";

  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const [index, cell] of table.header.entries()) {
    const th = document.createElement("th");
    if (table.align[index]) {
      th.style.textAlign = table.align[index];
    }
    renderInlineMarkdown(th, cell, copy);
    headRow.append(th);
  }
  head.append(headRow);
  element.append(head);

  const body = document.createElement("tbody");
  for (const row of table.rows) {
    const tr = document.createElement("tr");
    for (const [index, cell] of row.entries()) {
      const td = document.createElement("td");
      if (table.align[index]) {
        td.style.textAlign = table.align[index];
      }
      renderInlineMarkdown(td, cell, copy);
      tr.append(td);
    }
    body.append(tr);
  }
  element.append(body);
  parent.append(element);
}

function renderBlock(parent: HTMLElement, state: EditorState, node: MarkdownNode): void {
  const doc = state.doc;
  if (isHeading(node.name)) {
    appendTextBlock(
      parent,
      `h${headingLevel(node.name)}`,
      "cm-md-details-heading",
      headingText(doc, node),
      state.facet(editorUiCopy),
    );
    return;
  }

  switch (node.name) {
    case "Paragraph":
      appendTextBlock(
        parent,
        "p",
        "cm-md-details-paragraph",
        doc.sliceString(node.from, node.to),
        state.facet(editorUiCopy),
      );
      return;
    case "FencedCode":
    case "CodeBlock":
      renderCode(parent, state, node);
      return;
    case "BulletList":
      renderList(parent, state, node, false);
      return;
    case "OrderedList":
      renderList(parent, state, node, true);
      return;
    case "Blockquote": {
      const quote = document.createElement("blockquote");
      quote.className = "cm-md-details-quote";
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.name !== "QuoteMark") {
          renderBlock(quote, state, child);
        }
      }
      parent.append(quote);
      return;
    }
    case "HorizontalRule":
      parent.append(document.createElement("hr"));
      return;
    case "Table":
      renderTable(parent, state, node);
      return;
    case "HTMLBlock": {
      const raw = doc.sliceString(node.from, node.to).trim();
      if (/^<hr\s*\/?>$/i.test(raw)) {
        parent.append(document.createElement("hr"));
      } else if (!/^<br\s*\/?>$/i.test(raw)) {
        const pre = document.createElement("pre");
        pre.className = "cm-md-details-html";
        pre.textContent = raw;
        parent.append(pre);
      }
      return;
    }
    case "Comment":
    case "CommentBlock":
      return;
    default:
      if (node.firstChild) {
        let child: MarkdownNode | null = node.firstChild;
        while (child) {
          renderBlock(parent, state, child);
          child = child.nextSibling;
        }
      }
  }
}

function rootChildren(state: EditorState): readonly MarkdownNode[] {
  const root = syntaxTree(state).topNode as unknown as MarkdownNode;
  const children: MarkdownNode[] = [];
  let child = root.firstChild;
  while (child) {
    children.push(child);
    child = child.nextSibling;
  }
  return children;
}

/**
 * Text outside Markdown block nodes. This is the body of an inline
 * `<details>...</details>` block, which Lezer keeps as one HTML block and
 * therefore cannot hand to `renderBlock`.
 */
function renderPlain(container: HTMLElement, state: EditorState, from: number, to: number): void {
  const raw = state.doc.sliceString(from, to).trim();
  if (!raw) {
    return;
  }
  const element = document.createElement("div");
  element.className = "cm-md-details-plain";
  renderInlineMarkdown(element, raw, state.facet(editorUiCopy));
  container.append(element);
}

/** Renders complete top-level blocks fully contained in `[from, to)`. */
function renderAstRange(
  container: HTMLElement,
  state: EditorState,
  from: number,
  to: number,
): void {
  let cursor = from;
  for (const child of rootChildren(state)) {
    if (child.to <= from) {
      continue;
    }
    if (child.from >= to) {
      break;
    }
    if (child.from < from || child.to > to) {
      continue;
    }
    renderPlain(container, state, cursor, child.from);
    renderBlock(container, state, child);
    cursor = child.to;
  }
  renderPlain(container, state, cursor, to);
}

function renderBlockRange(container: HTMLElement, view: EditorView, block: DetailsBlock): void {
  let cursor = block.bodyFrom;
  for (const child of block.children) {
    const start = Math.min(child.from, block.bodyTo);
    renderAstRange(container, view.state, cursor, start);
    container.append(buildDetailsElement(view, child, true));
    cursor = Math.max(cursor, Math.min(child.to, block.bodyTo));
  }
  renderAstRange(container, view.state, cursor, block.bodyTo);
}

function renderDetailsBody(container: HTMLElement, view: EditorView, block: DetailsBlock): void {
  const state = view.state;
  const copy = state.facet(editorUiCopy);
  if (block.bodyTo - block.bodyFrom > MAX_BODY_LENGTH) {
    const tooLarge = document.createElement("div");
    tooLarge.className = "cm-md-details-empty";
    tooLarge.textContent = copy.details.tooLarge;
    container.append(tooLarge);
    return;
  }

  const body = state.doc.sliceString(block.bodyFrom, block.bodyTo);
  if (!body.trim()) {
    const empty = document.createElement("div");
    empty.className = "cm-md-details-empty";
    empty.textContent = copy.details.empty;
    container.append(empty);
    return;
  }

  renderBlockRange(container, view, block);
}

function editSource(view: EditorView, from: number): void {
  view.dispatch({ selection: { anchor: from }, scrollIntoView: true });
  view.focus();
}

function buildDetailsElement(view: EditorView, block: DetailsBlock, nested: boolean): HTMLElement {
  const copy = view.state.facet(editorUiCopy);
  const wrapper = document.createElement("div");
  wrapper.className = nested ? "cm-md-details cm-md-details-nested" : "cm-md-details";
  wrapper.dataset.open = String(block.open);
  wrapper.title = copy.details.wrapperTitle;

  const header = document.createElement("div");
  header.className = "cm-md-details-header";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "cm-md-details-summary";
  toggle.setAttribute("aria-expanded", String(block.open));

  const icon = document.createElement("span");
  icon.className = "cm-md-details-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = block.open ? "▾" : "▸";

  const label = document.createElement("span");
  label.className = "cm-md-details-label";
  label.textContent = block.summary;
  toggle.append(icon, label);

  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "cm-md-details-edit";
  edit.textContent = copy.details.edit;
  edit.title = copy.details.editTitle;
  edit.addEventListener("mousedown", (event) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    editSource(view, block.from);
  });

  const content = document.createElement("div");
  content.className = "cm-md-details-content";
  content.hidden = !block.open;
  renderDetailsBody(content, view, block);

  toggle.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const next = wrapper.dataset.open !== "true";
    wrapper.dataset.open = String(next);
    content.hidden = !next;
    toggle.setAttribute("aria-expanded", String(next));
    icon.textContent = next ? "▾" : "▸";
  });

  header.append(toggle, edit);
  wrapper.append(header, content);

  wrapper.addEventListener("mousedown", (event) => {
    if (event.button !== 0) {
      return;
    }
    if ((event.target as Element | null)?.closest(".cm-md-details-header")) {
      // CodeMirror maps any mousedown that reaches the editor onto the
      // document and would delete this block widget before the click can
      // toggle it. The header owns its own interactions, so the event stops
      // here without moving the selection.
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    editSource(view, block.from);
  });

  return wrapper;
}

class DetailsWidget extends WidgetType {
  constructor(
    private readonly copy: EditorUiCopy,
    private readonly block: DetailsBlock,
  ) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return (
      other instanceof DetailsWidget &&
      other.copy.version === this.copy.version &&
      other.block.raw === this.block.raw
    );
  }

  override toDOM(view: EditorView): HTMLElement {
    // Padding-only root: CodeMirror's block measurement excludes margins, so
    // the bordered card must live inside the measured element.
    const wrapper = document.createElement("div");
    wrapper.className = "cm-md-details-widget";
    wrapper.append(buildDetailsElement(view, this.block, false));
    return wrapper;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

interface DetailsState {
  ranges: readonly DetailsBlock[];
  /** Inner source always stays plain while editing the block. */
  blocked: readonly DetailsBlock[];
  insideKey: string;
  decorations: DecorationSet;
}

function emptyState(): DetailsState {
  return { ranges: [], blocked: [], insideKey: "", decorations: Decoration.none };
}

function selectionTouches(state: EditorState, range: { from: number; to: number }): boolean {
  return state.selection.ranges.some(
    (selection) => selection.from <= range.to && selection.to >= range.from,
  );
}

function insideKey(state: EditorState, ranges: readonly DetailsBlock[]): string {
  return ranges
    .map((range, index) => (selectionTouches(state, range) ? index : ""))
    .filter((value) => value !== "")
    .join(",");
}

function buildDetails(state: EditorState): DetailsState {
  if (state.doc.length > DETAILS_BLOCK_MAX_UNITS) {
    return emptyState();
  }
  const ranges = readDetailsBlocks(state);
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
          widget: new DetailsWidget(copy, range),
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

export const detailsBlockPreview = StateField.define<DetailsState>({
  create: buildDetails,
  update(value, transaction) {
    const treeChanged = syntaxTree(transaction.state) !== syntaxTree(transaction.startState);
    if (editorCopyChanged(transaction) || transaction.docChanged || treeChanged) {
      return buildDetails(transaction.state);
    }
    if (!transaction.newSelection.eq(transaction.startState.selection)) {
      if (insideKey(transaction.state, value.ranges) !== value.insideKey) {
        return buildDetails(transaction.state);
      }
    }
    return value;
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    EditorView.atomicRanges.of((view) => view.state.field(field).decorations),
  ],
});
