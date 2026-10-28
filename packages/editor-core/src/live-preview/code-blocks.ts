import { defaultKeymap, indentWithTab, redo, undo } from "@codemirror/commands";
import { LanguageDescription, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import {
  ChangeSet,
  Compartment,
  EditorSelection,
  EditorState,
  StateField,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  drawSelection,
  keymap,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";

import { codeLanguages } from "../extensions/languages";
import { qingmoHighlightStyle } from "../extensions/markdown";
import { selectionTextHighlight } from "../extensions/basic";
import { qingmoEditorTheme } from "../extensions/theme";
import { editorCopyChanged, editorUiCopy, type EditorUiCopy } from "../i18n";
import { readFencedCode, type ParsedFencedCode } from "./specs";
import type { MarkdownNode } from "./markdown-node";
import { EXTERNAL_DIAGRAM_LANGUAGES } from "./widgets";

/**
 * Above this size the code-block scan is disabled and top-level fences keep
 * their raw Markdown source. A document with hundreds of thousands of
 * characters does not benefit from mounting an embedded editor for every
 * fence.
 */
export const CODE_BLOCK_MAX_UNITS = 200_000;

export interface CodeBlockRange {
  from: number;
  to: number;
  codeFrom: number;
  codeTo: number;
}

interface CodeBlockState {
  ranges: readonly CodeBlockRange[];
  decorations: DecorationSet;
}

function emptyState(): CodeBlockState {
  return { ranges: [], decorations: Decoration.none };
}

function buildCodeBlocks(state: EditorState): CodeBlockState {
  if (state.doc.length > CODE_BLOCK_MAX_UNITS) {
    return emptyState();
  }

  const copy = state.facet(editorUiCopy);
  const ranges: CodeBlockRange[] = [];
  const decorations: ReturnType<Decoration["range"]>[] = [];

  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== "FencedCode") {
        return true;
      }
      // The embedded editor owns a self-contained rectangle. Block quotes and
      // list items need their marker/prefix preserved, so those fences keep
      // the line-based rendering from the decoration planner.
      if (node.node.parent?.name !== "Document") {
        return false;
      }
      const code = readFencedCode(state.doc, node.node as unknown as MarkdownNode);
      if (!code) {
        return false;
      }
      // Math and Mermaid fences have dedicated block renderers. Let those
      // fields own the range instead of mounting a code editor for them.
      const language = code.language.trim().toLowerCase();
      if (language === "math" || language === "latex" || language === "mermaid") {
        return false;
      }

      const from = code.openingLine.from;
      const to = code.closingLine.to;
      ranges.push({
        from,
        to,
        codeFrom: code.contentFrom,
        codeTo: code.contentTo,
      });
      decorations.push(
        Decoration.replace({
          block: true,
          widget: new CodeBlockWidget(copy, state.doc.sliceString(from, to), code, state.readOnly),
        }).range(from, to),
      );
      return false;
    },
  });

  return {
    ranges,
    decorations: decorations.length > 0 ? Decoration.set(decorations, true) : Decoration.none,
  };
}

function readOnlyExtensions(readOnly: boolean): readonly Extension[] {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
}

function makeCodeLineDecorations(
  state: EditorState,
  highlightLines: readonly number[],
  diff: boolean,
): DecorationSet {
  const decorations: ReturnType<Decoration["range"]>[] = [];
  for (let number = 1; number <= state.doc.lines; number += 1) {
    const line = state.doc.line(number);
    if (diff) {
      if (
        line.text.startsWith("+++") ||
        line.text.startsWith("---") ||
        line.text.startsWith("@@")
      ) {
        decorations.push(Decoration.line({ class: "cm-md-code-diff-meta" }).range(line.from));
      } else if (line.text.startsWith("+")) {
        decorations.push(Decoration.line({ class: "cm-md-code-diff-add" }).range(line.from));
      } else if (line.text.startsWith("-")) {
        decorations.push(Decoration.line({ class: "cm-md-code-diff-del" }).range(line.from));
      }
    }
    if (highlightLines.includes(number)) {
      decorations.push(Decoration.line({ class: "cm-md-code-highlight" }).range(line.from));
    }
  }
  return Decoration.set(decorations, true);
}

function codeLineHighlighter(highlightLines: readonly number[], diff: boolean): Extension {
  return StateField.define<DecorationSet>({
    create: (state) => makeCodeLineDecorations(state, highlightLines, diff),
    update(value, transaction) {
      if (!transaction.docChanged) {
        return value;
      }
      return makeCodeLineDecorations(transaction.state, highlightLines, diff);
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}

const nestedCodeTheme = EditorView.theme({
  "&": {
    height: "auto",
    backgroundColor: "transparent",
    fontSize: "inherit",
  },
  "&.cm-focused": {
    outline: "none",
  },
  ".cm-scroller": {
    fontFamily: "var(--qm-font-mono)",
    lineHeight: "1.75",
    overflow: "visible",
  },
  ".cm-content": {
    padding: "0",
    caretColor: "var(--qm-accent)",
  },
  ".cm-line": {
    padding: "0",
  },
  ".cm-gutters": {
    display: "none",
  },
  ".cm-activeLine": {
    backgroundColor: "transparent",
  },
});

/**
 * Keep the chip as snug as Typora's language label. `ch` follows the
 * monospace face, and the extra padding covers the input's inline padding and
 * border so short values such as `ts` are never clipped.
 */
function sizeLanguageChip(chip: HTMLInputElement): void {
  const length = chip.value.length;
  chip.size = Math.max(2, length);
  chip.style.width = length === 0 ? "6em" : `${Math.max(2.5, length + 1.8)}ch`;
}

/**
 * Mutable bridge shared by the widget instance and the embedded editor's
 * update listener. CodeMirror may keep the widget DOM across transactions
 * while creating a new WidgetType instance, so the listener cannot close over
 * a single widget object.
 */
interface CodeBlockHandle {
  outer: EditorView;
  dom: HTMLElement;
  nested: EditorView;
  from: number;
  to: number;
  codeFrom: number;
  codeTo: number;
  infoFrom: number;
  infoTo: number;
  language: string;
  title: string | null;
  highlightLines: readonly number[];
  readOnly: boolean;
  copy: EditorUiCopy;
  destroyed: boolean;
  syncing: boolean;
  languageRequest: number;
  languageCompartment: Compartment;
  readOnlyCompartment: Compartment;
  metaCompartment: Compartment;
  chip: HTMLInputElement;
  titleNode: HTMLElement;
  externalNode: HTMLElement | null;
}

async function loadLanguageSupport(language: string): Promise<Extension | null> {
  if (!language) {
    return null;
  }
  const description = LanguageDescription.matchLanguageName([...codeLanguages], language, true);
  if (!description) {
    return null;
  }
  try {
    return await description.load();
  } catch {
    return null;
  }
}

function applyLanguage(handle: CodeBlockHandle, language: string, force = false): void {
  if (!force && handle.language === language) {
    return;
  }
  handle.language = language;
  const request = ++handle.languageRequest;
  void loadLanguageSupport(language).then((support) => {
    if (handle.destroyed || handle.languageRequest !== request) {
      return;
    }
    handle.nested.dispatch({
      effects: handle.languageCompartment.reconfigure(support ?? []),
    });
  });
}

function codeTextOf(source: string, offset: number, code: ParsedFencedCode): string {
  return source.slice(code.contentFrom - offset, code.contentTo - offset);
}

class CodeBlockWidget extends WidgetType {
  constructor(
    private readonly copy: EditorUiCopy,
    private readonly source: string,
    private readonly code: ParsedFencedCode,
    private readonly readOnly: boolean,
  ) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return (
      other instanceof CodeBlockWidget &&
      other.copy.version === this.copy.version &&
      other.readOnly === this.readOnly &&
      other.source === this.source &&
      other.code.openingLine.from === this.code.openingLine.from
    );
  }

  override get estimatedHeight(): number {
    return Math.max(1, this.codeText.split("\n").length) * 26 + 48;
  }

  private get codeText(): string {
    return codeTextOf(this.source, this.code.openingLine.from, this.code);
  }

  override toDOM(outer: EditorView): HTMLElement {
    const doc = outer.dom.ownerDocument;
    const wrapper = doc.createElement("div");
    wrapper.className = "cm-md-code-block-widget";
    wrapper.dataset.codeFrom = String(this.code.openingLine.from);

    const editorHost = doc.createElement("div");
    editorHost.className = "cm-md-code-editor";
    wrapper.append(editorHost);

    const info = doc.createElement("div");
    info.className = "cm-md-code-info cm-md-code-info-floating";
    const chip = doc.createElement("input");
    chip.type = "text";
    chip.className = "cm-md-code-language";
    chip.value = this.code.language;
    chip.placeholder = this.copy.codeBlock.language;
    chip.setAttribute("aria-label", this.copy.codeBlock.language);
    chip.spellcheck = false;
    chip.autocapitalize = "off";
    chip.autocomplete = "off";
    chip.readOnly = this.readOnly;
    chip.tabIndex = this.readOnly ? -1 : 0;
    sizeLanguageChip(chip);
    info.append(chip);

    const title = doc.createElement("span");
    title.className = "cm-md-code-title";
    title.hidden = !this.code.title;
    title.textContent = this.code.title ?? "";
    info.append(title);
    wrapper.append(info);

    const handle: CodeBlockHandle = {
      outer,
      dom: wrapper,
      nested: null as unknown as EditorView,
      from: this.code.openingLine.from,
      to: this.code.closingLine.to,
      codeFrom: this.code.contentFrom,
      codeTo: this.code.contentTo,
      infoFrom: this.code.infoFrom,
      infoTo: this.code.infoTo,
      language: this.code.language,
      title: this.code.title,
      highlightLines: this.code.highlightLines,
      readOnly: this.readOnly,
      copy: this.copy,
      destroyed: false,
      syncing: false,
      languageRequest: 0,
      languageCompartment: new Compartment(),
      readOnlyCompartment: new Compartment(),
      metaCompartment: new Compartment(),
      chip,
      titleNode: title,
      externalNode: null,
    };
    (wrapper as unknown as { qingmoCodeBlock?: CodeBlockHandle }).qingmoCodeBlock = handle;

    const state = EditorState.create({
      doc: this.codeText,
      extensions: [
        EditorView.lineWrapping,
        qingmoEditorTheme,
        nestedCodeTheme,
        drawSelection(),
        selectionTextHighlight,
        syntaxHighlighting(qingmoHighlightStyle),
        handle.readOnlyCompartment.of(readOnlyExtensions(this.readOnly)),
        handle.languageCompartment.of([]),
        handle.metaCompartment.of(
          codeLineHighlighter(this.code.highlightLines, this.code.language === "diff"),
        ),
        keymap.of([
          {
            key: "Mod-z",
            preventDefault: true,
            run: () => undo(handle.outer),
          },
          {
            key: "Mod-Shift-z",
            preventDefault: true,
            run: () => redo(handle.outer),
          },
          {
            key: "Mod-y",
            preventDefault: true,
            run: () => redo(handle.outer),
          },
          {
            key: "ArrowUp",
            run: (view) => {
              if (view.state.selection.main.head !== 0) {
                return false;
              }
              return leaveBlock(handle, "before");
            },
          },
          {
            key: "ArrowDown",
            run: (view) => {
              if (view.state.selection.main.head !== view.state.doc.length) {
                return false;
              }
              return leaveBlock(handle, "after");
            },
          },
          indentWithTab,
          ...defaultKeymap,
        ]),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged || handle.syncing || handle.destroyed) {
            return;
          }
          // Forward the embedded editor's own ChangeSet instead of replacing
          // the whole code range. This keeps undo steps character-sized and
          // preserves composition updates exactly as they happened.
          syncToOuter(handle, update.changes);
        }),
      ],
    });
    handle.nested = new EditorView({ state, parent: editorHost });

    applyLanguage(handle, this.code.language, true);

    chip.addEventListener("mousedown", (event) => {
      event.stopPropagation();
    });
    chip.addEventListener("focus", () => {
      chip.select();
    });
    chip.addEventListener("input", () => {
      sizeLanguageChip(chip);
    });
    chip.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commitLanguage(handle);
        handle.nested.focus();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        chip.value = handle.language;
        sizeLanguageChip(chip);
        chip.blur();
      }
    });
    chip.addEventListener("blur", () => {
      commitLanguage(handle);
    });

    wrapper.addEventListener("mousedown", (event) => {
      if (event.target === wrapper || event.target === editorHost) {
        event.preventDefault();
        handle.nested.focus();
      }
    });

    updateInfo(handle);
    return wrapper;
  }

  override updateDOM(dom: HTMLElement, outer: EditorView): boolean {
    const handle = (dom as unknown as { qingmoCodeBlock?: CodeBlockHandle }).qingmoCodeBlock;
    if (!handle || handle.destroyed) {
      return false;
    }

    const previousLanguage = handle.language;
    const previousHighlights = handle.highlightLines.join(",");

    handle.outer = outer;
    handle.from = this.code.openingLine.from;
    handle.to = this.code.closingLine.to;
    handle.codeFrom = this.code.contentFrom;
    handle.codeTo = this.code.contentTo;
    handle.infoFrom = this.code.infoFrom;
    handle.infoTo = this.code.infoTo;
    handle.title = this.code.title;
    handle.copy = this.copy;
    handle.highlightLines = this.code.highlightLines;
    dom.dataset.codeFrom = String(this.code.openingLine.from);

    if (dom.ownerDocument.activeElement !== handle.chip) {
      if (handle.chip.value !== this.code.language) {
        handle.chip.value = this.code.language;
        sizeLanguageChip(handle.chip);
      }
    }
    handle.chip.readOnly = this.readOnly;
    handle.chip.tabIndex = this.readOnly ? -1 : 0;
    handle.chip.placeholder = this.copy.codeBlock.language;
    handle.chip.setAttribute("aria-label", this.copy.codeBlock.language);

    applyLanguage(handle, this.code.language);

    if (handle.readOnly !== this.readOnly) {
      handle.readOnly = this.readOnly;
      handle.nested.dispatch({
        effects: handle.readOnlyCompartment.reconfigure(readOnlyExtensions(this.readOnly)),
      });
    }

    if (
      previousHighlights !== this.code.highlightLines.join(",") ||
      previousLanguage !== this.code.language
    ) {
      handle.nested.dispatch({
        effects: handle.metaCompartment.reconfigure(
          codeLineHighlighter(this.code.highlightLines, this.code.language === "diff"),
        ),
      });
    }

    const codeText = this.codeText;
    if (handle.nested.state.doc.toString() !== codeText) {
      const changes = ChangeSet.of(
        { from: 0, to: handle.nested.state.doc.length, insert: codeText },
        handle.nested.state.doc.length,
      );
      const selection = handle.nested.state.selection.main;
      handle.syncing = true;
      handle.nested.dispatch({
        changes,
        selection: EditorSelection.single(
          changes.mapPos(selection.anchor, 1),
          changes.mapPos(selection.head, 1),
        ),
      });
      handle.syncing = false;
    }

    handle.titleNode.textContent = this.code.title ?? "";
    handle.titleNode.hidden = !this.code.title;
    updateInfo(handle);
    return true;
  }

  override destroy(dom: HTMLElement): void {
    const handle = (dom as unknown as { qingmoCodeBlock?: CodeBlockHandle }).qingmoCodeBlock;
    if (!handle) {
      return;
    }
    const hadFocus = dom.contains(dom.ownerDocument.activeElement);
    handle.destroyed = true;
    handle.nested.destroy();
    if (hadFocus) {
      queueMicrotask(() => {
        if (handle.outer.dom.isConnected) {
          handle.outer.focus();
        }
      });
    }
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

function syncToOuter(handle: CodeBlockHandle, changes: ChangeSet): void {
  const mapped: { from: number; to: number; insert: string }[] = [];
  let delta = 0;
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    mapped.push({
      from: handle.codeFrom + fromA,
      to: handle.codeFrom + toA,
      insert: inserted.toString(),
    });
    delta += inserted.length - (toA - fromA);
  });
  if (mapped.length === 0) {
    return;
  }

  // Update the bridge before dispatching. CodeMirror may reuse the widget DOM
  // synchronously during the dispatch; keeping the ranges current prevents a
  // fast second keystroke from writing to a stale offset.
  handle.codeTo += delta;
  handle.to += delta;
  handle.syncing = true;
  handle.outer.dispatch({
    changes: mapped,
    userEvent: "input.type",
    scrollIntoView: false,
  });
  handle.syncing = false;
}

function leaveBlock(handle: CodeBlockHandle, direction: "before" | "after"): boolean {
  const doc = handle.outer.state.doc;
  if (direction === "after") {
    if (handle.to >= doc.length) {
      return false;
    }
    handle.outer.focus();
    handle.outer.dispatch({
      selection: { anchor: Math.min(handle.to + 1, doc.length) },
    });
    return true;
  }
  if (handle.from <= 0) {
    return false;
  }
  handle.outer.focus();
  handle.outer.dispatch({ selection: { anchor: handle.from - 1 } });
  return true;
}

function commitLanguage(handle: CodeBlockHandle): void {
  if (handle.destroyed || handle.readOnly) {
    return;
  }
  const next = handle.chip.value.trim().split(/\s+/)[0] ?? "";
  if (next === handle.language) {
    return;
  }

  const doc = handle.outer.state.doc;
  // When the fence has no language yet, insert the token at the info-string
  // start. A following title/highlight attribute needs a separating space.
  const following =
    handle.infoTo > handle.infoFrom
      ? ""
      : doc.sliceString(handle.infoFrom, Math.min(handle.infoFrom + 1, doc.length));
  const separator = next && following && !/^\s/.test(following) ? " " : "";

  handle.outer.dispatch({
    changes: {
      from: handle.infoFrom,
      to: handle.infoTo,
      insert: `${next}${separator}`,
    },
    userEvent: "input.type",
    scrollIntoView: false,
  });
  handle.language = next;
  handle.infoTo = handle.infoFrom + next.length;
  handle.chip.value = next;
  sizeLanguageChip(handle.chip);
  updateInfo(handle);
}

function updateInfo(handle: CodeBlockHandle): void {
  const info = handle.chip.parentElement;
  if (!info) {
    return;
  }
  const external = EXTERNAL_DIAGRAM_LANGUAGES[handle.language.trim().toLowerCase()];
  if (external) {
    if (!handle.externalNode) {
      handle.externalNode = handle.dom.ownerDocument.createElement("span");
      handle.externalNode.className = "cm-md-code-external";
      info.append(handle.externalNode);
    }
    handle.externalNode.textContent = handle.copy.widgets.externalRender;
    handle.externalNode.title = handle.copy.widgets.externalRenderHint(external);
  } else if (handle.externalNode) {
    handle.externalNode.remove();
    handle.externalNode = null;
  }
}

export const codeBlockPreview = StateField.define<CodeBlockState>({
  create: buildCodeBlocks,
  update(value, transaction) {
    const treeChanged = syntaxTree(transaction.state) !== syntaxTree(transaction.startState);
    const readOnlyChanged = transaction.startState.readOnly !== transaction.state.readOnly;
    if (
      editorCopyChanged(transaction) ||
      transaction.docChanged ||
      treeChanged ||
      readOnlyChanged
    ) {
      return buildCodeBlocks(transaction.state);
    }
    return value;
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    EditorView.atomicRanges.of((view) => view.state.field(field).decorations),
  ],
});

/**
 * A code block is a single atomic widget, so an external selection (search,
 * go-to-line, restored session) can land inside its hidden source. Hand that
 * selection to the embedded editor instead of leaving an invisible caret in
 * the Markdown text.
 */
export const codeBlockSelectionGuard = ViewPlugin.fromClass(
  class {
    private destroyed = false;

    constructor(private readonly view: EditorView) {
      this.view.dom.addEventListener("focusin", this.handleFocusIn);
    }

    destroy(): void {
      this.destroyed = true;
      this.view.dom.removeEventListener("focusin", this.handleFocusIn);
    }

    update(update: ViewUpdate): void {
      if (!update.selectionSet || update.docChanged) {
        return;
      }
      const field = update.state.field(codeBlockPreview, false);
      if (!field) {
        return;
      }
      const selection = update.state.selection.main;
      const block = field.ranges.find(
        (range) => selection.head >= range.from && selection.head <= range.to,
      );
      if (!block) {
        return;
      }
      queueMicrotask(() => this.focusBlock(block));
    }

    private readonly handleFocusIn = (event: FocusEvent): void => {
      if (event.target !== this.view.contentDOM) {
        return;
      }
      const field = this.view.state.field(codeBlockPreview, false);
      const selection = this.view.state.selection.main;
      const block = field?.ranges.find(
        (range) => selection.head >= range.from && selection.head <= range.to,
      );
      if (block) {
        this.focusBlock(block);
      }
    };

    private focusBlock(block: CodeBlockRange): void {
      if (this.destroyed) {
        return;
      }
      const active = this.view.dom.ownerDocument.activeElement;
      // The find panel keeps keyboard focus while stepping through matches.
      if (active instanceof HTMLElement && active.closest(".cm-search")) {
        return;
      }
      const field = this.view.state.field(codeBlockPreview, false);
      const selection = this.view.state.selection.main;
      const current = field?.ranges.find(
        (range) => selection.head >= range.from && selection.head <= range.to,
      );
      if (!current || current.from !== block.from) {
        return;
      }
      const dom = this.view.dom.querySelector<HTMLElement>(
        `.cm-md-code-block-widget[data-code-from="${current.from}"]`,
      );
      if (!dom) {
        return;
      }
      const editor = dom.querySelector<HTMLElement>(".cm-editor");
      const nested = editor ? EditorView.findFromDOM(editor) : null;
      if (!nested) {
        return;
      }
      if (dom.contains(active)) {
        return;
      }
      const from = Math.max(
        0,
        Math.min(nested.state.doc.length, selection.from - current.codeFrom),
      );
      const to = Math.max(from, Math.min(nested.state.doc.length, selection.to - current.codeFrom));
      nested.focus();
      nested.dispatch({ selection: EditorSelection.single(from, to) });
    }
  },
);
