import { syntaxTree } from "@codemirror/language";
import { Prec } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap, type ViewUpdate } from "@codemirror/view";

/**
 * Typora treats a fence as a fixed block: typing the opening marker creates a
 * self-contained code block instead of pairing with a closing fence further
 * down the document. A plain-text Markdown source cannot rely on that block
 * model, so a freshly typed top-level fence is completed with its own closing
 * fence as soon as the author commits the opening line (Enter) or moves the
 * caret away.
 *
 * Without this, typing ``` above an existing fenced block makes CommonMark
 * pair the new opening with the old closing fence; the embedded editor then
 * renders both blocks as one and swallows the content between them.
 */
interface PendingFence {
  lineFrom: number;
  char: "`" | "~";
}

const pendingFences = new WeakMap<EditorView, PendingFence>();

const OPENING = /^(\s{0,3})(`{3,}|~{3,})(.*)$/;
const BARE_FENCE = /^ {0,3}(`{3,}|~{3,})$/;
const CLOSING = /^ {0,3}(`{3,}|~{3,})\s*$/;

function isClosingFence(text: string, char: string, minLength: number): boolean {
  const match = CLOSING.exec(text);
  const run = match?.[1];
  return !!run && run[0] === char && run.length >= minLength;
}

/**
 * Only top-level paragraphs can become an embedded code block. Fences inside
 * quotes, lists or tables keep the line-based rendering, so completing them
 * here would mutate source that the widget model does not own.
 */
function isTopLevelParagraph(view: EditorView, pos: number): boolean {
  const node = syntaxTree(view.state).resolveInner(pos, 1);
  return node.name === "Paragraph" && node.parent?.name === "Document";
}

interface FenceLine {
  indent: string;
  run: string;
  info: string;
}

function fenceRun(lineText: string, char: PendingFence["char"]): FenceLine | null {
  const match = OPENING.exec(lineText);
  const indent = match?.[1];
  const run = match?.[2];
  const info = match?.[3];
  if (indent == null || run == null || info == null || run[0] !== char) {
    return null;
  }
  // CommonMark forbids backticks in a backtick fence's info string.
  if (char === "`" && info.includes("`")) {
    return null;
  }
  return { indent, run, info };
}

function completeFence(view: EditorView, pending: PendingFence, moveCaret: boolean): boolean {
  const { state } = view;
  if (state.readOnly || pending.lineFrom > state.doc.length) {
    return false;
  }
  const line = state.doc.lineAt(pending.lineFrom);
  if (line.from !== pending.lineFrom) {
    return false;
  }
  const match = fenceRun(line.text, pending.char);
  if (!match) {
    return false;
  }
  const length = match.run.length;
  const next = line.number < state.doc.lines ? state.doc.line(line.number + 1) : null;
  if (next && isClosingFence(next.text, pending.char, length)) {
    return false;
  }
  const closing = `${match.indent}${pending.char.repeat(length)}`;
  view.dispatch({
    changes: { from: line.to, insert: `\n\n${closing}` },
    ...(moveCaret ? { selection: { anchor: line.to + 1 } } : {}),
    userEvent: "input",
    scrollIntoView: true,
  });
  return true;
}

const fenceInput = EditorView.inputHandler.of((view, from, to, text) => {
  if (view.composing || view.state.readOnly) {
    return false;
  }
  if (!/^[`~]+$/.test(text) || from !== to) {
    return false;
  }
  const line = view.state.doc.lineAt(from);
  if (to !== line.to) {
    return false;
  }
  const typed = line.text.slice(0, from - line.from) + text;
  if (!BARE_FENCE.test(typed)) {
    return false;
  }
  if (!isTopLevelParagraph(view, line.from)) {
    return false;
  }
  pendingFences.set(view, {
    lineFrom: line.from,
    char: text[0] === "~" ? "~" : "`",
  });
  return false;
});

const fenceEnter = Prec.high(
  keymap.of([
    {
      key: "Enter",
      run(view) {
        const pending = pendingFences.get(view);
        if (!pending) {
          return false;
        }
        const { state } = view;
        if (state.readOnly) {
          pendingFences.delete(view);
          return false;
        }
        const selection = state.selection.main;
        if (!selection.empty) {
          pendingFences.delete(view);
          return false;
        }
        const line = state.doc.lineAt(selection.head);
        if (line.from !== pending.lineFrom || selection.head !== line.to) {
          pendingFences.delete(view);
          return false;
        }
        pendingFences.delete(view);
        return completeFence(view, pending, true);
      },
    },
  ]),
);

const fenceAutoClose = ViewPlugin.fromClass(
  class {
    constructor(private readonly view: EditorView) {}

    update(update: ViewUpdate): void {
      const pending = pendingFences.get(update.view);
      if (!pending) {
        return;
      }
      const line = update.state.doc.lineAt(Math.min(pending.lineFrom, update.state.doc.length));
      if (line.from !== pending.lineFrom) {
        pendingFences.delete(update.view);
        return;
      }
      const selection = update.state.selection.main;
      // Wait for a caret: a drag that spans the opening line should not insert
      // text under the pointer. A click or keyboard move outside the line
      // commits the fence.
      if (!selection.empty) {
        return;
      }
      if (selection.head >= line.from && selection.head <= line.to) {
        return;
      }
      // The author moved on without pressing Enter: close the fence in place
      // so the fixed block cannot pair with a later closing fence.
      pendingFences.delete(update.view);
      queueMicrotask(() => completeFence(this.view, pending, false));
    }
  },
);

export const codeFenceAutoClose = [fenceInput, fenceEnter, fenceAutoClose];
