import { ensureSyntaxTree } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";

import { createEditorState } from "../index";
import { parseHtmlTable, readHtmlTables } from "./html-tables";

const views: Array<{ view: EditorView; parent: HTMLDivElement }> = [];

afterEach(() => {
  for (const { view, parent } of views.splice(0)) {
    view.destroy();
    parent.remove();
  }
});

function stateFor(doc: string) {
  const state = createEditorState({ doc });
  ensureSyntaxTree(state, state.doc.length, 10_000);
  // `ensureSyntaxTree` advances the parse context, not the state field; an
  // empty transaction adopts the completed tree for `syntaxTree(state)`.
  return state.update({}).state;
}

const TABLE = `<table>
  <caption>**系统** 架构</caption>
  <thead>
    <tr><th rowspan="2">模块</th><th colspan="2" align="center">状态</th></tr>
    <tr><th>CPU</th><th>内存</th></tr>
  </thead>
  <tbody>
    <tr><td rowspan="2" onclick="alert(1)">API</td><td>10%</td><td>20%</td></tr>
    <tr><td colspan="3">**合并**</td></tr>
  </tbody>
  <tfoot>
    <tr><td colspan="3">合计</td></tr>
  </tfoot>
</table>`;

describe("parseHtmlTable", () => {
  it("parses captions, sections, spans and safe alignment", () => {
    const table = parseHtmlTable(TABLE);
    expect(table).not.toBeNull();
    if (!table) {
      return;
    }

    expect(table.caption).toBe("**系统** 架构");
    expect(table.rows.map((row) => row.section)).toEqual(["head", "head", "body", "body", "foot"]);

    const firstHead = table.rows[0];
    expect(firstHead?.cells[0]).toMatchObject({
      tag: "th",
      content: "模块",
      rowspan: 2,
      colspan: 1,
    });
    expect(firstHead?.cells[1]).toMatchObject({
      tag: "th",
      content: "状态",
      align: "center",
      colspan: 2,
    });

    const firstBody = table.rows[2];
    expect(firstBody?.cells[0]).toMatchObject({
      tag: "td",
      content: "API",
      rowspan: 2,
    });
    expect(firstBody?.cells[2]?.content).toBe("20%");

    const secondBody = table.rows[3];
    expect(secondBody?.cells[0]).toMatchObject({
      content: "**合并**",
      colspan: 3,
    });
  });

  it("keeps malformed spans bounded and ignores unknown tags as structure", () => {
    const table = parseHtmlTable(
      '<table><tr><td colspan="99999" rowspan="-2">a</td>' +
        "<td><table><tr><td>nested</td></tr></table></td></tr></table>",
    );

    expect(table?.rows[0]?.cells[0]?.colspan).toBe(1_000);
    expect(table?.rows[0]?.cells[0]?.rowspan).toBe(1);
    expect(table?.rows[0]?.cells[1]?.content).toContain("<table>");
    expect(table?.rows[0]?.cells[1]?.content).toContain("nested");
  });

  it("returns null when no cell exists", () => {
    expect(parseHtmlTable("<table><caption>empty</caption></table>")).toBeNull();
  });
});

describe("readHtmlTables", () => {
  it("finds a table across blank lines and ignores fenced code", () => {
    const doc =
      "<table>\n<tr><th>A</th></tr>\n\n<tr><td>B</td></tr>\n</table>\n\n" +
      "```html\n<table><tr><td>code</td></tr></table>\n```\n";
    const tables = readHtmlTables(stateFor(doc));

    expect(tables).toHaveLength(1);
    expect(tables[0]?.from).toBe(0);
    expect(tables[0]?.to).toBe(doc.indexOf("</table>") + "</table>".length);
    expect(tables[0]?.rows).toHaveLength(2);
  });

  it("requires a matching closing tag and no trailing content", () => {
    expect(readHtmlTables(stateFor("<table>\n<tr><td>A</td></tr>\n"))).toHaveLength(0);
    expect(readHtmlTables(stateFor("<table><tr><td>A</td></tr></table> trailing\n"))).toHaveLength(
      0,
    );
  });

  it("supports indented top-level tables", () => {
    const doc = "  <table>\n    <tr><td>A</td></tr>\n  </table>\n";
    const tables = readHtmlTables(stateFor(doc));
    expect(tables).toHaveLength(1);
    expect(tables[0]?.from).toBe(0);
  });
});

describe("HTML table preview widget", () => {
  it("renders structure and safe cell Markdown, then reveals source on click", () => {
    const doc =
      TABLE +
      "\n\n" +
      "<table><tr><td><script>alert(1)</script></td><td><img src=x onerror=alert(1)></td></tr></table>\n" +
      "\n结尾段落\n";
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: stateFor(doc), parent });
    views.push({ view, parent });

    view.dispatch({ selection: { anchor: doc.length } });
    const blocks = view.dom.querySelectorAll(".cm-md-table-block");
    expect(blocks).toHaveLength(2);

    const main = blocks[0] as HTMLElement;
    expect(main.querySelector("caption strong")?.textContent).toBe("系统");
    expect(main.querySelector("thead")).not.toBeNull();
    expect(main.querySelector("tfoot")).not.toBeNull();
    expect(main.querySelector('th[colspan="2"][style*="text-align: center"]')).not.toBeNull();
    expect(main.querySelector('td[rowspan="2"]')?.getAttribute("onclick")).toBeNull();
    expect(main.querySelectorAll("tbody tr")[1]?.querySelector("strong")?.textContent).toBe("合并");

    // Dangerous tags stay inert text and never become DOM nodes.
    const dangerous = blocks[1] as HTMLElement;
    expect(dangerous.querySelector("script")).toBeNull();
    expect(dangerous.querySelector("img")).toBeNull();
    expect(dangerous.textContent).toContain("<script>alert(1)</script>");
    expect(dangerous.textContent).toContain("onerror=alert(1)");
    expect(view.dom.querySelector("script")).toBeNull();

    // Clicking the rendered table returns to the HTML source.
    main.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(view.state.selection.main.head).toBe(0);
    expect(view.dom.querySelectorAll(".cm-md-table-block")).toHaveLength(1);
    expect(view.dom.textContent).toContain("<table>");
  });
});
