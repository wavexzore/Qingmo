import { history, historyKeymap, defaultKeymap } from "@codemirror/commands";
import { search, searchKeymap } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";

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
    dropCursor(),
    rectangularSelection(),
    crosshairCursor(),
    EditorState.allowMultipleSelections.of(true),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
    search({ top: true }),
  ];
}

export const basicExtensions: readonly Extension[] = Object.freeze(createBasicExtensions());
