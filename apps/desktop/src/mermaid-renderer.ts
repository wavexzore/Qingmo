import mermaid from "mermaid";

import {
  buildMermaidTheme,
  diagramKind,
  isMermaidDiagramKind,
  mermaidDiagramConfig,
  mermaidElkConfig,
  mermaidLayout,
  resolveMermaidPalette,
  sanitizeMermaidPalette,
  type MermaidDiagramKind,
  type MermaidPalette,
  type MermaidTheme,
} from "@qingmo/editor-core/mermaid-theme";

import { postProcessMermaidSvg } from "./mermaid-postprocess";

const REQUEST_TYPE = "qingmo:mermaid:render";
const RESULT_TYPE = "qingmo:mermaid:result";
const READY_TYPE = "qingmo:mermaid:ready";

const MAX_SOURCE_LENGTH = 200_000;

interface RenderRequest {
  type: typeof REQUEST_TYPE;
  requestId: number;
  code: string;
  theme: MermaidTheme;
  kind?: unknown;
  palette?: unknown;
}

function isRenderRequest(value: unknown): value is RenderRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.type === REQUEST_TYPE &&
    typeof record.requestId === "number" &&
    Number.isSafeInteger(record.requestId) &&
    typeof record.code === "string" &&
    record.code.length > 0 &&
    record.code.length <= MAX_SOURCE_LENGTH &&
    (record.theme === "default" || record.theme === "dark")
  );
}

/**
 * `securityLevel: "strict"` makes Mermaid escape labels instead of turning
 * them into HTML, and `htmlLabels: false` keeps the output as pure SVG. The
 * host still sanitizes the returned SVG before it reaches the editor DOM.
 *
 * The theme is rebuilt for every request because `themeCSS` depends on the
 * diagram kind (C4, mindmap, Git) and on the host's resolved colour tokens.
 */
function applyConfig(
  kind: MermaidDiagramKind,
  theme: MermaidTheme,
  palette: MermaidPalette,
  code: string,
): void {
  const built = buildMermaidTheme(theme, kind, palette);
  const layout = mermaidLayout(kind, code);
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    theme: "base",
    themeVariables: built.variables,
    themeCSS: built.themeCSS,
    fontFamily: palette.fontFamily,
    ...(layout ? { layout } : {}),
    ...mermaidDiagramConfig(built.c4, layout === "elk" ? mermaidElkConfig() : undefined),
  });
}

function uniqueId(): string {
  const suffix =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "")
      : Math.random().toString(36).slice(2);
  return `qingmo-mermaid-${suffix}`;
}

function requestKind(request: RenderRequest): MermaidDiagramKind {
  return isMermaidDiagramKind(request.kind) ? request.kind : diagramKind(request.code);
}

function requestPalette(request: RenderRequest): MermaidPalette {
  return sanitizeMermaidPalette(request.palette) ?? resolveMermaidPalette(request.theme);
}

async function renderDiagram(request: RenderRequest): Promise<string> {
  const kind = requestKind(request);
  const palette = requestPalette(request);
  applyConfig(kind, request.theme, palette, request.code);
  const id = uniqueId();
  try {
    const { svg } = await mermaid.render(id, request.code);
    return postProcessMermaidSvg(svg, kind, palette);
  } finally {
    // mermaid.render appends a temporary measuring node to the document.
    document.getElementById(`d${id}`)?.remove();
    document.getElementById(id)?.remove();
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

// Mermaid is not re-entrant: it mutates global configuration and shares a
// measurement container, so every request is rendered one at a time.
let queue: Promise<void> = Promise.resolve();

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window.parent || !isRenderRequest(event.data)) {
    return;
  }
  const request: RenderRequest = event.data;
  queue = queue
    .then(async () => {
      try {
        const svg = await renderDiagram(request);
        window.parent.postMessage({ type: RESULT_TYPE, requestId: request.requestId, svg }, "*");
      } catch (error) {
        window.parent.postMessage(
          {
            type: RESULT_TYPE,
            requestId: request.requestId,
            error: describeError(error),
          },
          "*",
        );
      }
    })
    .catch((error: unknown) => {
      // Keep the queue alive if even reporting a failure throws.
      console.error("Mermaid request failed", error);
    });
});

window.parent.postMessage({ type: READY_TYPE }, "*");
