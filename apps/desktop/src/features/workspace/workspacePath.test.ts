import { describe, expect, it } from "vitest";

import { ancestorSegments, parentSegments, workspaceKey, workspaceRowId } from "./workspacePath";

describe("workspace path helpers", () => {
  it("uses the root empty key and slash-joined segments", () => {
    expect(workspaceKey([])).toBe("");
    expect(workspaceKey(["docs"])).toBe("docs");
    expect(workspaceKey(["docs", "note.md"])).toBe("docs/note.md");
  });

  it("returns every prefix that must be loaded before a reveal", () => {
    expect(ancestorSegments(["docs", "notes", "a.md"])).toEqual([[], ["docs"], ["docs", "notes"]]);
    expect(ancestorSegments(["a.md"])).toEqual([[]]);
    expect(ancestorSegments([])).toEqual([]);
  });

  it("computes parents without mutating the input", () => {
    const segments = ["docs", "note.md"];
    expect(parentSegments(segments)).toEqual(["docs"]);
    expect(segments).toEqual(["docs", "note.md"]);
    expect(parentSegments([])).toEqual([]);
  });

  it("derives a stable row id that is safe for HTML", () => {
    expect(workspaceRowId(["docs", "note.md"])).toBe(workspaceRowId(["docs", "note.md"]));
    expect(workspaceRowId(["docs", "note.md"])).not.toBe(workspaceRowId(["docs", "other.md"]));
    expect(workspaceRowId(["docs", "note.md"])).toMatch(/^workspace-row-[0-9a-f]{8}$/);
  });
});
