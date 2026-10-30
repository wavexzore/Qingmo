import { Facet, type Extension, type Text } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

import { plainInlineText } from "../live-preview/heading-anchors";
import { resolveMinimapPalette, type MinimapPalette } from "./theme";
import {
  KIND,
  MINIMAP_ANCHOR_MAX,
  MINIMAP_ANCHOR_STRIDE_MIN,
  MINIMAP_ANCHOR_TARGET,
  MINIMAP_EPS,
  MINIMAP_MAX_LINES,
  MINIMAP_MAX_UNITS,
  MINIMAP_MIN_EDITOR_WIDTH,
  MINIMAP_MIN_LINES,
  MINIMAP_SLIDER_MIN_PX,
  buildBlockBands,
  buildMinimapBuckets,
  computeMinimapWindow,
  computeSliderGeometry,
  createAnchorMap,
  docYToScrollTop,
  lineAtDocY,
  railToDocY,
  scanMinimapDocument,
  scrollTopToDocY,
  type AnchorSample,
  type MinimapAnchorMap,
  type MinimapBlock,
  type MinimapBlockKind,
  type MinimapGeometry,
  type MinimapLineTable,
  type MinimapWindow,
} from "./model";

export type { MinimapGeometry } from "./model";

export interface MinimapOptions {
  railWidth?: number;
  railGap?: number;
  minLines?: number;
  maxLines?: number;
  maxUnits?: number;
  minEditorWidth?: number;
  sliderMinPx?: number;
  anchorTarget?: number;
  anchorMax?: number;
  rebuildDebounceMs?: number;
  /** Test-only geometry injection; production reads the real DOM. */
  geometry?: () => MinimapGeometry;
}

export type MinimapState = "off" | "pending" | "on" | "unsupported" | "degraded";

const RAIL_WIDTH = 76;
const RAIL_GAP = 12;
const REBUILD_DEBOUNCE = 120;
const ANCHOR_REFRESH = 250;
const TRACK_PADDING_Y = 6;
const INDENT_PX = 2;
const MINIMAP_LINE_HEIGHT = 3;
const MINIMAP_CHAR_WIDTH = 1;
const MINIMAP_SCALE_DIVISOR = 8;
const WHEEL_STEP = 1;
const MEASURE_KEY = Symbol("qm-minimap");

const minimapOptions = Facet.define<MinimapOptions, MinimapOptions>({
  combine: (values) => values[0] ?? {},
});

const minimapTheme = EditorView.theme({
  // Once the rail is visible it owns vertical navigation, so the native
  // scrollbar is redundant. Keep the scroller itself untouched: it stays the
  // single scroll source for ViewStateRecorder, the wheel and the keyboard.
  '& > .cm-scroller[data-minimap-scrollbar="hidden"]': {
    scrollbarWidth: "none",
  },
  '& > .cm-scroller[data-minimap-scrollbar="hidden"]::-webkit-scrollbar': {
    width: "0",
    height: "0",
  },
  "& > .qm-minimap": {
    position: "absolute",
    zIndex: "10",
    boxSizing: "border-box",
    display: "block",
    top: "0",
    right: "0",
    width: "var(--qm-minimap-width, 76px)",
    height: "100%",
    overflow: "hidden",
    borderLeft: "1px solid var(--qm-line)",
    background: "transparent",
    backgroundColor: "color-mix(in srgb, var(--qm-surface-muted) 28%, transparent)",
    userSelect: "none",
    touchAction: "none",
    cursor: "pointer",
  },
  "& > .qm-minimap > .qm-minimap-canvas": {
    display: "block",
    width: "100%",
    height: "100%",
  },
  "& > .qm-minimap > .qm-minimap-slider": {
    position: "absolute",
    left: "0",
    width: "100%",
    top: "0",
    boxSizing: "border-box",
    pointerEvents: "none",
    border: "1px solid color-mix(in srgb, var(--qm-accent) 36%, transparent)",
    borderRadius: "3px",
    background: "var(--qm-accent-soft)",
    opacity: "0.45",
    transition: "opacity var(--qm-duration-fast) var(--qm-ease-out, ease-out)",
    willChange: "transform",
  },
  "& > .qm-minimap:hover > .qm-minimap-slider, & > .qm-minimap.qm-minimap-dragging > .qm-minimap-slider":
    {
      opacity: "0.9",
    },
  "& > .qm-minimap > .qm-minimap-caret": {
    position: "absolute",
    left: "0",
    width: "100%",
    height: "1px",
    background: "var(--qm-accent-strong)",
    opacity: "0.8",
    pointerEvents: "none",
    willChange: "transform",
  },
});

interface ResolvedOptions {
  railWidth: number;
  railGap: number;
  minLines: number;
  maxLines: number;
  maxUnits: number;
  minEditorWidth: number;
  sliderMinPx: number;
  anchorTarget: number;
  anchorMax: number;
  rebuildDebounceMs: number;
  geometry?: () => MinimapGeometry;
}

interface Measurement {
  geometry: MeasuredGeometry;
  samples: AnchorSample[];
  degraded: boolean;
  unsupported: boolean;
}

interface MeasuredGeometry extends MinimapGeometry {
  railTop: number;
}

function resolveOptions(options: MinimapOptions): ResolvedOptions {
  return {
    railWidth: Number.isFinite(options.railWidth) ? Math.max(1, options.railWidth!) : RAIL_WIDTH,
    railGap: Number.isFinite(options.railGap) ? Math.max(0, options.railGap!) : RAIL_GAP,
    minLines: Number.isFinite(options.minLines)
      ? Math.max(1, options.minLines!)
      : MINIMAP_MIN_LINES,
    maxLines: Number.isFinite(options.maxLines)
      ? Math.max(1, options.maxLines!)
      : MINIMAP_MAX_LINES,
    maxUnits: Number.isFinite(options.maxUnits)
      ? Math.max(1, options.maxUnits!)
      : MINIMAP_MAX_UNITS,
    minEditorWidth: Number.isFinite(options.minEditorWidth)
      ? Math.max(1, options.minEditorWidth!)
      : MINIMAP_MIN_EDITOR_WIDTH,
    sliderMinPx: Number.isFinite(options.sliderMinPx)
      ? Math.max(1, options.sliderMinPx!)
      : MINIMAP_SLIDER_MIN_PX,
    anchorTarget: Number.isFinite(options.anchorTarget)
      ? Math.max(1, options.anchorTarget!)
      : MINIMAP_ANCHOR_TARGET,
    anchorMax: Number.isFinite(options.anchorMax)
      ? Math.max(2, options.anchorMax!)
      : MINIMAP_ANCHOR_MAX,
    rebuildDebounceMs: Number.isFinite(options.rebuildDebounceMs)
      ? Math.max(0, options.rebuildDebounceMs!)
      : REBUILD_DEBOUNCE,
    ...(options.geometry ? { geometry: options.geometry } : {}),
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function blockColor(kind: MinimapBlockKind, palette: MinimapPalette): string {
  switch (kind) {
    case "table":
      return palette.table;
    case "fence":
    case "math":
      return palette.code;
    case "media":
    case "html":
      return palette.muted;
    case "frontmatter":
      return palette.rule;
    default:
      return palette.muted;
  }
}

function lineColor(kind: number, palette: MinimapPalette): string | null {
  switch (kind) {
    case KIND.text:
      return palette.text;
    case KIND.heading:
      return palette.heading;
    case KIND.code:
      return palette.code;
    case KIND.diagram:
      return palette.diagram;
    case KIND.table:
      return palette.table;
    case KIND.rule:
    case KIND.frontmatter:
      return palette.rule;
    case KIND.list:
    case KIND.quote:
    case KIND.html:
      return palette.muted;
    default:
      return null;
  }
}

function isVisibleState(state: MinimapState): boolean {
  return state === "on" || state === "degraded";
}

interface GlyphMask {
  top: number;
  bottom: number;
}

interface GlyphTable {
  masks: readonly GlyphMask[];
}

const glyphTables = new Map<string, GlyphTable | null>();

/**
 * Builds a 1x2 alpha mask per printable ASCII character by rasterising a
 * normal-sized glyph and averaging it down. This is the same idea as VS
 * Code's minimap char renderer: at 1px wide, a full font would be blurry, so
 * only the ink distribution is kept.
 */
function buildGlyphTable(fontFamily: string): GlyphTable | null {
  if (typeof document === "undefined") {
    return null;
  }
  const canvas = document.createElement("canvas");
  canvas.width = 12;
  canvas.height = 12;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (
    !context ||
    typeof context.getImageData !== "function" ||
    typeof context.fillText !== "function"
  ) {
    return null;
  }

  try {
    context.clearRect(0, 0, 12, 12);
    context.font = `bold 11px ${fontFamily || "monospace"}`;
    context.textBaseline = "top";
    context.fillStyle = "#ffffff";
    const masks: GlyphMask[] = [];
    for (let code = 32; code <= 126; code += 1) {
      context.clearRect(0, 0, 12, 12);
      context.fillText(String.fromCharCode(code), 0, 0);
      const data = context.getImageData(0, 0, 12, 12).data;
      let top = 0;
      let bottom = 0;
      for (let y = 0; y < 6; y += 1) {
        for (let x = 0; x < 12; x += 1) {
          top += data[(y * 12 + x) * 4 + 3] ?? 0;
        }
      }
      for (let y = 6; y < 12; y += 1) {
        for (let x = 0; x < 12; x += 1) {
          bottom += data[(y * 12 + x) * 4 + 3] ?? 0;
        }
      }
      masks[code - 32] = {
        top: top / (6 * 12 * 255),
        bottom: bottom / (6 * 12 * 255),
      };
    }
    return { masks };
  } catch {
    return null;
  }
}

function glyphTableFor(fontFamily: string): GlyphTable | null {
  const key = fontFamily || "monospace";
  if (glyphTables.has(key)) {
    return glyphTables.get(key) ?? null;
  }
  const table = buildGlyphTable(key);
  glyphTables.set(key, table);
  return table;
}

function isFullWidthChar(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff)
  );
}

/** Live Preview renders Markdown; source mode keeps the raw text. */
function isRenderedMode(view: EditorView): boolean {
  return view.dom.dataset.livePreview === "true";
}

const FENCE_LINE_RE = /^\s*(?:`{3,}|~{3,})/;
const LIST_PREFIX_RE = /^\s{0,3}(?:[-+*]|\d+[.)])\s+/;
const TASK_PREFIX_RE = /^\[[ xX]\]\s*/;
const QUOTE_PREFIX_RE = /^\s{0,3}(?:>\s?)+/;
const HEADING_PREFIX_RE = /^\s{0,3}#{1,6}(?:\s+|$)/;
const HEADING_SUFFIX_RE = /\s+#+\s*$/;

/**
 * Builds the text a rendered Markdown line exposes to the minimap. Block
 * markers are removed, inline markers are flattened, and widget-only rows
 * return an empty string because the widget itself is drawn as a block.
 */
export function renderedLineText(raw: string, kind: number): string {
  if (kind === KIND.heading) {
    return plainInlineText(
      raw.replace(HEADING_PREFIX_RE, "").replace(HEADING_SUFFIX_RE, "").trim(),
    );
  }
  if (kind === KIND.quote) {
    return plainInlineText(raw.replace(QUOTE_PREFIX_RE, ""));
  }
  if (kind === KIND.list) {
    return plainInlineText(raw.replace(LIST_PREFIX_RE, "").replace(TASK_PREFIX_RE, ""));
  }
  if (kind === KIND.code || kind === KIND.diagram) {
    const trimmed = raw.trim();
    if (FENCE_LINE_RE.test(trimmed) || trimmed === "$$") {
      return "";
    }
    return kind === KIND.diagram ? "" : raw;
  }
  if (kind === KIND.table || kind === KIND.rule || kind === KIND.frontmatter) {
    return "";
  }
  if (kind === KIND.html) {
    return plainInlineText(raw.replace(/<[^>]*>/g, ""));
  }
  return plainInlineText(raw);
}

/** Source indentation in columns, used for rendered list bullets and quotes. */
function leadingColumns(raw: string, tabSize: number): number {
  let column = 0;
  for (const char of raw) {
    if (char === " ") {
      column += 1;
    } else if (char === "\t") {
      column += Math.max(1, tabSize - (column % tabSize));
    } else {
      break;
    }
  }
  return column;
}

/**
 * Owns one rail per top-level EditorView. All state is derived from the
 * current EditorState; the minimap never writes the document or persistence.
 */
class MinimapController {
  private readonly view: EditorView;
  private readonly options: ResolvedOptions;
  private readonly rail: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly buffer: HTMLCanvasElement;
  private readonly slider: HTMLDivElement;
  private readonly caret: HTMLDivElement;
  private readonly originalPaddingRight: string;
  private readonly scrollListener: () => void;
  private readonly pointerDownListener: (event: PointerEvent) => void;
  private readonly pointerMoveListener: (event: PointerEvent) => void;
  private readonly pointerUpListener: (event: PointerEvent) => void;
  private readonly wheelListener: (event: WheelEvent) => void;
  private readonly windowResizeListener: () => void;
  private readonly windowPointerMoveListener: (event: PointerEvent) => void;
  private readonly windowPointerUpListener: (event: PointerEvent) => void;
  private readonly resizeObserver: ResizeObserver | null;
  private readonly themeObserver: MutationObserver | null;

  private state: MinimapState = "off";
  private destroyed = false;
  private palette: MinimapPalette | null = null;
  private scannedDoc: Text | null = null;
  private scannedTabSize = 4;
  private lineTable: MinimapLineTable | null = null;
  private blocks: MinimapBlock[] = [];
  private headingLines: number[] = [];
  private anchorMap: MinimapAnchorMap | null = null;
  private geometry: MeasuredGeometry | null = null;
  private window: MinimapWindow | null = null;
  private windowTopDoc = 0;
  private windowBottomDoc = 1;
  private renderedMode = false;
  private minimapLineHeight = MINIMAP_LINE_HEIGHT;
  private minimapCharWidth = MINIMAP_CHAR_WIDTH;
  private glyphFont = "";
  private glyphs: GlyphTable | null = null;
  private hasFrame = false;
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private anchorTimer: ReturnType<typeof setTimeout> | null = null;
  private scrollFrame = 0;
  private generation = 0;
  private measureGeneration = 0;
  private dragging = false;
  private pointerId: number | null = null;
  private grabRatio = 0.5;
  private sliderTop = 0;
  private sliderHeight = 0;

  constructor(view: EditorView) {
    this.view = view;
    this.renderedMode = isRenderedMode(view);
    this.options = resolveOptions(view.state.facet(minimapOptions));
    const doc = view.dom.ownerDocument;

    this.rail = doc.createElement("div");
    this.rail.className = "qm-minimap";
    this.rail.setAttribute("aria-hidden", "true");
    this.rail.dataset.minimapState = "off";
    this.rail.style.display = "none";
    this.rail.style.visibility = "hidden";

    this.canvas = doc.createElement("canvas");
    this.canvas.className = "qm-minimap-canvas";
    this.buffer = doc.createElement("canvas");

    this.slider = doc.createElement("div");
    this.slider.className = "qm-minimap-slider";
    this.caret = doc.createElement("div");
    this.caret.className = "qm-minimap-caret";

    this.rail.append(this.canvas, this.slider, this.caret);
    view.dom.appendChild(this.rail);
    this.originalPaddingRight = view.dom.style.paddingRight;

    this.scrollListener = () => this.scheduleScrollUpdate();
    this.pointerDownListener = (event) => this.onPointerDown(event);
    this.pointerMoveListener = (event) => this.onPointerMove(event);
    this.pointerUpListener = (event) => this.onPointerUp(event);
    this.wheelListener = (event) => this.onWheel(event);
    this.windowResizeListener = () => this.scheduleRebuild(0);
    this.windowPointerMoveListener = (event) => this.onPointerMove(event);
    this.windowPointerUpListener = (event) => this.onPointerUp(event);

    view.scrollDOM.addEventListener("scroll", this.scrollListener, { passive: true });
    this.rail.addEventListener("pointerdown", this.pointerDownListener);
    this.rail.addEventListener("pointermove", this.pointerMoveListener);
    this.rail.addEventListener("pointerup", this.pointerUpListener);
    this.rail.addEventListener("pointercancel", this.pointerUpListener);
    this.rail.addEventListener("wheel", this.wheelListener, { passive: false });

    const window = doc.defaultView;
    window?.addEventListener("resize", this.windowResizeListener);

    this.resizeObserver =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(() => {
            if (!this.destroyed) {
              this.scheduleRebuild(0);
            }
          })
        : null;
    if (this.resizeObserver) {
      this.resizeObserver.observe(view.dom);
      this.resizeObserver.observe(view.scrollDOM);
    }

    this.themeObserver =
      typeof MutationObserver === "function" && doc.documentElement
        ? new MutationObserver(() => this.refreshTheme())
        : null;
    this.themeObserver?.observe(doc.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    this.scheduleRebuild(0);
  }

  update(update: ViewUpdate): void {
    if (this.destroyed) {
      return;
    }
    if (update.view.composing) {
      return;
    }

    let needsRebuild = false;
    const renderedMode = isRenderedMode(this.view);
    if (renderedMode !== this.renderedMode) {
      this.renderedMode = renderedMode;
      needsRebuild = true;
    }
    if (update.docChanged) {
      needsRebuild = true;
    }
    if (update.geometryChanged) {
      needsRebuild = true;
    }
    if (update.transactions.some((transaction) => transaction.reconfigured)) {
      needsRebuild = true;
    }

    if (needsRebuild) {
      if (this.view.composing) {
        return;
      }
      // Do not flash "pending" on documents that never had a visible rail.
      // Short/oversized documents stay "off" until the rebuild re-evaluates
      // eligibility; an already visible rail keeps its last frame while the
      // next measurement runs.
      if (this.hasFrame || isVisibleState(this.state) || this.state === "pending") {
        this.setPending();
      }
      this.scheduleRebuild(this.options.rebuildDebounceMs);
    }

    if (update.viewportChanged) {
      this.refreshScroll();
      this.scheduleAnchorRefresh();
    }
    if (update.selectionSet) {
      this.updateCaret();
    }
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.generation += 1;
    this.measureGeneration += 1;
    this.clearTimers();
    if (this.scrollFrame) {
      const window = this.view.dom.ownerDocument.defaultView;
      if (window) {
        window.cancelAnimationFrame(this.scrollFrame);
      }
      this.scrollFrame = 0;
    }
    this.view.scrollDOM.removeEventListener("scroll", this.scrollListener);
    this.rail.removeEventListener("pointerdown", this.pointerDownListener);
    this.rail.removeEventListener("pointermove", this.pointerMoveListener);
    this.rail.removeEventListener("pointerup", this.pointerUpListener);
    this.rail.removeEventListener("pointercancel", this.pointerUpListener);
    this.rail.removeEventListener("wheel", this.wheelListener);
    this.detachWindowPointerListeners();
    this.view.dom.ownerDocument.defaultView?.removeEventListener(
      "resize",
      this.windowResizeListener,
    );
    this.resizeObserver?.disconnect();
    this.themeObserver?.disconnect();
    this.rail.remove();
    this.view.dom.style.paddingRight = this.originalPaddingRight;
    this.view.dom.style.removeProperty("--qm-minimap-width");
    this.setScrollbarReplaced(false);
  }

  private clearTimers(): void {
    if (this.rebuildTimer !== null) {
      clearTimeout(this.rebuildTimer);
      this.rebuildTimer = null;
    }
    if (this.anchorTimer !== null) {
      clearTimeout(this.anchorTimer);
      this.anchorTimer = null;
    }
  }

  private setState(next: MinimapState): void {
    this.state = next;
    this.rail.dataset.minimapState = next;
  }

  private get reserve(): number {
    return this.options.railWidth + this.options.railGap;
  }

  private eligible(editorWidth: number): boolean {
    const doc = this.view.state.doc;
    if (
      !Number.isFinite(doc.lines) ||
      doc.lines < 1 ||
      doc.lines > this.options.maxLines ||
      !Number.isFinite(doc.length) ||
      doc.length > this.options.maxUnits
    ) {
      return false;
    }
    const wasVisible = this.hasFrame || isVisibleState(this.state);
    const minimumLines = wasVisible
      ? Math.max(1, this.options.minLines - 8)
      : this.options.minLines;
    const minimumWidth = wasVisible
      ? Math.max(1, this.options.minEditorWidth - 16)
      : this.options.minEditorWidth;
    return doc.lines >= minimumLines && editorWidth >= minimumWidth;
  }

  private scheduleRebuild(delay: number): void {
    if (this.destroyed) {
      return;
    }
    this.clearTimers();
    this.rebuildTimer = setTimeout(
      () => {
        this.rebuildTimer = null;
        this.rebuildNow();
      },
      Math.max(0, delay),
    );
  }

  private scheduleAnchorRefresh(): void {
    if (this.destroyed || this.dragging) {
      return;
    }
    if (this.anchorTimer !== null) {
      clearTimeout(this.anchorTimer);
    }
    this.anchorTimer = setTimeout(() => {
      this.anchorTimer = null;
      this.rebuildNow();
    }, ANCHOR_REFRESH);
  }

  private scheduleScrollUpdate(): void {
    if (this.destroyed || this.dragging) {
      return;
    }
    const window = this.view.dom.ownerDocument.defaultView;
    if (!window) {
      this.refreshScroll();
      return;
    }
    if (this.scrollFrame) {
      return;
    }
    this.scrollFrame = window.requestAnimationFrame(() => {
      this.scrollFrame = 0;
      this.refreshScroll();
    });
  }

  private ensureScanned(): void {
    const doc = this.view.state.doc;
    const tabSize = this.view.state.tabSize;
    if (this.scannedDoc === doc && this.scannedTabSize === tabSize) {
      return;
    }
    const scan = scanMinimapDocument(doc, tabSize);
    this.scannedDoc = doc;
    this.scannedTabSize = tabSize;
    this.lineTable = scan.lines;
    this.blocks = scan.blocks;
    this.headingLines = scan.headings;
  }

  private rebuildNow(): void {
    if (this.destroyed) {
      return;
    }
    const editorWidth = this.options.geometry?.().editorWidth ?? this.view.dom.clientWidth;
    if (!this.eligible(editorWidth)) {
      this.hide();
      return;
    }

    const startedAt = performance.now();
    this.ensureScanned();
    this.scanMs = performance.now() - startedAt;
    this.setPending();
    this.buildStartedAt = startedAt;
    const request = ++this.measureGeneration;
    this.view.requestMeasure<Measurement | null>({
      key: MEASURE_KEY,
      read: (view) => {
        const readStartedAt = performance.now();
        const measurement = this.readMeasurement(view);
        this.readMs = performance.now() - readStartedAt;
        return measurement;
      },
      write: (measurement) => {
        if (this.destroyed || request !== this.measureGeneration || !measurement) {
          return;
        }
        this.writeStartedAt = performance.now();
        this.applyMeasurement(measurement);
      },
    });
  }

  private readMeasurement(view: EditorView): Measurement | null {
    const injected = this.options.geometry?.();
    if (injected) {
      const docHeight = Math.max(
        1,
        injected.contentHeight - injected.documentPadding.top - injected.documentPadding.bottom,
      );
      return {
        geometry: {
          ...injected,
          railTop: 0,
          trackTop: TRACK_PADDING_Y,
          trackHeight: Math.max(1, injected.railHeight - TRACK_PADDING_Y * 2),
        },
        samples: this.measureAnchors(view, docHeight),
        degraded: false,
        unsupported: false,
      };
    }

    const scrollerRect = view.scrollDOM.getBoundingClientRect();
    const editorRect = view.dom.getBoundingClientRect();
    const railWidth = this.rail.clientWidth || this.options.railWidth;
    const railHeight = scrollerRect.height || view.scrollDOM.clientHeight;
    const documentPadding = view.documentPadding;
    const contentHeight = view.contentHeight;
    if (!Number.isFinite(contentHeight) || contentHeight <= 0 || railHeight <= 0) {
      return null;
    }
    const docHeight = Math.max(1, contentHeight - documentPadding.top - documentPadding.bottom);
    if (docHeight <= 1) {
      return null;
    }

    return {
      geometry: {
        editorWidth: view.dom.clientWidth,
        railWidth,
        railHeight,
        railTop: scrollerRect.top - editorRect.top,
        trackTop: TRACK_PADDING_Y,
        trackHeight: Math.max(1, railHeight - TRACK_PADDING_Y * 2),
        contentHeight,
        documentPadding,
        clientHeight: view.scrollDOM.clientHeight,
        scrollHeight: view.scrollDOM.scrollHeight,
      },
      samples: this.measureAnchors(view, docHeight),
      degraded: false,
      unsupported: false,
    };
  }

  private measureAnchors(view: EditorView, docHeight: number): AnchorSample[] {
    const doc = view.state.doc;
    const lastLine = Math.max(0, doc.lines - 1);
    const selected = new Set<number>([0, lastLine]);
    const priority = new Set<number>([0, lastLine]);

    for (const block of this.blocks) {
      const from = clamp(block.fromLine, 0, lastLine);
      const to = clamp(block.toLine + 1, 0, lastLine);
      selected.add(from);
      selected.add(to);
      priority.add(from);
      priority.add(to);
    }
    for (const line of this.headingLines) {
      if (line >= 0 && line < doc.lines) {
        selected.add(line);
        priority.add(line);
      }
    }

    const stride = Math.max(
      MINIMAP_ANCHOR_STRIDE_MIN,
      Math.ceil(doc.lines / Math.max(1, this.options.anchorTarget)),
    );
    for (let line = 0; line < doc.lines; line += stride) {
      selected.add(line);
    }

    for (const range of view.visibleRanges) {
      const first = doc.lineAt(range.from).number - 1;
      const last = doc.lineAt(range.to).number - 1;
      selected.add(first);
      selected.add(last);
      for (let line = first; line <= last; line += 4) {
        selected.add(line);
      }
    }

    let candidates = [...selected].sort((left, right) => left - right);
    if (candidates.length > this.options.anchorMax) {
      const must = candidates.filter((line) => priority.has(line));
      const picked = new Set<number>([0, lastLine]);
      if (must.length + 2 <= this.options.anchorMax) {
        for (const line of must) {
          picked.add(line);
        }
      } else {
        const step = Math.max(1, Math.ceil(must.length / Math.max(1, this.options.anchorMax - 2)));
        for (let index = 0; index < must.length; index += step) {
          picked.add(must[index]!);
        }
      }
      const rest = candidates.filter((line) => !picked.has(line));
      const room = Math.max(1, this.options.anchorMax - picked.size);
      const step = Math.max(1, Math.ceil(rest.length / room));
      for (
        let index = 0;
        index < rest.length && picked.size < this.options.anchorMax;
        index += step
      ) {
        picked.add(rest[index]!);
      }
      candidates = [...picked].sort((left, right) => left - right);
    }

    const samples: AnchorSample[] = [];
    let degraded = false;
    for (const line of candidates) {
      try {
        const position = doc.line(Math.min(line, lastLine) + 1).from;
        const docY = view.lineBlockAt(position).top;
        samples.push({ line, docY });
      } catch {
        degraded = true;
      }
    }

    samples.push({ line: doc.lines, docY: Math.max(1, docHeight) });

    const deduped: AnchorSample[] = [];
    for (const sample of samples.sort(
      (left, right) => left.line - right.line || left.docY - right.docY,
    )) {
      const previous = deduped[deduped.length - 1];
      if (!previous) {
        deduped.push(sample);
      } else if (sample.line > previous.line) {
        if (sample.line === doc.lines || sample.docY > previous.docY + MINIMAP_EPS) {
          deduped.push(sample);
        }
      }
    }
    if (deduped[0]?.line !== 0) {
      deduped.unshift({ line: 0, docY: 0 });
    } else {
      deduped[0] = { line: 0, docY: 0 };
    }
    if (deduped[deduped.length - 1]?.line !== doc.lines) {
      deduped.push({ line: doc.lines, docY: Math.max(1, docHeight) });
    } else {
      deduped[deduped.length - 1] = { line: doc.lines, docY: Math.max(1, docHeight) };
    }
    this.lastMeasurementDegraded = degraded && deduped.length > 2;
    return deduped;
  }

  private lastMeasurementDegraded = false;
  private buildStartedAt = 0;
  private scanMs = 0;
  private readMs = 0;
  private writeStartedAt = 0;

  private applyMeasurement(measurement: Measurement): void {
    this.geometry = measurement.geometry;
    this.rail.style.top = `${measurement.geometry.railTop}px`;
    this.rail.style.height = `${measurement.geometry.railHeight}px`;
    this.view.dom.style.setProperty("--qm-minimap-width", `${this.options.railWidth}px`);

    const doc = this.view.state.doc;
    const docHeight = Math.max(
      1,
      measurement.geometry.contentHeight -
        measurement.geometry.documentPadding.top -
        measurement.geometry.documentPadding.bottom,
    );
    const visible =
      this.eligible(measurement.geometry.editorWidth) &&
      docHeight > measurement.geometry.clientHeight + 1;
    if (!visible || measurement.unsupported) {
      this.hide();
      return;
    }

    this.anchorMap = createAnchorMap(
      measurement.samples,
      doc.lines,
      docHeight,
      measurement.geometry.trackTop,
      measurement.geometry.trackHeight,
    );

    this.palette = resolveMinimapPalette(this.view.dom);
    if (!this.palette) {
      this.markUnsupported();
      return;
    }

    this.updateScale();
    this.updateScrollLayout();
    const drawn = this.draw();
    if (!drawn) {
      if (this.hasFrame) {
        this.show("degraded");
        this.applySliderStyles();
        this.updateCaret();
      } else {
        this.markUnsupported();
      }
      return;
    }

    this.hasFrame = true;
    this.show(measurement.degraded || this.lastMeasurementDegraded ? "degraded" : "on");
    this.applySliderStyles();
    this.updateCaret();
    this.dispatchBuild();
  }

  private setPending(): void {
    this.rail.style.display = "block";
    this.rail.style.visibility = this.hasFrame ? "visible" : "hidden";
    this.view.dom.style.paddingRight = `${this.reserve}px`;
    this.view.dom.style.setProperty("--qm-minimap-width", `${this.options.railWidth}px`);
    this.setScrollbarReplaced(true);
    this.setState("pending");
  }

  private show(state: "on" | "degraded"): void {
    this.rail.style.display = "block";
    this.rail.style.visibility = "visible";
    this.view.dom.style.paddingRight = `${this.reserve}px`;
    this.setScrollbarReplaced(true);
    this.setState(state);
  }

  private hide(): void {
    this.hasFrame = false;
    this.window = null;
    this.caret.style.display = "none";
    this.rail.style.display = "none";
    this.rail.removeAttribute("data-minimap-render");
    delete this.rail.dataset.minimapLineHeight;
    delete this.rail.dataset.minimapCharWidth;
    delete this.rail.dataset.minimapWindowStart;
    delete this.rail.dataset.minimapWindowLines;
    this.rail.style.visibility = "hidden";
    this.view.dom.style.paddingRight = this.originalPaddingRight;
    this.view.dom.style.removeProperty("--qm-minimap-width");
    this.setScrollbarReplaced(false);
    this.setState("off");
  }

  private markUnsupported(): void {
    this.hasFrame = false;
    this.window = null;
    this.caret.style.display = "none";
    this.rail.style.display = "none";
    this.rail.removeAttribute("data-minimap-render");
    delete this.rail.dataset.minimapLineHeight;
    delete this.rail.dataset.minimapCharWidth;
    delete this.rail.dataset.minimapWindowStart;
    delete this.rail.dataset.minimapWindowLines;
    this.rail.style.visibility = "hidden";
    this.view.dom.style.paddingRight = this.originalPaddingRight;
    this.view.dom.style.removeProperty("--qm-minimap-width");
    this.setScrollbarReplaced(false);
    this.setState("unsupported");
  }

  /**
   * Hides the native vertical scrollbar while the rail is on screen. The
   * scroller keeps `overflow: auto`, so wheel, keyboard and ViewStateRecorder
   * continue to use the same element; only the native thumb disappears.
   */
  private setScrollbarReplaced(replaced: boolean): void {
    if (replaced) {
      this.view.scrollDOM.dataset.minimapScrollbar = "hidden";
    } else {
      delete this.view.scrollDOM.dataset.minimapScrollbar;
    }
  }

  private draw(): boolean {
    const geometry = this.geometry;
    const lines = this.lineTable;
    const map = this.anchorMap;
    const palette = this.palette;
    this.renderedMode = isRenderedMode(this.view);
    if (!geometry || !lines || !map || !palette) {
      return false;
    }
    const visibleContext = this.canvas.getContext("2d");
    const bufferContext = this.buffer.getContext("2d");
    if (!visibleContext || !bufferContext) {
      return false;
    }

    try {
      const window = this.view.dom.ownerDocument.defaultView;
      const dpr =
        window && Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0
          ? window.devicePixelRatio
          : 1;
      const width = Math.max(1, geometry.railWidth);
      const height = Math.max(1, geometry.railHeight);
      const backingWidth = Math.max(1, Math.round(width * dpr));
      const backingHeight = Math.max(1, Math.round(height * dpr));
      for (const canvas of [this.canvas, this.buffer]) {
        canvas.width = backingWidth;
        canvas.height = backingHeight;
      }
      this.canvas.style.width = `${width}px`;
      this.canvas.style.height = `${height}px`;

      bufferContext.setTransform(dpr, 0, 0, dpr, 0, 0);
      bufferContext.clearRect(0, 0, width, height);

      try {
        if (!this.window) {
          throw new Error("minimap window is not ready");
        }
        if (this.renderedMode) {
          this.drawRenderedFrame(bufferContext, width);
          this.rail.dataset.minimapRender = "rendered";
        } else {
          this.drawTextFrame(bufferContext, width);
          this.rail.dataset.minimapRender = "text";
        }
      } catch {
        bufferContext.setTransform(dpr, 0, 0, dpr, 0, 0);
        bufferContext.clearRect(0, 0, width, height);
        this.drawBarsFrame(bufferContext, width, height);
        this.rail.dataset.minimapRender = "blocks";
      }
      this.rail.dataset.minimapLineHeight = `${this.minimapLineHeight}`;
      this.rail.dataset.minimapCharWidth = `${this.minimapCharWidth}`;
      this.rail.dataset.minimapWindowStart = `${this.window?.startLine ?? 0}`;
      this.rail.dataset.minimapWindowLines = `${this.window?.lineCount ?? 0}`;

      visibleContext.setTransform(dpr, 0, 0, dpr, 0, 0);
      visibleContext.save();
      visibleContext.globalCompositeOperation = "copy";
      visibleContext.drawImage(this.buffer, 0, 0, width, height);
      visibleContext.restore();
      return true;
    } catch {
      return false;
    }
  }

  private ensureGlyphs(): void {
    const fontFamily =
      this.view.dom.ownerDocument.defaultView?.getComputedStyle(this.view.contentDOM).fontFamily ??
      "monospace";
    if (fontFamily !== this.glyphFont) {
      this.glyphFont = fontFamily;
      this.glyphs = glyphTableFor(fontFamily);
    }
  }

  /**
   * Renders the actual source text as a 1:1 miniature: one character advances
   * one miniature column, spaces stay blank, tabs snap to tab stops, and full
   * width CJK/emoji occupy two columns. This mirrors VS Code's minimap rather
   * than drawing density bars.
   */
  private drawTextFrame(context: CanvasRenderingContext2D, width: number): void {
    const geometry = this.geometry;
    const lines = this.lineTable;
    const palette = this.palette;
    const window = this.window;
    if (!geometry || !lines || !palette || !window) {
      throw new Error("minimap frame is not ready");
    }

    this.ensureGlyphs();
    const doc = this.view.state.doc;
    const stateTabSize = Math.max(1, Math.trunc(this.view.state.tabSize) || 4);
    const lineHeight = this.minimapLineHeight;
    const charWidth = this.minimapCharWidth;
    const trackTop = geometry.trackTop;
    const trackBottom = geometry.trackTop + geometry.trackHeight;
    const glyphHeight = Math.max(1, Math.min(2, lineHeight - 1));

    for (let offset = 0; offset < window.lineCount; offset += 1) {
      const lineIndex = window.startLine + offset;
      if (lineIndex < 0 || lineIndex >= doc.lines) {
        break;
      }
      const y = trackTop + (window.paddingLines + offset) * lineHeight;
      if (y >= trackBottom) {
        break;
      }
      const kind = lines.kind[lineIndex] ?? KIND.text;
      if (kind === KIND.blank) {
        continue;
      }
      const color = lineColor(kind, palette) ?? palette.text;
      const text = doc.line(lineIndex + 1).text;
      context.fillStyle = color;
      let x = 0;
      let column = 0;

      for (const char of text) {
        const code = char.codePointAt(0) ?? 0;
        if (char === "\t") {
          const next = (Math.floor(column / stateTabSize) + 1) * stateTabSize;
          x += (next - column) * charWidth;
          column = next;
          continue;
        }
        if (char === " " || char === "\u00a0") {
          x += charWidth;
          column += 1;
          continue;
        }

        const wide = isFullWidthChar(code);
        const columns = wide ? 2 : 1;
        if (x + columns * charWidth > width) {
          break;
        }

        if (wide) {
          context.globalAlpha = 0.85;
          context.fillRect(x, y, columns * charWidth, glyphHeight);
        } else if (this.glyphs) {
          const mask = this.glyphs.masks[code - 32];
          const top = Math.min(0.95, (mask?.top ?? 0.25) * 2.4);
          const bottom = Math.min(0.95, (mask?.bottom ?? 0.25) * 2.4);
          if (top <= 0.04 && bottom <= 0.04) {
            context.globalAlpha = 0.7;
            context.fillRect(x, y, charWidth, glyphHeight);
          } else {
            if (top > 0.04) {
              context.globalAlpha = top;
              context.fillRect(x, y, charWidth, 1);
            }
            if (bottom > 0.04) {
              context.globalAlpha = bottom;
              context.fillRect(x, y + lineHeight - 1, charWidth, 1);
            }
          }
        } else {
          context.globalAlpha = 0.85;
          context.fillRect(x, y, charWidth, glyphHeight);
        }

        x += columns * charWidth;
        column += columns;
      }
    }
    context.globalAlpha = 1;
  }

  private documentHeight(): number {
    const geometry = this.geometry;
    if (!geometry) {
      return 1;
    }
    return Math.max(
      1,
      geometry.contentHeight - geometry.documentPadding.top - geometry.documentPadding.bottom,
    );
  }

  /** Maps a document Y to the local window currently painted in the rail. */
  private docYToLocal(docY: number): number {
    const geometry = this.geometry;
    const window = this.window;
    if (!geometry || !window) {
      return 0;
    }
    const padding = window.paddingLines * this.minimapLineHeight;
    const contentTop = geometry.trackTop + padding;
    const contentHeight = Math.max(1, geometry.trackHeight - padding);
    const span = Math.max(1, this.windowBottomDoc - this.windowTopDoc);
    return contentTop + clamp((docY - this.windowTopDoc) / span, 0, 1) * contentHeight;
  }

  private lineRailY(line: number): number | null {
    const geometry = this.geometry;
    const map = this.anchorMap;
    const window = this.window;
    if (!geometry || !map || !window) {
      return null;
    }
    if (line < window.startLine || line >= window.startLine + window.lineCount) {
      return null;
    }
    if (!this.renderedMode) {
      return (
        geometry.trackTop + (line - window.startLine + window.paddingLines) * this.minimapLineHeight
      );
    }
    return this.docYToLocal(map.lineDocY[line] ?? this.windowTopDoc);
  }

  /**
   * Renders a Live Preview window: text is flattened, block widgets become
   * miniature cards, and vertical positions follow the real editor geometry
   * instead of a uniform source-line grid.
   */
  private drawRenderedFrame(context: CanvasRenderingContext2D, width: number): void {
    const geometry = this.geometry;
    const lines = this.lineTable;
    const map = this.anchorMap;
    const palette = this.palette;
    const window = this.window;
    if (!geometry || !lines || !map || !palette || !window) {
      throw new Error("minimap rendered frame is not ready");
    }

    this.ensureGlyphs();
    const doc = this.view.state.doc;
    const tabSize = Math.max(1, Math.trunc(this.view.state.tabSize) || 4);
    const charWidth = this.minimapCharWidth;
    const trackTop = geometry.trackTop;
    const trackBottom = geometry.trackTop + geometry.trackHeight;
    const docHeight = this.documentHeight();

    // Headings have a surface band in Live Preview; keep that cue.
    for (let offset = 0; offset < window.lineCount; offset += 1) {
      const line = window.startLine + offset;
      if (line < 0 || line >= doc.lines) {
        break;
      }
      if (lines.kind[line] !== KIND.heading) {
        continue;
      }
      const top = this.docYToLocal(map.lineDocY[line] ?? 0);
      const nextDocY = line + 1 >= doc.lines ? docHeight : (map.lineDocY[line + 1] ?? docHeight);
      const bottom = this.docYToLocal(nextDocY);
      const clippedTop = Math.max(trackTop, top);
      const clippedBottom = Math.min(trackBottom, bottom);
      if (clippedBottom <= clippedTop) {
        continue;
      }
      context.globalAlpha = 0.08;
      context.fillStyle = palette.heading;
      context.fillRect(0, clippedTop, width, clippedBottom - clippedTop);
    }
    context.globalAlpha = 1;

    let backgroundIndex = 0;
    while (
      backgroundIndex < this.blocks.length &&
      this.blocks[backgroundIndex]!.toLine < window.startLine
    ) {
      backgroundIndex += 1;
    }
    const windowEndLine = window.startLine + window.lineCount;
    for (let index = backgroundIndex; index < this.blocks.length; index += 1) {
      const block = this.blocks[index]!;
      if (block.fromLine >= windowEndLine) {
        break;
      }
      const from = Math.max(block.fromLine, window.startLine);
      const to = Math.min(block.toLine + 1, windowEndLine);
      if (to <= from) {
        continue;
      }
      const top = this.docYToLocal(map.lineDocY[from] ?? 0);
      const nextDocY = to >= doc.lines ? docHeight : (map.lineDocY[to] ?? docHeight);
      const bottom = this.docYToLocal(nextDocY);
      const clippedTop = Math.max(trackTop, top);
      const clippedBottom = Math.min(trackBottom, bottom);
      if (clippedBottom <= clippedTop) {
        continue;
      }
      this.drawRenderedBlock(context, block, clippedTop, clippedBottom, width, palette);
    }

    let blockIndex = 0;
    while (blockIndex < this.blocks.length && this.blocks[blockIndex]!.toLine < window.startLine) {
      blockIndex += 1;
    }

    for (let offset = 0; offset < window.lineCount; offset += 1) {
      const line = window.startLine + offset;
      if (line < 0 || line >= doc.lines) {
        break;
      }
      const kind = lines.kind[line] ?? KIND.text;
      if (kind === KIND.blank) {
        continue;
      }
      const top = this.docYToLocal(map.lineDocY[line] ?? 0);
      const nextDocY = line + 1 >= doc.lines ? docHeight : (map.lineDocY[line + 1] ?? docHeight);
      const bottom = this.docYToLocal(nextDocY);
      const height = Math.max(1, bottom - top);
      if (top >= trackBottom) {
        break;
      }
      if (bottom <= trackTop) {
        continue;
      }
      const color = lineColor(kind, palette) ?? palette.text;
      const raw = doc.line(line + 1).text;

      while (blockIndex < this.blocks.length && this.blocks[blockIndex]!.toLine < line) {
        blockIndex += 1;
      }
      const block = this.blocks[blockIndex];
      const inside = block && block.fromLine <= line && line <= block.toLine ? block : null;

      if (kind === KIND.rule) {
        context.globalAlpha = 0.55;
        context.fillStyle = color;
        context.fillRect(0, top, width, 1);
        context.globalAlpha = 1;
        continue;
      }
      if (kind === KIND.table || kind === KIND.diagram) {
        continue;
      }
      if (
        inside &&
        (inside.kind === "media" ||
          inside.kind === "math" ||
          inside.kind === "frontmatter" ||
          inside.kind === "html")
      ) {
        continue;
      }
      if (inside?.kind === "fence" && /^mermaid\b/i.test(inside.info)) {
        continue;
      }

      const text = renderedLineText(raw, kind);
      if (!text) {
        continue;
      }

      let x = 2;
      if (kind === KIND.quote) {
        context.globalAlpha = 0.5;
        context.fillStyle = color;
        context.fillRect(2, top, 1, Math.max(1, height));
        context.globalAlpha = 1;
        x = 5;
      } else if (kind === KIND.list) {
        const indent = Math.min(width - 6, leadingColumns(raw, tabSize));
        context.globalAlpha = 0.85;
        context.fillStyle = color;
        context.fillRect(2 + indent, top + Math.max(0, Math.floor(height / 2)), 1, 1);
        context.globalAlpha = 1;
        x = 5 + indent;
      } else if (kind === KIND.code) {
        x = 3;
      }

      if (x >= width) {
        continue;
      }
      const glyphHeight = Math.max(1, Math.min(2, height - 1));
      const topRow = top + Math.max(0, Math.floor((height - glyphHeight) / 2));
      this.paintTextRun(
        context,
        text,
        x,
        topRow,
        width - x,
        charWidth,
        glyphHeight,
        color,
        tabSize,
      );
    }
    context.globalAlpha = 1;
  }

  private drawRenderedBlock(
    context: CanvasRenderingContext2D,
    block: MinimapBlock,
    top: number,
    bottom: number,
    width: number,
    palette: MinimapPalette,
  ): void {
    const height = Math.max(1, bottom - top);
    const color = blockColor(block.kind, palette);
    const innerLeft = 3;
    const innerRight = Math.max(innerLeft + 1, width - 3);
    const innerWidth = Math.max(1, innerRight - innerLeft);

    context.save();
    context.globalAlpha = 0.1;
    context.fillStyle = color;
    context.fillRect(0, top, width, height);
    context.globalAlpha = 0.28;
    context.strokeStyle = color;
    context.lineWidth = 1;
    context.strokeRect(0.5, top + 0.5, Math.max(1, width - 1), Math.max(1, height - 1));
    context.globalAlpha = 1;

    if (block.kind === "fence") {
      if (/^mermaid\b/i.test(block.info)) {
        const nodeWidth = Math.max(4, Math.min(14, Math.floor(innerWidth / 3)));
        const nodeHeight = Math.max(2, Math.min(5, Math.floor(height / 4)));
        const topRow = top + Math.max(2, Math.floor(height * 0.22));
        const bottomRow = top + Math.max(2, Math.floor(height * 0.62));
        context.globalAlpha = 0.55;
        context.fillStyle = color;
        context.fillRect(innerLeft, topRow, nodeWidth, nodeHeight);
        context.fillRect(innerRight - nodeWidth, topRow, nodeWidth, nodeHeight);
        context.fillRect(
          innerLeft + Math.floor(innerWidth / 2) - Math.floor(nodeWidth / 2),
          bottomRow,
          nodeWidth,
          nodeHeight,
        );
        context.globalAlpha = 0.35;
        context.strokeStyle = color;
        context.beginPath();
        context.moveTo(innerLeft + nodeWidth, topRow + nodeHeight / 2);
        context.lineTo(innerRight - nodeWidth, topRow + nodeHeight / 2);
        context.stroke();
        context.beginPath();
        context.moveTo(innerLeft + nodeWidth / 2, topRow + nodeHeight);
        context.lineTo(innerLeft + innerWidth / 2, bottomRow);
        context.stroke();
      } else {
        if (height >= 10) {
          context.globalAlpha = 0.35;
          context.fillStyle = color;
          for (let index = 0; index < 3; index += 1) {
            context.fillRect(innerLeft + index * 3, top + 2, 1, 1);
          }
        }
        context.globalAlpha = 0.25;
        context.fillStyle = color;
        context.fillRect(
          1,
          top + Math.max(4, Math.floor(height * 0.18)),
          1,
          Math.max(1, height - 6),
        );
      }
    } else if (block.kind === "table") {
      const rows = Math.max(1, Math.min(6, block.toLine - block.fromLine));
      context.globalAlpha = 0.35;
      context.strokeStyle = color;
      for (let row = 1; row <= rows; row += 1) {
        const y = top + (height * row) / (rows + 1);
        context.beginPath();
        context.moveTo(innerLeft, y);
        context.lineTo(innerRight, y);
        context.stroke();
      }
      for (let column = 1; column <= 2; column += 1) {
        const x = innerLeft + (innerWidth * column) / 3;
        context.beginPath();
        context.moveTo(x, top + 2);
        context.lineTo(x, bottom - 2);
        context.stroke();
      }
    } else if (block.kind === "media") {
      context.globalAlpha = 0.35;
      context.strokeStyle = color;
      context.strokeRect(innerLeft, top + 2, innerWidth, Math.max(1, height - 4));
      const baseline = top + height * 0.65;
      context.beginPath();
      context.moveTo(innerLeft + 2, baseline);
      context.lineTo(innerLeft + innerWidth * 0.35, top + height * 0.35);
      context.lineTo(innerLeft + innerWidth * 0.6, baseline);
      context.lineTo(innerLeft + innerWidth * 0.8, top + height * 0.5);
      context.lineTo(innerRight - 2, baseline);
      context.stroke();
      context.beginPath();
      context.arc(innerRight - 5, top + Math.max(3, height * 0.25), 1.5, 0, Math.PI * 2);
      context.stroke();
    } else if (block.kind === "math") {
      const middle = top + height / 2;
      context.globalAlpha = 0.5;
      context.fillStyle = color;
      context.fillRect(width * 0.3, middle - 2, width * 0.4, 1);
      context.fillRect(width * 0.36, middle, width * 0.28, 1);
      context.fillRect(width * 0.42, middle + 2, width * 0.16, 1);
    } else if (block.kind === "frontmatter") {
      const rows = Math.min(3, Math.max(1, Math.floor(height / 4)));
      context.globalAlpha = 0.35;
      context.fillStyle = color;
      for (let row = 0; row < rows; row += 1) {
        context.fillRect(innerLeft, top + 3 + row * 3, innerWidth * (0.8 - row * 0.12), 1);
      }
    } else if (block.kind === "html") {
      context.globalAlpha = 0.35;
      context.strokeStyle = color;
      context.beginPath();
      context.moveTo(innerLeft, top + 3);
      context.lineTo(innerLeft + 3, top + 5);
      context.lineTo(innerLeft, top + 7);
      context.stroke();
      context.globalAlpha = 0.25;
      context.fillStyle = color;
      context.fillRect(innerLeft + 5, top + 5, Math.max(1, innerWidth - 5), 1);
    }
    context.restore();
  }

  private paintTextRun(
    context: CanvasRenderingContext2D,
    text: string,
    startX: number,
    y: number,
    maxWidth: number,
    charWidth: number,
    glyphHeight: number,
    color: string,
    tabSize: number,
  ): void {
    context.fillStyle = color;
    let x = startX;
    let column = 0;
    const limit = startX + maxWidth;

    for (const char of text) {
      const code = char.codePointAt(0) ?? 0;
      if (char === "\t") {
        const next = (Math.floor(column / tabSize) + 1) * tabSize;
        x += (next - column) * charWidth;
        column = next;
        continue;
      }
      if (char === " " || char === "\u00a0") {
        x += charWidth;
        column += 1;
        continue;
      }

      const wide = isFullWidthChar(code);
      const columns = wide ? 2 : 1;
      if (x + columns * charWidth > limit) {
        break;
      }

      if (wide) {
        context.globalAlpha = 0.85;
        context.fillRect(x, y, columns * charWidth, glyphHeight);
      } else if (this.glyphs) {
        const mask = this.glyphs.masks[code - 32];
        const top = Math.min(0.95, (mask?.top ?? 0.25) * 2.4);
        const bottom = Math.min(0.95, (mask?.bottom ?? 0.25) * 2.4);
        if (glyphHeight <= 1) {
          context.globalAlpha = Math.max(0.7, Math.max(top, bottom));
          context.fillRect(x, y, charWidth, 1);
        } else if (top <= 0.04 && bottom <= 0.04) {
          context.globalAlpha = 0.7;
          context.fillRect(x, y, charWidth, glyphHeight);
        } else {
          if (top > 0.04) {
            context.globalAlpha = top;
            context.fillRect(x, y, charWidth, 1);
          }
          if (bottom > 0.04) {
            context.globalAlpha = bottom;
            context.fillRect(x, y + glyphHeight - 1, charWidth, 1);
          }
        }
      } else {
        context.globalAlpha = 0.85;
        context.fillRect(x, y, charWidth, glyphHeight);
      }

      x += columns * charWidth;
      column += columns;
    }
    context.globalAlpha = 1;
  }

  /** Structural fallback if text rendering throws (for example a broken 2D context). */
  private drawBarsFrame(context: CanvasRenderingContext2D, width: number, height: number): void {
    const geometry = this.geometry;
    const lines = this.lineTable;
    const map = this.anchorMap;
    const palette = this.palette;
    if (!geometry || !lines || !map || !palette) {
      throw new Error("minimap bars are not ready");
    }
    const trackTop = geometry.trackTop;
    const trackHeight = geometry.trackHeight;
    const trackWidth = Math.max(1, width);
    const bandOrder = buildBlockBands(
      this.blocks,
      map.lineDocY,
      map,
      Math.max(0, lines.count - 1),
      trackTop,
      trackHeight,
    );
    for (const band of bandOrder) {
      context.globalAlpha = 0.16;
      context.fillStyle = blockColor(band.kind, palette);
      context.fillRect(
        0,
        trackTop + band.fromBucket,
        trackWidth,
        Math.max(1, band.toBucket - band.fromBucket),
      );
    }

    context.globalAlpha = 1;
    const buckets = buildMinimapBuckets(
      lines,
      map.lineDocY,
      map,
      trackTop,
      trackHeight,
      trackWidth,
    );
    for (let bucket = 0; bucket < buckets.length; bucket += 1) {
      const value = buckets[bucket]!;
      const color = lineColor(value.kind, palette);
      if (!color) {
        continue;
      }
      const x = Math.min(trackWidth - 1, value.indent * INDENT_PX);
      const barWidth = Math.max(1, Math.min(value.width, trackWidth - x));
      context.fillStyle = color;
      context.fillRect(x, trackTop + bucket, barWidth, 1);
    }
    void height;
  }

  private dispatchBuild(): void {
    const doc = this.view.state.doc;
    const now = performance.now();
    const wallMs = Math.max(0, now - this.buildStartedAt);
    const writeMs = Math.max(0, now - this.writeStartedAt);
    const cpuMs = this.scanMs + this.readMs + writeMs;
    const event = new CustomEvent("qm-minimap-build", {
      detail: {
        ms: wallMs,
        cpuMs,
        scanMs: this.scanMs,
        readMs: this.readMs,
        writeMs,
        waitMs: Math.max(0, wallMs - cpuMs),
        lines: doc.lines,
        anchors: this.anchorMap?.samples.length ?? 0,
        render: this.rail.dataset.minimapRender ?? "text",
        lineHeight: this.minimapLineHeight,
        charWidth: this.minimapCharWidth,
        windowStart: this.window?.startLine ?? 0,
        windowLines: this.window?.lineCount ?? 0,
      },
      bubbles: true,
    });
    this.rail.dispatchEvent(event);
  }

  private updateScale(): void {
    const scale = 1 / MINIMAP_SCALE_DIVISOR;
    const lineHeight = this.view.defaultLineHeight;
    const charWidth = this.view.defaultCharacterWidth;
    this.minimapLineHeight =
      Number.isFinite(lineHeight) && lineHeight > 0
        ? clamp(Math.round(lineHeight * scale), 2, 4)
        : MINIMAP_LINE_HEIGHT;
    this.minimapCharWidth =
      Number.isFinite(charWidth) && charWidth > 0
        ? clamp(Math.round(charWidth * scale), 1, 2)
        : MINIMAP_CHAR_WIDTH;
  }

  private refreshScroll(): void {
    const changed = this.updateScrollLayout();
    this.applySliderStyles();
    this.updateCaret();
    if (changed && this.hasFrame) {
      this.draw();
    }
  }

  private updateScrollLayout(): boolean {
    const geometry = this.geometry;
    const map = this.anchorMap;
    if (!geometry || !map || (!isVisibleState(this.state) && this.state !== "pending")) {
      return false;
    }
    const docHeight = Math.max(
      1,
      geometry.contentHeight - geometry.documentPadding.top - geometry.documentPadding.bottom,
    );
    const maxScroll = Math.max(0, geometry.scrollHeight - geometry.clientHeight);
    const sliders = computeSliderGeometry({
      docHeight,
      trackTop: geometry.trackTop,
      trackHeight: geometry.trackHeight,
      scrollTop: this.view.scrollDOM.scrollTop,
      clientHeight: geometry.clientHeight,
      paddingTop: geometry.documentPadding.top,
      minHeight: this.options.sliderMinPx,
    });
    if (maxScroll === 0) {
      this.sliderTop = geometry.trackTop;
      this.sliderHeight = geometry.trackHeight;
    } else {
      this.sliderTop = sliders.top;
      this.sliderHeight = sliders.height;
    }

    const topDoc = scrollTopToDocY(
      this.view.scrollDOM.scrollTop,
      geometry.documentPadding.top,
      docHeight,
    );
    const viewportStartLine = lineAtDocY(map.lineDocY, topDoc);
    const nextWindow = computeMinimapWindow({
      lineCount: this.view.state.doc.lines,
      viewportStartLine,
      sliderTop: this.sliderTop,
      trackTop: geometry.trackTop,
      lineHeight: this.minimapLineHeight,
      trackHeight: geometry.trackHeight,
    });
    const changed =
      !this.window ||
      this.window.startLine !== nextWindow.startLine ||
      this.window.paddingLines !== nextWindow.paddingLines ||
      this.window.lineCount !== nextWindow.lineCount;
    this.window = nextWindow;

    const windowTopDoc = map.lineDocY[nextWindow.startLine] ?? 0;
    const windowEndLine = Math.min(
      nextWindow.startLine + nextWindow.lineCount,
      this.view.state.doc.lines,
    );
    const windowBottomDoc =
      windowEndLine >= this.view.state.doc.lines
        ? docHeight
        : (map.lineDocY[windowEndLine] ?? docHeight);
    this.windowTopDoc = windowTopDoc;
    this.windowBottomDoc = Math.max(windowTopDoc + 1, windowBottomDoc);
    return changed;
  }

  private applySliderStyles(): void {
    this.slider.style.transform = `translateY(${this.sliderTop}px)`;
    this.slider.style.height = `${this.sliderHeight}px`;
  }

  private updateCaret(): void {
    const map = this.anchorMap;
    const geometry = this.geometry;
    const window = this.window;
    if (!map || !geometry || !window || (!isVisibleState(this.state) && this.state !== "pending")) {
      return;
    }
    const headLine = this.view.state.doc.lineAt(this.view.state.selection.main.head).number - 1;
    const y = this.lineRailY(headLine);
    if (y === null) {
      this.caret.style.display = "none";
      return;
    }
    this.caret.style.display = "block";
    this.caret.style.transform = `translateY(${y}px)`;
  }

  private refreshTheme(): void {
    if (this.destroyed) {
      return;
    }
    this.palette = resolveMinimapPalette(this.view.dom);
    if (!this.palette) {
      this.markUnsupported();
      return;
    }
    if (this.geometry && this.anchorMap && this.lineTable && isVisibleState(this.state)) {
      this.updateScrollLayout();
      if (this.draw()) {
        this.hasFrame = true;
        this.show(this.state === "degraded" ? "degraded" : "on");
        this.applySliderStyles();
        this.updateCaret();
      }
    }
  }

  private onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || !isVisibleState(this.state) || this.dragging) {
      return;
    }
    const geometry = this.geometry;
    const map = this.anchorMap;
    if (!geometry || !map) {
      return;
    }
    event.preventDefault();
    const rect = this.rail.getBoundingClientRect();
    const y = event.clientY - rect.top;
    const sliderBottom = this.sliderTop + this.sliderHeight;
    if (y >= this.sliderTop && y <= sliderBottom) {
      this.grabRatio = this.sliderHeight > 0 ? (y - this.sliderTop) / this.sliderHeight : 0.5;
    } else {
      this.grabRatio = 0.5;
      const docHeight = Math.max(
        1,
        geometry.contentHeight - geometry.documentPadding.top - geometry.documentPadding.bottom,
      );
      const maxScroll = Math.max(0, geometry.scrollHeight - geometry.clientHeight);
      const docY = railToDocY(y, docHeight, geometry.trackTop, geometry.trackHeight);
      this.view.scrollDOM.scrollTop = docYToScrollTop(
        docY,
        geometry.documentPadding.top,
        maxScroll,
        geometry.clientHeight / 2,
      );
    }

    this.dragging = true;
    this.pointerId = event.pointerId;
    this.rail.classList.add("qm-minimap-dragging");
    try {
      this.rail.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is an optimization; the window listeners below keep
      // dragging functional on older WebViews.
    }
    const window = this.view.dom.ownerDocument.defaultView;
    window?.addEventListener("pointermove", this.windowPointerMoveListener);
    window?.addEventListener("pointerup", this.windowPointerUpListener);
    window?.addEventListener("pointercancel", this.windowPointerUpListener);
  }

  private onPointerMove(event: PointerEvent): void {
    if (!this.dragging || (this.pointerId !== null && event.pointerId !== this.pointerId)) {
      return;
    }
    const geometry = this.geometry;
    const map = this.anchorMap;
    if (!geometry || !map) {
      return;
    }
    event.preventDefault();
    const rect = this.rail.getBoundingClientRect();
    const y = event.clientY - rect.top;
    const maximumTop = geometry.trackTop + geometry.trackHeight - this.sliderHeight;
    const desiredTop = clamp(y - this.grabRatio * this.sliderHeight, geometry.trackTop, maximumTop);
    const docHeight = Math.max(
      1,
      geometry.contentHeight - geometry.documentPadding.top - geometry.documentPadding.bottom,
    );
    const maxScroll = Math.max(0, geometry.scrollHeight - geometry.clientHeight);
    const docY = railToDocY(desiredTop, docHeight, geometry.trackTop, geometry.trackHeight);
    this.view.scrollDOM.scrollTop = docYToScrollTop(
      docY,
      geometry.documentPadding.top,
      maxScroll,
      0,
    );
    this.sliderTop = desiredTop;
    this.slider.style.transform = `translateY(${desiredTop}px)`;
  }

  private onPointerUp(event: PointerEvent): void {
    if (!this.dragging) {
      return;
    }
    if (this.pointerId !== null && event.pointerId !== this.pointerId) {
      return;
    }
    this.endDrag();
  }

  private endDrag(): void {
    if (this.pointerId !== null) {
      try {
        this.rail.releasePointerCapture(this.pointerId);
      } catch {
        // Ignore capture state after pointercancel.
      }
    }
    this.pointerId = null;
    this.dragging = false;
    this.rail.classList.remove("qm-minimap-dragging");
    this.detachWindowPointerListeners();
    this.refreshScroll();
    this.scheduleAnchorRefresh();
  }

  private detachWindowPointerListeners(): void {
    const window = this.view.dom.ownerDocument.defaultView;
    window?.removeEventListener("pointermove", this.windowPointerMoveListener);
    window?.removeEventListener("pointerup", this.windowPointerUpListener);
    window?.removeEventListener("pointercancel", this.windowPointerUpListener);
  }

  private onWheel(event: WheelEvent): void {
    if (!isVisibleState(this.state)) {
      return;
    }
    const geometry = this.geometry;
    if (!geometry) {
      return;
    }
    event.preventDefault();
    let delta = event.deltaY;
    if (event.shiftKey && event.deltaX !== 0) {
      delta = event.deltaX;
    }
    if (event.deltaMode === 1) {
      delta *= 16;
    } else if (event.deltaMode === 2) {
      delta *= geometry.clientHeight;
    }
    const maxScroll = Math.max(0, geometry.scrollHeight - geometry.clientHeight);
    this.view.scrollDOM.scrollTop = clamp(
      this.view.scrollDOM.scrollTop + delta * WHEEL_STEP,
      0,
      maxScroll,
    );
  }
}

const MinimapViewPlugin = ViewPlugin.fromClass(MinimapController);

export function minimapExtension(options: MinimapOptions = {}): Extension {
  return [minimapTheme, minimapOptions.of(options), MinimapViewPlugin];
}
