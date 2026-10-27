import mermaid from "mermaid";

const REQUEST_TYPE = "qingmo:mermaid:render";
const RESULT_TYPE = "qingmo:mermaid:result";
const READY_TYPE = "qingmo:mermaid:ready";

const MAX_SOURCE_LENGTH = 200_000;

type MermaidTheme = "default" | "dark";

interface RenderRequest {
  type: typeof REQUEST_TYPE;
  requestId: number;
  code: string;
  theme: MermaidTheme;
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
 */
function applyConfig(theme: MermaidTheme): void {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    theme,
    fontFamily: 'system-ui, -apple-system, "Segoe UI", "Noto Sans SC", sans-serif',
    flowchart: { useMaxWidth: true },
    sequence: { useMaxWidth: true },
    gantt: { useMaxWidth: true },
    journey: { useMaxWidth: true },
    timeline: { useMaxWidth: true },
  });
}

function uniqueId(): string {
  const suffix =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "")
      : Math.random().toString(36).slice(2);
  return `qingmo-mermaid-${suffix}`;
}

async function renderDiagram(code: string, theme: MermaidTheme): Promise<string> {
  applyConfig(theme);
  const id = uniqueId();
  try {
    const { svg } = await mermaid.render(id, code);
    return svg;
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
        const svg = await renderDiagram(request.code, request.theme);
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

applyConfig("default");
window.parent.postMessage({ type: READY_TYPE }, "*");
