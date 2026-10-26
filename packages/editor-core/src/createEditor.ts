import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { basicExtensions } from "./extensions/basic";
import { markdownExtensions } from "./extensions/markdown";
import { qingmoEditorTheme } from "./extensions/theme";

/**
 * Reconfiguration seams used by later tasks:
 * - theme: T-016 switches tokens without rebuilding the view.
 * - readOnly: future reload/conflict flows can re-lock a live document.
 * - mode: T-013 swaps Source/Live Preview without recreating EditorState.
 */
export const themeCompartment = new Compartment();
export const readOnlyCompartment = new Compartment();
export const modeCompartment = new Compartment();

export interface CreateEditorStateOptions {
  /** Raw text; CRLF/CR is normalized to the LF-only in-memory contract. */
  doc: string;
  /** MDX/mixed-EOL documents stay read-only until later phases. */
  readOnly?: boolean;
  /** CommandRegistry keymap and feature extensions (T-015/T-013). */
  extraExtensions?: readonly Extension[];
}

/** Normalizes line endings without touching any other character. */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export function readOnlyExtensions(readOnly: boolean): readonly Extension[] {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
}

export function setReadOnlyEffect(readOnly: boolean) {
  return readOnlyCompartment.reconfigure(readOnlyExtensions(readOnly));
}

export function setThemeEffect(theme: Extension) {
  return themeCompartment.reconfigure(theme);
}

export function setModeEffect(mode: Extension) {
  return modeCompartment.reconfigure(mode);
}

/**
 * The single CM6 state factory. It intentionally accepts no `lineSeparator`
 * and no DOM node: the document is always LF-only and the view is created by
 * T-010's EditorHost.
 */
export function createEditorState({
  doc,
  readOnly = false,
  extraExtensions = [],
}: CreateEditorStateOptions): EditorState {
  return EditorState.create({
    doc: normalizeLineEndings(doc),
    extensions: [
      ...basicExtensions,
      ...markdownExtensions,
      themeCompartment.of(qingmoEditorTheme),
      readOnlyCompartment.of(readOnlyExtensions(readOnly)),
      modeCompartment.of([]),
      ...extraExtensions,
    ],
  });
}
