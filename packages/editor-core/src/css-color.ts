/**
 * CSS colour resolution shared by Mermaid and the editor minimap.
 *
 * Both consumers need concrete colours for a canvas (or a sandboxed iframe)
 * that cannot read Qingmo's CSS custom properties directly. Keeping the probe
 * logic here prevents a second palette implementation from drifting away from
 * `tokens.css`.
 */

export interface TokenReader {
  color(token: string, fallback: string): string;
  raw(token: string, fallback: string): string;
  dispose(): void;
}

function hexChannel(value: string): string {
  const channel = Math.max(0, Math.min(255, Math.round(Number(value))));
  return channel.toString(16).padStart(2, "0");
}

/**
 * `getComputedStyle` returns `rgb(...)`/`rgba(...)`. Mermaid's comma-separated
 * options (for example `xyChart.plotColorPalette`) cannot contain commas
 * inside a colour, so opaque colours are normalised to hex.
 */
export function normalizeCssColor(value: string): string {
  const match = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)$/i.exec(
    value,
  );
  if (!match) {
    return value;
  }
  const [, red, green, blue, alpha] = match;
  if (!red || !green || !blue) {
    return value;
  }
  if (alpha !== undefined && Number(alpha) < 1) {
    return `rgba(${Math.round(Number(red))}, ${Math.round(Number(green))}, ${Math.round(Number(blue))}, ${alpha})`;
  }
  return `#${hexChannel(red)}${hexChannel(green)}${hexChannel(blue)}`;
}

/**
 * Creates a hidden probe used to resolve `light-dark()`/`color-mix()` tokens.
 * `dispose()` must always be called; one probe per resolution keeps theme
 * switches from leaking hidden DOM nodes.
 */
export function createTokenReader(root?: HTMLElement): TokenReader | null {
  const doc = root?.ownerDocument ?? (typeof document === "undefined" ? null : document);
  const view = doc?.defaultView;
  const tokenRoot = root ?? doc?.documentElement;
  const parent = root ?? doc?.body ?? doc?.documentElement;
  if (!doc || !view || !tokenRoot || !parent) {
    return null;
  }

  const host = doc.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText =
    "position:fixed;left:-10000px;top:0;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none;";
  const probe = doc.createElement("span");
  host.append(probe);
  parent.append(host);

  return {
    color(token, fallback) {
      // Plain token values are usable as-is (and are the only thing jsdom
      // can resolve). `light-dark()` and other functions need a probe, which
      // lets the browser compute the value for the current color-scheme.
      const raw = view.getComputedStyle(tokenRoot).getPropertyValue(token).trim();
      if (raw && !/^(?:light-dark|var|color-mix)\(/i.test(raw)) {
        return normalizeCssColor(raw);
      }
      probe.style.color = `var(${token}, ${fallback})`;
      const value = view.getComputedStyle(probe).color.trim();
      return normalizeCssColor(value && !value.startsWith("var(") ? value : fallback);
    },
    raw(token, fallback) {
      const value = view.getComputedStyle(tokenRoot).getPropertyValue(token).trim();
      return value || fallback;
    },
    dispose() {
      host.remove();
    },
  };
}
