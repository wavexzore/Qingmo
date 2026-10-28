import { syntaxTree } from "@codemirror/language";
import { StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

import { editorCopyChanged, editorUiCopy, type EditorUiCopy } from "../i18n";
import {
  currentMermaidTheme,
  MermaidRenderError,
  renderMermaid,
  type MermaidRenderErrorCode,
} from "./mermaid-render";
import { sanitizeMermaidSvg } from "./mermaid-sanitize";
import { diagramInfo } from "./mermaid-theme";
import { readDetailsBlocks } from "./details";
import { readFrontMatter } from "./frontmatter";
import type { MarkdownNode } from "./markdown-node";

/**
 * Above this size Mermaid fences keep their source treatment, matching the
 * table and math previews.
 */
export const MERMAID_BLOCK_MAX_UNITS = 200_000;

const MERMAID_ERROR_COPY: Record<MermaidRenderErrorCode, keyof EditorUiCopy["mermaid"]> = {
  unavailable: "unavailable",
  "ready-timeout": "readyTimeout",
  "render-timeout": "renderTimeout",
  "render-failed": "renderFailed",
  "unsafe-svg": "unsafeSvg",
  "invalid-svg": "invalidSvg",
};

export function mermaidErrorMessage(copy: EditorUiCopy, error: unknown): string {
  const code = error instanceof MermaidRenderError ? error.code : "render-failed";
  return copy.mermaid[MERMAID_ERROR_COPY[code]];
}

interface MermaidRange {
  from: number;
  to: number;
  code: string;
}

interface MermaidBlockState {
  ranges: readonly MermaidRange[];
  /** Blocks currently replaced by a widget; the planner skips their source. */
  blocked: readonly MermaidRange[];
  insideKey: string;
  decorations: DecorationSet;
}

function emptyState(): MermaidBlockState {
  return { ranges: [], blocked: [], insideKey: "", decorations: Decoration.none };
}

function selectionTouches(state: EditorState, range: { from: number; to: number }): boolean {
  return state.selection.ranges.some(
    (selection) => selection.from <= range.to && selection.to >= range.from,
  );
}

function insideKey(state: EditorState, ranges: readonly MermaidRange[]): string {
  return ranges
    .map((range, index) => (selectionTouches(state, range) ? index : ""))
    .filter((value) => value !== "")
    .join(",");
}

function directChild(node: MarkdownNode, name: string): MarkdownNode | null {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === name) {
      return child;
    }
  }
  return null;
}

/** Reads a top-level ```` ```mermaid ```` fence, ignoring nested examples. */
function readMermaidFence(doc: EditorState["doc"], node: MarkdownNode): MermaidRange | null {
  if (node.name !== "FencedCode" || node.parent?.name !== "Document") {
    return null;
  }
  const info = directChild(node, "CodeInfo");
  if (!info) {
    return null;
  }
  const language = doc.sliceString(info.from, info.to).trim().split(/\s+/)[0]?.toLowerCase();
  if (language !== "mermaid") {
    return null;
  }

  let code = "";
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "CodeText") {
      code += doc.sliceString(child.from, child.to);
    }
  }
  return code.trim() ? { from: node.from, to: node.to, code } : null;
}

function buildMermaidBlocks(state: EditorState): MermaidBlockState {
  if (state.doc.length > MERMAID_BLOCK_MAX_UNITS) {
    return emptyState();
  }

  const ranges: MermaidRange[] = [];
  const blocked: MermaidRange[] = [];
  const decorations: ReturnType<Decoration["range"]>[] = [];
  const copy = state.facet(editorUiCopy);
  const frontMatter = readFrontMatter(state.doc);
  const details = readDetailsBlocks(state);

  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== "FencedCode") {
        // Mermaid fences are rendered only at the document top level.
        return node.name === "Document";
      }
      if (
        (frontMatter && node.from >= frontMatter.from && node.to <= frontMatter.to) ||
        details.some((block) => node.from >= block.from && node.to <= block.to)
      ) {
        return false;
      }
      const range = readMermaidFence(state.doc, node.node as unknown as MarkdownNode);
      if (!range) {
        return false;
      }
      ranges.push(range);
      if (!selectionTouches(state, range)) {
        blocked.push(range);
        decorations.push(
          Decoration.replace({
            block: true,
            widget: new MermaidBlockWidget(copy, range.code, range.from, range.to),
          }).range(range.from, range.to),
        );
      }
      return false;
    },
  });

  return {
    ranges,
    blocked,
    insideKey: insideKey(state, ranges),
    decorations: decorations.length > 0 ? Decoration.set(decorations, true) : Decoration.none,
  };
}

/** Manual zoom floor: 1% keeps very large diagrams explorable as thumbnails. */
const MIN_MERMAID_SCALE = 0.01;
const MAX_MERMAID_SCALE = 2;
const MERMAID_SCALE_STEP = 0.1;
/**
 * Fitting a very wide diagram to the card can shrink its labels below a
 * readable size. Above this fit ratio the diagram keeps its natural width and
 * the canvas scrolls instead.
 */
const MERMAID_MIN_FIT_SCALE = 0.7;

function createTool(label: string, ariaLabel: string, extraClass = ""): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = extraClass ? `cm-md-mermaid-tool ${extraClass}` : "cm-md-mermaid-tool";
  button.textContent = label;
  button.title = ariaLabel;
  button.setAttribute("aria-label", ariaLabel);
  return button;
}

function createSkeleton(): HTMLElement {
  const skeleton = document.createElement("div");
  skeleton.className = "cm-md-mermaid-skeleton";
  skeleton.setAttribute("aria-hidden", "true");
  for (let index = 0; index < 3; index += 1) {
    const node = document.createElement("span");
    node.className = "cm-md-mermaid-skeleton-node";
    skeleton.append(node);
    if (index < 2) {
      const link = document.createElement("span");
      link.className = "cm-md-mermaid-skeleton-link";
      skeleton.append(link);
    }
  }
  return skeleton;
}

function createError(message: string, copy: EditorUiCopy, onEdit: () => void): HTMLElement {
  const box = document.createElement("div");
  box.className = "cm-md-mermaid-error";
  const text = document.createElement("span");
  text.className = "cm-md-mermaid-error-message";
  text.textContent = message;
  const edit = createTool(copy.mermaid.edit, copy.mermaid.editTitle, "cm-md-mermaid-edit");
  edit.addEventListener("mousedown", (event) => event.stopPropagation());
  edit.addEventListener("click", (event) => {
    event.stopPropagation();
    onEdit();
  });
  box.append(text, edit);
  return box;
}

function readNaturalWidth(svg: SVGSVGElement): number {
  const width = Number.parseFloat(svg.getAttribute("width") ?? "");
  if (Number.isFinite(width) && width > 0) {
    return width;
  }
  const viewBox = (svg.getAttribute("viewBox") ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const viewBoxWidth = viewBox[2];
  if (viewBox.length === 4 && viewBoxWidth !== undefined && viewBoxWidth > 0) {
    return viewBoxWidth;
  }
  return svg.getBoundingClientRect().width;
}

class MermaidBlockWidget extends WidgetType {
  private readonly teardowns = new WeakMap<HTMLElement, () => void>();

  constructor(
    private readonly copy: EditorUiCopy,
    private readonly code: string,
    private readonly from: number,
    private readonly to: number,
  ) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return (
      other instanceof MermaidBlockWidget &&
      other.copy.version === this.copy.version &&
      other.code === this.code &&
      other.from === this.from &&
      other.to === this.to
    );
  }

  override toDOM(view: EditorView): HTMLElement {
    const info = diagramInfo(this.code, this.copy);
    const wrapper = document.createElement("div");
    wrapper.className = "cm-md-mermaid";
    wrapper.tabIndex = 0;
    wrapper.setAttribute("role", "group");
    wrapper.setAttribute("aria-label", `Mermaid ${info.label}`);
    wrapper.dataset.mermaidKind = info.kind;

    const openSource = (): void => {
      view.dispatch({ selection: { anchor: this.from }, scrollIntoView: true });
      view.focus();
    };

    const head = document.createElement("div");
    head.className = "cm-md-mermaid-head";

    const title = document.createElement("div");
    title.className = "cm-md-mermaid-title";
    const icon = document.createElement("span");
    icon.className = "cm-md-mermaid-icon";
    icon.setAttribute("aria-hidden", "true");
    const badge = document.createElement("span");
    badge.className = "cm-md-mermaid-badge";
    badge.textContent = "MERMAID";
    const separator = document.createElement("span");
    separator.className = "cm-md-mermaid-sep";
    separator.textContent = "/";
    separator.setAttribute("aria-hidden", "true");
    const kind = document.createElement("span");
    kind.className = "cm-md-mermaid-kind";
    kind.textContent = info.label;
    title.append(icon, badge, separator, kind);

    const actions = document.createElement("div");
    actions.className = "cm-md-mermaid-actions";
    const hint = document.createElement("span");
    hint.className = "cm-md-mermaid-hint";
    hint.textContent = this.copy.mermaid.hintEdit;

    const tools = document.createElement("div");
    tools.className = "cm-md-mermaid-tools";
    const zoomOut = createTool("−", this.copy.mermaid.zoomOut);
    const zoomReset = createTool("100%", this.copy.mermaid.zoomReset);
    const zoomIn = createTool("+", this.copy.mermaid.zoomIn);
    const fitWidth = createTool(this.copy.mermaid.fitWidth, this.copy.mermaid.fitTitle);
    const source = createTool(this.copy.mermaid.source, this.copy.mermaid.sourceTitle);
    tools.append(zoomOut, zoomReset, zoomIn, fitWidth, source);
    actions.append(hint, tools);
    head.append(title, actions);

    const canvas = document.createElement("div");
    canvas.className = "cm-md-mermaid-canvas";
    const figure = document.createElement("div");
    figure.className = "cm-md-mermaid-figure";
    canvas.append(figure);
    wrapper.append(head, canvas);

    let generation = 0;
    let theme = currentMermaidTheme();
    let scale = 1;
    let fitMode = false;
    let naturalWidth = 0;
    /**
     * Diagram point (0–1 of the SVG width) kept under the viewport centre
     * while zooming. It survives clamped scroll offsets so an out-and-back
     * zoom returns to the same part of the diagram.
     */
    let zoomAnchor: number | null = null;
    let lastProgrammaticScroll: number | null = null;
    let suppressScrollSync = false;
    let revealedTopContent = false;

    const contentWidth = (): number => {
      if (canvas.clientWidth <= 0) {
        return naturalWidth;
      }
      const style = getComputedStyle(canvas);
      const left = Number.parseFloat(style.paddingLeft) || 0;
      const right = Number.parseFloat(style.paddingRight) || 0;
      return Math.max(1, canvas.clientWidth - left - right);
    };

    /**
     * Zooming only changes the SVG width, so the canvas scroll offset has to
     * be adjusted as well. Keeping the diagram point under the viewport
     * centre prevents "zoom in, zoom out, zoom in" from drifting into an
     * empty corner when the offset was clamped at a smaller scale.
     */
    const readZoomAnchor = (svg: SVGSVGElement): number => {
      const viewport = canvas.getBoundingClientRect();
      const box = svg.getBoundingClientRect();
      if (box.width <= 0) {
        return 0.5;
      }
      const offset = box.left - viewport.left + canvas.scrollLeft;
      const center = canvas.scrollLeft + canvas.clientWidth / 2;
      return Math.min(1, Math.max(0, (center - offset) / box.width));
    };

    const applyScale = (keepAnchor = false): void => {
      const svg = figure.querySelector("svg");
      if (!(svg instanceof SVGSVGElement)) {
        return;
      }
      if (!naturalWidth) {
        naturalWidth = readNaturalWidth(svg);
      }
      const available = contentWidth();
      if (naturalWidth <= 0 || available <= 0) {
        return;
      }
      if (keepAnchor) {
        // A pending scroll event from the user may not have fired yet, so
        // compare the current offset with the one we last wrote ourselves.
        const drifted =
          lastProgrammaticScroll !== null &&
          Math.abs(canvas.scrollLeft - lastProgrammaticScroll) > 1;
        if (zoomAnchor === null || drifted) {
          zoomAnchor = readZoomAnchor(svg);
        }
      }
      const anchor = keepAnchor ? zoomAnchor : null;
      // The fit control is only useful when the default 100% view overflows
      // because shrinking to the card would drop below the readability floor.
      const fitsReadably = available >= naturalWidth * MERMAID_MIN_FIT_SCALE;
      const canFit = naturalWidth > available + 0.5 && !fitsReadably;
      if (fitMode && !canFit) {
        fitMode = false;
        scale = 1;
      }
      if (fitMode) {
        scale = Math.min(1, available / naturalWidth);
      }
      zoomReset.textContent = `${Math.round(scale * 100)}%`;
      fitWidth.hidden = !canFit;
      fitWidth.classList.toggle("is-active", fitMode);
      zoomOut.disabled = fitMode || scale <= MIN_MERMAID_SCALE + 0.001;
      zoomIn.disabled = scale >= MAX_MERMAID_SCALE - 0.001;

      // Prefer a readable natural width over an arbitrarily tiny fit. Only
      // shrink to the card when the result stays above the readability floor.
      const baseWidth =
        naturalWidth <= available || fitsReadably
          ? Math.min(naturalWidth, available)
          : naturalWidth;
      const displayWidth = baseWidth * scale;
      svg.style.width = `${Math.round(displayWidth)}px`;
      svg.style.maxWidth = "none";
      figure.classList.toggle("is-zoomed", displayWidth > available + 0.5);

      if (anchor !== null) {
        const viewport = canvas.getBoundingClientRect();
        const box = svg.getBoundingClientRect();
        const offset = box.left - viewport.left + canvas.scrollLeft;
        const target = offset + anchor * box.width - canvas.clientWidth / 2;
        const max = Math.max(0, canvas.scrollWidth - canvas.clientWidth);
        const next = Math.min(max, Math.max(0, target));
        lastProgrammaticScroll = next;
        suppressScrollSync = true;
        canvas.scrollLeft = next;
        requestAnimationFrame(() => {
          suppressScrollSync = false;
        });
      }

      const overflows = canvas.scrollWidth > canvas.clientWidth + 1;
      hint.textContent = overflows ? this.copy.mermaid.hintScroll : this.copy.mermaid.hintEdit;
    };

    /**
     * Some large multi-component graphs start with a mostly empty top-left
     * band. On first paint, scroll horizontally to the topmost real node so
     * the card opens on diagram content instead of empty canvas.
     */
    const revealTopContent = (svg: SVGSVGElement): void => {
      if (revealedTopContent || fitMode || canvas.scrollLeft > 1) {
        return;
      }
      revealedTopContent = true;
      const viewport = canvas.getBoundingClientRect();
      const top = Math.max(viewport.top, 0);
      const bottom = Math.min(viewport.bottom, window.innerHeight);
      if (bottom <= top) {
        return;
      }
      let target: DOMRect | null = null;
      for (const node of Array.from(svg.querySelectorAll("g.node"))) {
        const box = node.getBoundingClientRect();
        if (box.width <= 0 || box.height <= 0 || box.bottom < top || box.top > bottom) {
          continue;
        }
        if (!target || box.top < target.top || (box.top === target.top && box.left < target.left)) {
          target = box;
        }
      }
      if (!target) {
        return;
      }
      const overlap = Math.min(target.right, viewport.right) - Math.max(target.left, viewport.left);
      if (overlap >= target.width * 0.8) {
        return;
      }
      const max = Math.max(0, canvas.scrollWidth - canvas.clientWidth);
      const next = Math.min(
        max,
        Math.max(
          0,
          canvas.scrollLeft +
            (target.left + target.width / 2) -
            (viewport.left + canvas.clientWidth / 2),
        ),
      );
      canvas.scrollLeft = next;
    };

    const changeScale = (delta: number): void => {
      const next = Math.round((scale + delta) * 10) / 10;
      fitMode = false;
      scale = Math.min(MAX_MERMAID_SCALE, Math.max(MIN_MERMAID_SCALE, next));
      applyScale(true);
    };

    const stop = (event: Event): void => event.stopPropagation();
    for (const button of [zoomOut, zoomReset, zoomIn, fitWidth, source]) {
      button.addEventListener("mousedown", stop);
      button.addEventListener("click", stop);
    }
    zoomOut.addEventListener("click", () => changeScale(-MERMAID_SCALE_STEP));
    zoomReset.addEventListener("click", () => {
      fitMode = false;
      scale = 1;
      applyScale(true);
    });
    zoomIn.addEventListener("click", () => changeScale(MERMAID_SCALE_STEP));
    fitWidth.addEventListener("click", () => {
      fitMode = true;
      zoomAnchor = 0.5;
      applyScale();
    });
    source.addEventListener("click", openSource);

    // A manual canvas scroll chooses a new zoom anchor; programmatic scrolls
    // from applyScale must not overwrite the anchor that produced them.
    const syncZoomAnchor = (): void => {
      if (suppressScrollSync) {
        return;
      }
      const svg = figure.querySelector("svg");
      if (svg instanceof SVGSVGElement) {
        zoomAnchor = readZoomAnchor(svg);
      }
    };
    canvas.addEventListener("scroll", syncZoomAnchor, { passive: true });

    const setKindState = (failed: boolean): void => {
      head.classList.toggle("is-error", failed);
      kind.textContent = failed ? this.copy.mermaid.renderFailed : info.label;
    };

    const paint = async (): Promise<void> => {
      const current = ++generation;
      const paintTheme = currentMermaidTheme();
      theme = paintTheme;
      const previous = figure.querySelector("svg");
      if (previous) {
        canvas.classList.add("is-refreshing");
      } else {
        figure.replaceChildren(createSkeleton());
        canvas.classList.remove("is-refreshing");
      }
      setKindState(false);

      try {
        const svg = await renderMermaid(this.code, paintTheme);
        if (!figure.isConnected || current !== generation) {
          return;
        }
        const sanitized = sanitizeMermaidSvg(svg);
        if (!sanitized) {
          throw new MermaidRenderError("unsafe-svg");
        }
        const parsed = new DOMParser().parseFromString(sanitized, "image/svg+xml");
        if (
          parsed.querySelector("parsererror") ||
          parsed.documentElement.localName.toLowerCase() !== "svg"
        ) {
          throw new MermaidRenderError("invalid-svg");
        }
        const imported = document.importNode(
          parsed.documentElement,
          true,
        ) as unknown as SVGSVGElement;
        figure.replaceChildren(imported);
        naturalWidth = readNaturalWidth(imported);
        applyScale();
        revealTopContent(imported);
        canvas.classList.remove("is-refreshing");
        wrapper.dataset.mermaidTheme = paintTheme;
        setKindState(false);
      } catch (error) {
        if (!figure.isConnected || current !== generation) {
          return;
        }
        figure.replaceChildren(
          createError(mermaidErrorMessage(this.copy, error), this.copy, openSource),
        );
        naturalWidth = 0;
        canvas.classList.remove("is-refreshing");
        delete wrapper.dataset.mermaidTheme;
        setKindState(true);
      }
    };

    const observer = new MutationObserver(() => {
      if (currentMermaidTheme() !== theme) {
        void paint();
      }
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            applyScale();
          });
    resizeObserver?.observe(canvas);
    this.teardowns.set(wrapper, () => {
      observer.disconnect();
      resizeObserver?.disconnect();
      canvas.removeEventListener("scroll", syncZoomAnchor);
    });

    void paint();
    return wrapper;
  }

  override destroy(dom: HTMLElement): void {
    this.teardowns.get(dom)?.();
    this.teardowns.delete(dom);
  }

  override ignoreEvent(): boolean {
    // The plate is a self-contained rendered artifact: clicking the diagram,
    // selecting its labels or dragging its zoomed scrollbar must not move the
    // editor selection into the fence and reveal the source. Only the explicit
    // “Source” button (or the error-state edit button) dispatches `openSource`.
    return true;
  }
}

export const mermaidBlockPreview = StateField.define<MermaidBlockState>({
  create: buildMermaidBlocks,
  update(value, transaction) {
    const treeChanged = syntaxTree(transaction.state) !== syntaxTree(transaction.startState);
    if (editorCopyChanged(transaction) || transaction.docChanged || treeChanged) {
      return buildMermaidBlocks(transaction.state);
    }

    if (!transaction.newSelection.eq(transaction.startState.selection)) {
      if (insideKey(transaction.state, value.ranges) !== value.insideKey) {
        return buildMermaidBlocks(transaction.state);
      }
    }

    return value;
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    EditorView.atomicRanges.of((view) => view.state.field(field).decorations),
  ],
});
