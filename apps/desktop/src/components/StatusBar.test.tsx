import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import i18n from "../i18n";
import { EMPTY_STATUS_SNAPSHOT, StatusBar, type StatusBarSnapshot } from "./StatusBar";

const snapshot: StatusBarSnapshot = {
  ...EMPTY_STATUS_SNAPSHOT,
  fileName: "note.md",
  encoding: "utf16Le",
  eol: "crlf",
  size: 1536,
};

afterEach(async () => {
  await i18n.changeLanguage("zh-CN");
});

describe("StatusBar formatting", () => {
  it("shows canonical encoding/EOL labels and the shared byte formatter", () => {
    render(<StatusBar snapshot={snapshot} />);

    expect(screen.getByText("UTF-16 LE")).toBeInTheDocument();
    expect(screen.getByText("CRLF")).toBeInTheDocument();
    expect(screen.getByText("1.5 KB")).toBeInTheDocument();
    expect(screen.queryByText("utf16Le")).not.toBeInTheDocument();
    expect(screen.queryByText("crlf")).not.toBeInTheDocument();
  });

  it("renders a dash for missing size and identifiers", () => {
    render(
      <StatusBar
        snapshot={{ ...EMPTY_STATUS_SNAPSHOT, encoding: "utf8", eol: "lf", size: null }}
      />,
    );

    expect(screen.getByText("UTF-8")).toBeInTheDocument();
    expect(screen.getByText("LF")).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });
});
