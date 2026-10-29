import { history, historyKeymap, defaultKeymap } from "@codemirror/commands";
import { searchKeymap } from "@codemirror/search";
import { EditorState, type Extension, type Range } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  rectangularSelection,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";

import { qingmoSearch } from "./search";

/**
 * `drawSelection` paints the selection behind the text, so a solid selection
 * colour needs a matching text colour to stay readable. This mark lets the
 * theme invert the selected glyphs; it is a pure view decoration and never
 * touches the document or the selection ranges themselves.
 */
const selectedText = Decoration.mark({ class: "cm-selectedText" });
const selectedLine = Decoration.line({ class: "cm-selectedLine" });

function selectedTextDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const lines = new Set<number>();
  for (const selection of view.state.selection.ranges) {
    // Marks may not span line breaks, so split each selection into one mark
    // per line. This is what makes multi-line selections invert every line,
    // not just the last one.
    let position = selection.from;
    while (position < selection.to) {
      const line = view.state.doc.lineAt(position);
      if (!lines.has(line.from)) {
        lines.add(line.from);
        // Code-block backgrounds are opaque and otherwise cover the
        // selection layer; make selected lines transparent while selected.
        ranges.push(selectedLine.range(line.from));
      }
      const end = Math.min(line.to, selection.to);
      if (end > position) {
        ranges.push(selectedText.range(position, end));
      }
      if (line.to >= selection.to) {
        break;
      }
      position = line.to + 1;
    }
  }
  return Decoration.set(ranges, true);
}

export const selectionTextHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = selectedTextDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.selectionSet || update.docChanged) {
        this.decorations = selectedTextDecorations(update.view);
      }
    }
  },
  { decorations: (value) => value.decorations },
);

/**
 * The non-Markdown CM6 baseline: line numbers, history, selection behaviour
 * and the default/search keymaps. CommandRegistry keybindings are appended by
 * T-015 through `createEditorState({ extraExtensions })`, so this list never
 * becomes a second shortcut source.
 */
export function createBasicExtensions(): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    history(),
    drawSelection(),
    selectionTextHighlight,
    dropCursor(),
    rectangularSelection(),
    crosshairCursor(),
    // A writing surface wraps at the window edge; block widgets (tables,
    // Mermaid plates) then measure against the viewport instead of the
    // document's longest unbroken line.
    EditorView.lineWrapping,
    EditorState.allowMultipleSelections.of(true),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
    qingmoSearch(),
  ];
}

export const basicExtensions: readonly Extension[] = Object.freeze(createBasicExtensions());
