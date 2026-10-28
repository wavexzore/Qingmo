import { describe, expect, it } from "vitest";

import { APP_ERROR_CODES, isAppErrorCode } from "../lib/ipc/errors";
import i18n, { resources } from "./index";

describe("i18n error resources", () => {
  it("covers every AppError code including INVALID_LOCALE", () => {
    const codes = Object.keys(resources["zh-CN"].errors);
    expect(codes).toHaveLength(20);
    expect(codes).toContain("INVALID_LOCALE");
    expect(codes).toEqual(Object.keys(resources.en.errors));
    expect(new Set(codes)).toEqual(new Set(APP_ERROR_CODES));
    expect(isAppErrorCode("INVALID_LOCALE")).toBe(true);

    for (const code of codes) {
      expect(i18n.t(`errors:${code}`)).not.toBe(`errors:${code}`);
    }
  });
});
