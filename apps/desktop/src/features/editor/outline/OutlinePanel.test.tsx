import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type {
  HeadingOutlineEntry,
  HeadingOutlineState,
  HeadingOutlineStatus,
} from "@qingmo/editor-core";

import type { EditorSession } from "../EditorSession";
import { OutlinePanel } from "./OutlinePanel";

function entry(index: number, overrides: Partial<HeadingOutlineEntry> = {}): HeadingOutlineEntry {
  return {
    level: 1,
    text: `Heading ${index}`,
    plainText: `Heading ${index}`,
    from: index * 10,
    to: index * 10 + 8,
    line: index + 1,
    lineFrom: index * 10,
    ...overrides,
  };
}

function outline(
  overrides: Partial<HeadingOutlineState> & {
    status?: HeadingOutlineStatus;
  } = {},
): HeadingOutlineState {
  return {
    entries: [entry(0), entry(1), entry(2)],
    status: "complete",
    limitReason: null,
    errorReason: null,
    treeComplete: true,
    ...overrides,
  };
}

function createSession(initial: HeadingOutlineState) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  const revealPosition = vi.fn(() => true);
  const focusEditor = vi.fn(() => true);

  const session = {
    subscribeOutline: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getOutlineSnapshot: () => snapshot,
    revealPosition,
    focusEditor,
  } as unknown as EditorSession;

  return {
    session,
    revealPosition,
    focusEditor,
    setOutline(next: HeadingOutlineState) {
      snapshot = next;
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

function renderPanel(state = outline(), cursorLine = 1, onClose = vi.fn()) {
  const fake = createSession(state);
  const result = render(
    <OutlinePanel session={fake.session} cursorLine={cursorLine} onClose={onClose} />,
  );
  return { ...fake, ...result, onClose };
}

describe("OutlinePanel", () => {
  it("renders entries, count and indentation", () => {
    const state = outline({
      entries: [
        entry(0, { level: 1, text: "One", plainText: "One" }),
        entry(1, { level: 3, text: "Three", plainText: "Three" }),
      ],
    });
    renderPanel(state);

    const panel = screen.getByTestId("outline-panel");
    expect(panel).toHaveAttribute("data-outline-count", "2");
    expect(panel).toHaveAttribute("data-outline-total", "2");
    expect(screen.getByText("One")).toBeInTheDocument();
    const three = screen.getByRole("button", { name: /Three/ });
    expect(three).toHaveStyle({ paddingLeft: "36px" });
  });

  it("falls back to raw text when plain text is empty", () => {
    renderPanel(outline({ entries: [entry(0, { plainText: "", text: "![cover](x)" })] }));
    expect(screen.getByRole("button", { name: /!\[cover\]/ })).toBeInTheDocument();
  });

  it("marks the active heading and keeps the first item tabbable", () => {
    renderPanel(outline(), 1);
    const list = screen.getByRole("list");
    const buttons = within(list).getAllByRole("button");
    expect(buttons[0]).toHaveAttribute("aria-current", "location");
    expect(buttons[0]).toHaveAttribute("tabindex", "0");
    expect(buttons[1]).toHaveAttribute("tabindex", "-1");
    expect(buttons[1]).not.toHaveAttribute("aria-current");
  });

  it("calls revealPosition on click and on Enter after keyboard movement", () => {
    const { revealPosition } = renderPanel(outline(), 1);
    const list = screen.getByRole("list");
    const buttons = within(list).getAllByRole("button");

    fireEvent.click(buttons[1]!);
    expect(revealPosition).toHaveBeenCalledWith(10);

    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(buttons[1]).toHaveFocus();
    fireEvent.keyDown(list, { key: "Enter" });
    expect(revealPosition).toHaveBeenCalledWith(10);
  });

  it("supports Home and End roving focus", () => {
    renderPanel(outline(), 1);
    const list = screen.getByRole("list");
    const buttons = within(list).getAllByRole("button");

    fireEvent.keyDown(list, { key: "End" });
    expect(buttons[2]).toHaveFocus();
    fireEvent.keyDown(list, { key: "Home" });
    expect(buttons[0]).toHaveFocus();
  });

  it("closes from the button and Escape, then focuses the editor", () => {
    const { onClose, focusEditor } = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "关闭大纲" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(focusEditor).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(screen.getByTestId("outline-panel"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(focusEditor).toHaveBeenCalledTimes(2);
  });

  it("renders the complete empty state", () => {
    renderPanel(outline({ entries: [], status: "complete" }));
    expect(screen.getByRole("status")).toHaveTextContent("本文档没有标题");
  });

  it("renders generating and size empty states", () => {
    const first = renderPanel(outline({ entries: [], status: "partial" }));
    expect(screen.getByRole("status")).toHaveTextContent("正在生成大纲");
    first.unmount();

    renderPanel(outline({ entries: [], status: "partial", limitReason: "size" }));
    expect(screen.getByRole("status")).toHaveTextContent("前 200k");
  });

  it("renders an error footer while preserving last-known entries", () => {
    renderPanel(outline({ status: "error", errorReason: "boom" }));
    expect(screen.getByText("大纲暂不可用")).toBeInTheDocument();
    expect(screen.getByRole("list")).toBeInTheDocument();
  });

  it("renders an error alert for an empty last-known-safe state", () => {
    renderPanel(outline({ entries: [], status: "error", errorReason: "boom" }));
    expect(screen.getByRole("alert")).toHaveTextContent("大纲暂不可用");
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("renders only 500 rows but reports the full field count", () => {
    const entries = Array.from({ length: 1_200 }, (_, index) => entry(index));
    renderPanel(outline({ entries }));
    const panel = screen.getByTestId("outline-panel");
    expect(panel).toHaveAttribute("data-outline-count", "500");
    expect(panel).toHaveAttribute("data-outline-total", "1200");
    expect(within(screen.getByRole("list")).getAllByRole("button")).toHaveLength(500);
  });

  it("updates aria-current when the cursor moves", () => {
    const { session, rerender } = renderPanel(outline(), 1);
    expect(within(screen.getByRole("list")).getAllByRole("button")[0]).toHaveAttribute(
      "aria-current",
      "location",
    );

    rerender(<OutlinePanel session={session} cursorLine={2} onClose={vi.fn()} />);
    expect(within(screen.getByRole("list")).getAllByRole("button")[1]).toHaveAttribute(
      "aria-current",
      "location",
    );
    expect(within(screen.getByRole("list")).getAllByRole("button")[0]).not.toHaveAttribute(
      "aria-current",
    );
  });
});
