/**
 * Mermaid returns SVG. Even with `securityLevel: "strict"`, the diagram is
 * generated from user-authored text, so it is parsed and reduced to a small
 * SVG subset before it enters the editor DOM.
 *
 * The markup is parsed as HTML instead of XML: Mermaid can emit HTML labels
 * and named entities (`&nbsp;`) that are invalid in an XML document, and a
 * tolerant parse lets the sanitizer inspect and remove those nodes instead of
 * rejecting the whole diagram.
 */
const ALLOWED_TAGS = new Set([
  "svg",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "defs",
  "marker",
  "clippath",
  "lineargradient",
  "radialgradient",
  "stop",
  "style",
  "title",
  "desc",
  "pattern",
  "mask",
  "filter",
  "fegaussianblur",
  "fedropshadow",
  "fecolormatrix",
  "fecomponenttransfer",
  "fefuncr",
  "fefuncg",
  "fefuncb",
  "fefunca",
  "feoffset",
  "feblend",
  "femerge",
  "femergenode",
  "feflood",
  "fecomposite",
  "femorphology",
  "feturbulence",
  "fedisplacementmap",
]);

const DANGEROUS_ATTRIBUTES = new Set(["href", "xlink:href", "src", "action", "formaction"]);

const EXTERNAL_URL = /url\(\s*['"]?(?:https?:|javascript:|data:)/i;

function sanitizeStyleText(value: string): string {
  return value
    .replace(/@import[^;]+;?/gi, "")
    .replace(/url\(\s*['"]?(?:https?:|javascript:|data:)[^)]*\)/gi, "none")
    .replace(/expression\s*\(/gi, "")
    .replace(/behavior\s*:/gi, "");
}

function sanitizeElement(element: Element): void {
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === 8 || child.nodeType === 7) {
      child.remove();
      continue;
    }
    if (child.nodeType !== 1) {
      continue;
    }
    const childElement = child as Element;
    if (!ALLOWED_TAGS.has(childElement.localName.toLowerCase())) {
      childElement.remove();
      continue;
    }
    sanitizeElement(childElement);
  }

  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase();
    if (name.startsWith("on") || DANGEROUS_ATTRIBUTES.has(name)) {
      element.removeAttribute(attribute.name);
      continue;
    }
    if (name === "style" || name === "fill" || name === "stroke" || name === "filter") {
      if (EXTERNAL_URL.test(attribute.value)) {
        element.removeAttribute(attribute.name);
      }
    }
  }

  if (element.localName.toLowerCase() === "style") {
    element.textContent = sanitizeStyleText(element.textContent ?? "");
  }
}

export function sanitizeMermaidSvg(svg: string): string {
  if (typeof DOMParser === "undefined" || typeof XMLSerializer === "undefined") {
    return "";
  }
  const parsed = new DOMParser().parseFromString(svg, "text/html");
  const root = parsed.body.querySelector("svg");
  if (!root || root.localName.toLowerCase() !== "svg") {
    return "";
  }
  sanitizeElement(root);
  return new XMLSerializer().serializeToString(root);
}
