import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { FlatRow } from "./workspaceTree";
import { VirtualWorkspaceTree } from "./VirtualWorkspaceTree";

function row(segments: string[], kind: FlatRow["kind"], extra: Partial<FlatRow> = {}): FlatRow {
  return {
    key: segments.join("/"),
    segments,
    name: segments[segments.length - 1] ?? "",
    kind,
    depth: segments.length - 1,
    expandable: kind === "directory" || kind === "symlinkDirectory",
    openable: kind === "file" || kind === "symlinkFile",
    expanded: false,
    posInSet: 1,
    setSize: 1,
    loadState: "loaded",
    stale: false,
    errorCode: null,
    truncated: false,
    truncationReason: null,
    ...extra,
  };
}

const DOCS = row(["docs"], "directory", { expanded: true });
const NESTED = row(["docs", "nested"], "directory");
const NOTE = row(["docs", "note.md"], "file", { posInSet: 2, setSize: 2 });
const ROOT_FILE = row(["readme.md"], "file", { posInSet: 2, setSize: 2 });

interface HarnessProps {
  rows: FlatRow[];
  onToggle?: (segments: string[]) => void;
  onOpenFile?: (segments: string[]) => void;
  onRetry?: (segments: string[]) => void;
  initialFocused?: string | null;
  currentKey?: string | null;
  active?: boolean;
}

function Harness({
  rows,
  onToggle = () => undefined,
  onOpenFile = () => undefined,
  onRetry = () => undefined,
  initialFocused = rows[0]?.key ?? null,
  currentKey = null,
  active = true,
}: HarnessProps) {
  const [focusedKey, setFocusedKey] = useState<string | null>(initialFocused);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  return (
    <VirtualWorkspaceTree
      rows={rows}
      focusedKey={focusedKey}
      selectedKey={selectedKey}
      currentKey={currentKey}
      active={active}
      onFocusKey={setFocusedKey}
      onSelectKey={setSelectedKey}
      onToggle={onToggle}
      onOpenFile={onOpenFile}
      onRetry={onRetry}
    />
  );
}

function rowElement(key: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-workspace-key="${key}"]`);
  if (!element) {
    throw new Error(`missing row ${key}`);
  }
  return element;
}

describe("VirtualWorkspaceTree", () => {
  it("renders treeitem ARIA state from the flat rows", () => {
    render(<Harness rows={[DOCS, NOTE, ROOT_FILE]} />);

    expect(screen.getByRole("tree", { name: "工作区文件树" })).toBeInTheDocument();
    const docs = rowElement("docs");
    expect(docs).toHaveAttribute("role", "treeitem");
    expect(docs).toHaveAttribute("aria-level", "1");
    expect(docs).toHaveAttribute("aria-expanded", "true");
    expect(docs).toHaveAttribute("aria-posinset", "1");
    expect(docs).toHaveAttribute("aria-setsize", "1");

    const note = rowElement("docs/note.md");
    expect(note).toHaveAttribute("aria-level", "2");
    expect(note).not.toHaveAttribute("aria-expanded");
    expect(note).toHaveAttribute("aria-selected", "false");
  });

  it("selects and opens a file on a single click", () => {
    const onOpenFile = vi.fn();
    const onToggle = vi.fn();
    render(<Harness rows={[NOTE]} onOpenFile={onOpenFile} onToggle={onToggle} />);

    fireEvent.click(rowElement("docs/note.md"));
    expect(rowElement("docs/note.md")).toHaveAttribute("aria-selected", "true");
    expect(onOpenFile).toHaveBeenCalledWith(["docs", "note.md"]);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("toggles a directory on click instead of selecting it as a file", () => {
    const onOpenFile = vi.fn();
    const onToggle = vi.fn();
    render(<Harness rows={[DOCS]} onOpenFile={onOpenFile} onToggle={onToggle} />);

    fireEvent.click(rowElement("docs"));
    expect(onToggle).toHaveBeenCalledWith(["docs"]);
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("opens a focused file with Enter and Space", () => {
    const onOpenFile = vi.fn();
    render(<Harness rows={[NOTE]} onOpenFile={onOpenFile} initialFocused="docs/note.md" />);

    fireEvent.keyDown(rowElement("docs/note.md"), { key: "Enter" });
    fireEvent.keyDown(rowElement("docs/note.md"), { key: " " });
    expect(onOpenFile).toHaveBeenNthCalledWith(1, ["docs", "note.md"]);
    expect(onOpenFile).toHaveBeenNthCalledWith(2, ["docs", "note.md"]);
  });

  it("moves focus with arrow keys, Home and End", () => {
    render(<Harness rows={[DOCS, NOTE, ROOT_FILE]} initialFocused="docs" />);

    fireEvent.keyDown(rowElement("docs"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(rowElement("docs/note.md"));

    fireEvent.keyDown(rowElement("docs/note.md"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(rowElement("readme.md"));

    fireEvent.keyDown(rowElement("readme.md"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(rowElement("readme.md"));

    fireEvent.keyDown(rowElement("readme.md"), { key: "Home" });
    expect(document.activeElement).toBe(rowElement("docs"));

    fireEvent.keyDown(rowElement("docs"), { key: "End" });
    expect(document.activeElement).toBe(rowElement("readme.md"));
  });

  it("expands with ArrowRight and focuses the first child when already expanded", () => {
    const onToggle = vi.fn();
    const collapsed = row(["docs"], "directory");
    const { rerender } = render(
      <Harness rows={[collapsed]} onToggle={onToggle} initialFocused="docs" />,
    );
    fireEvent.keyDown(rowElement("docs"), { key: "ArrowRight" });
    expect(onToggle).toHaveBeenCalledWith(["docs"]);

    rerender(<Harness rows={[DOCS, NESTED]} onToggle={onToggle} initialFocused="docs" />);
    fireEvent.keyDown(rowElement("docs"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(rowElement("docs/nested"));
  });

  it("collapses with ArrowLeft and moves to the parent from a child", () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <Harness rows={[DOCS, NOTE]} onToggle={onToggle} initialFocused="docs" />,
    );
    fireEvent.keyDown(rowElement("docs"), { key: "ArrowLeft" });
    expect(onToggle).toHaveBeenCalledWith(["docs"]);

    rerender(<Harness rows={[DOCS, NOTE]} onToggle={onToggle} initialFocused="docs/note.md" />);
    fireEvent.focus(rowElement("docs/note.md"));
    fireEvent.keyDown(rowElement("docs/note.md"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(rowElement("docs"));
  });

  it("retries a failed directory without selecting the row", () => {
    const onRetry = vi.fn();
    const failed = row(["docs"], "directory", { loadState: "error", errorCode: "IO" });
    render(<Harness rows={[failed]} onRetry={onRetry} />);

    fireEvent.click(screen.getByRole("button", { name: "重试读取此目录" }));
    expect(onRetry).toHaveBeenCalledWith(["docs"]);
    expect(rowElement("docs")).toHaveAttribute("aria-selected", "false");
  });

  it("marks the current row and scrolls it into view on activation", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    render(<Harness rows={[NOTE]} currentKey="docs/note.md" />);

    expect(rowElement("docs/note.md")).toHaveAttribute("data-workspace-current", "true");
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("ignores keyboard events originating from a row button", () => {
    const onRetry = vi.fn();
    const failed = row(["docs"], "directory", { loadState: "error", errorCode: "IO" });
    render(<Harness rows={[failed]} initialFocused="docs" onRetry={onRetry} />);

    const button = screen.getByRole("button", { name: "重试读取此目录" });
    fireEvent.keyDown(button, { key: "Enter" });
    expect(onRetry).not.toHaveBeenCalled();
  });
});
