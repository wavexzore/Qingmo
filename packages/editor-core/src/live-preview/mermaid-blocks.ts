import { syntaxTree } from "@codemirror/language";
import { StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

import { currentMermaidTheme, renderMermaid } from "./mermaid-render";
import { sanitizeMermaidSvg } from "./mermaid-sanitize";
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

function statusElement(text: string, className: string): HTMLElement {
  const element = document.createElement("div");
  element.className = className;
  element.textContent = text;
  return element;
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
    const wrapper = document.createElement("div");
    wrapper.className = "cm-md-mermaid";
    wrapper.title = "点击编辑 Mermaid 源码";
    wrapper.setAttribute("role", "img");
    wrapper.setAttribute("aria-label", "Mermaid 图表");

    wrapper.addEventListener("mousedown", (event) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({ selection: { anchor: this.from }, scrollIntoView: true });
      view.focus();
    });

    const body = document.createElement("div");
    body.className = "cm-md-mermaid-body";
    wrapper.append(body);

    let generation = 0;
    let theme = currentMermaidTheme();

    const paint = async (): Promise<void> => {
      const current = ++generation;
      body.replaceChildren(statusElement("正在渲染图表…", "cm-md-mermaid-status"));
      const paintTheme = currentMermaidTheme();
      theme = paintTheme;

      try {
        const svg = await renderMermaid(this.code, paintTheme);
        if (!body.isConnected || current !== generation) {
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
        body.replaceChildren(document.importNode(parsed.documentElement, true));
        wrapper.dataset.mermaidTheme = paintTheme;
      } catch (error) {
        if (!body.isConnected || current !== generation) {
          return;
        }
        const raw = error instanceof Error ? error.message : String(error);
        const message = raw.length > 500 ? `${raw.slice(0, 500)}…` : raw;
        delete wrapper.dataset.mermaidTheme;
        body.replaceChildren(statusElement(`Mermaid 渲染失败：${message}`, "cm-md-mermaid-error"));
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
    this.teardowns.set(wrapper, () => observer.disconnect());

    void paint();
    return wrapper;
  }

  override destroy(dom: HTMLElement): void {
    this.teardowns.get(dom)?.();
    this.teardowns.delete(dom);
  }

  override ignoreEvent(): boolean {
    return false;
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
