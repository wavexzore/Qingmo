import { syntaxTree } from "@codemirror/language";
import { StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

import { readDetailsBlocks } from "./details";
import { readFrontMatter } from "./frontmatter";
import { renderInlineMarkdown } from "./inline-render";

/**
 * Definition lists are a Pandoc / Markdown Extra extension, not part of GFM.
 * They are detected only at the top level and only when the paragraph follows
 * the `Term\n: definition` shape.
 */
export const DEFINITION_LIST_MAX_UNITS = 200_000;

export interface DefinitionListData {
  terms: readonly string[];
  definitions: readonly string[];
}

/**
 * Parses one paragraph. A definition starts with `:` followed by whitespace;
 * indented lines extend the previous definition. Anything else invalidates the
 * paragraph, so ordinary prose is never converted by accident.
 */
export function parseDefinitionList(text: string): DefinitionListData | null {
  const lines = text.split("\n");
  const terms: string[] = [];
  const definitions: string[] = [];
  let inDefinitions = false;

  for (const line of lines) {
    const definition = /^\s*:\s+(.*)$/.exec(line);
    if (definition) {
      inDefinitions = true;
      const value = (definition[1] ?? "").trim();
      if (!value) {
        return null;
      }
      definitions.push(value);
      continue;
    }

    if (!inDefinitions) {
      const term = line.trim();
      if (term) {
        terms.push(term);
      }
      continue;
    }

    // Only indented continuation lines are allowed after the first definition.
    if (!/^\s{2,}\S/.test(line)) {
      return null;
    }
    const previous = definitions[definitions.length - 1] ?? "";
    definitions[definitions.length - 1] = `${previous} ${line.trim()}`.trim();
  }

  if (terms.length === 0 || definitions.length === 0) {
    return null;
  }
  return { terms, definitions };
}

interface DefinitionRange {
  from: number;
  to: number;
  data: DefinitionListData;
}

interface DefinitionListState {
  ranges: readonly DefinitionRange[];
  /** Definition sources always stay plain while editing. */
  blocked: readonly DefinitionRange[];
  insideKey: string;
  decorations: DecorationSet;
}

function emptyState(): DefinitionListState {
  return { ranges: [], blocked: [], insideKey: "", decorations: Decoration.none };
}

function selectionTouches(state: EditorState, range: { from: number; to: number }): boolean {
  return state.selection.ranges.some(
    (selection) => selection.from <= range.to && selection.to >= range.from,
  );
}

function insideKey(state: EditorState, ranges: readonly DefinitionRange[]): string {
  return ranges
    .map((range, index) => (selectionTouches(state, range) ? index : ""))
    .filter((value) => value !== "")
    .join(",");
}

function buildDefinitionLists(state: EditorState): DefinitionListState {
  if (state.doc.length > DEFINITION_LIST_MAX_UNITS) {
    return emptyState();
  }

  const ranges: DefinitionRange[] = [];
  const decorations: ReturnType<Decoration["range"]>[] = [];
  const frontMatter = readFrontMatter(state.doc);
  const details = readDetailsBlocks(state);

  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === "Document") {
        return true;
      }
      if (
        (frontMatter && node.from >= frontMatter.from && node.to <= frontMatter.to) ||
        details.some((block) => node.from >= block.from && node.to <= block.to)
      ) {
        return false;
      }
      if (node.name !== "Paragraph") {
        return false;
      }
      const syntaxNode = node.node;
      if (syntaxNode.parent?.name !== "Document") {
        return false;
      }
      const data = parseDefinitionList(state.doc.sliceString(node.from, node.to));
      if (!data) {
        return false;
      }
      const range: DefinitionRange = { from: node.from, to: node.to, data };
      ranges.push(range);
      if (!selectionTouches(state, range)) {
        decorations.push(
          Decoration.replace({
            block: true,
            widget: new DefinitionListWidget(data, range.from),
          }).range(range.from, range.to),
        );
      }
      return false;
    },
  });

  return {
    ranges,
    blocked: ranges,
    insideKey: insideKey(state, ranges),
    decorations: decorations.length > 0 ? Decoration.set(decorations, true) : Decoration.none,
  };
}

class DefinitionListWidget extends WidgetType {
  constructor(
    private readonly data: DefinitionListData,
    private readonly from: number,
  ) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return (
      other instanceof DefinitionListWidget &&
      other.from === this.from &&
      JSON.stringify(other.data) === JSON.stringify(this.data)
    );
  }

  override toDOM(view: EditorView): HTMLElement {
    const list = document.createElement("dl");
    list.className = "cm-md-definition-list";
    list.title = "点击编辑定义列表源码";

    list.addEventListener("mousedown", (event) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({ selection: { anchor: this.from }, scrollIntoView: true });
      view.focus();
    });

    const item = document.createElement("div");
    item.className = "cm-md-definition-item";

    const term = document.createElement("dt");
    term.className = "cm-md-definition-term";
    renderInlineMarkdown(term, this.data.terms.join(" / "));
    item.append(term);

    for (const definition of this.data.definitions) {
      const description = document.createElement("dd");
      description.className = "cm-md-definition-desc";
      renderInlineMarkdown(description, definition);
      item.append(description);
    }

    list.append(item);
    return list;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

export const definitionListPreview = StateField.define<DefinitionListState>({
  create: buildDefinitionLists,
  update(value, transaction) {
    const treeChanged = syntaxTree(transaction.state) !== syntaxTree(transaction.startState);
    if (transaction.docChanged || treeChanged) {
      return buildDefinitionLists(transaction.state);
    }

    if (!transaction.newSelection.eq(transaction.startState.selection)) {
      if (insideKey(transaction.state, value.ranges) !== value.insideKey) {
        return buildDefinitionLists(transaction.state);
      }
    }

    return value;
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    EditorView.atomicRanges.of((view) => view.state.field(field).decorations),
  ],
});
