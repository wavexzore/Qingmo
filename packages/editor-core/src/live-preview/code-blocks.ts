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
 * One entry in the language picker. `value` is written into the fence info
 * string; an empty value clears it and renders the block as plain text.
 */
interface LanguageChoice {
  value: string;
  label: string;
  /** Terms matched by the filter input (names, aliases and extensions). */
  terms: readonly string[];
  custom?: boolean;
}

const PLAIN_TEXT_TERMS = ["text", "plain", "plaintext", "txt", "none"] as const;

function languageChoices(plainText: string): LanguageChoice[] {
  const choices: LanguageChoice[] = [{ value: "", label: plainText, terms: PLAIN_TEXT_TERMS }];
  for (const description of codeLanguages) {
    const value = description.name.toLowerCase();
    choices.push({
      value,
      label: description.name,
      terms: [description.name, value, ...description.alias, ...description.extensions],
    });
  }
  for (const [value, label] of Object.entries(EXTERNAL_DIAGRAM_LANGUAGES)) {
    choices.push({ value, label, terms: [value, label.toLowerCase()] });
  }
  return choices;
}

/** Resolve a fence token (including aliases such as `js`) to a choice value. */
function languageChoiceValue(choices: readonly LanguageChoice[], token: string): string | null {
  const normalized = token.trim().toLowerCase();
  if (normalized === "") {
    return "";
  }
  const match = choices.find((choice) =>
    choice.terms.some((term) => term.trim().toLowerCase() === normalized),
  );
  return match ? match.value : null;
}

function updateLanguageLabel(handle: CodeBlockHandle): void {
  const value = handle.language || "text";
  const label = `${handle.copy.codeBlock.language}: ${value}`;
  handle.languageLabel.textContent = value;
  handle.languageButton.title = label;
  handle.languageButton.setAttribute("aria-label", label);
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
  picker: HTMLElement;
  languageButton: HTMLButtonElement;
  languageLabel: HTMLElement;
  languagePopover: HTMLElement;
  languageSearch: HTMLInputElement;
  languageList: HTMLElement;
  closeLanguage: (restoreFocus?: boolean) => void;
  titleNode: HTMLElement;
  externalNode: HTMLElement | null;
  copyButton: HTMLButtonElement;
  copyIcon: SVGSVGElement;
  copyCheck: SVGSVGElement;
  copyTimer: number | null;
  moreButton: HTMLButtonElement;
  copyItem: HTMLButtonElement;
  selectItem: HTMLButtonElement;
  cleanup: (() => void) | null;
}

const SVG_NS = "http://www.w3.org/2000/svg";

let languagePickerCount = 0;

function svgIcon(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  return svg;
}

function strokeShape(doc: Document, tag: "path" | "rect"): SVGElement {
  const shape = doc.createElementNS(SVG_NS, tag);
  shape.setAttribute("stroke", "currentColor");
  shape.setAttribute("stroke-width", "1.2");
  shape.setAttribute("stroke-linecap", "round");
  shape.setAttribute("stroke-linejoin", "round");
  return shape;
}

function createCopyIcon(doc: Document): SVGSVGElement {
  const svg = svgIcon(doc);
  const back = strokeShape(doc, "path");
  back.setAttribute("d", "M5.5 4.6V3.4c0-.5.4-.9.9-.9h6.2c.5 0 .9.4.9.9v6.2c0 .5-.4.9-.9.9h-1.2");
  const front = strokeShape(doc, "rect");
  front.setAttribute("x", "2.5");
  front.setAttribute("y", "5.5");
  front.setAttribute("width", "8");
  front.setAttribute("height", "8");
  front.setAttribute("rx", "1.2");
  svg.append(back, front);
  return svg;
}

function createCheckIcon(doc: Document): SVGSVGElement {
  const svg = svgIcon(doc);
  const check = strokeShape(doc, "path");
  check.setAttribute("d", "M3.2 8.3l3 3.1 6.6-7.1");
  check.setAttribute("stroke-width", "1.5");
  svg.append(check);
  return svg;
}

function createMoreIcon(doc: Document): SVGSVGElement {
  const svg = svgIcon(doc);
  for (const cy of ["3.2", "8", "12.8"]) {
    const dot = doc.createElementNS(SVG_NS, "circle");
    dot.setAttribute("cx", "8");
    dot.setAttribute("cy", cy);
    dot.setAttribute("r", "1.15");
    dot.setAttribute("fill", "currentColor");
    svg.append(dot);
  }
  return svg;
}

function createChevronIcon(doc: Document): SVGSVGElement {
  const svg = svgIcon(doc);
  svg.classList.add("cm-md-code-language-chevron");
  const chevron = strokeShape(doc, "path");
  chevron.setAttribute("d", "M4.2 6.4 8 10.2l3.8-3.8");
  chevron.setAttribute("stroke-width", "1.3");
  svg.append(chevron);
  return svg;
}

function actionButton(doc: Document, className: string, label: string): HTMLButtonElement {
  const button = doc.createElement("button");
  button.type = "button";
  button.className = `cm-md-code-action ${className}`;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.addEventListener("mousedown", (event) => {
    event.stopPropagation();
  });
  return button;
}

function menuItem(doc: Document, label: string): HTMLButtonElement {
  const button = doc.createElement("button");
  button.type = "button";
  button.className = "cm-md-code-menu-item";
  button.setAttribute("role", "menuitem");
  button.textContent = label;
  button.addEventListener("mousedown", (event) => {
    event.stopPropagation();
  });
  return button;
}

async function writeClipboard(text: string, doc: Document): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the legacy path when the webview denies clipboard
      // access (for example before the window has focus).
    }
  }

  const area = doc.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  doc.body.append(area);
  area.select();
  const copied = doc.execCommand("copy");
  area.remove();
  if (!copied) {
    throw new Error("clipboard copy was rejected");
  }
}

function resetCopy(handle: CodeBlockHandle): void {
  handle.copyTimer = null;
  handle.copyIcon.style.display = "";
  handle.copyCheck.style.display = "none";
  delete handle.copyButton.dataset.state;
  handle.copyButton.title = handle.copy.codeBlock.copy;
  handle.copyButton.setAttribute("aria-label", handle.copy.codeBlock.copy);
}

function flashCopy(handle: CodeBlockHandle, success: boolean): void {
  if (handle.destroyed) {
    return;
  }
  if (handle.copyTimer !== null) {
    window.clearTimeout(handle.copyTimer);
  }
  handle.copyIcon.style.display = success ? "none" : "";
  handle.copyCheck.style.display = success ? "" : "none";
  handle.copyButton.dataset.state = success ? "copied" : "failed";
  const label = success ? handle.copy.codeBlock.copied : handle.copy.codeBlock.copyFailed;
  handle.copyButton.title = label;
  handle.copyButton.setAttribute("aria-label", label);
  handle.copyTimer = window.setTimeout(() => resetCopy(handle), 1_500);
}

async function copyCode(handle: CodeBlockHandle): Promise<void> {
  try {
    await writeClipboard(handle.nested.state.doc.toString(), handle.dom.ownerDocument);
    flashCopy(handle, true);
  } catch {
    flashCopy(handle, false);
  }
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
    return Math.max(1, this.codeText.split("\n").length) * 26 + 84;
  }

  private get codeText(): string {
    return codeTextOf(this.source, this.code.openingLine.from, this.code);
  }

  override toDOM(outer: EditorView): HTMLElement {
    const doc = outer.dom.ownerDocument;
    const wrapper = doc.createElement("div");
    wrapper.className = "cm-md-code-block-widget";
    wrapper.dataset.codeFrom = String(this.code.openingLine.from);
    wrapper.dataset.blockGap = "";

    // The wrapper only carries the block's vertical rhythm (padding). CodeMirror
    // measures a block widget with getBoundingClientRect(), which excludes
    // margins, so spacing implemented as margin would desynchronise the height
    // map and shift click hit-testing for every line after the block.
    const card = doc.createElement("div");
    card.className = "cm-md-code-block-card";

    const header = doc.createElement("div");
    header.className = "cm-md-code-header";

    const dots = doc.createElement("span");
    dots.className = "cm-md-code-dots";
    dots.setAttribute("aria-hidden", "true");
    for (const tone of ["red", "yellow", "green"] as const) {
      const dot = doc.createElement("span");
      dot.className = `cm-md-code-dot cm-md-code-dot-${tone}`;
      dots.append(dot);
    }

    const title = doc.createElement("span");
    title.className = "cm-md-code-title";
    title.hidden = !this.code.title;
    title.textContent = this.code.title ?? "";

    const spacer = doc.createElement("span");
    spacer.className = "cm-md-code-header-spacer";

    const actions = doc.createElement("span");
    actions.className = "cm-md-code-actions";

    const picker = doc.createElement("span");
    picker.className = "cm-md-code-language-picker";

    const languageButton = doc.createElement("button");
    languageButton.type = "button";
    languageButton.className = "cm-md-code-language";
    languageButton.setAttribute("aria-haspopup", "listbox");
    languageButton.setAttribute("aria-expanded", "false");
    languageButton.disabled = this.readOnly;
    languageButton.tabIndex = this.readOnly ? -1 : 0;

    const languageLabel = doc.createElement("span");
    languageLabel.className = "cm-md-code-language-label";
    languageButton.append(languageLabel, createChevronIcon(doc));

    const languagePopover = doc.createElement("div");
    languagePopover.className = "cm-md-code-language-popover";
    languagePopover.hidden = true;

    const languageSearch = doc.createElement("input");
    languageSearch.type = "text";
    languageSearch.className = "cm-md-code-language-search";
    languageSearch.placeholder = this.copy.codeBlock.searchLanguage;
    languageSearch.setAttribute("aria-label", this.copy.codeBlock.searchLanguage);
    languageSearch.spellcheck = false;
    languageSearch.autocomplete = "off";
    languageSearch.setAttribute("role", "combobox");
    languageSearch.setAttribute("aria-expanded", "false");
    languageSearch.setAttribute("aria-autocomplete", "list");

    const languageList = doc.createElement("div");
    languageList.className = "cm-md-code-language-list";
    languageList.setAttribute("role", "listbox");
    languageList.setAttribute("aria-label", this.copy.codeBlock.language);

    const pickerId = `cm-md-code-language-${++languagePickerCount}`;
    languageList.id = `${pickerId}-list`;
    languageSearch.setAttribute("aria-controls", languageList.id);

    languagePopover.append(languageSearch, languageList);
    picker.append(languageButton, languagePopover);

    const copyButton = actionButton(doc, "cm-md-code-copy", this.copy.codeBlock.copy);
    const copyIcon = createCopyIcon(doc);
    copyIcon.classList.add("cm-md-code-copy-icon");
    const copyCheck = createCheckIcon(doc);
    copyCheck.classList.add("cm-md-code-copy-check");
    copyCheck.style.display = "none";
    copyButton.append(copyIcon, copyCheck);

    const moreButton = actionButton(doc, "cm-md-code-more", this.copy.codeBlock.more);
    moreButton.setAttribute("aria-haspopup", "menu");
    moreButton.setAttribute("aria-expanded", "false");
    moreButton.append(createMoreIcon(doc));

    const menu = doc.createElement("div");
    menu.className = "cm-md-code-menu";
    menu.setAttribute("role", "menu");
    menu.hidden = true;

    const copyItem = menuItem(doc, this.copy.codeBlock.copy);
    const selectItem = menuItem(doc, this.copy.codeBlock.selectAll);
    menu.append(copyItem, selectItem);

    actions.append(picker, copyButton, moreButton);
    header.append(dots, title, spacer, actions, menu);

    const editorHost = doc.createElement("div");
    editorHost.className = "cm-md-code-editor";
    card.append(header, editorHost);
    wrapper.append(card);

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
      picker,
      languageButton,
      languageLabel,
      languagePopover,
      languageSearch,
      languageList,
      closeLanguage: () => {},
      titleNode: title,
      externalNode: null,
      copyButton,
      copyIcon,
      copyCheck,
      copyTimer: null,
      moreButton,
      copyItem,
      selectItem,
      cleanup: null,
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

    let menuOpen = false;
    const closeMenu = (restoreFocus = false): void => {
      if (!menuOpen) {
        return;
      }
      menuOpen = false;
      menu.hidden = true;
      moreButton.setAttribute("aria-expanded", "false");
      if (restoreFocus) {
        moreButton.focus();
      }
    };
    const openMenu = (): void => {
      menuOpen = true;
      menu.hidden = false;
      moreButton.setAttribute("aria-expanded", "true");
      menu.querySelector<HTMLButtonElement>(".cm-md-code-menu-item")?.focus();
    };

    let languageOpen = false;
    let optionButtons: HTMLButtonElement[] = [];
    let optionChoices: LanguageChoice[] = [];
    let activeOption = 0;

    const setActiveOption = (index: number): void => {
      if (optionButtons.length === 0) {
        languageSearch.removeAttribute("aria-activedescendant");
        return;
      }
      const next = Math.max(0, Math.min(index, optionButtons.length - 1));
      optionButtons[activeOption]?.removeAttribute("data-active");
      activeOption = next;
      const option = optionButtons[next];
      if (!option) {
        return;
      }
      option.setAttribute("data-active", "true");
      languageSearch.setAttribute("aria-activedescendant", option.id);
      option.scrollIntoView?.({ block: "nearest" });
    };

    function closeLanguage(restoreFocus = false): void {
      if (!languageOpen) {
        return;
      }
      languageOpen = false;
      languagePopover.hidden = true;
      languageSearch.value = "";
      languageSearch.setAttribute("aria-expanded", "false");
      languageButton.setAttribute("aria-expanded", "false");
      if (restoreFocus) {
        languageButton.focus();
      }
    }
    handle.closeLanguage = closeLanguage;

    const applyChoice = (choice: LanguageChoice): void => {
      const current =
        languageChoiceValue(languageChoices(handle.copy.codeBlock.plainText), handle.language) ??
        handle.language.trim();
      closeLanguage();
      if (choice.value === current) {
        return;
      }
      commitLanguageValue(handle, choice.value);
    };

    const renderLanguageOptions = (): void => {
      const query = languageSearch.value.trim();
      const normalized = query.toLowerCase();
      const choices = languageChoices(handle.copy.codeBlock.plainText);
      const currentToken = handle.language.trim();
      const catalogValue = languageChoiceValue(choices, currentToken);
      if (currentToken && catalogValue === null) {
        choices.unshift({ value: currentToken, label: currentToken, terms: [currentToken] });
      }
      let visible = normalized
        ? choices.filter((choice) =>
            choice.terms.some((term) => term.toLowerCase().includes(normalized)),
          )
        : choices;
      if (
        normalized &&
        !choices.some((choice) =>
          choice.terms.some((term) => term.trim().toLowerCase() === normalized),
        )
      ) {
        visible = visible.concat({
          value: normalized.split(/\s+/)[0] ?? "",
          label: handle.copy.codeBlock.customLanguage(query),
          terms: [normalized],
          custom: true,
        });
      }

      const selectedToken = catalogValue ?? currentToken;
      optionChoices = visible;
      optionButtons = visible.map((choice, index) => {
        const option = doc.createElement("button");
        option.type = "button";
        option.id = `${pickerId}-option-${index}`;
        option.className = "cm-md-code-language-option";
        option.setAttribute("role", "option");
        option.setAttribute(
          "aria-selected",
          String(!choice.custom && choice.value === selectedToken),
        );
        option.tabIndex = -1;
        option.textContent = choice.label;
        option.addEventListener("mousedown", (event) => {
          event.stopPropagation();
        });
        option.addEventListener("click", () => {
          applyChoice(choice);
        });
        return option;
      });
      languageList.replaceChildren(...optionButtons);
      const selectedIndex = visible.findIndex(
        (choice) => !choice.custom && choice.value === selectedToken,
      );
      activeOption = 0;
      setActiveOption(selectedIndex >= 0 ? selectedIndex : 0);
    };

    const openLanguage = (): void => {
      if (languageOpen || handle.readOnly) {
        return;
      }
      languageOpen = true;
      languagePopover.hidden = false;
      languageSearch.setAttribute("aria-expanded", "true");
      languageButton.setAttribute("aria-expanded", "true");
      renderLanguageOptions();
      languageSearch.focus();
    };

    const onDocumentMouseDown = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (menuOpen && !menu.contains(target) && !moreButton.contains(target)) {
        closeMenu();
      }
      if (languageOpen && !picker.contains(target)) {
        closeLanguage();
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") {
        return;
      }
      if (languageOpen) {
        event.preventDefault();
        closeLanguage(true);
        return;
      }
      if (menuOpen) {
        event.preventDefault();
        closeMenu(true);
      }
    };
    doc.addEventListener("mousedown", onDocumentMouseDown, true);
    wrapper.addEventListener("keydown", onKeyDown);
    handle.cleanup = () => {
      doc.removeEventListener("mousedown", onDocumentMouseDown, true);
      wrapper.removeEventListener("keydown", onKeyDown);
      if (handle.copyTimer !== null) {
        window.clearTimeout(handle.copyTimer);
      }
    };

    copyButton.addEventListener("click", () => {
      void copyCode(handle);
      handle.nested.focus();
    });
    moreButton.addEventListener("click", (event) => {
      event.stopPropagation();
      if (menuOpen) {
        closeMenu(true);
      } else {
        openMenu();
      }
    });
    copyItem.addEventListener("click", () => {
      closeMenu();
      handle.nested.focus();
      void copyCode(handle);
    });
    selectItem.addEventListener("click", () => {
      closeMenu();
      handle.nested.focus();
      handle.nested.dispatch({
        selection: EditorSelection.single(0, handle.nested.state.doc.length),
      });
    });

    languageButton.addEventListener("mousedown", (event) => {
      event.stopPropagation();
    });
    languageButton.addEventListener("click", (event) => {
      event.stopPropagation();
      if (languageOpen) {
        closeLanguage();
      } else {
        openLanguage();
      }
    });
    languagePopover.addEventListener("mousedown", (event) => {
      event.stopPropagation();
    });
    languageSearch.addEventListener("input", () => {
      renderLanguageOptions();
    });
    languageSearch.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveOption(activeOption + 1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveOption(activeOption - 1);
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        setActiveOption(0);
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        setActiveOption(optionButtons.length - 1);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const choice = optionChoices[activeOption];
        if (choice) {
          applyChoice(choice);
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeLanguage(true);
        return;
      }
      if (event.key === "Tab") {
        closeLanguage();
      }
    });
    picker.addEventListener("focusout", (event) => {
      if (!languageOpen) {
        return;
      }
      const next = event.relatedTarget;
      if (next instanceof Node && picker.contains(next)) {
        return;
      }
      closeLanguage();
    });

    wrapper.addEventListener("mousedown", (event) => {
      if (event.target === wrapper || event.target === card || event.target === editorHost) {
        event.preventDefault();
        handle.nested.focus();
      }
    });

    updateLanguageLabel(handle);
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

    handle.languageSearch.placeholder = this.copy.codeBlock.searchLanguage;
    handle.languageSearch.setAttribute("aria-label", this.copy.codeBlock.searchLanguage);
    handle.languageList.setAttribute("aria-label", this.copy.codeBlock.language);
    handle.languageButton.disabled = this.readOnly;
    handle.languageButton.tabIndex = this.readOnly ? -1 : 0;
    if (this.readOnly) {
      handle.closeLanguage();
    }

    handle.copyItem.textContent = this.copy.codeBlock.copy;
    handle.selectItem.textContent = this.copy.codeBlock.selectAll;
    handle.moreButton.title = this.copy.codeBlock.more;
    handle.moreButton.setAttribute("aria-label", this.copy.codeBlock.more);
    if (!handle.copyButton.dataset.state) {
      handle.copyButton.title = this.copy.codeBlock.copy;
      handle.copyButton.setAttribute("aria-label", this.copy.codeBlock.copy);
    }

    applyLanguage(handle, this.code.language);
    updateLanguageLabel(handle);

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
    handle.cleanup?.();
    handle.cleanup = null;
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

function commitLanguageValue(handle: CodeBlockHandle, raw: string): void {
  if (handle.destroyed || handle.readOnly) {
    return;
  }
  const next = raw.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
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
  updateLanguageLabel(handle);
  updateInfo(handle);
}

function updateInfo(handle: CodeBlockHandle): void {
  const host = handle.picker.parentElement;
  if (!host) {
    return;
  }
  const external = EXTERNAL_DIAGRAM_LANGUAGES[handle.language.trim().toLowerCase()];
  if (external) {
    if (!handle.externalNode) {
      handle.externalNode = handle.dom.ownerDocument.createElement("span");
      handle.externalNode.className = "cm-md-code-external";
      host.insertBefore(handle.externalNode, handle.picker);
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
