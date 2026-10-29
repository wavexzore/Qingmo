import { EditorSelection } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";

/**
 * Block widgets keep their vertical rhythm in root padding so CodeMirror's
 * height map includes it. That padding is therefore part of the widget's hit
 * area: without this plugin a click in the gap would reveal or focus the block
 * instead of placing the caret on the nearest text line.
 *
 * Widgets opt in with `data-block-gap` on their block root.
 */
export const blockWidgetGapClicks = ViewPlugin.fromClass(
  class {
    private readonly view: EditorView;
    private readonly onMouseDown: (event: MouseEvent) => void;

    constructor(view: EditorView) {
      this.view = view;
      this.onMouseDown = (event) => this.handle(event);
      // Capture phase: block widgets handle their own mousedown events, which
      // would otherwise consume a gap click before it reaches the editor.
      view.contentDOM.addEventListener("mousedown", this.onMouseDown, true);
    }

    destroy(): void {
      this.view.contentDOM.removeEventListener("mousedown", this.onMouseDown, true);
    }

    private handle(event: MouseEvent): void {
      if (event.button !== 0 || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) {
        return;
      }
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      if (target.parentElement !== this.view.contentDOM || !target.hasAttribute("data-block-gap")) {
        return;
      }

      const style = getComputedStyle(target);
      const paddingTop = Number.parseFloat(style.paddingTop) || 0;
      const paddingBottom = Number.parseFloat(style.paddingBottom) || 0;
      if (paddingTop <= 0 && paddingBottom <= 0) {
        return;
      }

      const rect = target.getBoundingClientRect();
      const borderTop = Number.parseFloat(style.borderTopWidth) || 0;
      const borderBottom = Number.parseFloat(style.borderBottomWidth) || 0;
      const scrollbarHeight = Math.max(
        0,
        target.offsetHeight - target.clientHeight - borderTop - borderBottom,
      );
      // A horizontal scrollbar owns the bottom strip; never turn its drags
      // into caret moves.
      if (scrollbarHeight > 0 && event.clientY > rect.bottom - borderBottom - scrollbarHeight) {
        return;
      }
      const contentTop = rect.top + borderTop + paddingTop;
      const contentBottom = rect.bottom - borderBottom - paddingBottom;
      if (event.clientY >= contentTop && event.clientY <= contentBottom) {
        return;
      }

      // Map to the line just outside the whole widget. Coordinates inside the
      // widget's own box would resolve to the block's source position.
      const y = event.clientY < contentTop ? rect.top - 1 : rect.bottom + 1;
      const pos = this.view.posAtCoords({ x: event.clientX, y });
      if (pos == null) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      this.view.dispatch({ selection: EditorSelection.cursor(pos) });
      this.view.focus();
    }
  },
);
