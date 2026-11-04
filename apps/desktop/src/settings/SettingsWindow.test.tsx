import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_EDITOR_TYPOGRAPHY } from "@qingmo/shared";

import { LocaleController } from "../app/LocaleController";
import i18n from "../i18n";
import { FakeSettings } from "../lib/settings/fake";
import { EDITOR_TYPOGRAPHY_STORAGE_KEY, LANGUAGE_STORAGE_KEY, uiStore } from "../stores/uiStore";
import { SettingsWindow } from "./SettingsWindow";

const controllers: LocaleController[] = [];

function renderSettings(options: { settings?: FakeSettings } = {}) {
  const settings = options.settings ?? new FakeSettings();
  const controller = new LocaleController({ store: uiStore, i18n, native: null });
  controller.start();
  controllers.push(controller);
  render(<SettingsWindow settings={settings} />);
  return { settings };
}

async function resetLocale(): Promise<void> {
  window.localStorage.removeItem(LANGUAGE_STORAGE_KEY);
  window.localStorage.removeItem(EDITOR_TYPOGRAPHY_STORAGE_KEY);
  uiStore.syncFromStorage(null);
  await i18n.changeLanguage("zh-CN");
}

afterEach(async () => {
  for (const controller of controllers.splice(0)) {
    controller.stop();
  }
  await resetLocale();
});

describe("SettingsWindow", () => {
  it("renders the General sections with the current language", async () => {
    renderSettings();

    expect(screen.getByTestId("settings-window")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "通用设置" })).toBeInTheDocument();
    expect(screen.getByTestId("settings-language")).toHaveTextContent("简体中文");
    await waitFor(() => expect(screen.getByText("版本 0.1.2")).toBeInTheDocument());
  });

  it("renders both General sections with the default typography", async () => {
    renderSettings();

    expect(screen.getByTestId("settings-window")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "通用设置" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "排版" })).toBeInTheDocument();
    expect(screen.getByTestId("settings-language")).toHaveTextContent("简体中文");
    expect(screen.getByTestId("settings-font-size")).toHaveValue("15");
    expect(screen.getByTestId("settings-font-size-value")).toHaveTextContent("15px");
    expect(screen.getByTestId("settings-font-mono")).toBeChecked();
    expect(screen.getByTestId("settings-font-option-mono")).toHaveAttribute("data-checked", "true");
    expect(screen.getByTestId("settings-typography-reset")).toBeDisabled();
    await waitFor(() => expect(screen.getByText("版本 0.1.2")).toBeInTheDocument());
  });

  it("updates the font size, preview, and persisted JSON from the range", async () => {
    renderSettings();

    fireEvent.change(screen.getByTestId("settings-font-size"), { target: { value: "22" } });

    await waitFor(() => expect(uiStore.getSnapshot().typography.fontSize).toBe(22));
    expect(screen.getByTestId("settings-font-size-value")).toHaveTextContent("22px");
    expect(screen.getByTestId("settings-typography-preview").querySelector("p")).toHaveStyle({
      fontSize: "22px",
    });
    expect(JSON.parse(window.localStorage.getItem(EDITOR_TYPOGRAPHY_STORAGE_KEY) ?? "{}")).toEqual({
      version: 1,
      fontSize: 22,
      fontFamily: "mono",
    });
    expect(screen.getByTestId("settings-typography-reset")).toBeEnabled();
  });

  it("selects a font family from the visible label", async () => {
    renderSettings();

    fireEvent.click(screen.getByTestId("settings-font-option-serif"));

    await waitFor(() => expect(uiStore.getSnapshot().typography.fontFamily).toBe("serif"));
    expect(screen.getByTestId("settings-font-serif")).toBeChecked();
    expect(screen.getByTestId("settings-font-option-serif")).toHaveAttribute(
      "data-checked",
      "true",
    );
    expect(screen.getByTestId("settings-font-option-mono")).toHaveAttribute(
      "data-checked",
      "false",
    );
    expect(JSON.parse(window.localStorage.getItem(EDITOR_TYPOGRAPHY_STORAGE_KEY) ?? "{}")).toEqual({
      version: 1,
      fontSize: 15,
      fontFamily: "serif",
    });
  });

  it("restores the defaults and confirms with a toast", async () => {
    renderSettings();

    fireEvent.change(screen.getByTestId("settings-font-size"), { target: { value: "26" } });
    fireEvent.click(screen.getByTestId("settings-font-option-sans"));
    await waitFor(() => expect(uiStore.getSnapshot().typography.fontFamily).toBe("sans"));

    fireEvent.click(screen.getByTestId("settings-typography-reset"));

    await waitFor(() =>
      expect(uiStore.getSnapshot().typography).toEqual(DEFAULT_EDITOR_TYPOGRAPHY),
    );
    expect(screen.getByTestId("settings-font-size")).toHaveValue("15");
    expect(screen.getByTestId("settings-font-mono")).toBeChecked();
    expect(screen.getByTestId("settings-typography-reset")).toBeDisabled();
    expect(screen.getByText("编辑器排版已恢复默认。")).toBeInTheDocument();
  });

  it("keeps the session value and warns once when persistence fails", async () => {
    renderSettings();
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });

    fireEvent.change(screen.getByTestId("settings-font-size"), { target: { value: "18" } });
    fireEvent.change(screen.getByTestId("settings-font-size"), { target: { value: "19" } });

    await waitFor(() => expect(uiStore.getSnapshot().typography.fontSize).toBe(19));
    expect(screen.getByTestId("settings-font-size")).toHaveValue("19");
    expect(
      screen.getAllByText("无法保存排版设置；本次会话仍生效，重启后会恢复默认。"),
    ).toHaveLength(1);
    expect(setItem).toHaveBeenCalled();
  });

  it("applies a language immediately and translates its own webview", async () => {
    renderSettings();

    fireEvent.click(screen.getByTestId("settings-language"));
    fireEvent.click(screen.getByRole("option", { name: /English/ }));

    await waitFor(() => expect(uiStore.getSnapshot().language).toBe("en"));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "General settings" })).toBeInTheDocument(),
    );
    expect(screen.getByTestId("settings-language")).toHaveTextContent("English");
    expect(screen.getByText("Interface language set to English.")).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("en");
  });

  it("supports keyboard selection with the combobox pattern", async () => {
    renderSettings();

    const trigger = screen.getByTestId("settings-language");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "Enter" });

    await waitFor(() => expect(uiStore.getSnapshot().language).toBe("en"));
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("closes the popup on Escape without closing the window", async () => {
    const { settings } = renderSettings();

    const trigger = screen.getByTestId("settings-language");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    fireEvent.keyDown(trigger, { key: "Escape" });

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(settings.closed).toBe(false);
  });

  it("closes the window from the title-bar button", async () => {
    const { settings } = renderSettings();

    fireEvent.click(screen.getByTestId("settings-close"));
    await waitFor(() => expect(settings.closed).toBe(true));
  });

  it("closes the window on Escape when no popup is open", async () => {
    const { settings } = renderSettings();

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => expect(settings.closed).toBe(true));
  });
});
