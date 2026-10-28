import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import i18n from "../../i18n";
import { ConflictBanner } from "./ConflictBanner";

const conflict = {
  currentHash: "abcdef1234567890",
  currentMtimeMs: 1,
  currentSize: 1536,
};

afterEach(async () => {
  await i18n.changeLanguage("zh-CN");
});

function renderBanner() {
  render(
    <ConflictBanner
      conflict={conflict}
      onReload={() => undefined}
      onOverwrite={() => undefined}
      onDismiss={() => undefined}
    />,
  );
}

describe("ConflictBanner byte size", () => {
  it("uses the shared formatter instead of a raw byte suffix", () => {
    renderBanner();

    expect(screen.getByTestId("conflict-banner")).toHaveTextContent("abcdef123456");
    expect(screen.getByTestId("conflict-banner")).toHaveTextContent("1.5 KB");
    expect(screen.getByTestId("conflict-banner")).not.toHaveTextContent("1536 B");
  });

  it("keeps the same canonical size in English", async () => {
    await i18n.changeLanguage("en");
    renderBanner();

    expect(screen.getByTestId("conflict-banner")).toHaveTextContent("1.5 KB");
  });
});
