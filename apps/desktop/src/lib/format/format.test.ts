import { describe, expect, it, vi } from "vitest";

import { formatBytes, formatDate, formatEncoding, formatEol, formatTime } from "./index";

describe("formatBytes", () => {
  it("formats boundaries with the selected language", () => {
    expect(formatBytes(0, "zh-CN")).toBe("0 B");
    expect(formatBytes(1023, "zh-CN")).toBe("1,023 B");
    expect(formatBytes(1024, "zh-CN")).toBe("1 KB");
    expect(formatBytes(1536, "zh-CN")).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024, "en")).toBe("1 MB");
    expect(formatBytes(1.25 * 1024 * 1024, "en")).toBe("1.3 MB");
  });

  it("returns a dash for missing, negative, or non-finite input", () => {
    expect(formatBytes(null, "en")).toBe("—");
    expect(formatBytes(undefined, "en")).toBe("—");
    expect(formatBytes(-1, "en")).toBe("—");
    expect(formatBytes(Number.NaN, "en")).toBe("—");
    expect(formatBytes(Number.POSITIVE_INFINITY, "en")).toBe("—");
  });

  it("reuses one formatter per language and precision", () => {
    const spy = vi.spyOn(Intl, "NumberFormat");
    formatBytes(1536, "fr");
    formatBytes(2048, "fr");
    formatBytes(4096, "fr");
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe("formatTime", () => {
  it("follows the selected language and keeps invalid values", () => {
    const timestamp = "2026-10-28T13:04:05";
    const parsed = new Date(timestamp);
    const zh = new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(parsed);
    const en = new Intl.DateTimeFormat("en", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(parsed);

    expect(formatTime(timestamp, "zh-CN")).toBe(zh);
    expect(formatTime(timestamp, "en")).toBe(en);
    expect(formatTime("not-a-date", "en")).toBe("not-a-date");
  });
});

describe("formatDate", () => {
  it("follows the selected language and keeps invalid values", () => {
    const value = "2026-10-28T12:00:00Z";
    const parsed = new Date(value);
    expect(formatDate(value, "en")).toBe(
      new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(parsed),
    );
    expect(formatDate(value, "zh-CN")).toBe(
      new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(parsed),
    );
    expect(formatDate("not-a-date", "en")).toBe("not-a-date");
    expect(formatDate(null, "en")).toBeNull();
    expect(formatDate("", "en")).toBeNull();
  });
});

describe("formatEncoding / formatEol", () => {
  it("maps every wire value and hides unknown values", () => {
    expect(formatEncoding("utf8")).toBe("UTF-8");
    expect(formatEncoding("utf16Le")).toBe("UTF-16 LE");
    expect(formatEncoding("utf16Be")).toBe("UTF-16 BE");
    expect(formatEncoding(null)).toBe("—");
    expect(formatEncoding("gbk")).toBe("—");

    expect(formatEol("lf")).toBe("LF");
    expect(formatEol("crlf")).toBe("CRLF");
    expect(formatEol("cr")).toBe("CR");
    expect(formatEol(undefined)).toBe("—");
    expect(formatEol("mixed")).toBe("—");
  });
});
