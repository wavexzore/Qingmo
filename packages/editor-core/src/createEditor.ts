import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, placeholder as cmPlaceholder } from "@codemirror/view";

import { basicExtensions } from "./extensions/basic";
import { markdownExtensions } from "./extensions/markdown";
import { codeBlockSelectAll } from "./extensions/select-all";
import { qingmoEditorTheme } from "./extensions/theme";
import { DEFAULT_EDITOR_UI_COPY, editorUiCopy, type EditorUiCopy } from "./i18n";
import { previewTierFor } from "./limits";
import { headingOutline, outlineParseDriver } from "./live-preview/outline";
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
export const placeholderCompartment = new Compartment();
export const uiCopyCompartment = new Compartment();

export interface CreateEditorStateOptions {
  /** Raw text; CRLF/CR is normalized to the LF-only in-memory contract. */
  doc: string;
  /**
   * Initial selection, clamped into the normalized document. Used by T-004 to
   * restore a persisted cursor before the first view exists.
   */
  selection?: { anchor: number; head: number };
  /** MDX/mixed-EOL documents stay read-only until later phases. */
  readOnly?: boolean;
  /** CommandRegistry keymap and feature extensions (T-015/T-013). */
  extraExtensions?: readonly Extension[];
  /** Shown only while the document is empty (untitled startup editor). */
  placeholder?: string;
  /** Injected Widget/block copy; defaults to editor-core's English fallback. */
  uiCopy?: EditorUiCopy;
  /**
   * Effective Live Preview switch. Defaults to
   * `previewTierFor(doc.length) !== "source"`; later tasks pass
   * `preference && tier !== "source"` so the user preference and the
   * affordability policy stay separate.
   */
  previewEnabled?: boolean;
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
 * Swaps the empty-document hint without rebuilding state, so an in-flight IME
 * composition is never interrupted and undo history survives.
 */
export function setPlaceholderEffect(text: string) {
  return placeholderCompartment.reconfigure(text ? cmPlaceholder(text) : []);
}

/** Swaps the Widget copy without rebuilding EditorState or the view. */
export function setEditorUiCopyEffect(copy: EditorUiCopy) {
  return uiCopyCompartment.reconfigure(editorUiCopy.of(copy));
}

/**
 * The single CM6 state factory. It intentionally accepts no `lineSeparator`
 * and no DOM node: the document is always LF-only and the view is created by
 * T-010's EditorHost.
 */
export function createEditorState({
  doc,
  selection,
  readOnly = false,
  extraExtensions = [],
  placeholder,
  uiCopy = DEFAULT_EDITOR_UI_COPY,
  previewEnabled,
}: CreateEditorStateOptions): EditorState {
  const normalized = normalizeLineEndings(doc);
  // Large documents start in source mode; the plugin and every block module
  // also refuse to decorate above the same limits, so growing past a boundary
  // degrades without a state rebuild.
  const previewOn = previewEnabled ?? previewTierFor(normalized.length) !== "source";
  const initialSelection = selection
    ? {
        anchor: Math.min(normalized.length, Math.max(0, Math.trunc(selection.anchor))),
        head: Math.min(normalized.length, Math.max(0, Math.trunc(selection.head))),
      }
    : undefined;

  return EditorState.create({
    doc: normalized,
    ...(initialSelection ? { selection: initialSelection } : {}),
    extensions: [
      ...basicExtensions,
      ...markdownExtensions,
      headingOutline,
      outlineParseDriver,
      codeBlockSelectAll,
      themeCompartment.of(qingmoEditorTheme),
      readOnlyCompartment.of(readOnlyExtensions(readOnly)),
      modeCompartment.of(previewOn ? livePreview() : []),
      placeholderCompartment.of(placeholder ? cmPlaceholder(placeholder) : []),
      uiCopyCompartment.of(editorUiCopy.of(uiCopy)),
      ...extraExtensions,
    ],
  });
}
