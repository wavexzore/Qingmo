/**
 * jsdom lacks the layout APIs CodeMirror measures during mount. Benchmarks
 * assert timing, not pixels, so zero-sized layout shims are sufficient.
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
