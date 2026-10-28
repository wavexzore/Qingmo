import { EditorView, WidgetType } from "@codemirror/view";
import katex from "katex";

import type { EditorUiCopy } from "../i18n";
import { inlineHtmlElement, renderInlineMarkdown } from "./inline-render";
import type { LivePreviewWidgetSpec } from "./specs";

class BulletWidget extends WidgetType {
  override eq(other: WidgetType): boolean {
    return other instanceof BulletWidget;
  }

  override toDOM(): HTMLElement {
    const bullet = document.createElement("span");
    bullet.className = "cm-md-bullet";
    bullet.setAttribute("aria-hidden", "true");
    bullet.textContent = "•";
    return bullet;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

class TaskWidget extends WidgetType {
  constructor(
    private readonly copy: EditorUiCopy,
    private readonly checked: boolean,
    private readonly from: number,
    private readonly to: number,
  ) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return (
      other instanceof TaskWidget &&
      other.copy.version === this.copy.version &&
      other.checked === this.checked &&
      other.from === this.from &&
      other.to === this.to
    );
  }

  override toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className = "cm-md-task";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = this.checked;
    input.disabled = view.state.readOnly;
    input.tabIndex = -1;
    input.setAttribute("aria-label", this.copy.widgets.taskToggle);
    input.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (view.state.readOnly) {
        return;
      }
      view.dispatch({
        changes: {
          from: this.from,
          to: this.to,
          insert: this.checked ? "[ ]" : "[x]",
        },
      });
    });

    wrapper.append(input);
    return wrapper;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

class RuleWidget extends WidgetType {
  override eq(other: WidgetType): boolean {
    return other instanceof RuleWidget;
  }

  override toDOM(): HTMLElement {
    const rule = document.createElement("span");
    rule.className = "cm-md-rule";
    rule.setAttribute("role", "separator");
    return rule;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

class ImageWidget extends WidgetType {
  constructor(
    private readonly src: string,
    private readonly alt: string,
    private readonly title: string | null,
    private readonly width: string | null,
    private readonly height: string | null,
  ) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return (
      other instanceof ImageWidget &&
      other.src === this.src &&
      other.alt === this.alt &&
      other.title === this.title &&
      other.width === this.width &&
      other.height === this.height
    );
  }

  override toDOM(): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className = "cm-md-image";
    wrapper.title = this.title ?? this.src;

    const icon = document.createElement("span");
    icon.className = "cm-md-image-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "▧";

    const fallback = document.createElement("span");
    fallback.className = "cm-md-image-fallback";
    fallback.textContent = this.alt || fileNameOf(this.src) || this.src;

    wrapper.append(icon, fallback);

    if (this.src.length > 0) {
      const image = document.createElement("img");
      image.alt = this.alt;
      image.loading = "lazy";
      image.referrerPolicy = "no-referrer";
      image.addEventListener("error", () => {
        image.remove();
      });
      image.addEventListener("load", () => {
        icon.remove();
        fallback.remove();
      });
      if (this.width) {
        image.setAttribute("width", this.width);
      }
      if (this.height) {
        image.setAttribute("height", this.height);
      }
      image.src = this.src;
      wrapper.append(image);
    }

    return wrapper;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

const EXTERNAL_DIAGRAM_LANGUAGES: Readonly<Record<string, string>> = Object.freeze({
  plantuml: "PlantUML",
  dot: "Graphviz DOT",
  graphviz: "Graphviz",
  d2: "D2",
  drawio: "draw.io",
  excalidraw: "Excalidraw",
});

class CodeLanguageWidget extends WidgetType {
  constructor(
    private readonly copy: EditorUiCopy,
    private readonly language: string,
    private readonly title: string | null,
  ) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return (
      other instanceof CodeLanguageWidget &&
      other.copy.version === this.copy.version &&
      other.language === this.language &&
      other.title === this.title
    );
  }

  override toDOM(): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className = "cm-md-code-info";

    const badge = document.createElement("span");
    badge.className = "cm-md-code-language";
    badge.textContent = this.language || "code";
    wrapper.append(badge);

    if (this.title) {
      const title = document.createElement("span");
      title.className = "cm-md-code-title";
      title.textContent = this.title;
      wrapper.append(title);
    }

    const external = EXTERNAL_DIAGRAM_LANGUAGES[this.language.trim().toLowerCase()];
    if (external) {
      const hint = document.createElement("span");
      hint.className = "cm-md-code-external";
      hint.textContent = this.copy.widgets.externalRender;
      hint.title = this.copy.widgets.externalRenderHint(external);
      wrapper.append(hint);
    }

    return wrapper;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

class EntityWidget extends WidgetType {
  constructor(private readonly raw: string) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return other instanceof EntityWidget && other.raw === this.raw;
  }

  override toDOM(): HTMLElement {
    const entity = document.createElement("span");
    entity.className = "cm-md-entity";
    entity.textContent = decodeEntity(this.raw);
    return entity;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

class EmojiWidget extends WidgetType {
  constructor(private readonly char: string) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return other instanceof EmojiWidget && other.char === this.char;
  }

  override toDOM(): HTMLElement {
    const emoji = document.createElement("span");
    emoji.className = "cm-md-emoji";
    emoji.textContent = this.char;
    return emoji;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

class InlineHtmlWidget extends WidgetType {
  constructor(
    private readonly copy: EditorUiCopy,
    private readonly tag: string,
    private readonly content: string,
  ) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return (
      other instanceof InlineHtmlWidget &&
      other.copy.version === this.copy.version &&
      other.tag === this.tag &&
      other.content === this.content
    );
  }

  override toDOM(): HTMLElement {
    const element = inlineHtmlElement(this.tag);
    if (!element) {
      const fallback = document.createElement("span");
      fallback.textContent = this.content;
      return fallback;
    }
    renderInlineMarkdown(element, this.content, this.copy);
    return element;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

class AlertWidget extends WidgetType {
  constructor(private readonly label: string) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return other instanceof AlertWidget && other.label === this.label;
  }

  override toDOM(): HTMLElement {
    const label = document.createElement("span");
    label.className = `cm-md-alert-label cm-md-alert-label-${this.label.toLowerCase()}`;
    label.textContent = this.label;
    return label;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

class AttributesWidget extends WidgetType {
  constructor(
    private readonly copy: EditorUiCopy,
    private readonly label: string,
  ) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return (
      other instanceof AttributesWidget &&
      other.copy.version === this.copy.version &&
      other.label === this.label
    );
  }

  override toDOM(): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className = "cm-md-attr-badge";

    const badge = document.createElement("span");
    badge.className = "cm-md-attr-badge-label";
    badge.textContent = this.copy.widgets.attributes;

    const value = document.createElement("span");
    value.className = "cm-md-attr-badge-value";
    value.textContent = this.label;

    wrapper.append(badge, value);
    return wrapper;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

class FootnoteRefWidget extends WidgetType {
  constructor(
    private readonly copy: EditorUiCopy,
    private readonly label: string,
    private readonly lineFrom: number | null,
  ) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return (
      other instanceof FootnoteRefWidget &&
      other.copy.version === this.copy.version &&
      other.label === this.label &&
      other.lineFrom === this.lineFrom
    );
  }

  override toDOM(view: EditorView): HTMLElement {
    const reference = document.createElement("span");
    reference.className = "cm-md-footnote-ref";
    reference.textContent = this.label;

    if (this.lineFrom !== null) {
      reference.classList.add("cm-md-footnote-jump");
      reference.title = this.copy.widgets.footnoteJump;
      reference.addEventListener("mousedown", (event) => {
        if (event.button !== 0) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        view.dispatch({
          selection: { anchor: this.lineFrom ?? 0 },
          scrollIntoView: true,
        });
        view.focus();
      });
      reference.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
    }

    return reference;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

class FootnoteDefWidget extends WidgetType {
  constructor(private readonly label: string) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return other instanceof FootnoteDefWidget && other.label === this.label;
  }

  override toDOM(): HTMLElement {
    const label = document.createElement("span");
    label.className = "cm-md-footnote-def-label";
    label.textContent = `${this.label}.`;
    return label;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

class InlineFootnoteWidget extends WidgetType {
  constructor(
    private readonly copy: EditorUiCopy,
    private readonly label: string,
    private readonly content: string,
  ) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return (
      other instanceof InlineFootnoteWidget &&
      other.copy.version === this.copy.version &&
      other.label === this.label &&
      other.content === this.content
    );
  }

  override toDOM(): HTMLElement {
    const note = document.createElement("span");
    note.className = "cm-md-footnote-inline";
    note.textContent = this.label;
    note.title = this.content;
    note.setAttribute("aria-label", this.copy.widgets.inlineFootnote(this.content));
    return note;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

class MathWidget extends WidgetType {
  constructor(private readonly tex: string) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return other instanceof MathWidget && other.tex === this.tex;
  }

  override toDOM(): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className = "cm-md-math-inline";
    renderTeX(wrapper, this.tex, false);
    return wrapper;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

class AbbreviationWidget extends WidgetType {
  constructor(
    private readonly copy: EditorUiCopy,
    private readonly term: string,
    private readonly definition: string,
  ) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return (
      other instanceof AbbreviationWidget &&
      other.copy.version === this.copy.version &&
      other.term === this.term &&
      other.definition === this.definition
    );
  }

  override toDOM(): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className = "cm-md-abbr-def";
    wrapper.title = `${this.term}: ${this.definition}`;

    const badge = document.createElement("span");
    badge.className = "cm-md-abbr-def-badge";
    badge.textContent = this.copy.widgets.abbreviation;

    const term = document.createElement("span");
    term.className = "cm-md-abbr-def-term";
    term.textContent = this.term;

    const definition = document.createElement("span");
    definition.className = "cm-md-abbr-def-value";
    definition.textContent = this.definition;

    wrapper.append(badge, term, definition);
    return wrapper;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

class WikiLinkWidget extends WidgetType {
  constructor(
    private readonly copy: EditorUiCopy,
    private readonly target: string,
    private readonly label: string,
    private readonly embed: boolean,
  ) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return (
      other instanceof WikiLinkWidget &&
      other.copy.version === this.copy.version &&
      other.target === this.target &&
      other.label === this.label &&
      other.embed === this.embed
    );
  }

  override toDOM(): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className = this.embed ? "cm-md-wiki-link cm-md-wiki-embed" : "cm-md-wiki-link";
    wrapper.title = this.embed
      ? this.copy.widgets.wikiEmbed(this.target)
      : this.copy.widgets.wikiLink(this.target);

    const icon = document.createElement("span");
    icon.className = "cm-md-wiki-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = this.embed ? "⧉" : "↗";

    const label = document.createElement("span");
    label.className = "cm-md-wiki-label";
    label.textContent = this.label;

    wrapper.append(icon, label);
    return wrapper;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

class HtmlAnchorWidget extends WidgetType {
  constructor(
    private readonly copy: EditorUiCopy,
    private readonly label: string,
  ) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return (
      other instanceof HtmlAnchorWidget &&
      other.copy.version === this.copy.version &&
      other.label === this.label
    );
  }

  override toDOM(): HTMLElement {
    const anchor = document.createElement("span");
    anchor.className = "cm-md-html-anchor";
    anchor.title = this.copy.widgets.htmlAnchor(this.label);

    const icon = document.createElement("span");
    icon.className = "cm-md-html-anchor-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "⚓";

    const label = document.createElement("span");
    label.textContent = this.label;

    anchor.append(icon, label);
    return anchor;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

class AnchorLinkWidget extends WidgetType {
  constructor(
    private readonly copy: EditorUiCopy,
    private readonly label: string,
    private readonly href: string,
    private readonly lineFrom: number,
  ) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return (
      other instanceof AnchorLinkWidget &&
      other.copy.version === this.copy.version &&
      other.label === this.label &&
      other.href === this.href &&
      other.lineFrom === this.lineFrom
    );
  }

  override toDOM(view: EditorView): HTMLElement {
    const link = document.createElement("span");
    link.className = "cm-md-anchor-link";
    link.title = this.copy.widgets.anchorJump(this.href);
    renderInlineMarkdown(link, this.label || this.href, this.copy);

    link.addEventListener("mousedown", (event) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({
        selection: { anchor: this.lineFrom },
        scrollIntoView: true,
      });
      view.focus();
    });
    link.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });

    return link;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/** Shared KaTeX entry point; untrusted TeX cannot emit links or HTML. */
export function renderTeX(target: HTMLElement, tex: string, displayMode: boolean): void {
  try {
    katex.render(tex, target, {
      displayMode,
      throwOnError: false,
      trust: false,
      strict: "ignore",
      errorColor: "var(--qm-danger)",
    });
  } catch {
    target.textContent = tex;
  }
}

/**
 * CommonMark renders entities as their Unicode character. Numeric entities are
 * decoded directly; named entities reuse the browser's entity table through a
 * textarea, which stays inert even if the entity spells out markup.
 */
function decodeEntity(raw: string): string {
  if (raw.startsWith("&#")) {
    const hex = raw[2] === "x" || raw[2] === "X";
    const digits = raw.slice(hex ? 3 : 2, -1);
    const value = Number.parseInt(digits, hex ? 16 : 10);
    if (
      Number.isFinite(value) &&
      value > 0 &&
      value <= 0x10ffff &&
      !(value >= 0xd800 && value <= 0xdfff)
    ) {
      return String.fromCodePoint(value);
    }
    return raw;
  }

  const textarea = document.createElement("textarea");
  textarea.innerHTML = raw;
  return textarea.value || raw;
}

function fileNameOf(src: string): string {
  const withoutQuery = src.split(/[?#]/)[0] ?? src;
  const parts = withoutQuery.split(/[\\/]/);
  return parts[parts.length - 1] ?? withoutQuery;
}

export function createLivePreviewWidget(
  spec: LivePreviewWidgetSpec,
  from: number,
  to: number,
  copy: EditorUiCopy,
): WidgetType {
  switch (spec.kind) {
    case "bullet":
      return new BulletWidget();
    case "task":
      return new TaskWidget(copy, spec.checked, from, to);
    case "rule":
      return new RuleWidget();
    case "image":
      return new ImageWidget(spec.src, spec.alt, spec.title, spec.width, spec.height);
    case "code-language":
      return new CodeLanguageWidget(copy, spec.language, spec.title);
    case "entity":
      return new EntityWidget(spec.raw);
    case "emoji":
      return new EmojiWidget(spec.char);
    case "inline-html":
      return new InlineHtmlWidget(copy, spec.tag, spec.content);
    case "alert":
      return new AlertWidget(spec.label);
    case "footnote-ref":
      return new FootnoteRefWidget(copy, spec.label, spec.lineFrom);
    case "footnote-def":
      return new FootnoteDefWidget(spec.label);
    case "inline-footnote":
      return new InlineFootnoteWidget(copy, spec.label, spec.content);
    case "math":
      return new MathWidget(spec.tex);
    case "abbreviation":
      return new AbbreviationWidget(copy, spec.term, spec.definition);
    case "wiki-link":
      return new WikiLinkWidget(copy, spec.target, spec.label, spec.embed);
    case "anchor-link":
      return new AnchorLinkWidget(copy, spec.label, spec.href, spec.lineFrom);
    case "html-anchor":
      return new HtmlAnchorWidget(copy, spec.label);
    case "attributes":
      return new AttributesWidget(copy, spec.label);
  }
}
