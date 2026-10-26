import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { basicExtensions } from "./extensions/basic";
import { markdownExtensions } from "./extensions/markdown";
import { qingmoEditorTheme } from "./extensions/theme";
import { LP_MAX_UNITS } from "./limits";
import { livePreview } from "./live-preview/plugin";

/**
 * Reconfiguration seams used by later tasks:
 * - theme: T-016 switches tokens without rebuilding the view.
 * - readOnly: future reload/conflict flows can re-lock a live document.
 * - mode: T-014 swaps Source/Live Preview without recreating EditorState;
 *   T-013 installs Live Preview as the default mode.
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
  const normalized = normalizeLineEndings(doc);
  // Large documents start in source mode; the plugin also refuses to decorate
  // above the same limit, so growing past it degrades without a state rebuild.
  const previewEnabled = normalized.length <= LP_MAX_UNITS;

  return EditorState.create({
    doc: normalized,
    extensions: [
      ...basicExtensions,
      ...markdownExtensions,
      themeCompartment.of(qingmoEditorTheme),
      readOnlyCompartment.of(readOnlyExtensions(readOnly)),
      modeCompartment.of(previewEnabled ? livePreview() : []),
      ...extraExtensions,
    ],
  });
}
