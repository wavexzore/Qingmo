import {
  diagramKind,
  mermaidPaletteKey,
  resolveMermaidPalette,
  type MermaidDiagramKind,
  type MermaidPalette,
  type MermaidTheme,
} from "./mermaid-theme";

const REQUEST_TYPE = "qingmo:mermaid:render";
const RESULT_TYPE = "qingmo:mermaid:result";
const READY_TYPE = "qingmo:mermaid:ready";

/** A diagram that takes longer than this is reported as a render failure. */
const REQUEST_TIMEOUT_MS = 20_000;
/** If the sandbox page cannot boot (CSP, missing asset), fail fast. */
const READY_TIMEOUT_MS = 15_000;
const MAX_CACHE_ENTRIES = 50;

export type { MermaidTheme };

export function currentMermaidTheme(root: HTMLElement = document.documentElement): MermaidTheme {
  return root.dataset.theme === "dark" ? "dark" : "default";
}

interface QueueItem {
  code: string;
  theme: MermaidTheme;
  kind: MermaidDiagramKind;
  palette: MermaidPalette;
  resolve: (svg: string) => void;
  reject: (error: Error) => void;
}

interface PendingRequest {
  item: QueueItem;
  cacheKey: string;
  timer: ReturnType<typeof setTimeout>;
}

function cacheKey(code: string, theme: MermaidTheme, kind: MermaidDiagramKind): string {
  return `${mermaidPaletteKey(theme)}\u0000${kind}\u0000${code}`;
}

/**
 * Renders Mermaid diagrams in a separate, sandboxed document. The iframe is
 * created lazily, kept off-screen, and used only as a rendering surface: the
 * resulting SVG is sanitized by the caller before it is imported into the
 * editor DOM.
 *
 * `allow-same-origin` is required because the renderer is served as a module
 * from the app origin; the production CSP uses `script-src 'self'`, which
 * cannot match the opaque origin of a fully sandboxed document. No user
 * authoring is executed as script — Mermaid runs with `securityLevel:
 * "strict"` and no HTML labels.
 */
class MermaidRenderer {
  private frame: HTMLIFrameElement | null = null;
  private ready = false;
  private readyFailed = false;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private pending = new Map<number, PendingRequest>();
  private queue: QueueItem[] = [];
  private active = false;
  private nextRequestId = 1;
  private cache = new Map<string, string>();

  render(code: string, theme: MermaidTheme): Promise<string> {
    const kind = diagramKind(code);
    const key = cacheKey(code, theme, kind);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return Promise.resolve(cached);
    }
    if (this.readyFailed) {
      return Promise.reject(new Error("Mermaid 渲染器不可用"));
    }

    return new Promise<string>((resolve, reject) => {
      this.queue.push({
        code,
        theme,
        kind,
        palette: resolveMermaidPalette(theme),
        resolve,
        reject,
      });
      this.ensureFrame();
      this.pump();
    });
  }

  private ensureFrame(): void {
    if (this.frame || typeof document === "undefined") {
      return;
    }

    const frame = document.createElement("iframe");
    frame.className = "cm-md-mermaid-sandbox";
    frame.title = "Mermaid renderer";
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
    frame.tabIndex = -1;
    frame.src = new URL("mermaid-renderer.html", document.baseURI).toString();
    // Keep the document rendered (Mermaid measures text with getBBox) but
    // outside the viewport so it never flashes or steals pointer events.
    frame.style.cssText =
      "position:fixed;left:-10000px;top:0;width:1024px;height:768px;border:0;opacity:0;pointer-events:none;";
    document.body.append(frame);
    this.frame = frame;
    window.addEventListener("message", this.onMessage);

    this.readyTimer = setTimeout(() => {
      if (this.ready) {
        return;
      }
      this.readyTimer = null;
      this.readyFailed = true;
      this.failQueue(new Error("Mermaid 渲染器加载超时"));
    }, READY_TIMEOUT_MS);
  }

  private readonly onMessage = (event: MessageEvent): void => {
    if (event.source !== this.frame?.contentWindow) {
      return;
    }
    const data = event.data as Record<string, unknown> | null;
    if (!data || typeof data !== "object") {
      return;
    }

    if (data.type === READY_TYPE) {
      this.ready = true;
      this.readyFailed = false;
      if (this.readyTimer !== null) {
        clearTimeout(this.readyTimer);
        this.readyTimer = null;
      }
      this.pump();
      return;
    }

    if (data.type !== RESULT_TYPE || typeof data.requestId !== "number") {
      return;
    }
    const pending = this.pending.get(data.requestId);
    if (!pending) {
      return;
    }
    this.pending.delete(data.requestId);
    clearTimeout(pending.timer);

    if (typeof data.svg === "string" && data.svg.length > 0) {
      this.storeCache(pending.cacheKey, data.svg);
      pending.item.resolve(data.svg);
    } else {
      pending.item.reject(
        new Error(typeof data.error === "string" ? data.error : "Mermaid 渲染失败"),
      );
    }

    this.active = false;
    this.pump();
  };

  private pump(): void {
    if (this.active || this.queue.length === 0) {
      return;
    }
    const frame = this.frame;
    if (!frame || !this.ready) {
      return;
    }

    const item = this.queue.shift();
    if (!item) {
      return;
    }

    const key = cacheKey(item.code, item.theme, item.kind);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      item.resolve(cached);
      this.pump();
      return;
    }

    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    this.active = true;

    const timer = setTimeout(() => {
      this.pending.delete(requestId);
      this.active = false;
      item.reject(new Error("Mermaid 图表渲染超时"));
      this.pump();
    }, REQUEST_TIMEOUT_MS);
    this.pending.set(requestId, { item, cacheKey: key, timer });

    frame.contentWindow?.postMessage(
      {
        type: REQUEST_TYPE,
        requestId,
        code: item.code,
        theme: item.theme,
        kind: item.kind,
        palette: item.palette,
      },
      "*",
    );
  }

  private failQueue(error: Error): void {
    const queued = this.queue;
    this.queue = [];
    for (const item of queued) {
      item.reject(error);
    }
  }

  private storeCache(key: string, svg: string): void {
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) {
        this.cache.delete(oldest.value);
      }
    }
    this.cache.set(key, svg);
  }
}

const mermaidRenderer = new MermaidRenderer();

export function renderMermaid(code: string, theme: MermaidTheme): Promise<string> {
  return mermaidRenderer.render(code, theme);
}
