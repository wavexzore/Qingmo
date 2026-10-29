import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  search,
  SearchQuery,
  selectMatches,
  setSearchQuery,
} from "@codemirror/search";
import type { Extension } from "@codemirror/state";
import { runScopeHandlers, type EditorView, type Panel, type ViewUpdate } from "@codemirror/view";

import { editorUiCopy, type EditorUiCopy } from "../i18n";

const SVG_NS = "http://www.w3.org/2000/svg";

function svgIcon(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  return svg;
}

function strokeShape(doc: Document, tag: "path" | "circle" | "line"): SVGElement {
  const shape = doc.createElementNS(SVG_NS, tag);
  shape.setAttribute("stroke", "currentColor");
  shape.setAttribute("stroke-width", "1.3");
  shape.setAttribute("stroke-linecap", "round");
  shape.setAttribute("stroke-linejoin", "round");
  return shape;
}

function findIcon(doc: Document): SVGSVGElement {
  const svg = svgIcon(doc);
  const lens = strokeShape(doc, "circle");
  lens.setAttribute("cx", "7");
  lens.setAttribute("cy", "7");
  lens.setAttribute("r", "4.1");
  const handle = strokeShape(doc, "path");
  handle.setAttribute("d", "M10.2 10.2 13.3 13.3");
  svg.append(lens, handle);
  return svg;
}

function replaceIcon(doc: Document): SVGSVGElement {
  const svg = svgIcon(doc);
  const out = strokeShape(doc, "path");
  out.setAttribute("d", "M3.2 5.6h7.4m-2.2-2.2 2.2 2.2-2.2 2.2");
  const back = strokeShape(doc, "path");
  back.setAttribute("d", "M12.8 10.4H5.4m2.2 2.2-2.2-2.2 2.2-2.2");
  svg.append(out, back);
  return svg;
}

function chevronIcon(doc: Document, direction: "up" | "down"): SVGSVGElement {
  const svg = svgIcon(doc);
  const chevron = strokeShape(doc, "path");
  chevron.setAttribute("d", direction === "up" ? "M4.2 9.8 8 6l3.8 3.8" : "M4.2 6.2 8 10l3.8-3.8");
  svg.append(chevron);
  return svg;
}

function closeIcon(doc: Document): SVGSVGElement {
  const svg = svgIcon(doc);
  const first = strokeShape(doc, "path");
  first.setAttribute("d", "M4.3 4.3l7.4 7.4");
  const second = strokeShape(doc, "path");
  second.setAttribute("d", "M11.7 4.3l-7.4 7.4");
  svg.append(first, second);
  return svg;
}

function createButton(doc: Document, name: string, className: string): HTMLButtonElement {
  const button = doc.createElement("button");
  button.type = "button";
  button.name = name;
  button.className = className;
  // Keep the caret in the active text field while the pointer presses a
  // toolbar control. Keyboard focus still follows Tab as usual.
  button.addEventListener("mousedown", (event) => {
    event.preventDefault();
  });
  return button;
}

function createInput(doc: Document, name: string): HTMLInputElement {
  const input = doc.createElement("input");
  input.type = "text";
  input.name = name;
  input.className = "qm-search-input";
  input.autocomplete = "off";
  input.autocapitalize = "off";
  input.spellcheck = false;
  return input;
}

/**
 * A quiet, paper-coloured find bar. It keeps the keyboard contract of
 * CodeMirror's stock panel (Enter/Shift-Enter, Escape, Mod-f) while replacing
 * the browser-default controls with Qingmo's typography and semantic tokens.
 */
class QingmoSearchPanel implements Panel {
  readonly dom: HTMLElement;
  readonly top = true;

  private readonly view: EditorView;
  private readonly card: HTMLElement;
  private readonly replaceRow: HTMLElement;
  private readonly searchField: HTMLInputElement;
  private readonly replaceField: HTMLInputElement;
  private caseSensitive: boolean;
  private regexp: boolean;
  private wholeWord: boolean;
  private readonly previousButton: HTMLButtonElement;
  private readonly nextButton: HTMLButtonElement;
  private readonly selectAllButton: HTMLButtonElement;
  private readonly replaceButton: HTMLButtonElement;
  private readonly replaceAllButton: HTMLButtonElement;
  private readonly closeButton: HTMLButtonElement;

  private query: SearchQuery;
  private copy: EditorUiCopy;
  private composing = false;

  constructor(view: EditorView) {
    this.view = view;
    this.query = getSearchQuery(view.state);
    this.copy = view.state.facet(editorUiCopy);
    this.caseSensitive = this.query.caseSensitive;
    this.regexp = this.query.regexp;
    this.wholeWord = this.query.wholeWord;

    const doc = view.dom.ownerDocument;
    this.dom = doc.createElement("div");
    this.dom.className = "qm-search-panel";
    this.card = doc.createElement("div");
    this.card.className = "qm-search-card";
    this.card.setAttribute("role", "search");

    const findRow = doc.createElement("div");
    findRow.className = "qm-search-row qm-search-row-find";

    const findGlyph = doc.createElement("span");
    findGlyph.className = "qm-search-glyph";
    findGlyph.append(findIcon(doc));

    this.searchField = createInput(doc, "search");
    this.searchField.setAttribute("main-field", "true");
    this.searchField.value = this.query.search;

    const options = doc.createElement("div");
    options.className = "qm-search-options";

    const caseToggle = doc.createElement("button");
    caseToggle.type = "button";
    caseToggle.name = "case";
    caseToggle.className = "qm-search-toggle";
    caseToggle.textContent = "Aa";
    caseToggle.setAttribute("aria-pressed", String(this.caseSensitive));
    caseToggle.addEventListener("mousedown", (event) => {
      event.preventDefault();
    });
    caseToggle.addEventListener("click", () => {
      this.caseSensitive = !this.caseSensitive;
      caseToggle.setAttribute("aria-pressed", String(this.caseSensitive));
      this.commit();
    });

    const regexpToggle = doc.createElement("button");
    regexpToggle.type = "button";
    regexpToggle.name = "re";
    regexpToggle.className = "qm-search-toggle";
    regexpToggle.textContent = ".*";
    regexpToggle.setAttribute("aria-pressed", String(this.regexp));
    regexpToggle.addEventListener("mousedown", (event) => {
      event.preventDefault();
    });
    regexpToggle.addEventListener("click", () => {
      this.regexp = !this.regexp;
      regexpToggle.setAttribute("aria-pressed", String(this.regexp));
      this.commit();
    });

    const wordToggle = doc.createElement("button");
    wordToggle.type = "button";
    wordToggle.name = "word";
    wordToggle.className = "qm-search-toggle qm-search-toggle-word";
    wordToggle.textContent = "ab";
    wordToggle.setAttribute("aria-pressed", String(this.wholeWord));
    wordToggle.addEventListener("mousedown", (event) => {
      event.preventDefault();
    });
    wordToggle.addEventListener("click", () => {
      this.wholeWord = !this.wholeWord;
      wordToggle.setAttribute("aria-pressed", String(this.wholeWord));
      this.commit();
    });

    options.append(caseToggle, regexpToggle, wordToggle);

    this.selectAllButton = createButton(doc, "select", "qm-search-select");
    this.selectAllButton.addEventListener("click", () => {
      selectMatches(this.view);
    });

    const divider = doc.createElement("span");
    divider.className = "qm-search-divider";

    this.previousButton = createButton(doc, "prev", "qm-search-icon-button");
    this.previousButton.append(chevronIcon(doc, "up"));
    this.previousButton.addEventListener("click", () => {
      findPrevious(this.view);
    });

    this.nextButton = createButton(doc, "next", "qm-search-icon-button");
    this.nextButton.append(chevronIcon(doc, "down"));
    this.nextButton.addEventListener("click", () => {
      findNext(this.view);
    });

    this.closeButton = createButton(doc, "close", "qm-search-icon-button qm-search-close");
    this.closeButton.append(closeIcon(doc));
    this.closeButton.addEventListener("click", () => {
      closeSearchPanel(this.view);
      this.view.focus();
    });

    findRow.append(
      findGlyph,
      this.searchField,
      options,
      this.selectAllButton,
      divider,
      this.previousButton,
      this.nextButton,
      this.closeButton,
    );

    this.replaceRow = doc.createElement("div");
    this.replaceRow.className = "qm-search-row qm-search-row-replace";

    const replaceGlyph = doc.createElement("span");
    replaceGlyph.className = "qm-search-glyph qm-search-glyph-replace";
    replaceGlyph.append(replaceIcon(doc));

    this.replaceField = createInput(doc, "replace");
    this.replaceField.value = this.query.replace;

    const actions = doc.createElement("div");
    actions.className = "qm-search-actions";

    this.replaceButton = createButton(doc, "replace", "qm-search-action");
    this.replaceButton.addEventListener("click", () => {
      replaceNext(this.view);
    });

    this.replaceAllButton = createButton(
      doc,
      "replaceAll",
      "qm-search-action qm-search-action-primary",
    );
    this.replaceAllButton.addEventListener("click", () => {
      replaceAll(this.view);
    });

    actions.append(this.replaceButton, this.replaceAllButton);
    this.replaceRow.append(replaceGlyph, this.replaceField, actions);
    this.replaceRow.hidden = view.state.readOnly;

    this.card.append(findRow, this.replaceRow);
    this.dom.append(this.card);

    this.searchField.addEventListener("compositionstart", () => {
      this.composing = true;
    });
    this.searchField.addEventListener("compositionend", () => {
      this.composing = false;
      this.commit();
    });
    this.searchField.addEventListener("input", () => {
      if (!this.composing) {
        this.commit();
      }
    });
    this.replaceField.addEventListener("input", () => {
      this.commit();
    });

    this.dom.addEventListener("keydown", (event) => this.keydown(event));

    this.applyCopy();
  }

  private commit = (): void => {
    const query = new SearchQuery({
      search: this.searchField.value,
      caseSensitive: this.caseSensitive,
      regexp: this.regexp,
      wholeWord: this.wholeWord,
      replace: this.replaceField.value,
    });
    if (!query.eq(this.query)) {
      this.query = query;
      this.view.dispatch({ effects: setSearchQuery.of(query) });
    }
  };

  private keydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      closeSearchPanel(this.view);
      this.view.focus();
      return;
    }
    if (runScopeHandlers(this.view, event, "search-panel")) {
      event.preventDefault();
      return;
    }
    if (event.key !== "Enter") {
      return;
    }
    if (event.target !== this.searchField && event.target !== this.replaceField) {
      return;
    }
    event.preventDefault();
    if (event.target === this.replaceField) {
      replaceNext(this.view);
    } else if (event.shiftKey) {
      findPrevious(this.view);
    } else {
      findNext(this.view);
    }
  }

  private setQuery(query: SearchQuery): void {
    this.query = query;
    this.searchField.value = query.search;
    this.replaceField.value = query.replace;
    this.caseSensitive = query.caseSensitive;
    this.regexp = query.regexp;
    this.wholeWord = query.wholeWord;
    this.syncToggle("case", query.caseSensitive);
    this.syncToggle("re", query.regexp);
    this.syncToggle("word", query.wholeWord);
  }

  private syncToggle(name: string, pressed: boolean): void {
    const toggle = this.dom.querySelector<HTMLButtonElement>(`.qm-search-toggle[name="${name}"]`);
    toggle?.setAttribute("aria-pressed", String(pressed));
  }

  private applyCopy(): void {
    const { search } = this.copy;
    this.card.setAttribute("aria-label", search.find);
    this.searchField.placeholder = search.findPlaceholder;
    this.searchField.setAttribute("aria-label", search.find);
    this.replaceField.placeholder = search.replacePlaceholder;
    this.replaceField.setAttribute("aria-label", search.replace);
    this.previousButton.title = search.previous;
    this.previousButton.setAttribute("aria-label", search.previous);
    this.nextButton.title = search.next;
    this.nextButton.setAttribute("aria-label", search.next);
    this.selectAllButton.textContent = search.selectAll;
    this.selectAllButton.title = search.selectAll;
    this.selectAllButton.setAttribute("aria-label", search.selectAll);
    this.closeButton.title = search.close;
    this.closeButton.setAttribute("aria-label", search.close);
    this.replaceButton.textContent = search.replaceOne;
    this.replaceButton.title = search.replaceOne;
    this.replaceButton.setAttribute("aria-label", search.replaceOne);
    this.replaceAllButton.textContent = search.replaceAll;
    this.replaceAllButton.title = search.replaceAll;
    this.replaceAllButton.setAttribute("aria-label", search.replaceAll);

    const { matchCase, regexp, wholeWord } = search;
    const labels: Array<[string, string]> = [
      ["case", matchCase],
      ["re", regexp],
      ["word", wholeWord],
    ];
    for (const [name, label] of labels) {
      const toggle = this.dom.querySelector<HTMLButtonElement>(`.qm-search-toggle[name="${name}"]`);
      if (toggle) {
        toggle.title = label;
        toggle.setAttribute("aria-label", label);
      }
    }
  }

  mount(): void {
    this.searchField.focus();
    this.searchField.select();
  }

  update(update: ViewUpdate): void {
    const nextQuery = getSearchQuery(update.state);
    if (!nextQuery.eq(this.query)) {
      this.setQuery(nextQuery);
    }

    const nextCopy = update.state.facet(editorUiCopy);
    if (nextCopy.version !== this.copy.version) {
      this.copy = nextCopy;
      this.applyCopy();
    }

    this.replaceRow.hidden = update.state.readOnly;
  }
}

/** The app's search UI; the default panel is never rendered. */
export function qingmoSearch(): Extension {
  return search({
    top: true,
    createPanel: (view) => new QingmoSearchPanel(view),
  });
}
