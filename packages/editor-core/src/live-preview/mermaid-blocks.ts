import { syntaxTree } from "@codemirror/language";
import { StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

import { currentMermaidTheme, renderMermaid } from "./mermaid-render";
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
            widget: new MermaidBlockWidget(range.code, range.from, range.to),
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

const MIN_MERMAID_SCALE = 0.6;
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

function createError(message: string, onEdit: () => void): HTMLElement {
  const box = document.createElement("div");
  box.className = "cm-md-mermaid-error";
  const text = document.createElement("span");
  text.className = "cm-md-mermaid-error-message";
  text.textContent = message;
  const edit = createTool("编辑源码", "编辑 Mermaid 源码", "cm-md-mermaid-edit");
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
    private readonly code: string,
    private readonly from: number,
    private readonly to: number,
  ) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return (
      other instanceof MermaidBlockWidget &&
      other.code === this.code &&
      other.from === this.from &&
      other.to === this.to
    );
  }

  override toDOM(view: EditorView): HTMLElement {
    const info = diagramInfo(this.code);
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
    hint.textContent = "点击「源码」编辑";

    const tools = document.createElement("div");
    tools.className = "cm-md-mermaid-tools";
    const zoomOut = createTool("−", "缩小图表");
    const zoomReset = createTool("100%", "恢复 100%");
    const zoomIn = createTool("+", "放大图表");
    const fitWidth = createTool("适应", "适应画布宽度");
    const source = createTool("源码", "编辑 Mermaid 源码");
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

    const contentWidth = (): number => {
      if (canvas.clientWidth <= 0) {
        return naturalWidth;
      }
      const style = getComputedStyle(canvas);
      const left = Number.parseFloat(style.paddingLeft) || 0;
      const right = Number.parseFloat(style.paddingRight) || 0;
      return Math.max(1, canvas.clientWidth - left - right);
    };

    const applyScale = (): void => {
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

      const overflows = canvas.scrollWidth > canvas.clientWidth + 1;
      hint.textContent = overflows ? "可横向滚动查看" : "点击「源码」编辑";
    };

    const changeScale = (delta: number): void => {
      const next = Math.round((scale + delta) * 10) / 10;
      fitMode = false;
      scale = Math.min(MAX_MERMAID_SCALE, Math.max(MIN_MERMAID_SCALE, next));
      applyScale();
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
      applyScale();
    });
    zoomIn.addEventListener("click", () => changeScale(MERMAID_SCALE_STEP));
    fitWidth.addEventListener("click", () => {
      fitMode = true;
      applyScale();
    });
    source.addEventListener("click", openSource);

    const setKindState = (failed: boolean): void => {
      head.classList.toggle("is-error", failed);
      kind.textContent = failed ? "渲染失败" : info.label;
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
          throw new Error("图表内容未通过安全过滤");
        }
        const parsed = new DOMParser().parseFromString(sanitized, "image/svg+xml");
        if (
          parsed.querySelector("parsererror") ||
          parsed.documentElement.localName.toLowerCase() !== "svg"
        ) {
          throw new Error("图表 SVG 无效");
        }
        const imported = document.importNode(
          parsed.documentElement,
          true,
        ) as unknown as SVGSVGElement;
        figure.replaceChildren(imported);
        naturalWidth = readNaturalWidth(imported);
        applyScale();
        canvas.classList.remove("is-refreshing");
        wrapper.dataset.mermaidTheme = paintTheme;
        setKindState(false);
      } catch (error) {
        if (!figure.isConnected || current !== generation) {
          return;
        }
        const raw = error instanceof Error ? error.message : String(error);
        const message = raw.length > 500 ? `${raw.slice(0, 500)}…` : raw;
        figure.replaceChildren(createError(message, openSource));
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
    // 源码 button (or the error-state edit button) dispatches `openSource`.
    return true;
  }
}

export const mermaidBlockPreview = StateField.define<MermaidBlockState>({
  create: buildMermaidBlocks,
  update(value, transaction) {
    const treeChanged = syntaxTree(transaction.state) !== syntaxTree(transaction.startState);
    if (transaction.docChanged || treeChanged) {
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
