import type { MermaidDiagramKind, MermaidPalette } from "@qingmo/editor-core/mermaid-theme";

interface Point {
  x: number;
  y: number;
}

export interface NodeBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
}

interface RectBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

const EXTERNAL_LABELS: Record<string, string> = {
  "c4-external_system": "External System",
  "c4-external_person": "External Person",
  "c4-external_container": "External Container",
  "c4-external_component": "External Component",
};

export function externalTypeLabel(className: string): string | null {
  return EXTERNAL_LABELS[className] ?? null;
}

/**
 * Mermaid draws a C4 person as a circle plus a rounded rectangle. Merge them
 * into one outline so the internal arc does not read as a second component.
 */
export function buildPersonSilhouette(
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  headX: number,
  headY: number,
  headRadius: number,
): string | null {
  const values = [x, y, width, height, radius, headX, headY, headRadius];
  if (!values.every(Number.isFinite)) {
    return null;
  }
  if (width <= 0 || height <= 0 || headRadius <= 0 || radius < 0) {
    return null;
  }
  const dy = y - headY;
  if (dy <= 0 || dy >= headRadius) {
    return null;
  }
  const dx = Math.sqrt(Math.max(0, headRadius * headRadius - dy * dy));
  const left = headX - dx;
  const right = headX + dx;
  const x1 = x + width;
  const y1 = y + height;
  const r = Math.min(radius, width / 2, height / 2);
  return [
    `M${x},${y + r}`,
    `Q${x},${y} ${x + r},${y}`,
    `L${left},${y}`,
    `A${headRadius},${headRadius} 0 1 1 ${right},${y}`,
    `L${x1 - r},${y}`,
    `Q${x1},${y} ${x1},${y + r}`,
    `L${x1},${y1 - r}`,
    `Q${x1},${y1} ${x1 - r},${y1}`,
    `L${x + r},${y1}`,
    `Q${x},${y1} ${x},${y1 - r}`,
    "Z",
  ].join(" ");
}

function isPoint(value: unknown): value is Point {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const point = value as Record<string, unknown>;
  return typeof point.x === "number" && typeof point.y === "number";
}

function decodePoints(value: string | null): Point[] | null {
  if (!value) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(atob(value));
    if (!Array.isArray(parsed) || !parsed.every(isPoint) || parsed.length < 2) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function encodePoints(points: Point[]): string {
  return btoa(JSON.stringify(points));
}

export interface ArrowSegment {
  start: Point;
  end: Point;
}

/** Arrowheads whose terminal approach overlaps this much are duplicates. */
const ARROW_MERGE_MIN_OVERLAP = 0.8;
const ARROW_MERGE_MAX_ANGLE = (20 * Math.PI) / 180;
const ARROW_MERGE_MIN_LENGTH = 6;
/** Approximate rendered size of Mermaid's `barbEnd` marker, in user units. */
const ARROW_HEAD_LENGTH = 10;
const ARROW_HEAD_WIDTH = 14;

const PATH_TAIL =
  /(?:Q([-\d.eE+]+),([-\d.eE+]+) ([-\d.eE+]+),([-\d.eE+]+))?L([-\d.eE+]+),([-\d.eE+]+)$/;

/**
 * State diagrams use orthogonal, rounded paths. When two terminal tails are
 * only a couple of pixels apart, snap the duplicate's last straight run onto
 * the kept edge's axis so the two strokes become one line instead of a
 * parallel double stroke. Diagonal tails keep their own geometry; their
 * duplicate marker is still removed by the caller.
 */
function snapTerminalTail(
  path: SVGPathElement,
  duplicate: ArrowSegment,
  kept: ArrowSegment,
): boolean {
  const vertical =
    Math.abs(kept.end.x - kept.start.x) <= 0.5 &&
    Math.abs(duplicate.end.x - duplicate.start.x) <= 0.5;
  const horizontal =
    Math.abs(kept.end.y - kept.start.y) <= 0.5 &&
    Math.abs(duplicate.end.y - duplicate.start.y) <= 0.5;
  if (!vertical && !horizontal) {
    return false;
  }

  const target = vertical ? kept.end.x : kept.end.y;
  const source = vertical ? duplicate.end.x : duplicate.end.y;
  if (Math.abs(target - source) < 0.01) {
    return true;
  }

  const data = path.getAttribute("d");
  if (!data) {
    return false;
  }
  const match = PATH_TAIL.exec(data);
  if (!match) {
    return false;
  }
  const [, qx, qy, qex, qey, lx, ly] = match;
  if (lx === undefined || ly === undefined) {
    return false;
  }
  const corner =
    qx !== undefined && qy !== undefined && qex !== undefined && qey !== undefined
      ? vertical
        ? `Q${target},${qy} ${target},${qey}`
        : `Q${qx},${target} ${qex},${target}`
      : "";
  path.setAttribute(
    "d",
    `${data.slice(0, match.index)}${corner}${vertical ? `L${target},${ly}` : `L${lx},${target}`}`,
  );

  const points = decodePoints(path.getAttribute("data-points"));
  if (points) {
    const last = points[points.length - 1];
    const previous = points[points.length - 2];
    if (last) {
      if (vertical) {
        last.x = target;
      } else {
        last.y = target;
      }
    }
    if (previous && Math.abs((vertical ? previous.x : previous.y) - source) < 0.01) {
      if (vertical) {
        previous.x = target;
      } else {
        previous.y = target;
      }
    }
    path.setAttribute("data-points", encodePoints(points));
  }
  return true;
}

/**
 * Two edges can terminate at the same node with slightly different endpoints.
 * Mermaid then draws two auto-oriented arrowheads a couple of pixels apart,
 * which reads as a ghosted double arrow. Model the marker as a 10×14 box:
 * offsetting it along or across the approach direction reduces the overlap
 * area linearly, so 2px sideways still leaves ~86% of the two arrowheads
 * shared while 10px leaves none. This mirrors what the eye sees without
 * rasterising the marker.
 */
export function terminalArrowOverlap(a: ArrowSegment, b: ArrowSegment): number {
  const ax = a.end.x - a.start.x;
  const ay = a.end.y - a.start.y;
  const bx = b.end.x - b.start.x;
  const by = b.end.y - b.start.y;
  const aLength = Math.hypot(ax, ay);
  const bLength = Math.hypot(bx, by);
  if (aLength < ARROW_MERGE_MIN_LENGTH || bLength < ARROW_MERGE_MIN_LENGTH) {
    return 0;
  }
  const ux = ax / aLength;
  const uy = ay / aLength;
  const direction = (ux * bx + uy * by) / bLength;
  if (direction < Math.cos(ARROW_MERGE_MAX_ANGLE)) {
    return 0;
  }
  const dx = b.end.x - a.end.x;
  const dy = b.end.y - a.end.y;
  const along = Math.abs(dx * ux + dy * uy);
  const aside = Math.abs(-dx * uy + dy * ux);
  if (along > ARROW_HEAD_LENGTH || aside > ARROW_HEAD_WIDTH) {
    return 0;
  }
  return Math.max(0, 1 - along / ARROW_HEAD_LENGTH) * Math.max(0, 1 - aside / ARROW_HEAD_WIDTH);
}

function mergeOverlappingArrowheads(root: SVGSVGElement): number {
  const segments: Array<ArrowSegment & { path: SVGPathElement }> = [];
  for (const path of root.querySelectorAll<SVGPathElement>("g.edgePaths > path")) {
    const marker = path.getAttribute("marker-end");
    if (!marker || marker === "none") {
      continue;
    }
    const points = decodePoints(path.getAttribute("data-points"));
    if (!points) {
      continue;
    }
    const end = points[points.length - 1];
    const start = points[points.length - 2];
    if (!start || !end) {
      continue;
    }
    segments.push({ path, start, end });
  }

  const hidden = new Set<SVGPathElement>();
  let merged = 0;
  for (let index = 0; index < segments.length; index += 1) {
    const current = segments[index];
    if (!current || hidden.has(current.path)) {
      continue;
    }
    for (let other = index + 1; other < segments.length; other += 1) {
      const candidate = segments[other];
      if (!candidate || hidden.has(candidate.path)) {
        continue;
      }
      if (terminalArrowOverlap(current, candidate) < ARROW_MERGE_MIN_OVERLAP) {
        continue;
      }
      if (
        current.path.getAttribute("marker-end") !== candidate.path.getAttribute("marker-end") ||
        getComputedStyle(current.path).stroke !== getComputedStyle(candidate.path).stroke ||
        getComputedStyle(current.path).strokeOpacity !==
          getComputedStyle(candidate.path).strokeOpacity ||
        getComputedStyle(current.path).opacity !== getComputedStyle(candidate.path).opacity
      ) {
        continue;
      }
      // Keep the first edge's arrowhead and hide only the duplicate marker.
      // Both routes and their labels stay intact.
      snapTerminalTail(candidate.path, candidate, current);
      candidate.path.setAttribute("marker-end", "none");
      candidate.path.style.setProperty("marker-end", "none", "important");
      candidate.path.setAttribute("data-merged-arrowhead", "true");
      hidden.add(candidate.path);
      merged += 1;
    }
  }

  if (merged > 0) {
    root.setAttribute("data-merged-arrowheads", String(merged));
  }
  return merged;
}

function normalizeC4(root: SVGSVGElement): void {
  for (const shape of root.querySelectorAll<SVGGElement>("g.c4-shape.c4-external")) {
    const key = [...shape.classList].find((name) => externalTypeLabel(name) !== null);
    if (!key) {
      continue;
    }
    const type = shape.querySelector(".c4-type text");
    if (!type) {
      continue;
    }
    const label = externalTypeLabel(key);
    if (!label) {
      continue;
    }
    const tspans = [...type.querySelectorAll("tspan.text-inner-tspan")];
    if (tspans.length >= 2) {
      const [first, second] = tspans;
      if (first && second) {
        first.textContent = "[External";
        second.textContent = ` ${label.replace(/^External /, "")}]`;
      }
      for (const extra of tspans.slice(2)) {
        extra.remove();
      }
    } else {
      type.textContent = `[${label}]`;
    }
  }

  for (const basic of root.querySelectorAll<SVGGElement>(".c4-person .basic")) {
    const body = basic.querySelector("rect");
    const head = basic.querySelector("circle");
    if (!body || !head) {
      continue;
    }
    const path = buildPersonSilhouette(
      Number(body.getAttribute("x")),
      Number(body.getAttribute("y")),
      Number(body.getAttribute("width")),
      Number(body.getAttribute("height")),
      Number(body.getAttribute("rx") || 0),
      Number(head.getAttribute("cx")),
      Number(head.getAttribute("cy")),
      Number(head.getAttribute("r")),
    );
    if (!path) {
      continue;
    }
    const silhouette = document.createElementNS("http://www.w3.org/2000/svg", "path");
    silhouette.setAttribute("d", path);
    silhouette.setAttribute("class", "c4-person-shape");
    silhouette.setAttribute(
      "style",
      body.getAttribute("style") || head.getAttribute("style") || "",
    );
    body.replaceWith(silhouette);
    head.remove();
  }
}

function annotateMindmap(root: SVGSVGElement): void {
  if (!root.classList.contains("mindmapDiagram")) {
    return;
  }

  const nodes = new Map<string, SVGGElement>();
  for (const node of root.querySelectorAll<SVGGElement>(".mindmap-node")) {
    const match = node.id.match(/node_(\d+)$/);
    if (match?.[1]) {
      nodes.set(match[1], node);
    }
  }
  if (nodes.size === 0) {
    return;
  }

  const adjacency = new Map<string, string[]>();
  for (const path of root.querySelectorAll<SVGPathElement>('g.edgePaths path[data-id^="edge_"]')) {
    const match = (path.getAttribute("data-id") ?? "").match(/^edge_(\d+)_(\d+)$/);
    const from = match?.[1];
    const to = match?.[2];
    if (!from || !to) {
      continue;
    }
    const next = adjacency.get(from) ?? [];
    next.push(to);
    adjacency.set(from, next);
  }

  const rootId =
    [...nodes.entries()].find(([, node]) => node.classList.contains("section-root"))?.[0] ?? "0";
  const depths = new Map<string, number>();
  const queue: Array<[string, number]> = [[rootId, 0]];
  while (queue.length > 0) {
    const entry = queue.shift();
    if (!entry) {
      break;
    }
    const [id, depth] = entry;
    if (depths.has(id)) {
      continue;
    }
    depths.set(id, depth);
    for (const next of adjacency.get(id) ?? []) {
      if (!depths.has(next)) {
        queue.push([next, depth + 1]);
      }
    }
  }

  for (const [id, node] of nodes) {
    node.classList.add(`mind-depth-${depths.get(id) ?? 0}`);
  }

  for (const node of root.querySelectorAll<SVGGraphicsElement>(".mindmap-node .node-bkg")) {
    const box = node.getBBox();
    const pill = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    for (const attribute of [...node.attributes]) {
      if (attribute.name !== "d") {
        pill.setAttribute(attribute.name, attribute.value);
      }
    }
    pill.setAttribute("x", String(box.x));
    pill.setAttribute("y", String(box.y));
    pill.setAttribute("width", String(box.width));
    pill.setAttribute("height", String(box.height));
    pill.setAttribute("rx", String(box.height / 2));
    pill.setAttribute("ry", String(box.height / 2));
    node.replaceWith(pill);
  }

  const content = root.getBBox();
  const center = {
    x: content.x + content.width / 2,
    y: content.y + content.height / 2,
  };
  for (const path of root.querySelectorAll<SVGPathElement>(".edgePaths path[data-points]")) {
    const points = decodePoints(path.getAttribute("data-points"));
    if (!points) {
      continue;
    }
    const start = points[0];
    const end = points[points.length - 1];
    if (!start || !end) {
      continue;
    }
    const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    if (length === 0) {
      continue;
    }
    const side = mid.x < center.x ? 1 : -1;
    const bend = Math.min(10, Math.max(4, length * 0.14)) * side;
    const control = {
      x: mid.x + (-dy / length) * bend,
      y: mid.y + (dx / length) * bend,
    };
    path.setAttribute(
      "d",
      `M${start.x.toFixed(2)},${start.y.toFixed(2)} Q${control.x.toFixed(2)},${control.y.toFixed(2)} ${end.x.toFixed(2)},${end.y.toFixed(2)}`,
    );
  }
}

function nodeAt(nodes: readonly NodeBox[], point: Point): NodeBox | null {
  let best: NodeBox | null = null;
  for (const node of nodes) {
    const inside =
      point.x >= node.left - 2 &&
      point.x <= node.right + 2 &&
      point.y >= node.top - 2 &&
      point.y <= node.bottom + 2;
    if (!inside) {
      continue;
    }
    if (!best || node.width * node.height < best.width * best.height) {
      best = node;
    }
  }
  return best;
}

/** The only shape the controlled router takes over: a direct vertical back edge. */
export function isVerticalBackEdge(source: NodeBox, target: NodeBox): boolean {
  if (target.cy >= source.cy - 8) {
    return false;
  }
  const overlap = Math.min(source.right, target.right) - Math.max(source.left, target.left);
  return overlap >= Math.min(source.width, target.width) * 0.5 && source.cy - target.cy >= 28;
}

function routeBackEdges(
  root: SVGSVGElement,
  kind: MermaidDiagramKind,
): { routed: number; boxes: RectBox[] } {
  if (kind !== "flowchart") {
    return { routed: 0, boxes: [] };
  }

  const nodeBoxes: NodeBox[] = [];
  for (const node of root.querySelectorAll<SVGGElement>("g.node")) {
    if (node.closest("g.cluster")) {
      continue;
    }
    const box = node.getBBox();
    const matrix = node.transform.baseVal.consolidate()?.matrix;
    const tx = matrix?.e ?? 0;
    const ty = matrix?.f ?? 0;
    nodeBoxes.push({
      left: box.x + tx,
      right: box.x + box.width + tx,
      top: box.y + ty,
      bottom: box.y + box.height + ty,
      cx: box.x + box.width / 2 + tx,
      cy: box.y + box.height / 2 + ty,
      width: box.width,
      height: box.height,
    });
  }
  if (nodeBoxes.length === 0) {
    return { routed: 0, boxes: [] };
  }

  interface RoutableEdge {
    path: SVGPathElement;
    source: NodeBox;
    target: NodeBox;
    id: string | null;
  }

  const edges: RoutableEdge[] = [];
  for (const path of root.querySelectorAll<SVGPathElement>("g.edgePaths > path.flowchart-link")) {
    if (!path.classList.contains("edge-pattern-solid")) {
      continue;
    }
    const points = decodePoints(path.getAttribute("data-points"));
    if (!points) {
      continue;
    }
    const first = points[0];
    const last = points[points.length - 1];
    if (!first || !last) {
      continue;
    }
    const source = nodeAt(nodeBoxes, first);
    const target = nodeAt(nodeBoxes, last);
    if (!source || !target || source === target) {
      continue;
    }
    edges.push({ path, source, target, id: path.getAttribute("data-id") });
  }

  const labels = [...root.querySelectorAll<SVGGElement>("g.edgeLabel")];
  const routedBoxes: RectBox[] = [];
  const handled = new Set<SVGPathElement>();
  let routed = 0;

  for (const edge of edges) {
    if (handled.has(edge.path) || !isVerticalBackEdge(edge.source, edge.target)) {
      continue;
    }
    const { path, source, target } = edge;

    const gutter = Math.min(source.left, target.left) - 34;
    const sourceY = source.cy;
    const targetY = target.cy;

    const blocked = nodeBoxes.some(
      (node) =>
        node !== source &&
        node !== target &&
        ((node.left < gutter + 8 &&
          node.right > gutter - 8 &&
          node.top < sourceY &&
          node.bottom > targetY) ||
          (node.top < sourceY &&
            node.bottom > sourceY &&
            node.left < source.left &&
            node.right > gutter) ||
          (node.top < targetY &&
            node.bottom > targetY &&
            node.left < target.left &&
            node.right > gutter)),
    );
    if (blocked) {
      continue;
    }

    const radius = 10;
    const startX = source.left;
    const endX = target.left - 4;
    const points: Point[] = [
      { x: startX, y: sourceY },
      { x: gutter, y: sourceY },
      { x: gutter, y: targetY },
      { x: endX, y: targetY },
    ];
    path.setAttribute(
      "d",
      [
        `M${startX},${sourceY}`,
        `L${gutter + radius},${sourceY}`,
        `Q${gutter},${sourceY} ${gutter},${sourceY - radius}`,
        `L${gutter},${targetY + radius}`,
        `Q${gutter},${targetY} ${gutter + radius},${targetY}`,
        `L${endX},${targetY}`,
      ].join(""),
    );
    path.style.strokeDasharray = "none";
    path.style.strokeDashoffset = "0";
    path.setAttribute("data-points", encodePoints(points));
    routedBoxes.push(path.getBBox());

    const label = labels.find(
      (item) => item.querySelector("g.label")?.getAttribute("data-id") === edge.id,
    );
    if (label) {
      const box = label.getBBox();
      const offsetY = box.y + box.height / 2;
      label.setAttribute("transform", `translate(${gutter}, ${(sourceY + targetY) / 2 - offsetY})`);
      const matrix = label.transform.baseVal.consolidate()?.matrix;
      routedBoxes.push({
        x: box.x + (matrix?.e ?? 0),
        y: box.y + (matrix?.f ?? 0),
        width: box.width,
        height: box.height,
      });
    }

    // Once the back edge leaves the column, straighten the matching forward
    // edge if Mermaid left a detour around it.
    const reverse = edges.find((item) => item.source === target && item.target === source);
    if (reverse && reverse.path !== path && !handled.has(reverse.path)) {
      const reverseHasLabel = labels.some(
        (item) => item.querySelector("g.label")?.getAttribute("data-id") === reverse.id,
      );
      const sameColumn = Math.abs(source.cx - target.cx) <= 2;
      const forwardBlocked = nodeBoxes.some(
        (node) =>
          node !== source &&
          node !== target &&
          node.left < target.cx &&
          node.right > target.cx &&
          node.bottom > target.bottom &&
          node.top < source.top,
      );
      if (!reverseHasLabel && sameColumn && !forwardBlocked) {
        const startY = target.bottom;
        const endY = source.top - 4;
        reverse.path.setAttribute("d", `M${target.cx},${startY}L${target.cx},${endY}`);
        reverse.path.style.strokeDasharray = "none";
        reverse.path.style.strokeDashoffset = "0";
        reverse.path.setAttribute(
          "data-points",
          encodePoints([
            { x: target.cx, y: startY },
            { x: target.cx, y: endY },
          ]),
        );
        handled.add(reverse.path);
      }
    }

    handled.add(path);
    routed += 1;
  }

  return { routed, boxes: routedBoxes };
}

function recolorSankey(root: SVGSVGElement, palette: MermaidPalette): void {
  const colors = palette.accents;
  if (colors.length === 0) {
    return;
  }
  const colorAt = (index: number): string => colors[index % colors.length] ?? palette.accent;
  const nodes = [...root.querySelectorAll<SVGRectElement>(".nodes .node rect")];
  nodes.forEach((node, index) => {
    node.setAttribute("fill", colorAt(index));
  });
  const gradients = [...root.querySelectorAll<SVGLinearGradientElement>("g.link linearGradient")];
  gradients.forEach((gradient, index) => {
    const stops = [...gradient.querySelectorAll("stop")];
    const first = stops[0];
    const second = stops[1];
    if (first) {
      first.setAttribute("stop-color", colorAt(index));
    }
    if (second) {
      second.setAttribute("stop-color", colorAt(index + 1));
    }
  });
}

function recolorTreemap(root: SVGSVGElement, palette: MermaidPalette): void {
  const colors = palette.cats;
  for (const section of root.querySelectorAll<SVGElement>(".treemapNode.section")) {
    section.style.setProperty("fill", palette.diagramSurfaceAlt, "important");
    section.style.setProperty("stroke", palette.diagramBorder, "important");
  }
  [...root.querySelectorAll<SVGElement>(".treemapNode.leaf")].forEach((leaf, index) => {
    const color = colors[index % colors.length] ?? palette.diagramNode;
    leaf.style.setProperty("fill", color, "important");
    leaf.style.setProperty("stroke", palette.diagramBorder, "important");
  });
}

function applyViewBox(root: SVGSVGElement, kind: MermaidDiagramKind, boxes: RectBox[]): void {
  const parsed = (root.getAttribute("viewBox") ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const viewBox =
    parsed.length === 4 && parsed.every(Number.isFinite)
      ? [parsed[0] ?? 0, parsed[1] ?? 0, parsed[2] ?? 0, parsed[3] ?? 0]
      : [0, 0, 0, 0];

  if (boxes.length > 0) {
    let minX = viewBox[0] ?? 0;
    let minY = viewBox[1] ?? 0;
    let maxX = minX + (viewBox[2] ?? 0);
    let maxY = minY + (viewBox[3] ?? 0);
    for (const box of boxes) {
      minX = Math.min(minX, box.x);
      minY = Math.min(minY, box.y);
      maxX = Math.max(maxX, box.x + box.width);
      maxY = Math.max(maxY, box.y + box.height);
    }
    const pad = 4;
    viewBox[0] = minX - pad;
    viewBox[1] = minY - pad;
    viewBox[2] = maxX - minX + pad * 2;
    viewBox[3] = maxY - minY + pad * 2;
  }

  if (kind === "mindmap" || kind === "c4" || kind === "state") {
    const content = root.getBBox();
    // Mermaid hard-codes an 8px frame for state diagrams. The terminal
    // bullseye then sits almost on the card's bottom border, where it reads
    // as a stray dot. Recompute the frame so the final state keeps the same
    // optical breathing room as the states above it.
    const pad = kind === "c4" ? 20 : kind === "state" ? 18 : 12;
    viewBox[0] = content.x - pad;
    viewBox[1] = content.y - pad;
    viewBox[2] = content.width + pad * 2;
    viewBox[3] = content.height + pad * 2;
  }

  const width = Math.max(1, viewBox[2] ?? 0);
  const height = Math.max(1, viewBox[3] ?? 0);
  const rounded = [viewBox[0] ?? 0, viewBox[1] ?? 0, width, height].map(
    (value) => +value.toFixed(2),
  );
  root.removeAttribute("style");
  root.setAttribute("viewBox", rounded.join(" "));
  if (kind === "c4") {
    root.setAttribute("width", "960");
    root.setAttribute("height", String(Math.ceil((960 * height) / width)));
  } else {
    root.setAttribute("width", String(Math.ceil(width)));
    root.setAttribute("height", String(Math.ceil(height)));
  }
  root.setAttribute("preserveAspectRatio", "xMidYMid meet");
  root.setAttribute("role", "img");
  if (kind !== "c4") {
    root.removeAttribute("aria-roledescription");
  }
}

/**
 * Runs inside the sandbox after `mermaid.render`. Keeping this off the host
 * means the editor never imports Mermaid's DOM and the SVG is sanitized only
 * once, after every visual correction has been applied.
 */
export function postProcessMermaidSvg(
  svg: string,
  kind: MermaidDiagramKind,
  palette: MermaidPalette,
): string {
  if (typeof document === "undefined" || typeof XMLSerializer === "undefined") {
    return svg;
  }
  const host = document.createElement("div");
  host.style.cssText =
    "position:absolute;left:-100000px;top:0;visibility:hidden;pointer-events:none;";
  host.innerHTML = svg;
  const root = host.querySelector("svg");
  if (!root) {
    return svg;
  }
  const parent = document.body ?? document.documentElement;
  parent.append(host);
  try {
    if (kind === "c4") {
      normalizeC4(root);
    }
    if (kind === "mindmap") {
      annotateMindmap(root);
    }
    if (kind === "sankey") {
      recolorSankey(root, palette);
    }
    if (kind === "treemap") {
      recolorTreemap(root, palette);
    }
    const { routed, boxes } = routeBackEdges(root, kind);
    const mergedArrowheads = kind === "state" ? mergeOverlappingArrowheads(root) : 0;
    applyViewBox(root, kind, boxes);
    root.setAttribute("data-routed-back-edges", String(routed));
    root.setAttribute("data-merged-arrowheads", String(mergedArrowheads));
    return new XMLSerializer().serializeToString(root);
  } finally {
    host.remove();
  }
}
