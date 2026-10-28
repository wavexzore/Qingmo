import { DEFAULT_EDITOR_UI_COPY, type EditorUiCopy } from "../i18n";
import { emojiForName } from "./emoji";

const ESCAPED_CHAR = /^\\([\\`*_{}[\]()#+\-.!|>~^=])/;
const CODE_SPAN = /^`([^`\n]+)`/;
const WIKI_EMBED = /^!\[\[([^[\]\n]+)\]\]/;
const WIKI_LINK = /^\[\[([^[\]\n]+)\]\]/;
const LINK = /^\[([^\]\n]+)\]\(\s*([^\s)]+)(?:\s+(?:"([^"]*)"|'([^']*)'))?\s*\)/;
const AUTOLINK = /^<((?:https?:\/\/|mailto:)[^>\s]+)>/i;
const STRONG_EM = /^\*\*\*([^*\n]+)\*\*\*/;
const STRONG_STAR = /^\*\*(?!\*)([^\n]+?)\*\*/;
const STRONG_UNDER = /^__(?!_)([^\n]+?)__/;
const STRIKE = /^~~(?!~)([^\n]+?)~~/;
const HIGHLIGHT = /^==(?!=)([^=\n]+?)==/;
const EM_STAR = /^\*(?!\*)([^*\n]+)\*/;
const EM_UNDER = /^_(?!_)([^_\n]+)_/;
const SUBSCRIPT = /^~(?!~)([^~\s<>]+)~/;
const SUPERSCRIPT = /^\^(?!\^)([^^\s<>]+)\^/;
const EMOJI_SHORTCODE = /^:([a-z0-9_+-]+):/i;
const HTML_BR = /^<br\s*\/?>/i;
const HTML_PAIRED = /^<(sub|sup|u|s|del|mark|ins|b|strong|i|em|code|kbd)>([\s\S]*?)<\/\1\s*>/i;

/**
 * Safe inline HTML subset. Unknown tags stay literal text. Attributes are not
 * supported anywhere in this renderer.
 */
export const INLINE_HTML_TAGS: Readonly<Record<string, string>> = Object.freeze({
  b: "strong",
  strong: "strong",
  i: "em",
  em: "em",
  u: "u",
  ins: "ins",
  s: "s",
  del: "del",
  mark: "mark",
  sub: "sub",
  sup: "sup",
  code: "code",
  kbd: "kbd",
});

export function inlineHtmlElement(tag: string): HTMLElement | null {
  const elementTag = INLINE_HTML_TAGS[tag];
  if (!elementTag) {
    return null;
  }
  const element = document.createElement(elementTag);
  if (elementTag === "mark") {
    element.className = "cm-md-highlight";
  } else if (elementTag === "code") {
    element.className = "cm-md-inline-code";
  } else if (elementTag === "kbd") {
    element.className = "cm-md-kbd";
  }
  return element;
}

export function renderInlineMarkdown(
  parent: HTMLElement,
  raw: string,
  copy: EditorUiCopy = DEFAULT_EDITOR_UI_COPY,
): void {
  renderInlineTokens(parent, raw.replace(/\\\|/g, "|"), copy);
}

function appendElement(
  parent: HTMLElement,
  tag: string,
  className: string | null,
  content: string,
  copy: EditorUiCopy,
): void {
  const element = document.createElement(tag);
  if (className) {
    element.className = className;
  }
  renderInlineTokens(element, content, copy);
  parent.append(element);
}

function capture(match: RegExpExecArray, index: number): string {
  return match[index] ?? "";
}

function appendText(parent: HTMLElement, className: string, text: string): void {
  const element = document.createElement("span");
  element.className = className;
  element.textContent = text;
  parent.append(element);
}

function appendWikiLink(
  parent: HTMLElement,
  inner: string,
  embed: boolean,
  copy: EditorUiCopy,
): boolean {
  const [targetPart, alias] = inner.split("|", 2);
  const target = (targetPart ?? "").trim();
  if (!target) {
    return false;
  }
  const wrapper = document.createElement("span");
  wrapper.className = embed ? "cm-md-wiki-link cm-md-wiki-embed" : "cm-md-wiki-link";
  wrapper.title = embed ? copy.widgets.wikiEmbed(target) : copy.widgets.wikiLink(target);

  const icon = document.createElement("span");
  icon.className = "cm-md-wiki-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = embed ? "⧉" : "↗";

  const label = document.createElement("span");
  label.className = "cm-md-wiki-label";
  label.textContent = (alias ?? target).trim();

  wrapper.append(icon, label);
  parent.append(wrapper);
  return true;
}

/**
 * Minimal, DOM-only inline renderer shared by table cells and inline HTML
 * widgets. It never uses innerHTML, so document text cannot inject markup.
 * Inline HTML is limited to a small tag whitelist without attributes;
 * everything else stays text.
 */
function renderInlineTokens(parent: HTMLElement, text: string, copy: EditorUiCopy): void {
  let index = 0;
  let pending = "";

  const flush = () => {
    if (pending) {
      parent.append(document.createTextNode(pending));
      pending = "";
    }
  };

  while (index < text.length) {
    const rest = text.slice(index);
    let match: RegExpExecArray | null;

    if ((match = ESCAPED_CHAR.exec(rest))) {
      pending += capture(match, 1);
      index += match[0].length;
      continue;
    }

    if ((match = CODE_SPAN.exec(rest))) {
      flush();
      const code = document.createElement("code");
      code.className = "cm-md-inline-code";
      code.textContent = capture(match, 1);
      parent.append(code);
      index += match[0].length;
      continue;
    }

    if ((match = EMOJI_SHORTCODE.exec(rest))) {
      const emoji = emojiForName(capture(match, 1));
      if (emoji) {
        flush();
        appendText(parent, "cm-md-emoji", emoji);
        index += match[0].length;
        continue;
      }
    }

    if ((match = WIKI_EMBED.exec(rest))) {
      flush();
      if (appendWikiLink(parent, capture(match, 1), true, copy)) {
        index += match[0].length;
        continue;
      }
    }

    if ((match = WIKI_LINK.exec(rest))) {
      flush();
      if (appendWikiLink(parent, capture(match, 1), false, copy)) {
        index += match[0].length;
        continue;
      }
    }

    if ((match = LINK.exec(rest))) {
      flush();
      const link = document.createElement("span");
      link.className = "cm-md-link";
      link.title = capture(match, 2);
      renderInlineTokens(link, capture(match, 1), copy);
      parent.append(link);
      index += match[0].length;
      continue;
    }

    if ((match = STRONG_EM.exec(rest))) {
      flush();
      const strong = document.createElement("strong");
      strong.className = "cm-md-strong";
      appendElement(strong, "em", "cm-md-em", capture(match, 1), copy);
      parent.append(strong);
      index += match[0].length;
      continue;
    }

    if ((match = STRONG_STAR.exec(rest)) || (match = STRONG_UNDER.exec(rest))) {
      flush();
      appendElement(parent, "strong", "cm-md-strong", capture(match, 1), copy);
      index += match[0].length;
      continue;
    }

    if ((match = STRIKE.exec(rest))) {
      flush();
      appendElement(parent, "span", "cm-md-strike", capture(match, 1), copy);
      index += match[0].length;
      continue;
    }

    if ((match = HIGHLIGHT.exec(rest))) {
      flush();
      appendElement(parent, "mark", "cm-md-highlight", capture(match, 1), copy);
      index += match[0].length;
      continue;
    }

    if ((match = EM_STAR.exec(rest)) || (match = EM_UNDER.exec(rest))) {
      flush();
      appendElement(parent, "em", "cm-md-em", capture(match, 1), copy);
      index += match[0].length;
      continue;
    }

    if ((match = SUBSCRIPT.exec(rest))) {
      flush();
      appendElement(parent, "sub", "cm-md-sub", capture(match, 1), copy);
      index += match[0].length;
      continue;
    }

    if ((match = SUPERSCRIPT.exec(rest))) {
      flush();
      appendElement(parent, "sup", "cm-md-sup", capture(match, 1), copy);
      index += match[0].length;
      continue;
    }

    if ((match = HTML_PAIRED.exec(rest))) {
      flush();
      const element = inlineHtmlElement(capture(match, 1).toLowerCase());
      if (element) {
        renderInlineTokens(element, capture(match, 2), copy);
        parent.append(element);
        index += match[0].length;
        continue;
      }
    }

    if ((match = HTML_BR.exec(rest))) {
      flush();
      parent.append(document.createElement("br"));
      index += match[0].length;
      continue;
    }

    if ((match = AUTOLINK.exec(rest))) {
      flush();
      const link = document.createElement("span");
      link.className = "cm-md-link";
      link.title = capture(match, 1);
      link.textContent = capture(match, 1);
      parent.append(link);
      index += match[0].length;
      continue;
    }

    pending += rest.charAt(0);
    index += 1;
  }

  flush();
}
