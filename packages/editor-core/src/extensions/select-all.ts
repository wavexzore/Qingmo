import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorSelection, Prec, type EditorState, type Extension } from "@codemirror/state";
import { keymap, type Command } from "@codemirror/view";

/**
 * Cmd/Ctrl+A normally selects the whole document. Typora scopes the shortcut
 * to the code editor while the caret is inside a fenced block, so this command
 * mirrors that: select the fenced block's code text (fence lines excluded).
 * Returning false lets CM6's default keymap fall back to `selectAll`.
 */
const CODE_BLOCK_PARSE_BUDGET_MS = 50;

type SyntaxCursor = ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]>;

interface ContentRange {
  from: number;
  to: number;
}

function fencedCodeContent(state: EditorState, node: SyntaxCursor): ContentRange | null {
  const marks = node.getChildren("CodeMark");
  const opening = marks[0];
  if (!opening) {
    return null;
  }

  const openingLine = state.doc.lineAt(opening.from);
  const contentFrom = Math.min(openingLine.to + 1, state.doc.length);
  const closing = marks.length > 1 ? marks[marks.length - 1] : null;
  const contentTo = closing
    ? Math.max(contentFrom, state.doc.lineAt(closing.from).from - 1)
    : Math.max(contentFrom, node.to);

  // An empty fence has nothing to select; let the default command handle it.
  return contentTo > contentFrom ? { from: contentFrom, to: contentTo } : null;
}

function codeBlockContentAt(state: EditorState, position: number): ContentRange | null {
  const tree = ensureSyntaxTree(state, position, CODE_BLOCK_PARSE_BUDGET_MS) ?? syntaxTree(state);
  let node: SyntaxCursor | null = tree.resolveInner(position, 1);
  while (node) {
    if (node.name === "FencedCode") {
      return fencedCodeContent(state, node);
    }
    if (node.name === "CodeBlock") {
      // The Lezer node starts after the first line's indentation; include it
      // so the selection matches the whole code block as shown in the editor.
      return { from: state.doc.lineAt(node.from).from, to: node.to };
    }
    node = node.parent;
  }
  return null;
}

/**
 * Select the fenced or indented code block around the caret. A selection that
 * already extends outside the block is left to the default Select All.
 */
export const selectAllInCodeBlock: Command = (view) => {
  const { state } = view;
  if (state.selection.ranges.length !== 1) {
    return false;
  }

  const selection = state.selection.main;
  const range = codeBlockContentAt(state, selection.head);
  if (!range) {
    return false;
  }
  if (!selection.empty && (selection.from < range.from || selection.to > range.to)) {
    return false;
  }

  view.dispatch({
    selection: EditorSelection.single(range.from, range.to),
    scrollIntoView: true,
    userEvent: "select",
  });
  return true;
};

/** Highest precedence so it runs before the default keymap's Mod-a binding. */
export const codeBlockSelectAll: Extension = Prec.high(
  keymap.of([{ key: "Mod-a", run: selectAllInCodeBlock }]),
);
