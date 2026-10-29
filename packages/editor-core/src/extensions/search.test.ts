import { getSearchQuery, openSearchPanel } from "@codemirror/search";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_EDITOR_UI_COPY,
  createEditorState,
  setEditorUiCopyEffect,
  type EditorUiCopy,
} from "../index";

const SEARCH_COPY: EditorUiCopy = {
  ...DEFAULT_EDITOR_UI_COPY,
  version: "test:search:1",
  language: "zh-CN",
  search: {
    find: "查找",
    findPlaceholder: "查找…",
    replace: "替换为",
    replacePlaceholder: "替换为…",
    previous: "上一个匹配",
    next: "下一个匹配",
    matchCase: "区分大小写",
    regexp: "使用正则表达式",
    wholeWord: "全词匹配",
    selectAll: "全选",
    replaceOne: "替换",
    replaceAll: "全部替换",
    close: "关闭查找",
  },
};

const mounted: Array<{ view: EditorView; parent: HTMLElement }> = [];

function mount(doc = "alpha beta alpha", readOnly = false) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    state: createEditorState({ doc, readOnly, uiCopy: SEARCH_COPY }),
    parent,
  });
  mounted.push({ view, parent });
  openSearchPanel(view);
  return { view, parent };
}

afterEach(() => {
  for (const { view, parent } of mounted.splice(0)) {
    view.destroy();
    parent.remove();
  }
});

describe("qingmo search panel", () => {
  it("renders the localized Qingmo controls instead of the stock panel", () => {
    const { parent } = mount();
    const panel = parent.querySelector(".qm-search-panel");

    expect(panel).not.toBeNull();
    expect(panel?.classList.contains("cm-search")).toBe(false);

    const searchField = parent.querySelector<HTMLInputElement>('input[name="search"]');
    expect(searchField?.getAttribute("main-field")).toBe("true");
    expect(searchField?.placeholder).toBe("查找…");

    expect(parent.querySelector<HTMLButtonElement>('button[name="next"]')?.title).toBe(
      "下一个匹配",
    );
    expect(parent.querySelector<HTMLButtonElement>('button[name="prev"]')?.title).toBe(
      "上一个匹配",
    );
    expect(parent.querySelector<HTMLButtonElement>('button[name="replace"]')?.textContent).toBe(
      "替换",
    );
    expect(parent.querySelector<HTMLButtonElement>('button[name="replaceAll"]')?.textContent).toBe(
      "全部替换",
    );
    expect(parent.querySelector<HTMLButtonElement>('button[name="close"]')?.title).toBe("关闭查找");
  });

  it("commits typing and the option toggles to the search query", () => {
    const { view, parent } = mount();
    const searchField = parent.querySelector<HTMLInputElement>('input[name="search"]');
    const caseToggle = parent.querySelector<HTMLButtonElement>('button[name="case"]');

    if (!searchField || !caseToggle) {
      throw new Error("search controls missing");
    }

    searchField.value = "alpha";
    searchField.dispatchEvent(new Event("input", { bubbles: true }));
    expect(getSearchQuery(view.state).search).toBe("alpha");

    caseToggle.click();
    expect(getSearchQuery(view.state).caseSensitive).toBe(true);
    expect(caseToggle.getAttribute("aria-pressed")).toBe("true");
  });

  it("moves through matches with the toolbar arrows and closes with Escape", () => {
    const { view, parent } = mount("alpha beta alpha");
    const searchField = parent.querySelector<HTMLInputElement>('input[name="search"]');
    const nextButton = parent.querySelector<HTMLButtonElement>('button[name="next"]');

    if (!searchField || !nextButton) {
      throw new Error("search controls missing");
    }

    searchField.value = "alpha";
    searchField.dispatchEvent(new Event("input", { bubbles: true }));

    nextButton.click();
    expect(view.state.selection.main.from).toBe(0);
    nextButton.click();
    expect(view.state.selection.main.from).toBe(11);

    searchField.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(parent.querySelector(".qm-search-panel")).toBeNull();
  });

  it("hides the replace row in read-only documents", () => {
    const { parent } = mount("alpha", true);
    expect(parent.querySelector<HTMLElement>(".qm-search-row-replace")?.hidden).toBe(true);
  });

  it("updates labels when the injected copy changes", () => {
    const { view, parent } = mount();
    const searchField = parent.querySelector<HTMLInputElement>('input[name="search"]');

    view.dispatch({
      effects: setEditorUiCopyEffect({
        ...SEARCH_COPY,
        version: "test:search:2",
        search: { ...SEARCH_COPY.search, findPlaceholder: "Search…" },
      }),
    });

    expect(searchField?.placeholder).toBe("Search…");
  });
});
