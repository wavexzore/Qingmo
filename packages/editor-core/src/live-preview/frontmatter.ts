import { StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

import { editorCopyChanged, editorUiCopy, type EditorUiCopy } from "../i18n";

/**
 * Front matter is metadata, not prose. Very large documents should not pay for
 * the top-of-file scan on every keystroke.
 */
export const FRONTMATTER_MAX_UNITS = 200_000;

const MAX_SCAN_LINES = 2_000;
const MAX_DISPLAY_ENTRIES = 24;

export type FrontMatterFormat = "yaml" | "toml" | "json";

export interface FrontMatterEntry {
  key: string;
  values: readonly string[];
}

export interface ParsedFrontMatter {
  from: number;
  to: number;
  format: FrontMatterFormat;
  raw: string;
  body: string;
  entries: readonly FrontMatterEntry[];
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((item) => unquote(item))
      .filter((item) => item.length > 0)
      .join(", ");
  }
  return trimmed;
}

function parseEntries(body: string, format: FrontMatterFormat): FrontMatterEntry[] {
  const entries: FrontMatterEntry[] = [];
  let current: { key: string; values: string[] } | null = null;

  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const pair =
      format === "yaml"
        ? /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line)
        : /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    if (pair) {
      current = { key: pair[1] ?? "", values: [] };
      const value = unquote(pair[2] ?? "");
      if (value) {
        current.values.push(value);
      }
      entries.push(current);
      continue;
    }

    if (!current) {
      continue;
    }
    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem) {
      const value = unquote(listItem[1] ?? "");
      if (value) {
        current.values.push(value);
      }
      continue;
    }
    current.values.push(unquote(trimmed));
  }

  return entries;
}

function parseJsonEntries(raw: string): FrontMatterEntry[] | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  return Object.entries(data).map(([key, value]) => {
    if (Array.isArray(value)) {
      return {
        key,
        values: value.map((item) => (typeof item === "string" ? item : JSON.stringify(item))),
      };
    }
    if (value === null) {
      return { key, values: ["null"] };
    }
    if (typeof value === "object") {
      return { key, values: [JSON.stringify(value)] };
    }
    return { key, values: [String(value)] };
  });
}

/**
 * Reads a YAML (`---`), TOML (`+++`) or JSON (`{` … `}`) block only when it
 * starts on line 1. The closing delimiter must be in the first 2000 lines,
 * which mirrors how Obsidian and most static-site editors detect front matter.
 */
export function readFrontMatter(doc: EditorState["doc"]): ParsedFrontMatter | null {
  if (doc.length === 0) {
    return null;
  }
  const first = doc.line(1);
  const opening = first.text.trim();
  const format: FrontMatterFormat | null =
    opening === "---" ? "yaml" : opening === "+++" ? "toml" : opening === "{" ? "json" : null;
  if (!format) {
    return null;
  }

  const lastLine = Math.min(doc.lines, MAX_SCAN_LINES);
  for (let lineNumber = 2; lineNumber <= lastLine; lineNumber += 1) {
    const line = doc.line(lineNumber);
    const text = line.text.trim();
    const closing =
      format === "yaml"
        ? text === "---" || text === "..."
        : format === "toml"
          ? text === "+++"
          : text === "}";
    if (!closing) {
      continue;
    }
    const body = doc.sliceString(first.to, line.from);
    if (format === "json") {
      const entries = parseJsonEntries(doc.sliceString(first.from, line.to));
      if (!entries) {
        return null;
      }
      return {
        from: first.from,
        to: line.to,
        format,
        raw: doc.sliceString(first.from, line.to),
        body,
        entries,
      };
    }
    const entries = parseEntries(body, format);
    // A pair of horizontal rules around ordinary prose must not be mistaken
    // for metadata. Empty blocks are still valid.
    if (body.trim() && entries.length === 0) {
      return null;
    }
    return {
      from: first.from,
      to: line.to,
      format,
      raw: doc.sliceString(first.from, line.to),
      body,
      entries,
    };
  }
  return null;
}

function selectionTouches(state: EditorState, range: { from: number; to: number }): boolean {
  return state.selection.ranges.some(
    (selection) => selection.from <= range.to && selection.to >= range.from,
  );
}

interface FrontMatterState {
  data: ParsedFrontMatter | null;
  /** The replaced source range; the planner skips all decorations inside it. */
  blocked: readonly { from: number; to: number }[];
  inside: boolean;
  decorations: DecorationSet;
}

function emptyState(): FrontMatterState {
  return { data: null, blocked: [], inside: false, decorations: Decoration.none };
}

function buildFrontMatter(state: EditorState): FrontMatterState {
  if (state.doc.length > FRONTMATTER_MAX_UNITS) {
    return emptyState();
  }
  const data = readFrontMatter(state.doc);
  if (!data) {
    return emptyState();
  }
  const inside = selectionTouches(state, data);
  const blocked = [{ from: data.from, to: data.to }];
  if (inside) {
    // Keep the metadata as plain source while editing it: the delimiters must
    // not turn into horizontal-rule widgets and YAML lines must not be styled
    // as prose.
    return { data, blocked, inside, decorations: Decoration.none };
  }
  const copy = state.facet(editorUiCopy);
  return {
    data,
    blocked,
    inside,
    decorations: Decoration.set([
      Decoration.replace({
        block: true,
        widget: new FrontMatterWidget(copy, data),
      }).range(data.from, data.to),
    ]),
  };
}

function addCell(parent: HTMLElement, className: string, text: string): void {
  const cell = document.createElement("span");
  cell.className = className;
  cell.textContent = text;
  parent.append(cell);
}

class FrontMatterWidget extends WidgetType {
  constructor(
    private readonly copy: EditorUiCopy,
    private readonly data: ParsedFrontMatter,
  ) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return (
      other instanceof FrontMatterWidget &&
      other.copy.version === this.copy.version &&
      other.data.raw === this.data.raw
    );
  }

  override toDOM(view: EditorView): HTMLElement {
    const card = document.createElement("div");
    card.className = "cm-md-frontmatter";
    card.title = this.copy.frontmatter.wrapperTitle;

    card.addEventListener("mousedown", (event) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({ selection: { anchor: this.data.from }, scrollIntoView: true });
      view.focus();
    });

    const header = document.createElement("div");
    header.className = "cm-md-frontmatter-header";
    addCell(header, "cm-md-frontmatter-title", this.copy.frontmatter.title);
    addCell(header, "cm-md-frontmatter-badge", this.data.format.toUpperCase());
    addCell(
      header,
      "cm-md-frontmatter-count",
      this.copy.frontmatter.entries(this.data.entries.length),
    );
    card.append(header);

    if (this.data.entries.length === 0) {
      const body = this.data.body.trim();
      if (body) {
        const raw = document.createElement("pre");
        raw.className = "cm-md-frontmatter-raw";
        raw.textContent = body;
        card.append(raw);
      } else {
        addCell(card, "cm-md-frontmatter-empty", this.copy.frontmatter.empty);
      }
      return card;
    }

    const grid = document.createElement("div");
    grid.className = "cm-md-frontmatter-grid";
    for (const entry of this.data.entries.slice(0, MAX_DISPLAY_ENTRIES)) {
      const row = document.createElement("div");
      row.className = "cm-md-frontmatter-row";
      addCell(row, "cm-md-frontmatter-key", entry.key);
      addCell(
        row,
        "cm-md-frontmatter-value",
        entry.values.length > 0 ? entry.values.join(", ") : "—",
      );
      grid.append(row);
    }
    card.append(grid);

    const hidden = this.data.entries.length - MAX_DISPLAY_ENTRIES;
    if (hidden > 0) {
      addCell(card, "cm-md-frontmatter-more", this.copy.frontmatter.more(hidden));
    }
    return card;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

export const frontMatterPreview = StateField.define<FrontMatterState>({
  create: buildFrontMatter,
  update(value, transaction) {
    if (editorCopyChanged(transaction) || transaction.docChanged) {
      return buildFrontMatter(transaction.state);
    }
    if (!transaction.newSelection.eq(transaction.startState.selection)) {
      const inside = value.data ? selectionTouches(transaction.state, value.data) : false;
      if (inside !== value.inside) {
        return buildFrontMatter(transaction.state);
      }
    }
    return value;
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    EditorView.atomicRanges.of((view) => view.state.field(field).decorations),
  ],
});
