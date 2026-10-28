import { EDITOR_MODE } from "@qingmo/editor-core";
import { cx } from "@qingmo/ui";
import { describe, expect, it } from "vitest";

import i18n from "./i18n";

describe("workspace smoke", () => {
  it("exposes the product identity", () => {
    expect(i18n.t("common:appName")).toBe("青墨");
  });

  it("keeps editor modes as a closed contract", () => {
    expect(EDITOR_MODE.livePreview).toBe("live-preview");
  });

  it("joins class names without empty values", () => {
    expect(cx("a", false, null, undefined, "b")).toBe("a b");
  });
});
