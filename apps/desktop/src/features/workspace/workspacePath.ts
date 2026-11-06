/**
 * Stable cache keys for workspace directories.
 *
 * Segments are validated by Rust and never contain `/`, so joining with `/`
 * cannot collide. The root is the empty key.
 */
export function workspaceKey(segments: readonly string[]): string {
  return segments.join("/");
}

/** Prefixes that must be loaded/expanded before a row can be revealed. */
export function ancestorSegments(segments: readonly string[]): string[][] {
  const ancestors: string[][] = [];
  for (let index = 0; index < segments.length; index += 1) {
    ancestors.push(segments.slice(0, index));
  }
  return ancestors;
}

export function parentSegments(segments: readonly string[]): string[] {
  return segments.slice(0, -1);
}

/** Stable DOM id for one row; the key itself is not a safe HTML id. */
export function workspaceRowId(segments: readonly string[]): string {
  const key = workspaceKey(segments);
  let hash = 0x811c9dc5;
  for (const character of key) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `workspace-row-${hash.toString(16).padStart(8, "0")}`;
}
