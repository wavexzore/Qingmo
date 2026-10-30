import type { Text } from "@codemirror/state";

/**
 * Presentation-only Markdown line model for the minimap. This is deliberately
 * not a parser: it only answers "what colour/band does this line need" and
 * never changes the editor's Markdown semantics.
 */
export type MinimapLineKind =
  | "blank"
  | "text"
  | "heading"
  | "code"
  | "diagram"
  | "table"
  | "quote"
  | "list"
  | "rule"
  | "frontmatter"
  | "html";

/** Numeric encoding written to `Uint8Array`; larger values win in a bucket. */
export const KIND = {
  blank: 0,
  text: 1,
  list: 2,
  quote: 3,
  html: 4,
  rule: 5,
  table: 6,
  code: 7,
  diagram: 8,
  heading: 9,
  frontmatter: 10,
} as const;

export interface MinimapLineTable {
  count: number;
  kind: Uint8Array;
  headingLevel: Uint8Array;
  indent: Uint8Array;
  density: Uint16Array;
}

export type MinimapBlockKind = "fence" | "table" | "frontmatter" | "math" | "media" | "html";

export interface MinimapBlock {
  kind: MinimapBlockKind;
  /** Inclusive source line. */
  fromLine: number;
  /** Inclusive source line. */
  toLine: number;
  info: string;
}

export interface MinimapScan {
  lines: MinimapLineTable;
  blocks: MinimapBlock[];
  headings: number[];
}

export interface AnchorSample {
  /** 0-based source line; `lineCount` is the virtual document end. */
  line: number;
  /** Editor document coordinate; 0 is the top of the first line, excluding padding. */
  docY: number;
}

export interface MinimapBucket {
  kind: number;
  width: number;
  indent: number;
  headingLevel: number;
}

export interface MinimapBlockBand {
  kind: MinimapBlockKind;
  fromBucket: number;
  toBucket: number;
}

export interface MinimapAnchorMap {
  samples: readonly AnchorSample[];
  lineDocY: Float64Array;
  docYToRail(docY: number): number;
  railToDocY(railY: number): number;
}

/** Test-only geometry override; production reads the same values from CM6. */
export interface MinimapGeometry {
  editorWidth: number;
  railWidth: number;
  railHeight: number;
  trackTop: number;
  trackHeight: number;
  contentHeight: number;
  documentPadding: { top: number; bottom: number };
  clientHeight: number;
  scrollHeight: number;
}

export const MINIMAP_WIDTH_HYSTERESIS = 16;
export const MINIMAP_MAX_LINES = 100_000;
export const MINIMAP_MAX_UNITS = 2_000_000;
export const MINIMAP_MIN_EDITOR_WIDTH = 640;
export const MINIMAP_EPS = 0.5;
export const MINIMAP_ANCHOR_STRIDE_MIN = 40;
export const MINIMAP_ANCHOR_TARGET = 1_200;
export const MINIMAP_ANCHOR_MAX = 2_000;
export const MINIMAP_SLIDER_MIN_PX = 24;

const BLOCK_PRIORITY: Record<MinimapBlockKind, number> = {
  frontmatter: 0,
  fence: 1,
  table: 2,
  math: 3,
  media: 4,
  html: 5,
};

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const ATX_RE = /^ {0,3}(#{1,6})\s+(.*)$/;
const SETEXT_RE = /^ {0,3}(=+|-+)\s*$/;
const RULE_RE = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
const QUOTE_RE = /^ {0,3}>/;
const LIST_RE = /^ {0,3}(?:[-+*]|\d+[.)])\s+/;
const HTML_SINGLE_RE =
  /^ {0,3}<\/?(?:address|article|aside|audio|blockquote|details|dialog|div|dl|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|iframe|img|main|nav|ol|p|picture|pre|section|table|ul|video)\b/i;
const MEDIA_RE = /^(?:!\[[^\]]*\]\([^)]*\)|<\/?(?:img|video|audio|iframe|picture)\b[^>]*\/?>)$/i;
const TABLE_CELL_RE = /^:?-{3,}:?$/;

function frontMatterEnd(getLine: (line: number) => string, lineCount: number): number {
  if (
    lineCount < 2 ||
    getLine(0)
      .replace(/^\uFEFF/, "")
      .trim() !== "---"
  ) {
    return -1;
  }
  for (let i = 1; i < lineCount; i += 1) {
    const text = getLine(i).trim();
    if (text === "---" || text === "...") {
      return i;
    }
  }
  return -1;
}

function fenceOpener(line: string): { char: string; length: number; info: string } | null {
  const match = FENCE_RE.exec(line);
  if (!match) {
    return null;
  }
  const marker = match[1] ?? "";
  return { char: marker[0]!, length: marker.length, info: (match[2] ?? "").trim() };
}

function isFenceClose(line: string, char: string, minimum: number): boolean {
  const trimmed = line.trim();
  if (trimmed.length < minimum) {
    return false;
  }
  for (const value of trimmed) {
    if (value !== char) {
      return false;
    }
  }
  return true;
}

function tableCells(line: string): string[] {
  const trimmed = line.trim();
  const withoutEdges = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  return withoutEdges.split("|").map((cell) => cell.trim());
}

function isTableDelimiter(line: string): boolean {
  if (!line.includes("|")) {
    return false;
  }
  const cells = tableCells(line);
  return cells.length > 0 && cells.every((cell) => TABLE_CELL_RE.test(cell));
}

function isTableHeader(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length > 0 && trimmed.includes("|") && !trimmed.startsWith(">");
}

function isTableRow(line: string): boolean {
  return line.trim().length > 0 && line.includes("|");
}

function isMediaLine(line: string): boolean {
  return MEDIA_RE.test(line.trim());
}

function measureLine(line: string, tabSize: number): { indent: number; density: number } {
  let column = 0;
  let indent = -1;
  let units = 0;

  for (let i = 0; i < line.length; i += 1) {
    const code = line.charCodeAt(i);
    if (indent < 0) {
      if (code === 32) {
        column += 1;
      } else if (code === 9) {
        column += Math.max(1, tabSize - (column % tabSize));
      } else {
        indent = Math.min(255, column);
      }
      if (column >= 255) {
        indent = 255;
      }
    }
    units += code < 128 ? 1 : 1.6;
    if (units >= 65_535) {
      return { indent: indent < 0 ? Math.min(255, column) : indent, density: 65_535 };
    }
  }

  return { indent: indent < 0 ? Math.min(255, column) : indent, density: Math.round(units) };
}

/**
 * Scans a document into the columnar line table and block ranges used by the
 * canvas. The input is only read; no editor state or DOM is touched.
 */
export function scanMinimapDocument(text: Text | string, tabSize = 4): MinimapScan {
  const rawLines = typeof text === "string" ? text.split("\n") : Array.from(text.iterLines());
  const lineCount = rawLines.length;
  const getLine = (line: number): string => rawLines[line] ?? "";
  const tab = Number.isFinite(tabSize) && tabSize > 0 ? Math.max(1, Math.trunc(tabSize)) : 4;

  const lines: MinimapLineTable = {
    count: lineCount,
    kind: new Uint8Array(lineCount),
    headingLevel: new Uint8Array(lineCount),
    indent: new Uint8Array(lineCount),
    density: new Uint16Array(lineCount),
  };
  const blocked = new Uint8Array(lineCount);
  const blocks: MinimapBlock[] = [];
  const headings: number[] = [];

  const mark = (
    fromLine: number,
    toLine: number,
    kind: number,
    headingLevel = 0,
    block = false,
  ): void => {
    const from = Math.max(0, Math.min(lineCount - 1, fromLine));
    const to = Math.max(from, Math.min(lineCount - 1, toLine));
    for (let i = from; i <= to; i += 1) {
      lines.kind[i] = kind;
      if (headingLevel > 0) {
        lines.headingLevel[i] = headingLevel;
      }
      if (block) {
        blocked[i] = 1;
      }
    }
  };

  for (let i = 0; i < lineCount; i += 1) {
    const measured = measureLine(getLine(i), tab);
    lines.indent[i] = measured.indent;
    lines.density[i] = measured.density;
  }

  const frontEnd = frontMatterEnd(getLine, lineCount);
  let start = 0;
  if (frontEnd >= 0) {
    mark(0, frontEnd, KIND.frontmatter, 0, true);
    blocks.push({ kind: "frontmatter", fromLine: 0, toLine: frontEnd, info: "" });
    start = frontEnd + 1;
  }

  let i = start;
  while (i < lineCount) {
    const line = getLine(i);
    const trimmed = line.trim();

    if (blocked[i]) {
      i += 1;
      continue;
    }

    // Fast path for ordinary prose. Every block construct either starts with
    // one of these characters or needs a pipe for a table row; skipping the
    // regex chain here keeps a 100k-line scan inside one frame.
    const first = trimmed.charCodeAt(0);
    const blockStart =
      first === 35 || // #
      first === 45 || // -
      first === 42 || // *
      first === 43 || // +
      first === 62 || // >
      first === 95 || // _
      first === 61 || // =
      first === 96 || // `
      first === 126 || // ~
      first === 60 || // <
      first === 33 || // !
      first === 36 || // $
      (first >= 48 && first <= 57);
    if (!blockStart && !line.includes("|")) {
      mark(i, i, trimmed.length === 0 ? KIND.blank : KIND.text);
      i += 1;
      continue;
    }

    const opener = fenceOpener(line);
    if (opener) {
      let end = lineCount - 1;
      for (let j = i + 1; j < lineCount; j += 1) {
        if (isFenceClose(getLine(j), opener.char, opener.length)) {
          end = j;
          break;
        }
      }
      const diagram = /^mermaid\b/i.test(opener.info);
      mark(i, end, diagram ? KIND.diagram : KIND.code, 0, true);
      blocks.push({ kind: "fence", fromLine: i, toLine: end, info: opener.info });
      i = end + 1;
      continue;
    }

    if (i > 0 && isTableDelimiter(line) && isTableHeader(getLine(i - 1))) {
      let end = i;
      while (end + 1 < lineCount && isTableRow(getLine(end + 1))) {
        end += 1;
      }
      mark(i - 1, end, KIND.table, 0, true);
      blocks.push({ kind: "table", fromLine: i - 1, toLine: end, info: "" });
      i = end + 1;
      continue;
    }

    if (trimmed === "$$") {
      let end = lineCount - 1;
      for (let j = i + 1; j < lineCount; j += 1) {
        if (getLine(j).trim() === "$$") {
          end = j;
          break;
        }
      }
      mark(i, end, KIND.code, 0, true);
      blocks.push({ kind: "math", fromLine: i, toLine: end, info: "" });
      i = end + 1;
      continue;
    }

    if (/^<details\b/i.test(trimmed)) {
      let end = lineCount - 1;
      for (let j = i + 1; j < lineCount; j += 1) {
        if (/<\/details\s*>/i.test(getLine(j))) {
          end = j;
          break;
        }
      }
      mark(i, end, KIND.html, 0, true);
      blocks.push({ kind: "html", fromLine: i, toLine: end, info: "" });
      i = end + 1;
      continue;
    }

    if (isMediaLine(line)) {
      mark(i, i, KIND.html, 0, true);
      blocks.push({ kind: "media", fromLine: i, toLine: i, info: "" });
      i += 1;
      continue;
    }

    const setext = SETEXT_RE.exec(line);
    if (
      setext &&
      (setext[1]!.length >= 2 || setext[1]![0] === "=") &&
      i > 0 &&
      getLine(i - 1).trim().length > 0 &&
      !blocked[i - 1] &&
      lines.kind[i - 1] === KIND.text
    ) {
      lines.kind[i - 1] = KIND.heading;
      lines.headingLevel[i - 1] = setext[1]![0] === "=" ? 1 : 2;
      headings.push(i - 1);
      mark(i, i, KIND.blank);
      i += 1;
      continue;
    }

    const atx = ATX_RE.exec(line);
    if (atx) {
      mark(i, i, KIND.heading, atx[1]!.length);
      headings.push(i);
      i += 1;
      continue;
    }

    if (RULE_RE.test(line)) {
      mark(i, i, KIND.rule);
      i += 1;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      mark(i, i, KIND.quote);
      i += 1;
      continue;
    }

    if (LIST_RE.test(line)) {
      mark(i, i, KIND.list);
      i += 1;
      continue;
    }

    if (HTML_SINGLE_RE.test(line)) {
      mark(i, i, KIND.html, 0, true);
      i += 1;
      continue;
    }

    mark(i, i, trimmed.length === 0 ? KIND.blank : KIND.text);
    i += 1;
  }

  return { lines, blocks, headings };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

/** Linear interpolation from sparse anchor samples to one docY per source line. */
export function interpolateLineDocY(
  samples: readonly AnchorSample[],
  lineCount: number,
): Float64Array {
  const output = new Float64Array(Math.max(1, lineCount));
  if (lineCount <= 0) {
    return output;
  }

  const sorted = samples
    .filter((sample) => Number.isFinite(sample.line) && Number.isFinite(sample.docY))
    .slice()
    .sort((left, right) => left.line - right.line || left.docY - right.docY);

  const safe: AnchorSample[] = [];
  for (const sample of sorted) {
    const line = clamp(Math.trunc(sample.line), 0, lineCount);
    const docY = Math.max(0, sample.docY);
    const last = safe[safe.length - 1];
    if (!last) {
      safe.push({ line, docY });
    } else if (line > last.line) {
      // Keep the virtual terminal even when a giant widget produced the same
      // docY as the previous line.
      if (line === lineCount || docY > last.docY + MINIMAP_EPS) {
        safe.push({ line, docY });
      }
    }
  }

  if (safe.length === 0 || safe[0]!.line !== 0) {
    safe.unshift({ line: 0, docY: 0 });
  }
  const last = safe[safe.length - 1]!;
  if (last.line < lineCount) {
    safe.push({ line: lineCount, docY: last.docY });
  }

  let cursor = 0;
  for (let line = 0; line < lineCount; line += 1) {
    while (cursor + 1 < safe.length && safe[cursor + 1]!.line <= line) {
      cursor += 1;
    }
    const left = safe[cursor]!;
    const right = safe[cursor + 1];
    if (!right || right.line === left.line) {
      output[line] = left.docY;
      continue;
    }
    const t = (line - left.line) / (right.line - left.line);
    output[line] = left.docY + (right.docY - left.docY) * t;
  }

  return output;
}

export function docYToRail(
  docY: number,
  docHeight: number,
  trackTop: number,
  trackHeight: number,
): number {
  const height = Math.max(1, docHeight);
  const track = Math.max(1, trackHeight);
  return trackTop + (clamp(docY, 0, height) / height) * track;
}

export function railToDocY(
  railY: number,
  docHeight: number,
  trackTop: number,
  trackHeight: number,
): number {
  const height = Math.max(1, docHeight);
  const track = Math.max(1, trackHeight);
  return clamp((railY - trackTop) / track, 0, 1) * height;
}

export function createAnchorMap(
  samples: readonly AnchorSample[],
  lineCount: number,
  docHeight: number,
  trackTop: number,
  trackHeight: number,
): MinimapAnchorMap {
  const lineDocY = interpolateLineDocY(samples, lineCount);
  const height = Math.max(1, docHeight);
  const track = Math.max(1, trackHeight);
  return {
    samples,
    lineDocY,
    docYToRail(docY: number): number {
      return docYToRail(docY, height, trackTop, track);
    },
    railToDocY(railY: number): number {
      return railToDocY(railY, height, trackTop, track);
    },
  };
}

export interface MinimapWindow {
  /** 0-based first source line rendered in the rail. */
  startLine: number;
  /** Blank minimap rows reserved above the first line to keep the slider aligned. */
  paddingLines: number;
  /** Number of source lines rendered (excluding padding). */
  lineCount: number;
}

/** Finds the source line whose document interval contains `docY`. */
export function lineAtDocY(lineDocY: Float64Array, docY: number): number {
  const length = lineDocY.length;
  if (length === 0) {
    return 0;
  }
  const target = Math.max(0, docY);
  let low = 0;
  let high = length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((lineDocY[middle] ?? 0) <= target) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return Math.max(0, low - 1);
}

/**
 * VS Code-style minimap window: the canvas shows a fixed number of source
 * lines at a fixed miniature line height. The window start is chosen so the
 * document-relative slider sits over the viewport start, with blank padding
 * near the top to keep the mapping continuous.
 */
export function computeMinimapWindow({
  lineCount,
  viewportStartLine,
  sliderTop,
  trackTop,
  lineHeight,
  trackHeight,
}: {
  lineCount: number;
  viewportStartLine: number;
  sliderTop: number;
  trackTop: number;
  lineHeight: number;
  trackHeight: number;
}): MinimapWindow {
  const total = Math.max(1, lineCount);
  const height = Math.max(1, Math.floor(trackHeight / Math.max(1, lineHeight)));
  if (total <= height) {
    return { startLine: 0, paddingLines: 0, lineCount: total };
  }

  const sliderLines = Math.floor(Math.max(0, sliderTop - trackTop) / Math.max(1, lineHeight));
  const rawStart = Math.max(0, viewportStartLine) - sliderLines;
  let startLine = rawStart;
  let paddingLines = 0;
  if (rawStart < 0) {
    paddingLines = Math.min(height - 1, -rawStart);
    startLine = 0;
  }

  const maxStart = Math.max(0, total - height);
  startLine = clamp(startLine, 0, maxStart);
  const available = height - paddingLines;
  return {
    startLine,
    paddingLines,
    lineCount: Math.min(available, total - startLine),
  };
}

export function densityWidth(
  density: number,
  indent: number,
  trackWidth: number,
  indentPx = 2,
): number {
  const width = Math.max(1, trackWidth);
  const indentWidth = clamp(indent * indentPx, 0, width);
  return Math.max(0, Math.min(width - indentWidth, 3 + density * 0.55));
}

/** Aggregates every line into one visual row of `ceil(trackHeight)` buckets. */
export function buildMinimapBuckets(
  lines: MinimapLineTable,
  lineDocY: Float64Array,
  map: Pick<MinimapAnchorMap, "docYToRail">,
  trackTop: number,
  trackHeight: number,
  trackWidth: number,
): MinimapBucket[] {
  const count = Math.max(1, Math.ceil(trackHeight));
  const buckets: MinimapBucket[] = Array.from({ length: count }, () => ({
    kind: KIND.blank,
    width: 0,
    indent: 255,
    headingLevel: 0,
  }));

  for (let i = 0; i < lines.count; i += 1) {
    if (lines.kind[i] === KIND.blank) {
      continue;
    }
    const y = map.docYToRail(lineDocY[i] ?? 0);
    const bucket = clamp(Math.floor(y - trackTop), 0, count - 1);
    const target = buckets[bucket]!;
    const width = densityWidth(lines.density[i] ?? 0, lines.indent[i] ?? 0, trackWidth);
    target.width = Math.max(target.width, width);
    target.kind = Math.max(target.kind, lines.kind[i] ?? KIND.blank);
    target.indent = Math.min(target.indent, lines.indent[i] ?? 0);
    if (lines.kind[i] === KIND.heading) {
      const level = lines.headingLevel[i] ?? 0;
      if (level > 0) {
        target.headingLevel =
          target.headingLevel === 0 ? level : Math.min(target.headingLevel, level);
      }
    }
  }

  return buckets.map((bucket) => ({
    ...bucket,
    indent: bucket.indent === 255 ? 0 : bucket.indent,
  }));
}

/** Merges each block kind's rail ranges into bucket ranges. */
export function buildBlockBands(
  blocks: readonly MinimapBlock[],
  lineDocY: Float64Array,
  map: Pick<MinimapAnchorMap, "docYToRail">,
  lastLine: number,
  trackTop: number,
  trackHeight: number,
): MinimapBlockBand[] {
  const count = Math.max(1, Math.ceil(trackHeight));
  const grouped = new Map<MinimapBlockKind, Array<{ from: number; to: number }>>();

  for (const block of blocks) {
    if (block.fromLine < 0 || block.toLine < block.fromLine) {
      continue;
    }
    const fromY = map.docYToRail(lineDocY[block.fromLine] ?? 0);
    const toY =
      block.toLine >= lastLine
        ? trackTop + trackHeight
        : map.docYToRail(lineDocY[Math.min(block.toLine + 1, lastLine)] ?? fromY);
    const fromBucket = clamp(Math.floor(fromY - trackTop), 0, count - 1);
    const toBucket = clamp(
      Math.max(fromBucket + 1, Math.ceil(toY - trackTop)),
      fromBucket + 1,
      count,
    );
    const list = grouped.get(block.kind) ?? [];
    list.push({ from: fromBucket, to: toBucket });
    grouped.set(block.kind, list);
  }

  const bands: MinimapBlockBand[] = [];
  for (const kind of Object.keys(BLOCK_PRIORITY) as MinimapBlockKind[]) {
    const ranges = grouped.get(kind);
    if (!ranges) {
      continue;
    }
    ranges.sort((left, right) => left.from - right.from || left.to - right.to);
    let current = { ...ranges[0]! };
    for (let i = 1; i < ranges.length; i += 1) {
      const next = ranges[i]!;
      if (next.from <= current.to) {
        current.to = Math.max(current.to, next.to);
      } else {
        bands.push({ kind, fromBucket: current.from, toBucket: current.to });
        current = { ...next };
      }
    }
    bands.push({ kind, fromBucket: current.from, toBucket: current.to });
  }
  return bands;
}

export function scrollTopToDocY(scrollTop: number, paddingTop: number, docHeight: number): number {
  return clamp(scrollTop - paddingTop, 0, Math.max(1, docHeight));
}

export function docYToScrollTop(
  docY: number,
  paddingTop: number,
  maxScroll: number,
  viewportOffset = 0,
): number {
  return clamp(docY + paddingTop - viewportOffset, 0, Math.max(0, maxScroll));
}

export interface SliderGeometryInput {
  docHeight: number;
  trackTop: number;
  trackHeight: number;
  scrollTop: number;
  clientHeight: number;
  paddingTop: number;
  minHeight?: number;
}

export interface SliderGeometry {
  top: number;
  height: number;
  topDoc: number;
  bottomDoc: number;
}

export function computeSliderGeometry({
  docHeight,
  trackTop,
  trackHeight,
  scrollTop,
  clientHeight,
  paddingTop,
  minHeight = MINIMAP_SLIDER_MIN_PX,
}: SliderGeometryInput): SliderGeometry {
  const height = Math.max(1, docHeight);
  const track = Math.max(1, trackHeight);
  const topDoc = scrollTopToDocY(scrollTop, paddingTop, height);
  const bottomDoc = clamp(scrollTop - paddingTop + Math.max(0, clientHeight), 0, height);
  const topRaw = docYToRail(topDoc, height, trackTop, track);
  const bottomRaw = docYToRail(bottomDoc, height, trackTop, track);
  const rawHeight = Math.max(1, bottomRaw - topRaw);
  const sliderHeight = Math.min(track, Math.max(minHeight, rawHeight));
  const top = clamp(topRaw, trackTop, trackTop + track - sliderHeight);
  return { top, height: sliderHeight, topDoc, bottomDoc };
}

export interface EligibilityInput {
  lines: number;
  units: number;
  editorWidth: number;
  wasVisible: boolean;
}

export function isEligible({ lines, units, editorWidth, wasVisible }: EligibilityInput): boolean {
  if (!Number.isFinite(lines) || lines < 1 || lines > MINIMAP_MAX_LINES) {
    return false;
  }
  if (!Number.isFinite(units) || units > MINIMAP_MAX_UNITS) {
    return false;
  }
  const minimumWidth = wasVisible
    ? MINIMAP_MIN_EDITOR_WIDTH - MINIMAP_WIDTH_HYSTERESIS
    : MINIMAP_MIN_EDITOR_WIDTH;
  return editorWidth >= minimumWidth;
}

export interface VisibilityInput extends EligibilityInput {
  scrollHeight: number;
  clientHeight: number;
}

export function nextVisibility(input: VisibilityInput): "visible" | "hidden" {
  if (!isEligible(input)) {
    return "hidden";
  }
  return input.scrollHeight > input.clientHeight + 1 ? "visible" : "hidden";
}
