import { isTauriRuntime } from "../../../lib/platform/runtime";
import { toAssetUrl } from "../../../lib/platform/tauri";

const EXTERNAL_SCHEME = /^(?:https?:|data:|blob:|asset:)/i;
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const WINDOWS_DRIVE_RELATIVE = /^[A-Za-z]:(?![\\/])/;
const UNC_BACKSLASH = /^\\\\/;
const VERBATIM_UNC = /^\\\\\?\\UNC\\/i;
const VERBATIM = /^\\\\\?\\|^\\\\\.\\/;

/** A resolved source: either an opaque URL or a native file plus its suffix. */
export type ResolvedImageSource =
  { kind: "external"; url: string } | { kind: "file"; path: string; suffix: string };

/**
 * Resolves a Markdown/HTML image source against the document's directory.
 *
 * Tauri cannot load arbitrary `file://` URLs, so the resulting native path is
 * passed through `convertFileSrc` and the asset protocol. The path step is
 * pure and exported for tests; browser previews keep the raw source.
 */
export function resolveImagePath(documentPath: string, src: string): string {
  const resolved = resolveImageSource(documentPath, src);
  return resolved.kind === "external" ? resolved.url : resolved.path + resolved.suffix;
}

/**
 * Classifies and resolves one source. External URLs (web, data, blob, SVG
 * fragments) are returned untouched; anything that names a local file becomes
 * an absolute native path.
 */
export function resolveImageSource(documentPath: string, src: string): ResolvedImageSource {
  const trimmed = src.trim();
  if (!trimmed) {
    return { kind: "external", url: trimmed };
  }
  if (trimmed.startsWith("#")) {
    return { kind: "external", url: trimmed };
  }
  if (EXTERNAL_SCHEME.test(trimmed)) {
    return { kind: "external", url: trimmed };
  }

  const { path: rawPath, suffix } = splitSuffix(trimmed);
  if (!rawPath) {
    return { kind: "external", url: trimmed };
  }

  if (VERBATIM.test(rawPath)) {
    const native = normalizeNativePath(rawPath);
    return { kind: "file", path: absolutePath(native) ?? native, suffix };
  }

  if (UNC_BACKSLASH.test(rawPath) || rawPath.startsWith("//")) {
    const unc = normalizeUnc(rawPath);
    const candidate = unc.split("/")[2] ?? "";
    const documentUnc = UNC_BACKSLASH.test(documentPath) || documentPath.startsWith("//");
    if (documentUnc || looksLikeHostWithoutDot(candidate)) {
      return { kind: "file", path: absolutePath(unc) ?? unc, suffix };
    }
    return { kind: "external", url: trimmed };
  }

  if (WINDOWS_DRIVE.test(rawPath)) {
    return { kind: "file", path: absolutePath(rawPath) ?? rawPath, suffix };
  }
  if (WINDOWS_DRIVE_RELATIVE.test(rawPath)) {
    // Drive-relative paths resolve against the process CWD on that drive.
    return { kind: "file", path: rawPath, suffix };
  }

  if (rawPath.startsWith("/")) {
    // A leading slash means the root of the document's volume/share.
    const all = absoluteOnDocumentRoot(documentPath, rawPath);
    return all ? { kind: "file", path: all, suffix } : { kind: "external", url: trimmed };
  }

  if (/^file:/i.test(rawPath)) {
    const fromUrl = fileUrlPath(rawPath);
    if (fromUrl) {
      return { kind: "file", path: fromUrl, suffix };
    }
    return { kind: "external", url: trimmed };
  }

  if (ANY_SCHEME.test(rawPath)) {
    return { kind: "external", url: trimmed };
  }

  const document = normalizeNativePath(documentPath);
  if (document.length === 0) {
    return { kind: "external", url: trimmed };
  }
  const resolved = relativePath(document, rawPath);
  return resolved ? { kind: "file", path: resolved, suffix } : { kind: "external", url: trimmed };
}

/** Builds the resolver installed into the editor for one document. */
export function createImageSrcResolver(documentPath: string): (src: string) => string {
  if (!isTauriRuntime() || documentPath.length === 0) {
    return (src) => src;
  }
  return (src) => {
    const resolved = resolveImageSource(documentPath, src);
    if (resolved.kind === "external") {
      return resolved.url;
    }
    try {
      return toAssetUrl(resolved.path) + resolved.suffix;
    } catch {
      return resolved.path + resolved.suffix;
    }
  };
}

function splitSuffix(value: string): { path: string; suffix: string } {
  // A verbatim Windows prefix (`\\?\`) contains its own question mark.
  const start = VERBATIM.test(value) ? 4 : 0;
  const index = value.slice(start).search(/[?#]/);
  return index < 0
    ? { path: value, suffix: "" }
    : { path: value.slice(0, start + index), suffix: value.slice(start + index) };
}

/** Strips Windows verbatim/long-path prefixes and unifies separators. */
function normalizeNativePath(path: string): string {
  const withoutPrefix = VERBATIM_UNC.test(path)
    ? `//${path.slice(8)}`
    : VERBATIM.test(path)
      ? path.slice(4)
      : path;
  return withoutPrefix.replace(/\\/g, "/");
}

function normalizeUnc(path: string): string {
  const withoutPrefix = VERBATIM_UNC.test(path) ? `//${path.slice(8)}` : path;
  return `//${withoutPrefix.replace(/^[/\\]+/, "").replace(/\\/g, "/")}`;
}

interface PathRoot {
  prefix: string;
  segments: readonly string[];
}

/** Splits an absolute path into its root and decoded segments. */
function splitRoot(path: string): PathRoot | null {
  const unc = /^\/\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (unc) {
    return {
      prefix: `//${unc[1]}/${unc[2]}/`,
      segments: decodeSegments(unc[3] ?? ""),
    };
  }
  const drive = /^([A-Za-z]):\/(.*)$/.exec(path);
  if (drive) {
    return { prefix: `${drive[1]}:/`, segments: decodeSegments(drive[2] ?? "") };
  }
  if (path.startsWith("/")) {
    return { prefix: "/", segments: decodeSegments(path.slice(1)) };
  }
  return null;
}

/** Absolute inputs keep their own root; `..` never escapes it. */
function absolutePath(path: string): string | null {
  const split = splitRoot(normalizeNativePath(path));
  return split ? joinRoot(split.prefix, split.segments) : null;
}

/** Resolves a leading-slash source from the document's own volume root. */
function absoluteOnDocumentRoot(documentPath: string, src: string): string | null {
  const split = splitRoot(normalizeNativePath(documentPath));
  if (!split) {
    return null;
  }
  return joinRoot(split.prefix, decodeSegments(normalizeNativePath(src)));
}

function relativePath(documentPath: string, src: string): string | null {
  const split = splitRoot(documentPath);
  if (!split) {
    return null;
  }
  // The last document segment is the file name, not a directory.
  const base = split.segments.slice(0, -1);
  const segments = [...base, ...decodeSegments(normalizeNativePath(src))];
  return joinRoot(split.prefix, segments);
}

function joinRoot(prefix: string, segments: readonly string[]): string {
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  const suffix = out.join("/");
  return suffix.length === 0 ? prefix : `${prefix}${suffix}`;
}

/**
 * Percent-decodes a path and lets `%2F` act as a separator. A malformed escape
 * keeps the literal text instead of failing the whole image.
 */
function decodeSegments(path: string): string[] {
  return safeDecode(path).split("/");
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function looksLikeHostWithoutDot(host: string): boolean {
  if (host.length === 0) {
    return false;
  }
  return !host.includes(".") || /^[\d.]+$/.test(host);
}

/** Converts a `file:` URL to a native path, keeping UNC/Windows hosts. */

function fileUrlPath(value: string): string | null {
  try {
    const url = new URL(value);
    const path = normalizeNativePath(url.pathname);
    if (url.host.length > 0 && url.host.toLowerCase() !== "localhost") {
      return absolutePath(`//${url.host}${path}`);
    }
    if (WINDOWS_DRIVE.test(path.slice(1))) {
      return absolutePath(path.slice(1));
    }
    return absolutePath(path);
  } catch {
    return null;
  }
}
