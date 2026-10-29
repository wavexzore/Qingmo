import { syntaxTree } from "@codemirror/language";
import { StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

import { editorCopyChanged, editorUiCopy, type EditorUiCopy } from "../i18n";
import { readDetailsBlocks } from "./details";
import { renderInlineMarkdown } from "./inline-render";
import type { MarkdownNode } from "./markdown-node";

/**
 * Media HTML blocks are preview shells only: the source stays the single
 * document model, and relative files are resolved by the webview like images.
 * Very large documents keep the source untouched.
 */
export const MEDIA_BLOCK_MAX_UNITS = 200_000;

export type MediaKind = "video" | "audio" | "picture" | "iframe" | "img" | "figure" | "center";

export interface MediaSource {
  src: string | null;
  srcset: string | null;
  type: string | null;
  media: string | null;
}

export interface MediaBlock {
  from: number;
  to: number;
  kind: MediaKind;
  raw: string;
  src: string | null;
  poster: string | null;
  alt: string;
  title: string | null;
  width: string | null;
  height: string | null;
  caption: string | null;
  sources: readonly MediaSource[];
}

const MEDIA_TAG = /^<(video|audio|picture|iframe|figure|img|div)\b/i;
const SOURCE_TAG = /<source\b([^>]*)>/gi;
const IMG_TAG = /<img\b([^>]*)>/i;
const FIGCAPTION = /<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i;
const ATTRIBUTE = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
const DANGEROUS_URL = /^(?:javascript|vbscript|data|file):/i;
const ALLOWED_SCHEME = /^https?:/i;

function parseAttributes(raw: string): Map<string, string> {
  const attributes = new Map<string, string>();
  ATTRIBUTE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTRIBUTE.exec(raw))) {
    attributes.set((match[1] ?? "").toLowerCase(), match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

/** Only relative URLs and http(s) may reach a media element. */
function safeUrl(value: string | undefined | null): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed || DANGEROUS_URL.test(trimmed.replace(/\s+/g, ""))) {
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !ALLOWED_SCHEME.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function safeSrcset(value: string | undefined | null): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return null;
  }
  const first = trimmed.split(",")[0]?.trim().split(/\s+/)[0] ?? "";
  return safeUrl(first) ? trimmed : null;
}

function dimension(value: string | undefined | null): string | null {
  const trimmed = value?.trim() ?? "";
  return /^\d+(?:\.\d+)?%?$/.test(trimmed) ? trimmed : null;
}

function fileNameOf(src: string | null): string {
  if (!src) {
    return "";
  }
  const withoutQuery = src.split(/[?#]/)[0] ?? src;
  const parts = withoutQuery.split(/[\\/]/);
  return parts[parts.length - 1] ?? withoutQuery;
}

/** Reads top-level `<video>`, `<audio>`, `<picture>` and `<iframe>` blocks. */
export function readMediaBlocks(state: EditorState): readonly MediaBlock[] {
  if (state.doc.length > MEDIA_BLOCK_MAX_UNITS) {
    return [];
  }
  const doc = state.doc;
  const copy = state.facet(editorUiCopy);
  const root = syntaxTree(state).topNode as unknown as MarkdownNode;
  const details = readDetailsBlocks(state);
  const blocks: MediaBlock[] = [];

  for (let child = root.firstChild; child; child = child.nextSibling) {
    if (child.name !== "HTMLBlock" && child.name !== "Paragraph") {
      continue;
    }
    const node = child;
    if (details.some((block) => node.from >= block.from && node.to <= block.to)) {
      continue;
    }
    const raw = doc.sliceString(node.from, node.to).trim();
    const tag = MEDIA_TAG.exec(raw);
    if (!tag) {
      continue;
    }
    const tagName = (tag[1] ?? "").toLowerCase();
    const kind = (tagName === "div" ? "center" : tagName) as MediaKind;
    if (kind === "img") {
      if (!/\/?>$/.test(raw)) {
        continue;
      }
    } else if (!new RegExp(`</${tagName}\\s*>$`, "i").test(raw)) {
      continue;
    }

    const opening = raw.slice(0, raw.indexOf(">") + 1);
    const attributes = parseAttributes(opening);
    if (kind === "center") {
      if ((attributes.get("align") ?? "").trim().toLowerCase() !== "center") {
        continue;
      }
      const innerEnd = raw.lastIndexOf("</div>");
      const inner = innerEnd > 0 ? raw.slice(raw.indexOf(">") + 1, innerEnd) : "";
      if (!IMG_TAG.test(inner) || inner.replace(IMG_TAG, "").trim()) {
        continue;
      }
    }

    const sources: MediaSource[] = [];
    SOURCE_TAG.lastIndex = 0;
    let sourceMatch: RegExpExecArray | null;
    while ((sourceMatch = SOURCE_TAG.exec(raw))) {
      const sourceAttributes = parseAttributes(sourceMatch[1] ?? "");
      sources.push({
        src: safeUrl(sourceAttributes.get("src")),
        srcset: safeSrcset(sourceAttributes.get("srcset")),
        type: sourceAttributes.get("type")?.trim() || null,
        media: sourceAttributes.get("media")?.trim() || null,
      });
    }

    const imgMatch = IMG_TAG.exec(raw);
    const imgAttributes = imgMatch ? parseAttributes(imgMatch[1] ?? "") : new Map<string, string>();
    const imageLike =
      kind === "picture" || kind === "figure" || kind === "img" || kind === "center";
    const src = imageLike ? safeUrl(imgAttributes.get("src")) : safeUrl(attributes.get("src"));
    const alt =
      (imgAttributes.get("alt") ?? attributes.get("alt") ?? "").trim() ||
      (kind === "iframe" ? (src ?? copy.media.externalPage) : "") ||
      fileNameOf(src) ||
      copy.media.image;
    const captionMatch = kind === "figure" ? FIGCAPTION.exec(raw) : null;
    const caption = captionMatch ? (captionMatch[1] ?? "").trim() || null : null;

    blocks.push({
      from: node.from,
      to: node.to,
      kind,
      raw,
      src,
      poster: safeUrl(attributes.get("poster")),
      alt,
      title: (imgAttributes.get("title") ?? attributes.get("title"))?.trim() || null,
      width: dimension(imageLike ? imgAttributes.get("width") : attributes.get("width")),
      height: dimension(imageLike ? imgAttributes.get("height") : attributes.get("height")),
      caption,
      sources,
    });
  }

  return blocks;
}

interface MediaState {
  ranges: readonly MediaBlock[];
  blocked: readonly MediaBlock[];
  insideKey: string;
  decorations: DecorationSet;
}

function emptyState(): MediaState {
  return { ranges: [], blocked: [], insideKey: "", decorations: Decoration.none };
}

function selectionTouches(state: EditorState, range: { from: number; to: number }): boolean {
  return state.selection.ranges.some(
    (selection) => selection.from <= range.to && selection.to >= range.from,
  );
}

function insideKey(state: EditorState, ranges: readonly MediaBlock[]): string {
  return ranges
    .map((range, index) => (selectionTouches(state, range) ? index : ""))
    .filter((value) => value !== "")
    .join(",");
}

function buildMedia(state: EditorState): MediaState {
  if (state.doc.length > MEDIA_BLOCK_MAX_UNITS) {
    return emptyState();
  }
  const ranges = readMediaBlocks(state);
  if (ranges.length === 0) {
    return emptyState();
  }

  const copy = state.facet(editorUiCopy);
  const decorations: ReturnType<Decoration["range"]>[] = [];
  for (const range of ranges) {
    if (!selectionTouches(state, range)) {
      decorations.push(
        Decoration.replace({
          block: true,
          widget: new MediaWidget(copy, range),
        }).range(range.from, range.to),
      );
    }
  }

  return {
    ranges,
    blocked: ranges,
    insideKey: insideKey(state, ranges),
    decorations: decorations.length > 0 ? Decoration.set(decorations, true) : Decoration.none,
  };
}

function mediaLabel(kind: MediaKind, copy: EditorUiCopy): string {
  switch (kind) {
    case "video":
      return copy.media.video;
    case "audio":
      return copy.media.audio;
    case "picture":
      return copy.media.gallery;
    case "figure":
      return copy.media.figure;
    case "img":
      return copy.media.image;
    case "center":
      return copy.media.centeredImage;
    default:
      return copy.media.embed;
  }
}

function appendFallback(
  container: HTMLElement,
  block: MediaBlock,
  copy: EditorUiCopy,
): HTMLElement {
  const fallback = document.createElement("div");
  fallback.className = "cm-md-media-fallback";

  const icon = document.createElement("span");
  icon.className = "cm-md-media-fallback-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = block.kind === "audio" ? "♪" : block.kind === "iframe" ? "↗" : "▧";

  const label = document.createElement("span");
  label.textContent = block.kind === "iframe" ? copy.media.externalBlocked : block.alt;
  if (block.kind === "iframe") {
    label.title = block.alt;
  }

  fallback.append(icon, label);
  container.append(fallback);
  return fallback;
}

function sourceButton(view: EditorView, from: number, copy: EditorUiCopy): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cm-md-media-edit";
  button.textContent = copy.media.source;
  button.title = copy.media.editSource;
  button.addEventListener("mousedown", (event) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    view.dispatch({ selection: { anchor: from }, scrollIntoView: true });
    view.focus();
  });
  return button;
}

function appendVideoOrAudio(
  container: HTMLElement,
  block: MediaBlock,
  fallback: HTMLElement,
): void {
  const element = document.createElement(block.kind) as HTMLVideoElement;
  element.className = "cm-md-media-element";
  element.controls = true;
  element.preload = "metadata";
  element.setAttribute("aria-label", block.alt);
  if (block.title) {
    element.title = block.title;
  }
  if (block.poster) {
    element.poster = block.poster;
  }
  if (block.width) {
    element.setAttribute("width", block.width);
  }
  if (block.height) {
    element.setAttribute("height", block.height);
  }

  for (const source of block.sources) {
    const sourceElement = document.createElement("source");
    if (source.src) {
      sourceElement.src = source.src;
    }
    if (source.srcset) {
      sourceElement.srcset = source.srcset;
    }
    if (source.type) {
      sourceElement.type = source.type;
    }
    if (source.media) {
      sourceElement.media = source.media;
    }
    element.append(sourceElement);
  }
  if (block.src) {
    element.src = block.src;
  }

  const showFallback = () => {
    element.remove();
    fallback.hidden = false;
  };
  element.addEventListener("error", showFallback, { once: true });
  if (!block.src && block.sources.length === 0) {
    showFallback();
    return;
  }
  container.append(element);
}

function appendPicture(container: HTMLElement, block: MediaBlock, fallback: HTMLElement): void {
  const picture = document.createElement("picture");
  for (const source of block.sources) {
    const sourceElement = document.createElement("source");
    if (source.srcset) {
      sourceElement.srcset = source.srcset;
    }
    if (source.type) {
      sourceElement.type = source.type;
    }
    if (source.media) {
      sourceElement.media = source.media;
    }
    picture.append(sourceElement);
  }

  const image = document.createElement("img");
  image.className = "cm-md-media-image";
  image.alt = block.alt;
  image.loading = "lazy";
  image.referrerPolicy = "no-referrer";
  if (block.title) {
    image.title = block.title;
  }
  if (block.width) {
    image.setAttribute("width", block.width);
  }
  if (block.height) {
    image.setAttribute("height", block.height);
  }
  if (block.src) {
    image.src = block.src;
  }
  image.addEventListener(
    "error",
    () => {
      picture.remove();
      fallback.hidden = false;
    },
    { once: true },
  );
  if (!block.src && block.sources.length === 0) {
    fallback.hidden = false;
    return;
  }
  picture.append(image);
  container.append(picture);
}

function createMediaImage(block: MediaBlock): HTMLImageElement {
  const image = document.createElement("img");
  image.className = "cm-md-media-image";
  image.alt = block.alt;
  image.loading = "lazy";
  image.referrerPolicy = "no-referrer";
  if (block.title) {
    image.title = block.title;
  }
  if (block.width) {
    image.setAttribute("width", block.width);
  }
  if (block.height) {
    image.setAttribute("height", block.height);
  }
  if (block.src) {
    image.src = block.src;
  }
  return image;
}

function appendImage(
  container: HTMLElement,
  block: MediaBlock,
  fallback: HTMLElement,
  copy: EditorUiCopy,
): void {
  const image = createMediaImage(block);
  const showFallback = () => {
    image.remove();
    fallback.hidden = false;
  };
  image.addEventListener("error", showFallback, { once: true });

  if (!block.src) {
    showFallback();
    return;
  }

  if (block.kind === "figure") {
    const figure = document.createElement("figure");
    figure.className = "cm-md-figure";
    figure.append(image);
    if (block.caption) {
      const caption = document.createElement("figcaption");
      renderInlineMarkdown(caption, block.caption, copy);
      figure.append(caption);
    }
    container.append(figure);
    return;
  }

  if (block.kind === "center") {
    const center = document.createElement("div");
    center.className = "cm-md-center-image";
    center.append(image);
    container.append(center);
    return;
  }

  container.append(image);
}

class MediaWidget extends WidgetType {
  constructor(
    private readonly copy: EditorUiCopy,
    private readonly block: MediaBlock,
  ) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return (
      other instanceof MediaWidget &&
      other.copy.version === this.copy.version &&
      other.block.raw === this.block.raw
    );
  }

  override toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = `cm-md-media cm-md-media-${this.block.kind}`;
    wrapper.dataset.kind = this.block.kind;

    const header = document.createElement("div");
    header.className = "cm-md-media-header";

    const badge = document.createElement("span");
    badge.className = "cm-md-media-badge";
    badge.textContent = mediaLabel(this.block.kind, this.copy);

    const name = document.createElement("span");
    name.className = "cm-md-media-name";
    name.textContent =
      this.block.kind === "iframe"
        ? (this.block.src ?? this.block.alt)
        : fileNameOf(this.block.src) || this.block.alt;

    header.append(badge, name, sourceButton(view, this.block.from, this.copy));

    const body = document.createElement("div");
    body.className = "cm-md-media-body";
    const fallback = appendFallback(body, this.block, this.copy);
    fallback.hidden = true;

    if (this.block.kind === "picture") {
      appendPicture(body, this.block, fallback);
    } else if (this.block.kind === "iframe") {
      // Never mount an iframe: external pages stay inert and only the source
      // URL is shown. The user can still open the source with the button.
      fallback.hidden = false;
    } else if (
      this.block.kind === "img" ||
      this.block.kind === "figure" ||
      this.block.kind === "center"
    ) {
      appendImage(body, this.block, fallback, this.copy);
    } else {
      appendVideoOrAudio(body, this.block, fallback);
    }

    // The padding-only root carries the measured spacing; the bordered card is
    // an inner element so CodeMirror's height map stays aligned.
    const card = document.createElement("div");
    card.className = "cm-md-media-card";
    card.append(header, body);
    wrapper.append(card);
    wrapper.addEventListener("mousedown", (event) => {
      event.stopPropagation();
    });
    return wrapper;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

export const mediaBlockPreview = StateField.define<MediaState>({
  create: buildMedia,
  update(value, transaction) {
    const treeChanged = syntaxTree(transaction.state) !== syntaxTree(transaction.startState);
    if (editorCopyChanged(transaction) || transaction.docChanged || treeChanged) {
      return buildMedia(transaction.state);
    }
    if (!transaction.newSelection.eq(transaction.startState.selection)) {
      if (insideKey(transaction.state, value.ranges) !== value.insideKey) {
        return buildMedia(transaction.state);
      }
    }
    return value;
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    EditorView.atomicRanges.of((view) => view.state.field(field).decorations),
  ],
});
