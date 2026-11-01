import { Facet, type EditorState } from "@codemirror/state";

/** Maps a document-relative image source to a URL the webview can load. */
export type ImageSrcResolver = (src: string) => string;

const IDENTITY: ImageSrcResolver = (src) => src;

/**
 * The shell installs one resolver per document so Markdown and HTML images can
 * resolve against the document's directory (for example to `asset://` URLs).
 * The editor core stays platform-neutral: without a resolver, sources are
 * passed through unchanged.
 */
export const imageSrcResolver = Facet.define<ImageSrcResolver, ImageSrcResolver>({
  combine(values) {
    return values[values.length - 1] ?? IDENTITY;
  },
});

export function resolveImageSrc(state: EditorState, src: string): string {
  return state.facet(imageSrcResolver)(src);
}
