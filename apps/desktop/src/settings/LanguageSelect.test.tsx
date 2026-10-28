import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { LanguageSelect, type LanguageOption } from "./LanguageSelect";

const options: LanguageOption[] = [
  { value: "zh-CN", nativeName: "简体中文", detail: "Chinese (Simplified)", code: "ZH-CN" },
  { value: "en", nativeName: "English", detail: "English", code: "EN" },
];

describe("LanguageSelect", () => {
  it("exposes a select-only combobox with the selected option", () => {
    render(<LanguageSelect value="zh-CN" options={options} label="界面语言" onChange={() => {}} />);

    const trigger = screen.getByTestId("settings-language");
    expect(trigger).toHaveAttribute("role", "combobox");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveTextContent("简体中文");
    const listbox = screen.getByRole("listbox", { hidden: true });
    expect(listbox).toHaveAttribute("aria-label", "界面语言");
  });

  it("moves through options with the keyboard and selects on Enter", () => {
    const onChange = vi.fn();
    render(<LanguageSelect value="zh-CN" options={options} label="界面语言" onChange={onChange} />);

    const trigger = screen.getByTestId("settings-language");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "End" });
    expect(trigger.getAttribute("aria-activedescendant")).toContain("-option-1");

    fireEvent.keyDown(trigger, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith("en");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("selects an option with the pointer", () => {
    const onChange = vi.fn();
    render(<LanguageSelect value="zh-CN" options={options} label="界面语言" onChange={onChange} />);

    fireEvent.click(screen.getByTestId("settings-language"));
    fireEvent.click(screen.getByRole("option", { name: /English/ }));

    expect(onChange).toHaveBeenCalledWith("en");
  });

  it("closes the popup when Tab moves focus away", () => {
    render(<LanguageSelect value="zh-CN" options={options} label="界面语言" onChange={() => {}} />);

    const trigger = screen.getByTestId("settings-language");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "Tab" });

    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
});
