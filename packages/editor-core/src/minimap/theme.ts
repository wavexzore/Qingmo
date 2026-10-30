import { createTokenReader } from "../css-color";

/**
 * The minimap only needs six structural colour families plus the caret
 * colour. Keeping the token mapping here means a theme change never requires
 * a second palette in the minimap plugin.
 */
export interface MinimapPalette {
  text: string;
  heading: string;
  muted: string;
  code: string;
  diagram: string;
  table: string;
  rule: string;
  selection: string;
}

const NEUTRAL = "#808080";

export function resolveMinimapPalette(root?: HTMLElement): MinimapPalette | null {
  const reader = createTokenReader(root);
  if (!reader) {
    return null;
  }

  try {
    const color = (token: string): string => reader.color(token, NEUTRAL);
    return {
      text: color("--qm-ink"),
      heading: color("--qm-accent"),
      muted: color("--qm-ink-muted"),
      code: color("--qm-diagram-accent-3"),
      diagram: color("--qm-diagram-accent-4"),
      table: color("--qm-diagram-accent-2"),
      rule: color("--qm-ink-faint"),
      selection: color("--qm-accent-strong"),
    };
  } finally {
    reader.dispose();
  }
}
