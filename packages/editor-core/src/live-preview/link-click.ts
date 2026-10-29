import { Facet } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

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
export function linkHrefAtPoint(
  root: Element | null,
  clientX: number,
  clientY: number,
): string | null {
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
        return href;
      }
    }
  }
  return null;
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
