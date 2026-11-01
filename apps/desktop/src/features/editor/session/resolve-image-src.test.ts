import { afterEach, describe, expect, it, vi } from "vitest";

import { createImageSrcResolver, resolveImagePath } from "./resolve-image-src";

const doc = "/Users/me/notes/topic/doc.md";

afterEach(() => {
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

describe("resolveImagePath", () => {
  it("resolves sibling and parent-relative images against the document", () => {
    expect(resolveImagePath(doc, "diagram.png")).toBe("/Users/me/notes/topic/diagram.png");
    expect(resolveImagePath(doc, "../assets/diagram.png")).toBe(
      "/Users/me/notes/assets/diagram.png",
    );
    expect(resolveImagePath(doc, "../../assets/a/b.png")).toBe("/Users/me/assets/a/b.png");
  });

  it("decodes percent-encoded names, including an encoded separator", () => {
    expect(resolveImagePath(doc, "../assets/%E5%9B%BE%20%E7%89%87.png")).toBe(
      "/Users/me/notes/assets/图 片.png",
    );
    expect(resolveImagePath(doc, "sub%2Fpic.png")).toBe("/Users/me/notes/topic/sub/pic.png");
  });

  it("keeps malformed percent escapes literal", () => {
    expect(resolveImagePath(doc, "100%.png")).toBe("/Users/me/notes/topic/100%.png");
  });

  it("keeps external URLs, fragments and data URLs untouched", () => {
    expect(resolveImagePath(doc, "https://example.com/a.png")).toBe("https://example.com/a.png");
    expect(resolveImagePath(doc, "data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
    expect(resolveImagePath(doc, "blob:https://example.com/1")).toBe("blob:https://example.com/1");
    expect(resolveImagePath(doc, "#preview")).toBe("#preview");
    expect(resolveImagePath(doc, "//cdn.example.com/a.png")).toBe("//cdn.example.com/a.png");
  });

  it("converts file URLs to native paths and keeps the host", () => {
    expect(resolveImagePath(doc, "file:///Users/me/a%20b.png")).toBe("/Users/me/a b.png");
    expect(resolveImagePath(doc, "file://server/share/a.png")).toBe("//server/share/a.png");
    expect(resolveImagePath(doc, "file://localhost/Users/me/a.png")).toBe("/Users/me/a.png");
  });

  it("keeps absolute POSIX and Windows paths as native paths", () => {
    expect(resolveImagePath(doc, "/opt/images/a.png")).toBe("/opt/images/a.png");
    expect(resolveImagePath("C:\\Users\\me\\doc.md", "..\\images\\a.png")).toBe(
      "C:/Users/images/a.png",
    );
    expect(resolveImagePath("C:\\Users\\me\\doc.md", "/opt/a.png")).toBe("C:/opt/a.png");
  });

  it("normalizes Windows verbatim prefixes", () => {
    expect(resolveImagePath("C:\\Users\\me\\doc.md", "\\\\?\\C:\\Users\\me\\pics\\a.png")).toBe(
      "C:/Users/me/pics/a.png",
    );
    expect(resolveImagePath("C:\\Users\\me\\doc.md", "\\\\?\\UNC\\server\\share\\a.png")).toBe(
      "//server/share/a.png",
    );
  });

  it("resolves images relative to a UNC document", () => {
    const uncDoc = "\\\\server\\share\\notes\\doc.md";
    expect(resolveImagePath(uncDoc, "pic.png")).toBe("//server/share/notes/pic.png");
    expect(resolveImagePath(uncDoc, "../assets/pic.png")).toBe("//server/share/assets/pic.png");
    // `..` never climbs above the share.
    expect(resolveImagePath(uncDoc, "../../../../pic.png")).toBe("//server/share/pic.png");
  });

  it("treats a machine-like host as UNC on a local document", () => {
    expect(resolveImagePath(doc, "//fileserver/share/a.png")).toBe("//fileserver/share/a.png");
    expect(resolveImagePath(doc, "//192.168.1.4/share/a.png")).toBe("//192.168.1.4/share/a.png");
  });

  it("keeps the query and fragment out of the file name", () => {
    expect(resolveImagePath(doc, "pic.png?raw=1")).toBe("/Users/me/notes/topic/pic.png?raw=1");
    expect(resolveImagePath(doc, "pic.svg#icon")).toBe("/Users/me/notes/topic/pic.svg#icon");
    expect(resolveImagePath(doc, "https://example.com/a.png?x=1#y")).toBe(
      "https://example.com/a.png?x=1#y",
    );
  });

  it("leaves a relative source alone without a document path", () => {
    expect(resolveImagePath("", "pic.png")).toBe("pic.png");
  });
});

describe("createImageSrcResolver", () => {
  it("passes sources through outside the Tauri runtime", () => {
    const resolver = createImageSrcResolver(doc);
    expect(resolver("pic.png")).toBe("pic.png");
  });

  it("builds asset URLs for local files only in the Tauri runtime", () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {
        convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
      },
    });
    const resolver = createImageSrcResolver(doc);
    expect(resolver("pic.png")).toBe(
      `asset://localhost/${encodeURIComponent("/Users/me/notes/topic/pic.png")}`,
    );
    expect(resolver("pic.png?raw=1")).toBe(
      `asset://localhost/${encodeURIComponent("/Users/me/notes/topic/pic.png")}?raw=1`,
    );
    expect(resolver("https://example.com/a.png")).toBe("https://example.com/a.png");
    expect(resolver("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
  });

  it("stays identity for an untitled document", () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: { convertFileSrc: (path: string) => `asset://localhost/${path}` },
    });
    expect(createImageSrcResolver("")("pic.png")).toBe("pic.png");
  });
});
