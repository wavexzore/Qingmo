import type { MermaidDiagramKind } from "./mermaid-theme";

/**
 * Mermaid sizes nodes from label metrics measured inside the sandbox iframe and
 * then writes the label position from that same measurement. Two problems can
 * survive into the editor:
 *
 * - Cylinder-style shapes offset the label by `-bbox.width / 2`, while the
 *   label text is also centred with `text-anchor: middle` when the browser
 *   reports `bbox.x === 0`. The result is a label shifted half a width to the
 *   left of its own shape.
 * - The host document may resolve the label font differently from the sandbox
 *   (system fonts unavailable to the webview process). The shape keeps the
 *   sandbox width and the longer glyph run spills out of both sides.
 *
 * Both are fixed after import, where the real rendered metrics are available:
 * centre the label on the node and, when it still overflows, scale only that
 * label down until it fits inside the shape.
 */

/** Minimum horizontal breathing room between a label and its shape. */
const LABEL_PADDING_X = 8;
/** Smallest font size the fit pass is allowed to produce. */
const MIN_LABEL_FONT_SIZE = 10;

const TRANSLATE = /translate\(\s*(-?[\d.eE+]+)[\s,]+(-?[\d.eE+]+)\s*\)/;

/**
 * Returns a translate with its horizontal component removed. The label text is
 * centred by CSS, so any horizontal pre-offset would shift it twice.
 */
export function centeredLabelTransform(transform: string | null): string | null {
  const match = TRANSLATE.exec(transform ?? "");
  if (!match) {
    return null;
  }
  const y = Number(match[2]);
  if (!Number.isFinite(y)) {
    return null;
  }
  return `translate(0, ${y})`;
}

/** Font size that makes `labelWidth` fit in `boxWidth` without growing. */
export function fittedLabelFontSize(
  current: number,
  labelWidth: number,
  boxWidth: number,
): number | null {
  if (!(current > 0) || !(labelWidth > 0) || !(boxWidth > 0)) {
    return null;
  }
  const available = boxWidth - LABEL_PADDING_X * 2;
  if (available <= 0 || labelWidth <= available) {
    return null;
  }
  const next = Math.max(MIN_LABEL_FONT_SIZE, (current * available) / labelWidth);
  return next < current ? next : null;
}

const SHAPE_TAGS = new Set(["path", "rect", "circle", "ellipse", "polygon", "polyline"]);

function nodeShape(node: SVGGElement, label: SVGGElement): SVGGraphicsElement | null {
  for (const child of Array.from(node.children)) {
    if (child === label || !SHAPE_TAGS.has(child.localName)) {
      continue;
    }
    return child as SVGGraphicsElement;
  }
  return null;
}

function shrinkToFit(label: SVGGElement, shape: SVGGraphicsElement): boolean {
  const text = label.querySelector("text");
  if (!text) {
    return false;
  }
  const boxWidth = shape.getBBox().width;
  const labelWidth = label.getBBox().width;
  const current = Number.parseFloat(getComputedStyle(text).fontSize);
  const next = fittedLabelFontSize(current, labelWidth, boxWidth);
  if (next === null) {
    return false;
  }
  text.style.fontSize = `${next.toFixed(2)}px`;
  return true;
}

/**
 * Corrects labels on flowchart nodes after the SVG reached the host document.
 * Returns the number of labels moved back to the node axis or resized.
 */
export function fitMermaidNodeLabels(root: SVGSVGElement, kind: MermaidDiagramKind): number {
  if (kind !== "flowchart") {
    return 0;
  }
  let corrected = 0;
  for (const node of Array.from(root.querySelectorAll<SVGGElement>("g.node"))) {
    const label = Array.from(node.children).find(
      (child): child is SVGGElement =>
        child instanceof SVGGElement && child.classList.contains("label"),
    );
    if (!label) {
      continue;
    }
    const text = label.querySelector("text");
    if (!text || getComputedStyle(text).textAnchor !== "middle") {
      continue;
    }
    let touched = false;
    const centered = centeredLabelTransform(label.getAttribute("transform"));
    if (centered && centered !== label.getAttribute("transform")) {
      label.setAttribute("transform", centered);
      touched = true;
    }
    const shape = nodeShape(node, label);
    if (shape && shrinkToFit(label, shape)) {
      touched = true;
    }
    if (touched) {
      corrected += 1;
    }
  }
  return corrected;
}
