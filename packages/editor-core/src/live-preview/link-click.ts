import { Facet } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

/**
 * Host hook that hands an external URL to the operating system.
 *
 * editor-core never opens links itself: the desktop app injects the
 * `app_open_external` IPC call and tests inject a recorder. Rust owns the
 * scheme whitelist, so the renderer only decides *when* a link was activated.
 */
export interface EditorOpenExternalPort {
  open(href: string): void;
}

const NOOP_PORT: EditorOpenExternalPort = Object.freeze({ open: () => undefined });

export const editorOpenExternal = Facet.define<EditorOpenExternalPort, EditorOpenExternalPort>({
  combine: (values) => (values.length > 0 ? values[values.length - 1]! : NOOP_PORT),
});

/** Rendered links keep their destination in `data-href`, never in `href`. */
const LINK_HREF_SELECTOR = ".cm-md-link[data-href]";

/** The link destination under an event target, or null when none was hit. */
export function linkHrefAt(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) {
    return null;
  }
  const href = target.closest<HTMLElement>(LINK_HREF_SELECTOR)?.dataset.href?.trim();
  return href ? href : null;
}

/**
 * The rendered link under a point. A focused table cell puts its transparent
 * textarea on top of the rendered links, so ⌘/Ctrl+Click inside the editor
 * hit-tests the link rectangles underneath instead of the event target.
 */
export function linkElementAtPoint(
  root: Element | null,
  clientX: number,
  clientY: number,
): HTMLElement | null {
  if (!root) {
    return null;
  }
  const links = root.querySelectorAll<HTMLElement>(LINK_HREF_SELECTOR);
  for (let index = 0; index < links.length; index += 1) {
    const link = links[index]!;
    const href = link.dataset.href?.trim();
    if (!href) {
      continue;
    }
    const rects = link.getClientRects();
    for (let rectIndex = 0; rectIndex < rects.length; rectIndex += 1) {
      const rect = rects[rectIndex]!;
      if (
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom
      ) {
        return link;
      }
    }
  }
  return null;
}

export function linkHrefAtPoint(
  root: Element | null,
  clientX: number,
  clientY: number,
): string | null {
  const href = linkElementAtPoint(root, clientX, clientY)?.dataset.href?.trim();
  return href ? href : null;
}

/**
 * Destinations the OS opener may receive. `#fragment` links are handled by the
 * anchor widgets, and relative paths need a workspace before they can resolve,
 * so both stay inert for now.
 */
export function isOpenableHref(href: string): boolean {
  return /^(?:https?:|mailto:)/i.test(href) || /^(?:www\.|\/\/)/i.test(href);
}

/**
 * Typora's gesture: ⌘+Click (Ctrl on Windows/Linux) opens a link in an
 * editable document, while a read-only document opens on a plain click.
 */
export function isLinkOpenGesture(event: MouseEvent, readOnly: boolean): boolean {
  return readOnly || event.metaKey || event.ctrlKey;
}

export function openExternalLink(view: EditorView, href: string): void {
  view.state.facet(editorOpenExternal).open(href);
}

/**
 * Opens rendered inline links from the document text. Table widgets and other
 * block widgets consume their own `mousedown` events, so this handler only
 * covers the marks of the surrounding text.
 */
export const linkOpenMouseDown = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0) {
      return false;
    }
    const href = linkHrefAt(event.target);
    if (!href || !isOpenableHref(href) || !isLinkOpenGesture(event, view.state.readOnly)) {
      return false;
    }
    event.stopPropagation();
    openExternalLink(view, href);
    // Returning true also preventDefaults, so ⌘+Click never moves the caret
    // or clears an existing selection.
    return true;
  },
});

const LINK_HOVER_ATTRIBUTE = "data-link-hover";
const LINK_TAIL_ATTRIBUTE = "data-link-tail";

/**
 * Shows that a rendered link can be opened while the platform modifier is
 * held. The plugin resolves the link under the pointer and marks that element;
 * a focused table cell covers its rendered links with a transparent textarea,
 * so that case hit-tests the link rectangles and marks the cell editor.
 */
class LinkModifierAffordancePlugin {
  private readonly view: EditorView;
  private readonly win: Window | null;
  private modifier = false;
  private active = false;
  private hovered: HTMLElement | null = null;
  private pointer: { x: number; y: number } | null = null;

  constructor(view: EditorView) {
    this.view = view;
    this.win = view.dom.ownerDocument.defaultView;
    view.dom.addEventListener("mousemove", this.onMouseMove);
    view.dom.addEventListener("mouseleave", this.onMouseLeave);
    view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
    this.win?.addEventListener("keydown", this.onKey, true);
    this.win?.addEventListener("keyup", this.onKey, true);
    this.win?.addEventListener("blur", this.onBlur);
    this.syncActive();
  }

  update(update: ViewUpdate): void {
    if (update.state.readOnly !== update.startState.readOnly) {
      this.syncActive();
    }
    if (update.docChanged) {
      this.clearHovered();
    }
  }

  destroy(): void {
    this.view.dom.removeEventListener("mousemove", this.onMouseMove);
    this.view.dom.removeEventListener("mouseleave", this.onMouseLeave);
    this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
    this.win?.removeEventListener("keydown", this.onKey, true);
    this.win?.removeEventListener("keyup", this.onKey, true);
    this.win?.removeEventListener("blur", this.onBlur);
    this.clearHovered();
  }

  private readonly onKey = (event: KeyboardEvent): void => {
    this.modifier = event.metaKey || event.ctrlKey;
    this.syncActive();
    this.refreshHovered();
  };

  private readonly onBlur = (): void => {
    this.modifier = false;
    this.syncActive();
    this.clearHovered();
  };

  private readonly onScroll = (): void => {
    this.clearHovered();
  };

  private readonly onMouseLeave = (): void => {
    this.pointer = null;
    this.clearHovered();
  };

  private readonly onMouseMove = (event: MouseEvent): void => {
    this.pointer = { x: event.clientX, y: event.clientY };
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier !== this.modifier) {
      this.modifier = modifier;
      this.syncActive();
    }
    if (!this.active) {
      this.clearHovered();
      return;
    }
    this.resolveHovered(event.target, event.clientX, event.clientY);
  };

  private refreshHovered(): void {
    if (!this.active || !this.pointer) {
      this.clearHovered();
      return;
    }
    const target = this.view.dom.ownerDocument.elementFromPoint?.(this.pointer.x, this.pointer.y);
    if (!target || !this.view.dom.contains(target)) {
      this.clearHovered();
      return;
    }
    this.resolveHovered(target, this.pointer.x, this.pointer.y);
  }

  private resolveHovered(target: EventTarget | null, clientX: number, clientY: number): void {
    const direct =
      target instanceof Element ? target.closest<HTMLElement>(LINK_HREF_SELECTOR) : null;
    if (direct) {
      const href = direct.dataset.href?.trim();
      if (href && isOpenableHref(href)) {
        this.markHovered(direct);
      } else {
        this.clearHovered();
      }
      return;
    }

    if (
      target instanceof HTMLTextAreaElement &&
      target.classList.contains("cm-md-table-cell-input")
    ) {
      const cell = target.closest("th, td");
      const link = cell ? linkElementAtPoint(cell, clientX, clientY) : null;
      const href = link?.dataset.href?.trim();
      if (href && isOpenableHref(href)) {
        // The focused cell editor covers the rendered link. Mark the editor
        // itself so the pointer and tint communicate the clickable target.
        this.markHovered(target);
      } else {
        this.clearHovered();
      }
      return;
    }

    this.clearHovered();
  }

  private syncActive(): void {
    const active = this.modifier || this.view.state.readOnly;
    if (active === this.active) {
      return;
    }
    this.active = active;
    if (!active) {
      this.clearHovered();
    }
  }

  private markHovered(element: HTMLElement | null): void {
    if (element === this.hovered) {
      return;
    }
    this.clearHovered();
    if (!element) {
      return;
    }
    element.setAttribute(LINK_HOVER_ATTRIBUTE, "true");
    if (element.matches(LINK_HREF_SELECTOR) && isLinkAtLineEnd(element)) {
      element.setAttribute(LINK_TAIL_ATTRIBUTE, "true");
    }
    this.hovered = element;
  }

  private clearHovered(): void {
    this.hovered?.removeAttribute(LINK_HOVER_ATTRIBUTE);
    this.hovered?.removeAttribute(LINK_TAIL_ATTRIBUTE);
    this.hovered = null;
  }
}

/** A trailing badge sits at the baseline only when nothing follows the link. */
function isLinkAtLineEnd(link: HTMLElement): boolean {
  const line = link.closest(".cm-line");
  if (!line) {
    return true;
  }
  for (let node = link.nextSibling; node; node = node.nextSibling) {
    if ((node.textContent ?? "").trim()) {
      return false;
    }
  }
  return true;
}

export const linkModifierAffordance = ViewPlugin.fromClass(LinkModifierAffordancePlugin);
