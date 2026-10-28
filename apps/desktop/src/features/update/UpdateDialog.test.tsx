import type { UpdateSnapshot } from "@qingmo/shared";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import i18n from "../../i18n";
import { UpdateDialog } from "./UpdateDialog";

const date = "2026-10-28T12:00:00Z";
const snapshot: UpdateSnapshot = {
  phase: "available",
  generation: 1,
  currentVersion: "0.1.0",
  update: { version: "0.2.0", date, body: "Notes" },
  progress: null,
};

function renderDialog() {
  render(
    <UpdateDialog
      open
      snapshot={snapshot}
      blocked={false}
      error={null}
      onClose={() => undefined}
      onDownload={() => undefined}
      onInstall={() => undefined}
    />,
  );
}

afterEach(async () => {
  await i18n.changeLanguage("zh-CN");
});

describe("UpdateDialog date formatting", () => {
  it("uses the selected language's medium date", async () => {
    await i18n.changeLanguage("en");
    renderDialog();

    const expected = new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(date));
    expect(
      screen.getByText(new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))),
    ).toBeInTheDocument();
  });

  it("switches from Chinese to English formatting", async () => {
    renderDialog();
    const zh = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(new Date(date));
    expect(
      screen.getByText(new RegExp(zh.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))),
    ).toBeInTheDocument();
  });
});
