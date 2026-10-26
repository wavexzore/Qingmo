import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { EditorState, Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";

import { LP_MAX_UNITS, SYNTAX_TREE_BUDGET_MS } from "../limits";
import { collectDecorationSpecs, type VisibleRange } from "./specs";
import { livePreviewTheme } from "./theme";

type SyntaxTreeRef = ReturnType<typeof syntaxTree>;

interface CacheKey {
  doc: EditorState["doc"];
  tree: SyntaxTreeRef;
  viewport: string;
  selections: string;
}

function rangeKey(ranges: readonly VisibleRange[]): string {
  return ranges.map((range) => `${range.from}:${range.to}`).join(",");
}

function cacheKey(state: EditorState, ranges: readonly VisibleRange[]): CacheKey {
  return {
    doc: state.doc,
    tree: syntaxTree(state),
    viewport: rangeKey(ranges),
    selections: rangeKey(state.selection.ranges),
  };
}

function sameKey(left: CacheKey, right: CacheKey): boolean {
  return (
    left.doc === right.doc &&
    left.tree === right.tree &&
    left.viewport === right.viewport &&
    left.selections === right.selections
  );
}

/**
 * Builds decorations for the supplied ranges after a single syntax-tree
 * budget. Exported separately so snapshot tests never depend on jsdom layout.
 */
export function buildLivePreviewDecorations(
  state: EditorState,
  ranges: readonly VisibleRange[],
  selectionRanges: readonly VisibleRange[],
): DecorationSet {
  const specs = collectDecorationSpecs(state, ranges, selectionRanges);
  const decorations = specs.map((spec) => {
    if (spec.kind === "line") {
      return Decoration.line({ class: spec.className }).range(spec.from);
    }
    if (spec.kind === "mark") {
      return Decoration.mark({ class: spec.className }).range(spec.from, spec.to);
    }
    return Decoration.replace({}).range(spec.from, spec.to);
  });
  return Decoration.set(decorations, true);
}

function buildForView(view: EditorView): DecorationSet {
  const { state } = view;
  if (state.doc.length === 0 || state.doc.length > LP_MAX_UNITS) {
    return Decoration.none;
  }

  const ranges = view.visibleRanges;
  const lastRange = ranges[ranges.length - 1];
  if (!lastRange) {
    return Decoration.none;
  }

  // One total budget per update. If the parser cannot reach the viewport in
  // time, the current partial tree is still used and a later tree update will
  // invalidate the cache key.
  ensureSyntaxTree(state, Math.min(lastRange.to, state.doc.length), SYNTAX_TREE_BUDGET_MS);
  return buildLivePreviewDecorations(state, ranges, state.selection.ranges);
}

class LivePreviewViewPlugin {
  decorations: DecorationSet;
  private key: CacheKey;
  private wasComposing: boolean;

  constructor(view: EditorView) {
    this.decorations = buildForView(view);
    this.key = cacheKey(view.state, view.visibleRanges);
    this.wasComposing = view.composing;
  }

  update(update: ViewUpdate): void {
    if (update.docChanged) {
      this.decorations = this.decorations.map(update.changes);
    }

    if (update.view.composing) {
      this.wasComposing = true;
      return;
    }

    const nextKey = cacheKey(update.state, update.view.visibleRanges);
    if (!this.wasComposing && sameKey(nextKey, this.key)) {
      return;
    }

    this.decorations = buildForView(update.view);
    // `ensureSyntaxTree` may advance the tree, so capture the post-build key
    // instead of reusing the pre-build one.
    this.key = cacheKey(update.state, update.view.visibleRanges);
    this.wasComposing = false;
  }
}

export const livePreviewPlugin = ViewPlugin.fromClass(LivePreviewViewPlugin, {
  decorations: (plugin) => plugin.decorations,
});

/**
 * The single Live Preview extension. Source mode reconfigures the same
 * compartment back to an empty extension, so the editor view is never rebuilt.
 */
export function livePreview(): Extension {
  return [livePreviewPlugin, livePreviewTheme];
}
