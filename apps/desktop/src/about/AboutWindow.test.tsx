import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FakeAbout } from "../lib/about/fake";
import { AppError } from "../lib/ipc/errors";
import { FakeUpdatePort } from "../lib/update/fake";
import { AboutWindow } from "./AboutWindow";

function renderAbout(options: { about?: FakeAbout; updates?: FakeUpdatePort } = {}) {
  const about = options.about ?? new FakeAbout();
  const updates = options.updates ?? new FakeUpdatePort();
  render(<AboutWindow about={about} updates={updates} />);
  return { about, updates };
}

async function waitForMetadata(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByTestId("about-version")).toHaveTextContent("0.1.0");
    expect(screen.getByTestId("about-build")).toHaveTextContent("0.1.0 · arm64");
  });
}

describe("AboutWindow", () => {
  it("renders the Colophon edition metadata", async () => {
    renderAbout();

    await waitForMetadata();
    expect(screen.getByTestId("about-platform")).toHaveTextContent("macOS");
    expect(screen.getByTestId("about-license")).toHaveTextContent("Apache-2.0");
    expect(screen.getByTestId("about-status")).toHaveTextContent("已是最新版本");
    expect(screen.getByRole("heading", { name: "青墨" })).toBeInTheDocument();
  });

  it("copies the exact version banner", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    renderAbout();
    await waitForMetadata();

    fireEvent.click(screen.getByTestId("about-copy"));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("青墨 0.1.0 (0.1.0 · arm64) · macOS");
    });
    expect(await screen.findByText("版本信息已复制")).toBeInTheDocument();
  });

  it("checks for updates and turns the action into a changelog link", async () => {
    const updates = new FakeUpdatePort({
      update: { version: "0.2.0", date: null, body: null },
    });
    const { about } = renderAbout({ updates });
    await waitFor(() => expect(updates.calls.status).toBe(1));

    fireEvent.click(screen.getByTestId("about-check"));

    await waitFor(() => expect(updates.calls.check).toBe(1));
    expect(await screen.findByText("发现新版本 0.2.0")).toBeInTheDocument();
    expect(screen.getByTestId("about-check")).toHaveTextContent("查看更新");

    fireEvent.click(screen.getByTestId("about-check"));
    await waitFor(() => expect(about.openedLinks).toContain("changelog"));
  });

  it("keeps a retryable error state when the check fails", async () => {
    const updates = new FakeUpdatePort();
    updates.setError("check", new AppError("UPDATE_CHECK_FAILED", "offline"));
    renderAbout({ updates });
    await waitFor(() => expect(updates.calls.status).toBe(1));

    fireEvent.click(screen.getByTestId("about-check"));

    expect(await screen.findByText("检查失败，可重试")).toBeInTheDocument();
    expect(screen.getByTestId("about-check")).not.toBeDisabled();
  });

  it("routes every footer link through the native port and closes the window", async () => {
    const { about } = renderAbout();
    await waitForMetadata();

    for (const [testId, link] of [
      ["about-link-docs", "docs"],
      ["about-link-github", "github"],
      ["about-link-changelog", "changelog"],
      ["about-link-license", "license"],
    ] as const) {
      fireEvent.click(screen.getByTestId(testId));
      await waitFor(() => expect(about.openedLinks).toContain(link));
    }

    fireEvent.click(screen.getByTestId("about-close"));
    await waitFor(() => expect(about.closed).toBe(true));
  });
});
