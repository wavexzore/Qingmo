import { forceParsing, syntaxTree } from "@codemirror/language";
import { StateField, type EditorState } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

import {
  OUTLINE_PARSE_CHUNK_UNITS,
  OUTLINE_PARSE_CHROMIUM_SLICE_MS,
  OUTLINE_PARSE_MAX_ATTEMPTS_PER_CHUNK,
  OUTLINE_PARSE_WEBKIT_DELAY_MS,
  OUTLINE_PARSE_WEBKIT_SLICE_MS,
  OUTLINE_SAFETY_MAX_ENTRIES,
  OUTLINE_SCAN_MAX_UNITS,
} from "../limits";
import { readDetailsRanges } from "./details-range";
import { readFrontMatter } from "./frontmatter";
import { headingLevel, headingText, isHeading, plainInlineText } from "./heading-text";
import type { MarkdownNode } from "./markdown-node";

export type HeadingOutlineStatus = "complete" | "partial" | "error";
export type HeadingOutlineLimitReason = "size" | "count" | null;

export interface HeadingOutlineEntry {
  level: number;
  /** Raw heading text, including inline Markdown. TOC still renders it. */
  text: string;
  /** Plain text used by anchors and the side panel; never falls back to text. */
  plainText: string;
  from: number;
  to: number;
  /** 1-based line number. */
  line: number;
  /** Start of the heading line (the navigation target). */
  lineFrom: number;
}

export interface HeadingOutlineState {
  entries: readonly HeadingOutlineEntry[];
  status: HeadingOutlineStatus;
  limitReason: HeadingOutlineLimitReason;
  errorReason: string | null;
  /** Whether the parsed tree covers the scan target (doc length or 200k). */
  treeComplete: boolean;
}

function errorState(reason: string, previous?: HeadingOutlineState): HeadingOutlineState {
  return {
    entries: previous?.entries ?? [],
    status: "error",
    limitReason: previous?.limitReason ?? null,
    errorReason: reason,
    treeComplete: previous?.treeComplete ?? false,
  };
}

/**
 * Builds the one shared heading model. It only walks top-level headings from
 * the current syntax tree; it never advances the parser itself.
 */
export function buildHeadingOutline(state: EditorState): HeadingOutlineState {
  const doc = state.doc;
  const tree = syntaxTree(state);
  const scanTarget = Math.min(doc.length, OUTLINE_SCAN_MAX_UNITS);
  const treeComplete = tree.length >= scanTarget;
  const frontMatter = readFrontMatter(doc);
  const details = readDetailsRanges(state);
  const root = tree.topNode as unknown as MarkdownNode;
  const entries: HeadingOutlineEntry[] = [];
  let countLimited = false;

  for (let child = root.firstChild; child; child = child.nextSibling) {
    if (child.from >= OUTLINE_SCAN_MAX_UNITS) {
      break;
    }
    if (frontMatter && child.from >= frontMatter.from && child.to <= frontMatter.to) {
      continue;
    }
    if (
      details.length > 0 &&
      details.some((range) => child.from >= range.from && child.to <= range.to)
    ) {
      continue;
    }
    if (!isHeading(child.name)) {
      continue;
    }

    const text = headingText(doc, child);
    if (!text) {
      continue;
    }
    if (entries.length >= OUTLINE_SAFETY_MAX_ENTRIES) {
      countLimited = true;
      break;
    }

    const line = doc.lineAt(child.from);
    entries.push({
      level: headingLevel(child.name),
      text,
      plainText: plainInlineText(text),
      from: child.from,
      to: child.to,
      line: line.number,
      lineFrom: line.from,
    });
  }

  const sizeLimited = doc.length > OUTLINE_SCAN_MAX_UNITS && treeComplete;
  const limitReason: HeadingOutlineLimitReason = sizeLimited
    ? "size"
    : countLimited
      ? "count"
      : null;

  return {
    entries,
    status: treeComplete && !sizeLimited && !countLimited ? "complete" : "partial",
    limitReason,
    errorReason: null,
    treeComplete,
  };
}

export function sameHeadingOutline(left: HeadingOutlineState, right: HeadingOutlineState): boolean {
  if (
    left === right ||
    left.status !== right.status ||
    left.limitReason !== right.limitReason ||
    left.errorReason !== right.errorReason ||
    left.treeComplete !== right.treeComplete ||
    left.entries.length !== right.entries.length
  ) {
    return false;
  }
  for (let index = 0; index < left.entries.length; index += 1) {
    const a = left.entries[index];
    const b = right.entries[index];
    if (
      !a ||
      !b ||
      a.level !== b.level ||
      a.text !== b.text ||
      a.plainText !== b.plainText ||
      a.from !== b.from ||
      a.to !== b.to ||
      a.line !== b.line ||
      a.lineFrom !== b.lineFrom
    ) {
      return false;
    }
  }
  return true;
}

/**
 * The only heading field. Consumers read it through `readHeadingOutline`; they
 * must not traverse headings themselves.
 */
export const headingOutline = StateField.define<HeadingOutlineState>({
  create(state) {
    try {
      return buildHeadingOutline(state);
    } catch (error) {
      return errorState(error instanceof Error ? error.message : String(error));
    }
  },
  update(value, transaction) {
    if (
      !transaction.docChanged &&
      syntaxTree(transaction.startState) === syntaxTree(transaction.state)
    ) {
      return value;
    }
    try {
      const next = buildHeadingOutline(transaction.state);
      return sameHeadingOutline(value, next) ? value : next;
    } catch (error) {
      return errorState(error instanceof Error ? error.message : String(error), value);
    }
  },
});

/** Field access with a safe fallback for standalone states in tests/tools. */
export function readHeadingOutline(state: EditorState): HeadingOutlineState {
  return state.field(headingOutline, false) ?? buildHeadingOutline(state);
}

type IdleWindow = Window & {
  requestIdleCallback?: (
    callback: (deadline: IdleDeadline) => void,
    options?: { timeout?: number },
  ) => number;
  cancelIdleCallback?: (handle: number) => void;
};

const IDLE_TIMEOUT_MS = 64;

function isWebKit(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  return (
    /AppleWebKit/i.test(navigator.userAgent) && !/Chrome|Chromium|Edg/i.test(navigator.userAgent)
  );
}

class OutlineParseDriver {
  private timer: ReturnType<typeof setTimeout> | number | null = null;
  private idleTimer = false;
  private pending = true;
  private attempts = 0;
  private destroyed = false;
  private readonly view: EditorView;

  constructor(view: EditorView) {
    this.view = view;
    view.contentDOM.addEventListener("compositionstart", this.onCompositionStart);
    view.contentDOM.addEventListener("compositionend", this.onCompositionEnd);
    this.schedule();
  }

  update(update: ViewUpdate): void {
    if (this.destroyed) {
      return;
    }
    const treeChanged = syntaxTree(update.startState) !== syntaxTree(update.state);
    if (update.docChanged) {
      this.attempts = 0;
      this.pending = true;
      this.schedule();
    } else if (update.viewportChanged || treeChanged) {
      this.pending = true;
      this.schedule();
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.pending = false;
    this.cancelTimer();
    this.view.contentDOM.removeEventListener("compositionstart", this.onCompositionStart);
    this.view.contentDOM.removeEventListener("compositionend", this.onCompositionEnd);
  }

  private readonly onCompositionStart = (): void => {
    this.pending = true;
  };

  private readonly onCompositionEnd = (): void => {
    if (this.destroyed) {
      return;
    }
    this.pending = true;
    this.schedule();
  };

  private schedule(): void {
    if (this.destroyed || !this.pending || this.timer !== null) {
      return;
    }
    this.pending = false;

    if (isWebKit()) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.run(OUTLINE_PARSE_WEBKIT_SLICE_MS);
      }, OUTLINE_PARSE_WEBKIT_DELAY_MS);
      return;
    }

    const host = typeof window === "undefined" ? null : (window as IdleWindow);
    if (host?.requestIdleCallback) {
      this.idleTimer = true;
      this.timer = host.requestIdleCallback(
        () => {
          this.timer = null;
          this.idleTimer = false;
          this.run(OUTLINE_PARSE_CHROMIUM_SLICE_MS);
        },
        { timeout: IDLE_TIMEOUT_MS },
      );
      return;
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      this.run(OUTLINE_PARSE_CHROMIUM_SLICE_MS);
    }, 0);
  }

  private cancelTimer(): void {
    if (this.timer === null) {
      return;
    }
    const host = typeof window === "undefined" ? null : (window as IdleWindow);
    if (this.idleTimer && host?.cancelIdleCallback) {
      host.cancelIdleCallback(this.timer as number);
    } else {
      clearTimeout(this.timer as ReturnType<typeof setTimeout>);
    }
    this.timer = null;
    this.idleTimer = false;
  }

  private run(sliceMs: number): void {
    if (this.destroyed) {
      return;
    }
    if (this.view.composing) {
      this.pending = true;
      this.schedule();
      return;
    }

    const started = performance.now();
    // One idle callback may afford several 10k chunks. Keep the total slice
    // bounded (and hand the remaining budget to `forceParsing`) so a 200k
    // document finishes in a handful of frames instead of one chunk per frame.
    while (true) {
      if (this.destroyed) {
        return;
      }
      if (this.view.composing) {
        this.pending = true;
        this.schedule();
        return;
      }

      const target = Math.min(this.view.state.doc.length, OUTLINE_SCAN_MAX_UNITS);
      const tree = syntaxTree(this.view.state);
      if (tree.length >= target) {
        this.attempts = 0;
        return;
      }

      const elapsed = performance.now() - started;
      const budget = Math.max(1, sliceMs - elapsed);
      const next = Math.min(target, tree.length + OUTLINE_PARSE_CHUNK_UNITS);
      const advanced = forceParsing(this.view, next, budget);
      const after = syntaxTree(this.view.state);
      if (after.length >= target) {
        this.attempts = 0;
        return;
      }

      if (advanced) {
        this.attempts = 0;
      } else {
        this.attempts += 1;
      }
      if (this.attempts >= OUTLINE_PARSE_MAX_ATTEMPTS_PER_CHUNK) {
        // Pause rather than spinning forever. A document/viewport change or a
        // tree update from another consumer will schedule us again.
        this.pending = false;
        return;
      }
      if (performance.now() - started >= sliceMs) {
        break;
      }
    }
    this.pending = true;
    this.schedule();
  }
}

/**
 * Advances the syntax tree in bounded idle slices. The StateField remains
 * pure; this plugin only creates parse progress and never builds headings.
 */
export const outlineParseDriver = ViewPlugin.fromClass(OutlineParseDriver);
