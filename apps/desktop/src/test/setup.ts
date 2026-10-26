import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

import "../i18n";

/**
 * jsdom lacks the layout APIs CodeMirror measures during mount. The values are
 * deliberately zero-sized; tests assert DOM/state behaviour, not pixels.
 */
class ResizeObserverMock {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = ResizeObserverMock;
}

if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

if (!window.requestAnimationFrame) {
  window.requestAnimationFrame = (callback: FrameRequestCallback): number =>
    setTimeout(() => {
      callback(performance.now());
    }, 0) as unknown as number;
  window.cancelAnimationFrame = (handle: number): void => {
    clearTimeout(handle);
  };
}

if (!Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = () => new DOMRect();
}

if (!Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () =>
    Object.assign([], {
      item: () => null,
    }) as unknown as DOMRectList;
}

afterEach(() => {
  cleanup();
});
