import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

import { emojiForName } from "./emoji";
import {
  readAttributeAnchors,
  readAttributeLine,
  readTrailingAttributes,
} from "./attribute-blocks";
import {
  htmlAnchorId,
  readAnchorOnlyBlock,
  readHeadingAnchors,
  readHtmlAnchors,
  resolveHeadingAnchor,
  type HeadingAnchor,
} from "./heading-anchors";
import { FOOTNOTE_DEFINITION, readFootnoteDefinitions, readInlineFootnotes } from "./footnotes";
import { INLINE_HTML_TAGS } from "./inline-render";
import type { MarkdownNode } from "./markdown-node";
import { editorUiCopy } from "../i18n";
import { LP_MAX_UNITS, MAX_LINE_UNITS } from "../limits";

export type { MarkdownNode } from "./markdown-node";

export interface VisibleRange {
  from: number;
  to: number;
}

export type TableAlignment = "left" | "center" | "right" | null;

/**
 * Serializable description of a widget. The decorator planner stays pure and
 * testable; `widgets.ts` turns these descriptions into CM6 WidgetType
 * instances.
 */
export type LivePreviewWidgetSpec =
  | { kind: "bullet" }
  | { kind: "task"; checked: boolean }
  | { kind: "rule" }
  | {
      kind: "image";
      src: string;
      alt: string;
      title: string | null;
      width: string | null;
      height: string | null;
    }
  | { kind: "code-language"; language: string; title: string | null }
  | { kind: "entity"; raw: string }
  | { kind: "emoji"; char: string }
  | { kind: "inline-html"; tag: string; content: string }
  | { kind: "alert"; label: string }
  | { kind: "footnote-ref"; label: string; lineFrom: number | null }
  | { kind: "footnote-def"; label: string }
  | { kind: "inline-footnote"; label: string; content: string }
  | { kind: "math"; tex: string; display: boolean }
  | { kind: "abbreviation"; term: string; definition: string }
  | { kind: "wiki-link"; target: string; label: string; embed: boolean }
  | { kind: "anchor-link"; label: string; href: string; lineFrom: number }
  | { kind: "html-anchor"; label: string }
  | { kind: "attributes"; label: string };

export type DecorationSpec =
  | { kind: "replace"; from: number; to: number }
  | {
      kind: "mark";
      from: number;
      to: number;
      className: string;
      attributes?: Readonly<Record<string, string>>;
    }
  | { kind: "line"; from: number; to: number; className: string }
  | {
      kind: "widget";
      from: number;
      to: number;
      widget: LivePreviewWidgetSpec;
    };

const HEADING_CLASSES: Record<string, string> = {
  ATXHeading1: "cm-md-h1",
  ATXHeading2: "cm-md-h2",
  ATXHeading3: "cm-md-h3",
  ATXHeading4: "cm-md-h4",
  ATXHeading5: "cm-md-h5",
  ATXHeading6: "cm-md-h6",
  SetextHeading1: "cm-md-h1",
  SetextHeading2: "cm-md-h2",
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
  "cm-md-table": 3,
  "cm-md-code-block": 4,
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

function isWhitespace(value: string): boolean {
  return value === " " || value === "\t";
}

function extendOverWhitespace(doc: EditorState["doc"], position: number, limit: number): number {
  let end = position;
  while (end < limit && isWhitespace(doc.sliceString(end, end + 1))) {
    end += 1;
  }
  return end;
}

/**
 * Expands an ATX heading marker into its visual prefix/suffix.
 *
 * Lezer reports only the `#` characters; the separating space belongs to the
 * heading content. Replacing the marker alone would leave `# ddd` rendered as
 * ` ddd`, so the opening marker swallows following whitespace. Closing markers
 * (`## title ##`) swallow the whitespace before them for the same reason.
 */
function headingMarkerRange(
  doc: EditorState["doc"],
  mark: MarkdownNode,
  heading: MarkdownNode,
): { from: number; to: number } {
  const line = doc.lineAt(mark.from);
  const opening = directChildren(heading, "HeaderMark")[0];
  let from = mark.from;
  let to = mark.to;

  if (opening && mark.from > opening.from) {
    // Closing marker: swallow the whitespace before it, but stop at the
    // opening marker's visual end so `# #` never produces overlapping ranges.
    let openingEnd = opening.to;
    while (openingEnd < line.to && isWhitespace(doc.sliceString(openingEnd, openingEnd + 1))) {
      openingEnd += 1;
    }
    while (from > openingEnd && isWhitespace(doc.sliceString(from - 1, from))) {
      from -= 1;
    }
  } else {
    while (to < line.to && isWhitespace(doc.sliceString(to, to + 1))) {
      to += 1;
    }
  }

  return { from, to };
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

function firstChild(node: MarkdownNode, name: string): MarkdownNode | null {
  return directChildren(node, name)[0] ?? null;
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

function parseAlignment(delimiter: string): TableAlignment[] {
  const trimmed = delimiter.trim();
  const inner = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const withoutEnd = inner.endsWith("|") ? inner.slice(0, -1) : inner;
  return withoutEnd.split("|").map((part) => {
    const value = part.trim();
    const left = value.startsWith(":");
    const right = value.endsWith(":");
    if (left && right) {
      return "center";
    }
    if (left) {
      return "left";
    }
    if (right) {
      return "right";
    }
    return null;
  });
}

/**
 * Source range of one table cell. The trimmed `text` is what the rendered
 * widget shows; `from`/`to` include the surrounding padding so an in-place
 * edit can replace the text without disturbing the table's alignment or
 * column spacing.
 */
export interface TableCellRange {
  from: number;
  to: number;
  text: string;
}

export interface ParsedTable {
  from: number;
  to: number;
  header: string[];
  align: TableAlignment[];
  rows: string[][];
  headerLine: number;
  delimiterLine: number;
  rowLines: number[];
  headerCells: TableCellRange[];
  rowCells: TableCellRange[][];
}

function isEscapedPipe(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

/**
 * Splits a table row into cell ranges. Lezer omits `TableCell` children for
 * empty cells, which would make a freshly inserted row impossible to fill in;
 * scanning the row text keeps every column addressable.
 */
function splitTableRow(text: string, offset: number): TableCellRange[] {
  const segments: Array<{ start: number; end: number }> = [];
  let start = text.startsWith("|") && !isEscapedPipe(text, 0) ? 1 : 0;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === "|" && !isEscapedPipe(text, index)) {
      segments.push({ start, end: index });
      start = index + 1;
    }
  }
  const trailing = text.slice(start);
  if (
    segments.length === 0 ||
    (start < text.length && !(segments.length > 0 && trailing.trim().length === 0))
  ) {
    // Whitespace after the closing pipe is table padding, not a new column.
    segments.push({ start, end: text.length });
  }

  return segments.map((segment) => {
    const raw = text.slice(segment.start, segment.end);
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      // An empty cell has no text range of its own. Put the insertion point
      // between its padding so typing keeps the surrounding spaces.
      const position = offset + segment.start + Math.floor(raw.length / 2);
      return { from: position, to: position, text: "" };
    }
    const leading = raw.length - raw.trimStart().length;
    const trailing = raw.length - raw.trimEnd().length;
    return {
      from: offset + segment.start + leading,
      to: offset + segment.end - trailing,
      text: trimmed,
    };
  });
}

function padTableCells(
  cells: TableCellRange[],
  columns: number,
  rowText: string,
  rowOffset: number,
): TableCellRange[] {
  if (cells.length >= columns) {
    return cells.slice(0, columns);
  }
  // A short row still gets an editable cell for every header column. Insert
  // missing values before the closing pipe so the Markdown stays well formed.
  const position =
    rowText.endsWith("|") && !isEscapedPipe(rowText, rowText.length - 1)
      ? rowOffset + rowText.length - 1
      : rowOffset + rowText.length;
  return [
    ...cells,
    ...Array.from({ length: columns - cells.length }, () => ({
      from: position,
      to: position,
      text: "",
    })),
  ];
}

export function readTable(doc: EditorState["doc"], table: MarkdownNode): ParsedTable | null {
  const headerNode = firstChild(table, "TableHeader");
  const delimiterNode = firstChild(table, "TableDelimiter");
  if (!headerNode || !delimiterNode) {
    return null;
  }

  const headerCells = splitTableRow(
    doc.sliceString(headerNode.from, headerNode.to),
    headerNode.from,
  );
  const header = headerCells.map((cell) => cell.text);
  if (header.length === 0) {
    return null;
  }

  const align = parseAlignment(doc.sliceString(delimiterNode.from, delimiterNode.to));
  const rowNodes = directChildren(table, "TableRow");
  const rowCells = rowNodes.map((row) => {
    const rowText = doc.sliceString(row.from, row.to);
    return padTableCells(splitTableRow(rowText, row.from), header.length, rowText, row.from);
  });
  const rows = rowCells.map((cells) => header.map((_, index) => cells[index]?.text ?? ""));

  return {
    from: doc.lineAt(table.from).from,
    to: doc.lineAt(Math.min(table.to, doc.length)).to,
    header,
    align: header.map((_, index) => align[index] ?? null),
    rows,
    headerLine: doc.lineAt(headerNode.from).from,
    delimiterLine: doc.lineAt(delimiterNode.from).from,
    rowLines: rowNodes.map((row) => doc.lineAt(row.from).from),
    headerCells,
    rowCells,
  };
}

export interface ParsedFencedCode {
  language: string;
  title: string | null;
  highlightLines: readonly number[];
  openingLine: { from: number; to: number };
  closingLine: { from: number; to: number };
  /** Range of the code text between the two fence lines. */
  contentFrom: number;
  contentTo: number;
  /** Range of the language token in the opening info string. */
  infoFrom: number;
  infoTo: number;
}

interface ParsedCodeInfo {
  language: string;
  title: string | null;
  highlightLines: readonly number[];
}

function parseHighlightLines(raw: string): number[] {
  const lines = new Set<number>();
  for (const token of raw.split(/[,\s]+/)) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(token);
    if (!match) {
      continue;
    }
    let start = Number(match[1]);
    let end = Number(match[2] ?? match[1]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1) {
      continue;
    }
    if (start > end) {
      [start, end] = [end, start];
    }
    // Keep a malformed `{1-999999}` info string from creating thousands of
    // decorations. Real code blocks are far smaller than this cap.
    end = Math.min(end, start + 1_000);
    for (let line = start; line <= end; line += 1) {
      lines.add(line);
    }
  }
  return [...lines].sort((left, right) => left - right);
}

/**
 * Splits a fenced-code info string into its language, optional title and the
 * `{2,4-5}` line-highlight ranges used by several Markdown renderers.
 */
export function parseCodeInfo(raw: string): ParsedCodeInfo {
  let rest = raw.trim();
  let title: string | null = null;

  const titleMatch = /(?:^|\s)title\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/i.exec(rest);
  if (titleMatch) {
    title = titleMatch[1] ?? titleMatch[2] ?? titleMatch[3] ?? null;
    rest = `${rest.slice(0, titleMatch.index)} ${rest.slice(titleMatch.index + titleMatch[0].length)}`;
  }

  let highlightLines: readonly number[] = [];
  const highlightMatch = /\{([^{}]*)\}/.exec(rest);
  if (highlightMatch) {
    highlightLines = parseHighlightLines(highlightMatch[1] ?? "");
    rest = `${rest.slice(0, highlightMatch.index)} ${rest.slice(highlightMatch.index + highlightMatch[0].length)}`;
  }

  const language = rest.trim().split(/\s+/)[0] ?? "";
  return { language, title, highlightLines };
}

export function readFencedCode(
  doc: EditorState["doc"],
  node: MarkdownNode,
): ParsedFencedCode | null {
  const marks = directChildren(node, "CodeMark");
  if (marks.length < 2) {
    return null;
  }

  const opening = marks[0];
  const closing = marks[marks.length - 1];
  if (!opening || !closing) {
    return null;
  }
  const openingLine = doc.lineAt(opening.from);
  const closingLine = doc.lineAt(closing.from);
  const info = firstChild(node, "CodeInfo");
  const parsed = parseCodeInfo(info ? doc.sliceString(info.from, info.to) : "");

  // The code text starts on the line after the opening fence and stops
  // before the newline that introduces the closing fence. Keeping the
  // trailing newline out matches how Typora hands the block to its embedded
  // editor and makes the round trip back into Markdown unambiguous.
  const contentFrom = Math.min(openingLine.to + 1, closingLine.from);
  const contentTo = Math.max(contentFrom, closingLine.from - 1);

  // Locate the language token inside the opening line. `CodeInfo` covers the
  // whole info string (language, title, line-highlight range), so the token
  // itself is derived from the text following the fence marker.
  const afterFence = doc.sliceString(opening.to, openingLine.to);
  const leading = afterFence.length - afterFence.trimStart().length;
  const firstToken = afterFence.trimStart().split(/\s+/)[0] ?? "";
  const infoFrom = opening.to + leading;
  const infoTo =
    parsed.language && firstToken === parsed.language
      ? infoFrom + parsed.language.length
      : infoFrom;

  return {
    ...parsed,
    openingLine: { from: openingLine.from, to: openingLine.to },
    closingLine: { from: closingLine.from, to: closingLine.to },
    contentFrom,
    contentTo,
    infoFrom,
    infoTo,
  };
}

interface ReferenceDefinition {
  url: string;
  title: string | null;
}

function normalizeReferenceLabel(value: string): string {
  return value.replace(/^\[/, "").replace(/\]$/, "").trim().replace(/\s+/g, " ").toLowerCase();
}

function titleText(doc: EditorState["doc"], node: MarkdownNode | null): string | null {
  return node ? doc.sliceString(node.from, node.to).replace(/^["'(]|["')]$/g, "") : null;
}

function readImage(
  doc: EditorState["doc"],
  node: MarkdownNode,
  references: () => Map<string, ReferenceDefinition>,
): Extract<LivePreviewWidgetSpec, { kind: "image" }> | null {
  const marks = directChildren(node, "LinkMark");
  const url = firstChild(node, "URL");
  const opening = marks[0];
  const closingLabel = marks.find((mark) => doc.sliceString(mark.from, mark.to) === "]");

  if (!opening || !closingLabel) {
    return null;
  }

  const alt = doc.sliceString(opening.to, closingLabel.from);
  const title = titleText(doc, firstChild(node, "LinkTitle"));
  if (url) {
    return {
      kind: "image",
      src: doc.sliceString(url.from, url.to),
      alt,
      title,
      width: null,
      height: null,
    };
  }

  // Reference-style image: resolve `![alt][ref]` through `[ref]: url`.
  const label = firstChild(node, "LinkLabel");
  if (!label) {
    return null;
  }
  const definition = references().get(
    normalizeReferenceLabel(doc.sliceString(label.from, label.to)),
  );
  return definition
    ? {
        kind: "image",
        src: definition.url,
        alt,
        title: definition.title,
        width: null,
        height: null,
      }
    : null;
}

interface ParsedInlineHtmlTag {
  name: string;
  closing: boolean;
  selfClosing: boolean;
}

/** Parses only attribute-free HTML tags; anything else stays source text. */
function parseInlineHtmlTag(raw: string): ParsedInlineHtmlTag | null {
  const closing = /^<\s*\/\s*([a-zA-Z][\w-]*)\s*>$/.exec(raw);
  if (closing) {
    return { name: (closing[1] ?? "").toLowerCase(), closing: true, selfClosing: false };
  }
  const selfClosing = /^<\s*([a-zA-Z][\w-]*)\s*\/\s*>$/.exec(raw);
  if (selfClosing) {
    return { name: (selfClosing[1] ?? "").toLowerCase(), closing: false, selfClosing: true };
  }
  const opening = /^<\s*([a-zA-Z][\w-]*)\s*>$/.exec(raw);
  if (opening) {
    return { name: (opening[1] ?? "").toLowerCase(), closing: false, selfClosing: false };
  }
  return null;
}

/** Finds the matching close tag among the inline siblings of `node`. */
function findMatchingInlineHtml(
  doc: EditorState["doc"],
  node: MarkdownNode,
  name: string,
): MarkdownNode | null {
  let depth = 1;
  for (let sibling = node.nextSibling; sibling; sibling = sibling.nextSibling) {
    if (sibling.name !== "HTMLTag") {
      continue;
    }
    const tag = parseInlineHtmlTag(doc.sliceString(sibling.from, sibling.to));
    if (!tag || tag.name !== name || tag.selfClosing) {
      continue;
    }
    depth += tag.closing ? -1 : 1;
    if (depth === 0) {
      return sibling;
    }
  }
  return null;
}

function readFootnoteReference(doc: EditorState["doc"], node: MarkdownNode): string | null {
  const marks = directChildren(node, "LinkMark");
  const opening = marks[0];
  const closing = marks[1];
  if (!opening || !closing) {
    return null;
  }
  const label = doc.sliceString(opening.to, closing.from);
  if (!/^\^[^^\s\]]+$/.test(label)) {
    return null;
  }
  // `[^x](url)` is an ordinary inline link whose label starts with a caret.
  if (doc.sliceString(closing.to, closing.to + 1) === "(") {
    return null;
  }
  return label.slice(1);
}

const ALERT_PATTERN = /^\s*>+\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/;
const ABBREVIATION_DEFINITION = /^\*\[([^\]\n]+)\]:[ \t]+(\S[^\n]*)$/;
const WIKI_LINK = /^\[\[([^[\]\n]+)\]\]$/;
const WIKI_EMBED = /^!\[\[([^[\]\n]+)\]\]$/;

/**
 * These subtrees contain literal text rather than prose. Abbreviations must
 * never rewrite code, URLs, link destinations or raw HTML tags.
 */
const ABBREVIATION_EXCLUDED = new Set([
  "InlineCode",
  "Link",
  "Image",
  "Autolink",
  "URL",
  "HTMLTag",
  "HTMLBlock",
  "FencedCode",
  "CodeBlock",
  "Comment",
  "CommentBlock",
  "LinkReference",
]);

interface AbbreviationDefinition {
  term: string;
  definition: string;
  from: number;
  to: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function abbreviationPattern(term: string): RegExp {
  // ASCII word boundaries keep `HTML5` and `XHTML` untouched while still
  // matching `HTML` next to CJK prose (which has no ASCII word characters).
  return new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(term)}(?![A-Za-z0-9_])`, "g");
}

function collectExcludedRanges(node: MarkdownNode): VisibleRange[] {
  const ranges: VisibleRange[] = [];
  let child: MarkdownNode | null = node.firstChild;
  while (child) {
    if (ABBREVIATION_EXCLUDED.has(child.name)) {
      ranges.push({ from: child.from, to: child.to });
    } else {
      ranges.push(...collectExcludedRanges(child));
    }
    child = child.nextSibling;
  }
  return ranges;
}

function readWikiLink(
  doc: EditorState["doc"],
  node: MarkdownNode,
): { from: number; to: number; target: string; label: string } | null {
  if (node.from === 0) {
    return null;
  }
  const raw = doc.sliceString(node.from - 1, node.to + 1);
  const match = WIKI_LINK.exec(raw);
  if (!match) {
    return null;
  }
  const inner = match[1] ?? "";
  const [targetPart, alias] = inner.split("|", 2);
  const target = (targetPart ?? "").trim();
  if (!target) {
    return null;
  }
  return {
    from: node.from - 1,
    to: node.to + 1,
    target,
    label: (alias ?? target).trim(),
  };
}

const WIKI_IMAGE = /\.(?:png|jpe?g|gif|webp|avif|svg|bmp)(?:[?#].*)?$/i;

function wikiEmbedSize(alias: string | null): { width: string; height: string | null } | null {
  if (!alias) {
    return null;
  }
  const match = /^(\d+)(?:x(\d+))?$/.exec(alias.trim());
  if (!match) {
    return null;
  }
  return { width: match[1] ?? "", height: match[2] ?? null };
}

function safeWikiImageSource(target: string): string | null {
  const trimmed = target.trim();
  if (!trimmed) {
    return null;
  }
  if (/^(?:javascript|vbscript|data|file):/i.test(trimmed.replace(/\s+/g, ""))) {
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^https?:/i.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function readWikiEmbed(
  doc: EditorState["doc"],
  node: MarkdownNode,
): { target: string; label: string; alias: string | null } | null {
  const match = WIKI_EMBED.exec(doc.sliceString(node.from, node.to));
  if (!match) {
    return null;
  }
  const inner = match[1] ?? "";
  const [targetPart, aliasPart] = inner.split("|", 2);
  const target = (targetPart ?? "").trim();
  if (!target) {
    return null;
  }
  const alias = aliasPart?.trim() || null;
  return { target, label: alias ?? target, alias };
}

function readAnchorLink(
  doc: EditorState["doc"],
  node: MarkdownNode,
): { href: string; label: string } | null {
  const url = directChildren(node, "URL")[0];
  if (!url) {
    return null;
  }
  const href = doc.sliceString(url.from, url.to);
  if (!href.startsWith("#") || href.length === 1) {
    return null;
  }
  const marks = directChildren(node, "LinkMark");
  const opening = marks[0];
  const closing = marks[1];
  if (!opening || !closing) {
    return null;
  }
  return { href, label: doc.sliceString(opening.to, closing.from) };
}

/**
 * Pure decoration planner. The caller supplies the visible ranges and all
 * selection ranges, which makes marker-level source reveal and whole-line
 * widgets directly testable without a real viewport.
 */
export function collectDecorationSpecs(
  state: EditorState,
  ranges: readonly VisibleRange[],
  selectionRanges: readonly VisibleRange[],
  blockedRanges: readonly VisibleRange[] = [],
): DecorationSpec[] {
  const doc = state.doc;
  if (doc.length === 0 || doc.length > LP_MAX_UNITS) {
    return [];
  }

  const expanded = expandVisibleRanges(state, ranges);
  if (expanded.length === 0) {
    return [];
  }

  const copy = state.facet(editorUiCopy);

  const specs = new Map<string, DecorationSpec>();
  const lineClasses = new Map<number, Set<string>>();
  const handledRanges: VisibleRange[] = [];
  const tree = syntaxTree(state);

  /**
   * Abbreviation definitions are top-level metadata. Only block containers
   * are visited, so this scan stays cheap even when a document is scrollable.
   */
  const abbreviations = new Map<number, AbbreviationDefinition>();
  const abbreviationRanges: VisibleRange[] = [];
  tree.iterate({
    from: 0,
    to: Math.min(doc.length, tree.length),
    enter(node) {
      if (node.name === "Document") {
        return true;
      }
      if (node.name !== "Paragraph") {
        return false;
      }
      const match = ABBREVIATION_DEFINITION.exec(doc.sliceString(node.from, node.to));
      if (match) {
        abbreviations.set(node.from, {
          term: match[1] ?? "",
          definition: (match[2] ?? "").trim(),
          from: node.from,
          to: node.to,
        });
        abbreviationRanges.push({ from: node.from, to: node.to });
      }
      return false;
    },
  });

  /**
   * Heading anchors are only needed when an internal `#fragment` link is
   * actually rendered. Building the slug map lazily keeps ordinary documents
   * on the same fast path as before.
   */
  let headingAnchors: Map<string, HeadingAnchor> | null = null;
  const anchors = (): Map<string, HeadingAnchor> => {
    if (!headingAnchors) {
      headingAnchors = readHeadingAnchors(state, blockedRanges);
      for (const [id, target] of readAttributeAnchors(state, blockedRanges)) {
        if (!headingAnchors.has(id)) {
          headingAnchors.set(id, {
            slug: id,
            text: id,
            level: 0,
            lineFrom: target.lineFrom,
          });
        }
      }
      for (const [id, anchor] of readHtmlAnchors(state, blockedRanges)) {
        headingAnchors.set(id, anchor);
      }
    }
    return headingAnchors;
  };

  let footnoteDefinitions: ReturnType<typeof readFootnoteDefinitions> | null = null;
  const footnotes = (): ReturnType<typeof readFootnoteDefinitions> => {
    footnoteDefinitions ??= readFootnoteDefinitions(state, blockedRanges);
    return footnoteDefinitions;
  };

  let inlineFootnotes: ReturnType<typeof readInlineFootnotes> | null = null;
  const inlineNotes = (): ReturnType<typeof readInlineFootnotes> => {
    inlineFootnotes ??= readInlineFootnotes(state, blockedRanges);
    return inlineFootnotes;
  };

  /**
   * Reference definitions can live anywhere in the document. They are only
   * scanned when a reference-style image is actually rendered, and the scan
   * visits top-level blocks instead of every syntax node.
   */
  let referenceDefinitions: Map<string, ReferenceDefinition> | null = null;
  const references = (): Map<string, ReferenceDefinition> => {
    if (referenceDefinitions) {
      return referenceDefinitions;
    }
    const definitions = new Map<string, ReferenceDefinition>();
    referenceDefinitions = definitions;
    tree.iterate({
      from: 0,
      to: Math.min(doc.length, tree.length),
      enter(node) {
        if (node.name === "Document") {
          return true;
        }
        if (node.name !== "LinkReference") {
          return false;
        }
        const syntaxNode = node.node;
        const label = firstChild(syntaxNode, "LinkLabel");
        const url = firstChild(syntaxNode, "URL");
        if (label && url) {
          const key = normalizeReferenceLabel(doc.sliceString(label.from, label.to));
          if (!definitions.has(key)) {
            definitions.set(key, {
              url: doc.sliceString(url.from, url.to),
              title: titleText(doc, firstChild(syntaxNode, "LinkTitle")),
            });
          }
        }
        return false;
      },
    });
    return definitions;
  };

  const addSpec = (spec: DecorationSpec) => {
    const suffix =
      spec.kind === "replace" ? "" : spec.kind === "widget" ? spec.widget.kind : spec.className;
    specs.set(`${spec.kind}:${spec.from}:${spec.to}:${suffix}`, spec);
  };

  /**
   * A construct is shown only when the cursor or selection actually reaches
   * it. Merely being on the same line no longer exposes the Markdown source,
   * so `# ddd` renders as a heading while the caret sits in its text.
   *
   * - Cursor: touching either edge of the range counts, so it can be edited.
   * - Selection: any overlap with the range exposes it.
   */
  const rangeIsRevealed = (from: number, to: number): boolean =>
    selectionRanges.some((range) => {
      const start = Math.min(range.from, range.to);
      const end = Math.max(range.from, range.to);
      return start === end ? start >= from && start <= to : start < to && end > from;
    });

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
    if (line.length > MAX_LINE_UNITS || rangeIsRevealed(from, to)) {
      return;
    }
    // Inline constructs may not be replaced across lines, but block markers
    // (quote/list/heading) belong to multi-line block parents and must still
    // hide on every line.
    if (
      parent &&
      (parent.name === "StrongEmphasis" ||
        parent.name === "Emphasis" ||
        parent.name === "Strikethrough" ||
        parent.name === "Highlight" ||
        parent.name === "InlineCode" ||
        parent.name === "Link" ||
        parent.name === "Autolink") &&
      spansLines(state, parent.from, parent.to)
    ) {
      return;
    }
    addSpec({ kind: "replace", from, to });
  };

  const addWidget = (from: number, to: number, widget: LivePreviewWidgetSpec): boolean => {
    if (from >= to || rangeIsRevealed(from, to)) {
      return false;
    }
    if (doc.lineAt(from).length > MAX_LINE_UNITS) {
      return false;
    }
    addSpec({ kind: "widget", from, to, widget });
    return true;
  };

  const addMark = (
    from: number,
    to: number,
    className: string,
    attributes?: Readonly<Record<string, string>>,
  ) => {
    if (from < to) {
      addSpec(
        attributes
          ? { kind: "mark", from, to, className, attributes }
          : { kind: "mark", from, to, className },
      );
    }
  };

  const addInlineFootnotes = (node: MarkdownNode): void => {
    for (const note of inlineNotes().values()) {
      if (note.from < node.from || note.to > node.to) {
        continue;
      }
      if (
        abbreviationRanges.some(
          (definition) => note.from >= definition.from && note.to <= definition.to,
        ) ||
        handledRanges.some((handled) => note.from >= handled.from && note.to <= handled.to)
      ) {
        continue;
      }
      addWidget(note.from, note.to, {
        kind: "inline-footnote",
        label: copy.widgets.inlineFootnoteLabel(note.index),
        content: note.content,
      });
      // Keep the Link node Lezer creates for `[content]` from hiding its
      // brackets when the user selects the note and expects full source.
      handledRanges.push({ from: note.from, to: note.to });
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

  const addTableSourceClasses = (table: ParsedTable, range: VisibleRange): void => {
    const addIfVisible = (lineStart: number, className: string) => {
      if (lineStart >= range.from && lineStart <= range.to) {
        addLineClass(lineStart, className);
      }
    };

    addIfVisible(table.headerLine, "cm-md-table");
    addIfVisible(table.headerLine, "cm-md-table-header");
    addIfVisible(table.delimiterLine, "cm-md-table");
    addIfVisible(table.delimiterLine, "cm-md-table-delim");
    for (const lineStart of table.rowLines) {
      addIfVisible(lineStart, "cm-md-table");
      addIfVisible(lineStart, "cm-md-table-row");
    }
  };

  for (const range of expanded) {
    tree.iterate({
      from: range.from,
      to: range.to,
      enter(node) {
        if (
          handledRanges.some((handled) => node.from >= handled.from && node.to <= handled.to) ||
          blockedRanges.some((blocked) => node.from >= blocked.from && node.to <= blocked.to)
        ) {
          return false;
        }
        const syntaxNode = node.node;
        const parent = syntaxNode.parent;
        const parentName = parent?.name ?? "";

        switch (node.name) {
          case "ATXHeading1":
          case "ATXHeading2":
          case "ATXHeading3":
          case "ATXHeading4":
          case "ATXHeading5":
          case "ATXHeading6":
          case "SetextHeading1":
          case "SetextHeading2": {
            const className = HEADING_CLASSES[node.name];
            if (className) {
              addLineClass(node.from, className);
            }
            addInlineFootnotes(syntaxNode);
            break;
          }
          case "StrongEmphasis":
            markBetween(syntaxNode, "EmphasisMark", "cm-md-strong");
            break;
          case "Emphasis":
            markBetween(syntaxNode, "EmphasisMark", "cm-md-em");
            break;
          case "Strikethrough":
            markBetween(syntaxNode, "StrikethroughMark", "cm-md-strike");
            break;
          case "Highlight":
            markBetween(syntaxNode, "HighlightMark", "cm-md-highlight");
            break;
          case "InlineMath":
            addWidget(node.from, node.to, {
              kind: "math",
              tex: doc.sliceString(node.from + 1, node.to - 1),
              display: false,
            });
            break;
          case "Subscript":
            markBetween(syntaxNode, "SubscriptMark", "cm-md-sub");
            break;
          case "Superscript":
            markBetween(syntaxNode, "SuperscriptMark", "cm-md-sup");
            break;
          case "InlineCode":
            markBetween(syntaxNode, "CodeMark", "cm-md-inline-code");
            break;
          case "Link": {
            const wiki = readWikiLink(doc, syntaxNode);
            if (wiki) {
              // Keep the whole `[[...]]` source visible while selected. The
              // normal link markers would otherwise strip the inner brackets
              // and leave a misleading half-markup.
              handledRanges.push({ from: wiki.from, to: wiki.to });
              addWidget(wiki.from, wiki.to, {
                kind: "wiki-link",
                target: wiki.target,
                label: wiki.label,
                embed: false,
              });
              return false;
            }
            const anchor = readAnchorLink(doc, syntaxNode);
            if (anchor) {
              const heading = resolveHeadingAnchor(anchors(), anchor.href);
              if (heading) {
                handledRanges.push({ from: node.from, to: node.to });
                addWidget(node.from, node.to, {
                  kind: "anchor-link",
                  label: anchor.label,
                  href: anchor.href,
                  lineFrom: heading.lineFrom,
                });
                return false;
              }
            }
            const footnote = readFootnoteReference(doc, syntaxNode);
            if (footnote) {
              const definition = footnotes().get(footnote);
              if (
                addWidget(node.from, node.to, {
                  kind: "footnote-ref",
                  label: footnote,
                  lineFrom: definition?.lineFrom ?? null,
                })
              ) {
                handledRanges.push({ from: node.from, to: node.to });
                break;
              }
            }
            const marks = directChildren(syntaxNode, "LinkMark");
            const opening = marks[0];
            const closing = marks[1];
            const url = firstChild(syntaxNode, "URL");
            let href = url ? doc.sliceString(url.from, url.to) : null;
            let title = titleText(doc, firstChild(syntaxNode, "LinkTitle"));
            const label = firstChild(syntaxNode, "LinkLabel");
            if (label && opening && closing) {
              let key = normalizeReferenceLabel(doc.sliceString(label.from, label.to));
              if (!key) {
                key = normalizeReferenceLabel(doc.sliceString(opening.to, closing.from));
              }
              const definition = references().get(key);
              if (definition) {
                href ??= definition.url;
                title ??= definition.title;
              }
            }
            if (opening && closing) {
              const tooltip = title ?? href;
              addMark(
                opening.to,
                closing.from,
                "cm-md-link",
                tooltip ? { title: tooltip } : undefined,
              );
            }
            break;
          }
          case "Autolink": {
            const url = firstChild(syntaxNode, "URL");
            if (url) {
              const href = doc.sliceString(url.from, url.to);
              addMark(url.from, url.to, "cm-md-link", { title: href });
            }
            break;
          }
          case "Image": {
            const embed = readWikiEmbed(doc, syntaxNode);
            if (embed) {
              handledRanges.push({ from: node.from, to: node.to });
              const size = wikiEmbedSize(embed.alias);
              const imageSource = WIKI_IMAGE.test(embed.target)
                ? safeWikiImageSource(embed.target)
                : null;
              if (imageSource) {
                addWidget(node.from, node.to, {
                  kind: "image",
                  src: imageSource,
                  alt: size ? embed.target : embed.label,
                  title: copy.media.imageEmbedTitle(embed.target),
                  width: size?.width ?? null,
                  height: size?.height ?? null,
                });
                return false;
              }
              addWidget(node.from, node.to, {
                kind: "wiki-link",
                target: embed.target,
                label: size ? embed.target : embed.label,
                embed: true,
              });
              return false;
            }
            const image = readImage(doc, syntaxNode, references);
            if (image) {
              const attributes = readTrailingAttributes(doc, syntaxNode);
              const width = attributes?.values.get("width")?.trim() || null;
              const height = attributes?.values.get("height")?.trim() || null;
              if (
                addWidget(node.from, attributes?.to ?? node.to, {
                  ...image,
                  width,
                  height,
                })
              ) {
                return false;
              }
            }
            // Editing an image keeps its complete source visible.
            break;
          }
          case "Blockquote": {
            const firstLine = doc.lineAt(node.from);
            const alert = ALERT_PATTERN.exec(firstLine.text);
            if (alert) {
              const type = (alert[1] ?? "").toLowerCase();
              addLineClassesForBlock(state, syntaxNode, range, addLineClass, "cm-md-alert");
              addLineClassesForBlock(state, syntaxNode, range, addLineClass, `cm-md-alert-${type}`);
              const markerFrom = firstLine.from + firstLine.text.indexOf("[!");
              const markerTo = markerFrom + `[!${alert[1] ?? ""}]`.length;
              if (
                addWidget(markerFrom, markerTo, {
                  kind: "alert",
                  label: alert[1] ?? "",
                })
              ) {
                handledRanges.push({ from: markerFrom, to: markerTo });
              }
            }
            break;
          }
          case "Table": {
            const table = readTable(doc, syntaxNode);
            if (table) {
              addTableSourceClasses(table, range);
            }
            return false;
          }
          case "FencedCode": {
            // A top-level fence is an embedded code-block widget. Only fences
            // nested inside quotes/lists keep the line-based source styling.
            if (syntaxNode.parent?.name === "Document") {
              return false;
            }
            const code = readFencedCode(doc, syntaxNode);
            addLineClassesForBlock(state, syntaxNode, range, addLineClass, "cm-md-code-block");

            if (code) {
              // The language badge belongs to the bottom-right corner of the
              // block, like Typora. Both fence markers reveal themselves when
              // the caret reaches either line; the badge steps aside then so
              // the raw info string stays editable.
              const openingRevealed = rangeIsRevealed(code.openingLine.from, code.openingLine.to);
              const closingRevealed = rangeIsRevealed(code.closingLine.from, code.closingLine.to);
              const fencesRevealed = openingRevealed || closingRevealed;
              if (code.openingLine.from >= range.from && code.openingLine.from <= range.to) {
                addLineClass(code.openingLine.from, "cm-md-code-fence");
                if (!openingRevealed) {
                  // The opening fence is hidden; collapse its line so the
                  // block does not start with a blank row.
                  addLineClass(code.openingLine.from, "cm-md-code-fence-hidden");
                }
                addReplace(code.openingLine.from, code.openingLine.to, syntaxNode);
              }
              const openingNumber = doc.lineAt(code.openingLine.from).number;
              const closingNumber = doc.lineAt(code.closingLine.from).number;
              for (const offset of code.highlightLines) {
                const lineNumber = openingNumber + offset;
                if (lineNumber >= closingNumber) {
                  continue;
                }
                const line = doc.line(lineNumber);
                if (line.from >= range.from && line.from <= range.to) {
                  addLineClass(line.from, "cm-md-code-highlight");
                }
              }
              if (code.language.toLowerCase() === "diff") {
                for (
                  let lineNumber = openingNumber + 1;
                  lineNumber < closingNumber;
                  lineNumber += 1
                ) {
                  const line = doc.line(lineNumber);
                  if (line.from < range.from || line.from > range.to) {
                    continue;
                  }
                  const text = doc.sliceString(line.from, line.to);
                  if (text.startsWith("+++") || text.startsWith("---") || text.startsWith("@@")) {
                    addLineClass(line.from, "cm-md-code-diff-meta");
                  } else if (text.startsWith("+")) {
                    addLineClass(line.from, "cm-md-code-diff-add");
                  } else if (text.startsWith("-")) {
                    addLineClass(line.from, "cm-md-code-diff-del");
                  }
                }
              }
              if (code.closingLine.from >= range.from && code.closingLine.from <= range.to) {
                addLineClass(code.closingLine.from, "cm-md-code-fence");
                addLineClass(code.closingLine.from, "cm-md-code-fence-close");
                const badged =
                  !fencesRevealed &&
                  addWidget(code.closingLine.from, code.closingLine.to, {
                    kind: "code-language",
                    language: code.language,
                    title: code.title,
                  });
                if (badged) {
                  addLineClass(code.closingLine.from, "cm-md-code-fence-badged");
                } else {
                  addReplace(code.closingLine.from, code.closingLine.to, syntaxNode);
                }
              }
            } else {
              const openingLine = doc.lineAt(syntaxNode.from);
              if (openingLine.from >= range.from && openingLine.from <= range.to) {
                addLineClass(openingLine.from, "cm-md-code-fence");
              }
            }
            return false;
          }
          case "CodeBlock":
            addLineClassesForBlock(state, syntaxNode, range, addLineClass, "cm-md-code-block");
            return false;
          case "HardBreak": {
            const text = doc.sliceString(node.from, node.to);
            const end = text.endsWith("\n") ? node.to - 1 : node.to;
            // Hide only the break marker (spaces or backslash); the newline
            // itself is already the rendered line break.
            addReplace(node.from, end, parent);
            break;
          }
          case "HorizontalRule":
            addWidget(node.from, node.to, { kind: "rule" });
            break;
          case "HTMLBlock": {
            const raw = doc.sliceString(node.from, node.to).trim();
            if (/^<hr\s*\/?>$/i.test(raw)) {
              if (addWidget(node.from, node.to, { kind: "rule" })) {
                return false;
              }
            } else if (/^<br\s*\/?>$/i.test(raw)) {
              addReplace(node.from, node.to, parent);
              return false;
            }
            addLineClassesForBlock(state, syntaxNode, range, addLineClass, "cm-md-html");
            return false;
          }
          case "Comment":
            addReplace(node.from, node.to, parent);
            return false;
          case "CommentBlock": {
            const raw = doc.sliceString(node.from, node.to);
            if (!raw.includes("\n")) {
              addReplace(node.from, node.to, parent);
            } else {
              addLineClassesForBlock(state, syntaxNode, range, addLineClass, "cm-md-html");
            }
            return false;
          }
          case "HTMLTag": {
            const raw = doc.sliceString(node.from, node.to);
            if (htmlAnchorId(raw)) {
              const close = findMatchingInlineHtml(doc, syntaxNode, "a");
              if (close) {
                addReplace(node.from, node.to, parent);
                addReplace(close.from, close.to, parent);
                handledRanges.push({ from: close.from, to: close.to });
                return false;
              }
            }
            const tag = parseInlineHtmlTag(raw);
            if (tag && !tag.closing && !tag.selfClosing && INLINE_HTML_TAGS[tag.name]) {
              const close = findMatchingInlineHtml(doc, syntaxNode, tag.name);
              if (close) {
                const content = doc.sliceString(node.to, close.from);
                if (
                  addWidget(node.from, close.to, {
                    kind: "inline-html",
                    tag: tag.name,
                    content,
                  })
                ) {
                  handledRanges.push({ from: node.from, to: close.to });
                  break;
                }
              }
            }
            addMark(node.from, node.to, "cm-md-html");
            break;
          }
          case "LinkReference":
            addLineClassesForBlock(state, syntaxNode, range, addLineClass, "cm-md-link-reference");
            return false;
          case "Entity":
            addWidget(node.from, node.to, {
              kind: "entity",
              raw: doc.sliceString(node.from, node.to),
            });
            break;
          case "Emoji": {
            const char = emojiForName(doc.sliceString(node.from + 1, node.to - 1));
            if (char) {
              addWidget(node.from, node.to, { kind: "emoji", char });
            }
            break;
          }
          case "Paragraph": {
            const anchorIds = readAnchorOnlyBlock(doc.sliceString(node.from, node.to));
            if (anchorIds && anchorIds.length > 0) {
              handledRanges.push({ from: node.from, to: node.to });
              addWidget(node.from, node.to, {
                kind: "html-anchor",
                label: anchorIds.map((id) => `#${id}`).join(" "),
              });
              return false;
            }
            const abbreviation = abbreviations.get(node.from);
            if (abbreviation) {
              handledRanges.push({ from: node.from, to: node.to });
              addWidget(node.from, node.to, {
                kind: "abbreviation",
                term: abbreviation.term,
                definition: abbreviation.definition,
              });
              return false;
            }
            addInlineFootnotes(syntaxNode);
            const attributes = readAttributeLine(doc, syntaxNode);
            if (attributes) {
              const attributeLine = doc.lineAt(attributes.from);
              for (
                let lineNumber = doc.lineAt(node.from).number;
                lineNumber < attributeLine.number;
                lineNumber += 1
              ) {
                const line = doc.line(lineNumber);
                addLineClass(line.from, "cm-md-attr");
                for (const name of attributes.classes) {
                  addLineClass(line.from, `cm-md-attr-${name}`);
                }
              }
              handledRanges.push({ from: attributes.from, to: attributes.to });
              addWidget(attributes.from, attributes.to, {
                kind: "attributes",
                label: attributes.raw,
              });
            }
            const paragraphText = doc.sliceString(node.from, node.to);
            if (paragraphText.includes("[^")) {
              let position = node.from;
              while (position <= node.to) {
                const line = doc.lineAt(position);
                const definition = FOOTNOTE_DEFINITION.exec(doc.sliceString(line.from, line.to));
                if (definition) {
                  addLineClass(line.from, "cm-md-footnote-def");
                  const end = line.from + definition[0].length;
                  if (
                    addWidget(line.from, end, {
                      kind: "footnote-def",
                      label: definition[1] ?? "",
                    })
                  ) {
                    handledRanges.push({ from: line.from, to: end });
                  }
                }
                if (line.to >= node.to) {
                  break;
                }
                position = line.to + 1;
              }
            }
            break;
          }
          case "HeaderMark":
            if (parent && parentName.startsWith("ATXHeading")) {
              const marker = headingMarkerRange(doc, syntaxNode, parent);
              addReplace(marker.from, marker.to, parent);
            } else if (parent && parentName.startsWith("SetextHeading")) {
              addReplace(node.from, node.to, parent);
            }
            break;
          case "EmphasisMark":
            if (parentName === "StrongEmphasis" || parentName === "Emphasis") {
              addReplace(node.from, node.to, parent);
            }
            break;
          case "StrikethroughMark":
            if (parentName === "Strikethrough") {
              addReplace(node.from, node.to, parent);
            }
            break;
          case "HighlightMark":
            if (parentName === "Highlight") {
              addReplace(node.from, node.to, parent);
            }
            break;
          case "SubscriptMark":
          case "SuperscriptMark":
            if (parentName === "Subscript" || parentName === "Superscript") {
              addReplace(node.from, node.to, parent);
            }
            break;
          case "CodeMark":
            if (parentName === "InlineCode") {
              addReplace(node.from, node.to, parent);
            }
            break;
          case "LinkMark":
            if (parentName === "Link" || parentName === "Autolink") {
              addReplace(node.from, node.to, parent);
            }
            break;
          case "URL":
            if (parentName === "Link") {
              addReplace(node.from, node.to, parent);
            } else if (parentName === "Paragraph") {
              // GFM bare autolink: keep the URL, style it like a link.
              addMark(node.from, node.to, "cm-md-link", {
                title: doc.sliceString(node.from, node.to),
              });
            }
            break;
          case "LinkTitle":
          case "LinkLabel":
            if (parentName === "Link") {
              addReplace(node.from, node.to, parent);
            }
            break;
          case "QuoteMark": {
            addLineClass(node.from, "cm-md-quote");
            // Multi-line blockquotes put continuation markers under a
            // Paragraph node, so this must not require a Blockquote parent.
            const markerEnd = extendOverWhitespace(doc, node.to, doc.lineAt(node.to).to);
            addReplace(node.from, markerEnd, parent);
            break;
          }
          case "ListMark":
            addLineClass(node.from, "cm-md-list");
            if (parentName === "ListItem" && parent) {
              const task = firstChild(parent, "Task");
              if (task) {
                // The checkbox widget represents the whole task prefix; hide
                // the bullet and the whitespace before `[ ]`.
                const markerEnd = extendOverWhitespace(doc, node.to, doc.lineAt(node.to).to);
                addReplace(node.from, markerEnd, parent);
              } else if (parent.parent?.name === "BulletList") {
                addWidget(node.from, node.to, { kind: "bullet" });
              } else {
                addMark(node.from, node.to, "cm-md-list-number");
              }
            }
            break;
          case "TaskMarker":
            if (parentName === "Task") {
              const checked = /[xX]/.test(doc.sliceString(node.from, node.to));
              addWidget(node.from, node.to, { kind: "task", checked });
            }
            break;
          case "Escape":
            // Show the escaped character, not the backslash. The marker-level
            // rule still reveals it while the cursor touches it.
            addReplace(node.from, node.from + 1, parent);
            break;
          default:
            break;
        }
        return true;
      },
    });
  }

  if (abbreviations.size > 0) {
    const patterns = [...abbreviations.values()].map((definition) => ({
      definition,
      pattern: abbreviationPattern(definition.term),
    }));
    for (const range of expanded) {
      tree.iterate({
        from: range.from,
        to: range.to,
        enter(node) {
          if (node.name === "Document") {
            return true;
          }
          const prose = node.name === "Paragraph" || /^(?:ATX|Setext)Heading[1-6]$/.test(node.name);
          if (!prose) {
            return true;
          }
          if (
            blockedRanges.some((blocked) => node.from >= blocked.from && node.to <= blocked.to) ||
            handledRanges.some((handled) => node.from >= handled.from && node.to <= handled.to) ||
            abbreviationRanges.some(
              (definition) => node.from >= definition.from && node.to <= definition.to,
            )
          ) {
            return false;
          }
          const syntaxNode = node.node as unknown as MarkdownNode;
          const excluded = collectExcludedRanges(syntaxNode);
          const text = doc.sliceString(node.from, node.to);
          for (const { definition, pattern } of patterns) {
            pattern.lastIndex = 0;
            let match: RegExpExecArray | null;
            while ((match = pattern.exec(text))) {
              const from = node.from + match.index;
              const to = from + match[0].length;
              if (
                excluded.some((excludedRange) => from < excludedRange.to && to > excludedRange.from)
              ) {
                continue;
              }
              addMark(from, to, "cm-md-abbr", { title: definition.definition });
            }
          }
          return false;
        },
      });
    }
  }

  for (const range of expanded) {
    tree.iterate({
      from: range.from,
      to: range.to,
      enter(node) {
        if (node.name === "Document") {
          return true;
        }
        const prose = node.name === "Paragraph" || /^(?:ATX|Setext)Heading[1-6]$/.test(node.name);
        if (!prose) {
          return true;
        }
        if (
          blockedRanges.some((blocked) => node.from >= blocked.from && node.to <= blocked.to) ||
          handledRanges.some((handled) => node.from >= handled.from && node.to <= handled.to)
        ) {
          return false;
        }
        const text = doc.sliceString(node.from, node.to);
        if (!text.includes("%%")) {
          return false;
        }
        const syntaxNode = node.node as unknown as MarkdownNode;
        const excluded = collectExcludedRanges(syntaxNode);
        const pattern = /%%[^\n]*?%%/g;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(text))) {
          const from = node.from + match.index;
          const to = from + match[0].length;
          if (
            excluded.some((excludedRange) => from < excludedRange.to && to > excludedRange.from)
          ) {
            continue;
          }
          addReplace(from, to, syntaxNode);
        }
        return false;
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
    if (spec.kind === "replace" || spec.kind === "widget") {
      return 0;
    }
    return 1;
  };

  return [...specs.values()].sort(
    (left, right) =>
      left.from - right.from ||
      priority(left) - priority(right) ||
      left.to - right.to ||
      (left.kind === "replace" || left.kind === "widget" ? "" : left.className).localeCompare(
        right.kind === "replace" || right.kind === "widget" ? "" : right.className,
      ),
  );
}
