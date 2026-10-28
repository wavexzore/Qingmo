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
import { editorUiCopy, type EditorUiCopy } from "../i18n";
import { commentBlockPreview } from "./comment-blocks";
import { codeBlockPreview, codeBlockSelectionGuard } from "./code-blocks";
import { definitionListPreview } from "./definition-lists";
import { detailsBlockPreview } from "./details";
import { frontMatterPreview } from "./frontmatter";
import { mathBlockPreview } from "./math-blocks";
import { mediaBlockPreview } from "./media-blocks";
import { mermaidBlockPreview } from "./mermaid-blocks";
import { collectDecorationSpecs, type DecorationSpec, type VisibleRange } from "./specs";
import { tableBlockPreview, tableSelectionGuard } from "./table-blocks";
import { tocPreview } from "./toc";
import { livePreviewTheme } from "./theme";
import { createLivePreviewWidget } from "./widgets";

type SyntaxTreeRef = ReturnType<typeof syntaxTree>;

interface CacheKey {
  doc: EditorState["doc"];
  tree: SyntaxTreeRef;
  viewport: string;
  selections: string;
  uiCopy: string;
}

interface LivePreviewBuild {
  decorations: DecorationSet;
  atomicRanges: DecorationSet;
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
    uiCopy: state.facet(editorUiCopy).version,
  };
}

function sameKey(left: CacheKey, right: CacheKey): boolean {
  return (
    left.doc === right.doc &&
    left.tree === right.tree &&
    left.viewport === right.viewport &&
    left.selections === right.selections &&
    left.uiCopy === right.uiCopy
  );
}

function emptyBuild(): LivePreviewBuild {
  return { decorations: Decoration.none, atomicRanges: Decoration.none };
}

/**
 * Turns planner specs into CM6 decorations. Widget replacements are also
 * collected separately as atomic ranges so arrow keys and selection cannot
 * land inside a bullet, checkbox, rule, image or language badge.
 */
function buildFromSpecs(specs: readonly DecorationSpec[], copy: EditorUiCopy): LivePreviewBuild {
  const decorations: ReturnType<Decoration["range"]>[] = [];
  const atomic: ReturnType<Decoration["range"]>[] = [];

  for (const spec of specs) {
    if (spec.kind === "line") {
      decorations.push(Decoration.line({ class: spec.className }).range(spec.from));
      continue;
    }
    if (spec.kind === "mark") {
      decorations.push(
        Decoration.mark(
          spec.attributes
            ? { class: spec.className, attributes: spec.attributes }
            : { class: spec.className },
        ).range(spec.from, spec.to),
      );
      continue;
    }
    if (spec.kind === "replace") {
      decorations.push(Decoration.replace({}).range(spec.from, spec.to));
      continue;
    }

    const widget = createLivePreviewWidget(spec.widget, spec.from, spec.to, copy);
    const decoration = Decoration.replace({ widget }).range(spec.from, spec.to);
    decorations.push(decoration);
    atomic.push(decoration);
  }

  return {
    decorations: Decoration.set(decorations, true),
    atomicRanges: Decoration.set(atomic, true),
  };
}

/**
 * Builds decorations for the supplied ranges after a single syntax-tree
 * budget. Exported separately so snapshot tests never depend on jsdom layout.
 */
export function buildLivePreviewDecorations(
  state: EditorState,
  ranges: readonly VisibleRange[],
  selectionRanges: readonly VisibleRange[],
  blockedRanges: readonly VisibleRange[] = [],
): DecorationSet {
  return buildFromSpecs(
    collectDecorationSpecs(state, ranges, selectionRanges, blockedRanges),
    state.facet(editorUiCopy),
  ).decorations;
}

function buildForView(view: EditorView): LivePreviewBuild {
  const { state } = view;
  if (state.doc.length === 0 || state.doc.length > LP_MAX_UNITS) {
    return emptyBuild();
  }

  const ranges = view.visibleRanges;
  const lastRange = ranges[ranges.length - 1];
  if (!lastRange) {
    return emptyBuild();
  }

  // One total budget per update. If the parser cannot reach the viewport in
  // time, the current partial tree is still used and a later tree update will
  // invalidate the cache key.
  ensureSyntaxTree(state, Math.min(lastRange.to, state.doc.length), SYNTAX_TREE_BUDGET_MS);
  const blocked = [
    ...(state.field(frontMatterPreview, false)?.blocked ?? []),
    ...(state.field(tocPreview, false)?.blocked ?? []),
    ...(state.field(definitionListPreview, false)?.blocked ?? []),
    ...(state.field(detailsBlockPreview, false)?.blocked ?? []),
    ...(state.field(mediaBlockPreview, false)?.blocked ?? []),
    ...(state.field(commentBlockPreview, false)?.blocked ?? []),
    ...(state.field(codeBlockPreview, false)?.ranges ?? []),
    ...(state.field(tableBlockPreview, false)?.blocked ?? []),
    ...(state.field(mathBlockPreview, false)?.blocked ?? []),
    ...(state.field(mermaidBlockPreview, false)?.blocked ?? []),
  ];
  return buildFromSpecs(
    collectDecorationSpecs(state, ranges, state.selection.ranges, blocked),
    state.facet(editorUiCopy),
  );
}

class LivePreviewViewPlugin {
  decorations: DecorationSet;
  atomicRanges: DecorationSet;
  private key: CacheKey;
  private wasComposing: boolean;

  constructor(view: EditorView) {
    const build = buildForView(view);
    this.decorations = build.decorations;
    this.atomicRanges = build.atomicRanges;
    this.key = cacheKey(view.state, view.visibleRanges);
    this.wasComposing = view.composing;
  }

  update(update: ViewUpdate): void {
    if (update.docChanged) {
      this.decorations = this.decorations.map(update.changes);
      this.atomicRanges = this.atomicRanges.map(update.changes);
    }

    if (update.view.composing) {
      this.wasComposing = true;
      return;
    }

    const nextKey = cacheKey(update.state, update.view.visibleRanges);
    if (!this.wasComposing && sameKey(nextKey, this.key)) {
      return;
    }

    const build = buildForView(update.view);
    this.decorations = build.decorations;
    this.atomicRanges = build.atomicRanges;
    // `ensureSyntaxTree` may advance the tree, so capture the post-build key
    // instead of reusing the pre-build one.
    this.key = cacheKey(update.state, update.view.visibleRanges);
    this.wasComposing = false;
  }
}

export const livePreviewPlugin = ViewPlugin.fromClass(LivePreviewViewPlugin, {
  decorations: (plugin) => plugin.decorations,
});

const livePreviewAtomicRanges = EditorView.atomicRanges.of((view) => {
  return view.plugin(livePreviewPlugin)?.atomicRanges ?? Decoration.none;
});

/**
 * The single Live Preview extension. Source mode reconfigures the same
 * compartment back to an empty extension, so the editor view is never rebuilt.
 */
export function livePreview(): Extension {
  return [
    // Lets the shell style the editor by mode: Live Preview renders the
    // document and owns no code gutter, while source mode keeps line numbers.
    EditorView.editorAttributes.of({ "data-live-preview": "true" }),
    livePreviewPlugin,
    livePreviewAtomicRanges,
    frontMatterPreview,
    tocPreview,
    definitionListPreview,
    detailsBlockPreview,
    mediaBlockPreview,
    commentBlockPreview,
    codeBlockPreview,
    codeBlockSelectionGuard,
    tableBlockPreview,
    tableSelectionGuard,
    mathBlockPreview,
    mermaidBlockPreview,
    livePreviewTheme,
  ];
}
