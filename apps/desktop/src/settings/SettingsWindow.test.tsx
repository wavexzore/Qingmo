import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LocaleController } from "../app/LocaleController";
import i18n from "../i18n";
import { FakeSettings } from "../lib/settings/fake";
import { LANGUAGE_STORAGE_KEY, uiStore } from "../stores/uiStore";
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
  uiStore.syncFromStorage();
  await i18n.changeLanguage("zh-CN");
}

afterEach(async () => {
  for (const controller of controllers.splice(0)) {
    controller.stop();
  }
  await resetLocale();
});

describe("SettingsWindow", () => {
  it("renders the single General section with the current language", async () => {
    renderSettings();

    expect(screen.getByTestId("settings-window")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "通用设置" })).toBeInTheDocument();
    expect(screen.getByTestId("settings-language")).toHaveTextContent("简体中文");
    await waitFor(() => expect(screen.getByText("版本 0.1.2")).toBeInTheDocument());
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
