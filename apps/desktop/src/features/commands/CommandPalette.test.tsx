import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { AppError } from "@qingmo/shared";

import { CommandPalette } from "./CommandPalette";
import { CommandRegistry } from "./CommandRegistry";
import { formatKeybinding } from "./keybindings";

function createRegistry() {
  return new CommandRegistry({ warn: () => undefined });
}

function registerFileCommands(registry: CommandRegistry, run = vi.fn()) {
  registry.register({
    id: "file.open",
    titleKey: "commands:file.open",
    category: "commands:category.file",
    keybinding: "Mod+O",
    run,
  });
  registry.register({
    id: "file.save",
    titleKey: "commands:file.save",
    category: "commands:category.file",
    keybinding: "Mod+S",
    run,
  });
  return run;
}

function renderPalette(
  registry: CommandRegistry,
  options: {
    open?: boolean;
    onClose?: () => void;
    onError?: (error: AppError) => void;
  } = {},
) {
  const onClose = options.onClose ?? vi.fn();
  const onError = options.onError ?? vi.fn();
  const view = render(
    <CommandPalette
      open={options.open ?? true}
      onClose={onClose}
      onError={onError}
      registry={registry}
    />,
  );
  return { ...view, onClose, onError };
}

describe("CommandPalette", () => {
  it("lists registered commands with categories and registry-derived shortcuts", () => {
    const registry = createRegistry();
    registerFileCommands(registry);

    renderPalette(registry);

    expect(screen.getByRole("dialog", { name: "命令面板" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /打开文件/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /保存文件/ })).toBeInTheDocument();
    expect(screen.getAllByText("文件")).toHaveLength(2);
    expect(screen.getByText(formatKeybinding("Mod+O"))).toBeInTheDocument();
    expect(screen.getByText(formatKeybinding("Mod+S"))).toBeInTheDocument();
  });

  it("filters by title and hides commands whose when() is false", () => {
    const registry = createRegistry();
    registerFileCommands(registry);
    registry.register({
      id: "view.toggleTheme",
      titleKey: "commands:view.toggleTheme",
      category: "commands:category.view",
      keybinding: "Mod+Shift+L",
      when: () => false,
      run: vi.fn(),
    });

    renderPalette(registry);

    const input = screen.getByRole("combobox");
    expect(screen.queryByRole("option", { name: /切换主题/ })).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: "保存" } });

    expect(screen.getByRole("option", { name: /保存文件/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /打开文件/ })).not.toBeInTheDocument();
  });

  it("moves the active option with arrows and wraps at both ends", () => {
    const registry = createRegistry();
    registerFileCommands(registry);
    renderPalette(registry);

    const input = screen.getByRole("combobox");
    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
  });

  it("keeps focus inside the modal on Tab", () => {
    const registry = createRegistry();
    registerFileCommands(registry);
    renderPalette(registry);
    const input = screen.getByRole("combobox");

    expect(fireEvent.keyDown(input, { key: "Tab" })).toBe(false);
    expect(fireEvent.keyDown(input, { key: "Tab", shiftKey: true })).toBe(false);
  });

  it("runs the active command on Enter and closes first", async () => {
    const registry = createRegistry();
    const run = registerFileCommands(registry);
    const { onClose } = renderPalette(registry);

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });

    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  });

  it("runs a clicked command once", async () => {
    const registry = createRegistry();
    const run = registerFileCommands(registry);
    const { onClose } = renderPalette(registry);

    fireEvent.mouseDown(screen.getByRole("option", { name: /打开文件/ }));

    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  });

  it("closes on Escape and on an overlay click", () => {
    const registry = createRegistry();
    registerFileCommands(registry);
    const { onClose } = renderPalette(registry);

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.mouseDown(screen.getByTestId("command-palette-overlay"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("shows an empty state and ignores Enter when nothing matches", async () => {
    const registry = createRegistry();
    const run = registerFileCommands(registry);
    const { onClose } = renderPalette(registry);

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "zzzz" } });

    expect(screen.getByText("没有匹配的命令")).toBeInTheDocument();
    expect(screen.queryAllByRole("option")).toHaveLength(0);

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(onClose).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
  });

  it("reports command failures through onError", async () => {
    const registry = createRegistry();
    registry.register({
      id: "file.open",
      titleKey: "commands:file.open",
      category: "commands:category.file",
      keybinding: "Mod+O",
      run: () => {
        throw new Error("boom");
      },
    });
    const onError = vi.fn<(error: AppError) => void>();
    renderPalette(registry, { onError });

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ code: "IO", message: "boom" });
  });

  it("restores focus to the element that opened it", () => {
    const registry = createRegistry();
    registerFileCommands(registry);

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button type="button" onClick={() => setOpen(true)}>
            open palette
          </button>
          <CommandPalette open={open} onClose={() => setOpen(false)} registry={registry} />
        </div>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "open palette" });
    trigger.focus();
    fireEvent.click(trigger);

    const input = screen.getByRole("combobox");
    expect(input).toHaveFocus();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
