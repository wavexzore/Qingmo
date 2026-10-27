import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FilePayload, SaveResult } from "@qingmo/shared";

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMocks.invoke,
}));

import { COMMANDS } from "./commands";
import { APP_ERROR_CODES, AppError, isAppErrorCode, normalizeError } from "./errors";
import { FAKE_MAX_FILE_BYTES, FakeIpc, fakeHash } from "./fake";
import { createTauriIpc } from "./tauri";

const payload: FilePayload = {
  docToken: "token-1",
  path: "/docs/note.md",
  text: "hello\n",
  format: { encoding: "utf8", hasBom: false, eol: "lf" },
  mixedEol: false,
  hash: "hash-1",
  size: 6,
  textUnits: 6,
  mtimeMs: 1,
  readOnly: false,
  readOnlyReason: null,
};

const saveResult: SaveResult = { hash: "hash-2", size: 4, mtimeMs: 2 };

function asAppError(value: unknown): AppError {
  expect(value).toBeInstanceOf(AppError);
  return value as AppError;
}

beforeEach(() => {
  tauriMocks.invoke.mockReset();
});

describe("AppError normalization", () => {
  it("lists every generated error code exactly once", () => {
    expect(APP_ERROR_CODES).toHaveLength(19);
    expect(new Set(APP_ERROR_CODES).size).toBe(APP_ERROR_CODES.length);
    for (const code of APP_ERROR_CODES) {
      expect(isAppErrorCode(code)).toBe(true);
    }
    expect(isAppErrorCode("NOT_A_CODE")).toBe(false);
    expect(isAppErrorCode(null)).toBe(false);
  });

  it("keeps a structured Rust error and its details", () => {
    const normalized = normalizeError({
      code: "CONFLICT",
      message: "file changed",
      details: { currentHash: "abc", currentSize: 9 },
    });

    expect(normalized).toBeInstanceOf(AppError);
    expect(normalized.code).toBe("CONFLICT");
    expect(normalized.message).toBe("file changed");
    expect(normalized.details).toEqual({ currentHash: "abc", currentSize: 9 });
    expect(normalized.toJSON()).toEqual({
      code: "CONFLICT",
      message: "file changed",
      details: { currentHash: "abc", currentSize: 9 },
    });
  });

  it("preserves BUSY and CANCELLED instead of flattening them to IO", () => {
    expect(normalizeError({ code: "BUSY", message: "busy" }).code).toBe("BUSY");
    expect(normalizeError({ code: "CANCELLED", message: "cancel" }).code).toBe("CANCELLED");
  });

  it("maps strings, Error instances, and unknown values to IO", () => {
    expect(normalizeError("bridge closed").toJSON()).toEqual({
      code: "IO",
      message: "bridge closed",
    });
    expect(normalizeError(new Error("boom")).code).toBe("IO");
    expect(normalizeError(undefined).code).toBe("IO");
    expect(normalizeError({ message: "no code" }).code).toBe("IO");
    expect(normalizeError("").message).toBe("Unexpected IPC error");
  });

  it("uses a stable fallback message when the wire message is empty", () => {
    expect(normalizeError({ code: "NOT_FOUND", message: "" }).toJSON()).toEqual({
      code: "NOT_FOUND",
      message: "IPC command failed with NOT_FOUND",
    });
  });

  it("returns the same AppError instance on a second normalization", () => {
    const original = new AppError("READ_ONLY", "read only");
    expect(normalizeError(original)).toBe(original);
    expect(original.toJSON()).toEqual({ code: "READ_ONLY", message: "read only" });
  });
});

describe("Tauri IpcPort adapter", () => {
  it("uses the frozen command names and maps appCloseConfirm to void", async () => {
    tauriMocks.invoke
      .mockResolvedValueOnce(payload)
      .mockResolvedValueOnce(payload)
      .mockResolvedValueOnce(payload)
      .mockResolvedValueOnce(saveResult)
      .mockResolvedValueOnce(null);
    const ipc = createTauriIpc();

    await expect(ipc.documentOpen()).resolves.toEqual(payload);
    await expect(ipc.documentReload("token-1")).resolves.toEqual(payload);
    await expect(ipc.documentSaveAs("new\n")).resolves.toEqual(payload);
    await expect(
      ipc.documentWriteAtomic({
        docToken: "token-1",
        text: "new\n",
        expectedCurrentHash: "hash-0",
      }),
    ).resolves.toEqual(saveResult);
    await expect(ipc.appCloseConfirm({ allow: false })).resolves.toBeUndefined();

    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(1, "document_open", {});
    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(2, "document_reload", {
      docToken: "token-1",
    });
    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(3, "document_save_as", {
      text: "new\n",
    });
    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(4, "document_write_atomic", {
      docToken: "token-1",
      text: "new\n",
      expectedCurrentHash: "hash-0",
    });
    expect(tauriMocks.invoke).toHaveBeenNthCalledWith(5, "app_close_confirm", {
      allow: false,
    });
  });

  it("turns a Tauri rejection object into AppError", async () => {
    tauriMocks.invoke.mockRejectedValueOnce({
      code: "CONFLICT",
      message: "file changed",
      details: { currentHash: "h" },
    });

    await expect(createTauriIpc().documentReload("token-1")).rejects.toMatchObject({
      name: "AppError",
      code: "CONFLICT",
      message: "file changed",
      details: { currentHash: "h" },
    });
  });

  it("normalizes a non-AppError rejection to IO", async () => {
    tauriMocks.invoke.mockRejectedValueOnce("ipc unavailable");
    await expect(createTauriIpc().documentOpen()).rejects.toMatchObject({
      code: "IO",
      message: "ipc unavailable",
    });
  });

  it("keeps a cancelled native dialog as CANCELLED", async () => {
    tauriMocks.invoke.mockRejectedValueOnce({
      code: "CANCELLED",
      message: "file dialog was cancelled",
    });
    await expect(createTauriIpc().documentOpen()).rejects.toMatchObject({
      code: "CANCELLED",
    });
  });
});

describe("FakeIpc", () => {
  it("opens a fixture, reloads it, and reports UTF-16 text units", async () => {
    const ipc = new FakeIpc({
      files: [{ path: "/docs/note.md", text: "a😀b\n" }],
    });

    const opened = await ipc.documentOpen();
    expect(opened.path).toBe("/docs/note.md");
    expect(opened.text).toBe("a😀b\n");
    expect(opened.textUnits).toBe(5);
    expect(opened.format).toEqual({ encoding: "utf8", hasBom: false, eol: "lf" });
    expect(opened.readOnly).toBe(false);
    expect(opened.hash).toBe(fakeHash("a😀b\n"));

    ipc.setDiskText("/docs/note.md", "external\n");
    const reloaded = await ipc.documentReload(opened.docToken);
    expect(reloaded.text).toBe("external\n");
    expect(reloaded.hash).toBe(fakeHash("external\n"));
    expect(ipc.getFile("/docs/note.md")?.baseHash).toBe(fakeHash("external\n"));
  });

  it("returns CANCELLED when the fake dialog is configured to cancel", async () => {
    const ipc = new FakeIpc({
      files: [{ path: "/docs/note.md", text: "x" }],
      openFile: null,
    });
    await expect(ipc.documentOpen()).rejects.toMatchObject({
      code: "CANCELLED",
    });
  });

  it("saves an untitled buffer through the fake Save As dialog", async () => {
    const ipc = new FakeIpc({ saveAsFile: "/docs/untitled.md" });
    const saved = await ipc.documentSaveAs("draft\n");

    expect(saved.path).toBe("/docs/untitled.md");
    expect(saved.text).toBe("draft\n");
    expect(saved.hash).toBe(fakeHash("draft\n"));
    expect(saved.format).toEqual({ encoding: "utf8", hasBom: false, eol: "lf" });
    expect(ipc.getFile("/docs/untitled.md")?.text).toBe("draft\n");
    await expect(
      ipc.documentWriteAtomic({ docToken: saved.docToken, text: "next\n" }),
    ).resolves.toMatchObject({ hash: fakeHash("next\n") });
  });

  it("appends .md and rejects unsupported Save As extensions", async () => {
    const ipc = new FakeIpc({ saveAsFile: "/docs/no-extension" });
    const saved = await ipc.documentSaveAs("body");
    expect(saved.path).toBe("/docs/no-extension.md");

    ipc.setSaveAsFile("/docs/note.txt");
    await expect(ipc.documentSaveAs("body")).rejects.toMatchObject({
      code: "UNSUPPORTED_EXTENSION",
    });
  });

  it("returns CANCELLED when the fake Save As dialog is cancelled", async () => {
    const ipc = new FakeIpc({ saveAsFile: null });
    await expect(ipc.documentSaveAs("draft")).rejects.toMatchObject({
      code: "CANCELLED",
    });
    expect(ipc.getFile("/docs/untitled.md")).toBeUndefined();
  });

  it("invalidates the previous token when another file opens", async () => {
    const ipc = new FakeIpc({
      files: [
        { path: "/docs/a.md", text: "a" },
        { path: "/docs/b.md", text: "b" },
      ],
    });
    const first = await ipc.documentOpen();
    ipc.setOpenFile("/docs/b.md");
    const second = await ipc.documentOpen();

    expect(second.docToken).not.toBe(first.docToken);
    await expect(
      ipc.documentWriteAtomic({ docToken: first.docToken, text: "stale" }),
    ).rejects.toMatchObject({ code: "INVALID_PATH" });
    await expect(ipc.documentWriteAtomic({ docToken: "forged", text: "x" })).rejects.toMatchObject({
      code: "INVALID_PATH",
    });
  });

  it("detects an external change and allows an exact-version override", async () => {
    const ipc = new FakeIpc({
      files: [{ path: "/docs/note.md", text: "base\n" }],
    });
    const opened = await ipc.documentOpen();
    ipc.setDiskText("/docs/note.md", "external\n");

    const conflict = await ipc
      .documentWriteAtomic({ docToken: opened.docToken, text: "mine\n" })
      .catch((error: unknown) => error);

    expect(conflict).toBeInstanceOf(AppError);
    expect(conflict).toMatchObject({
      code: "CONFLICT",
      details: { currentHash: fakeHash("external\n"), currentSize: 9 },
    });
    expect(ipc.getFile("/docs/note.md")?.text).toBe("external\n");

    await expect(
      ipc.documentWriteAtomic({
        docToken: opened.docToken,
        text: "mine\n",
        expectedCurrentHash: fakeHash("external\n"),
      }),
    ).resolves.toMatchObject({ hash: fakeHash("mine\n"), size: 5 });
    expect(ipc.getFile("/docs/note.md")?.text).toBe("mine\n");
  });

  it("conflicts again after a second external change", async () => {
    const ipc = new FakeIpc({
      files: [{ path: "/docs/note.md", text: "base\n" }],
    });
    const opened = await ipc.documentOpen();
    ipc.setDiskText("/docs/note.md", "first\n");
    const first = asAppError(
      await ipc
        .documentWriteAtomic({ docToken: opened.docToken, text: "mine\n" })
        .catch((error: unknown) => error),
    );
    const firstHash = (first.details as { currentHash: string }).currentHash;

    ipc.setDiskText("/docs/note.md", "second\n");
    const second = asAppError(
      await ipc
        .documentWriteAtomic({
          docToken: opened.docToken,
          text: "mine\n",
          expectedCurrentHash: firstHash,
        })
        .catch((error: unknown) => error),
    );

    expect(second.code).toBe("CONFLICT");
    expect((second.details as { currentHash: string }).currentHash).toBe(fakeHash("second\n"));
    expect(ipc.getFile("/docs/note.md")?.text).toBe("second\n");
  });

  it("refreshes the base version on a byte-identical confirmation", async () => {
    const ipc = new FakeIpc({
      files: [{ path: "/docs/note.md", text: "base\n" }],
    });
    const opened = await ipc.documentOpen();
    ipc.setDiskText("/docs/note.md", "external\n");

    await expect(
      ipc.documentWriteAtomic({
        docToken: opened.docToken,
        text: "external\n",
        expectedCurrentHash: fakeHash("external\n"),
      }),
    ).resolves.toMatchObject({ hash: fakeHash("external\n") });

    await expect(
      ipc.documentWriteAtomic({ docToken: opened.docToken, text: "after\n" }),
    ).resolves.toMatchObject({ hash: fakeHash("after\n") });
  });

  it("rejects writes to an MDX or mixed-EOL document", async () => {
    const ipc = new FakeIpc({
      files: [
        { path: "/docs/component.mdx", text: "base\n", readOnlyReason: "mdx" },
        { path: "/docs/mixed.md", text: "base\n", readOnlyReason: "mixedEol" },
      ],
    });

    const mdx = await ipc.documentOpen();
    await expect(
      ipc.documentWriteAtomic({ docToken: mdx.docToken, text: "mine\n" }),
    ).rejects.toMatchObject({ code: "READ_ONLY" });

    ipc.setOpenFile("/docs/mixed.md");
    const mixed = await ipc.documentOpen();
    await expect(
      ipc.documentWriteAtomic({
        docToken: mixed.docToken,
        text: "mine\n",
        expectedCurrentHash: mixed.hash,
      }),
    ).rejects.toMatchObject({ code: "READ_ONLY" });
  });

  it("rejects CR, NUL, and oversized text without changing the fake disk", async () => {
    const ipc = new FakeIpc({
      files: [{ path: "/docs/note.md", text: "base\n" }],
    });
    const opened = await ipc.documentOpen();
    const before = ipc.getFile("/docs/note.md");

    await expect(
      ipc.documentWriteAtomic({ docToken: opened.docToken, text: "a\r\nb" }),
    ).rejects.toMatchObject({ code: "IO" });
    await expect(
      ipc.documentWriteAtomic({ docToken: opened.docToken, text: "a\0b" }),
    ).rejects.toMatchObject({ code: "IO" });
    await expect(
      ipc.documentWriteAtomic({
        docToken: opened.docToken,
        text: "a".repeat(FAKE_MAX_FILE_BYTES + 1),
      }),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });

    expect(ipc.getFile("/docs/note.md")).toEqual(before);
  });

  it("supports per-command delays for state-machine tests", async () => {
    vi.useFakeTimers();
    try {
      const ipc = new FakeIpc({
        files: [{ path: "/docs/note.md", text: "base\n" }],
        delayMs: 50,
      });
      let settled = false;
      const pending = ipc.documentOpen().then((value) => {
        settled = true;
        return value;
      });

      await vi.advanceTimersByTimeAsync(49);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({ path: "/docs/note.md" });
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("supports one-shot and persistent error injection", async () => {
    const ipc = new FakeIpc({
      files: [{ path: "/docs/note.md", text: "base\n" }],
    });
    ipc.failNext(COMMANDS.documentOpen, "BUSY", "busy once");
    await expect(ipc.documentOpen()).rejects.toMatchObject({
      code: "BUSY",
      message: "busy once",
    });
    const opened = await ipc.documentOpen();

    ipc.failAlways(COMMANDS.documentReload, "IO", "persistent");
    await expect(ipc.documentReload(opened.docToken)).rejects.toMatchObject({
      code: "IO",
      message: "persistent",
    });
    await expect(ipc.documentReload(opened.docToken)).rejects.toMatchObject({
      code: "IO",
    });

    ipc.clearInjectedErrors();
    await expect(ipc.documentReload(opened.docToken)).resolves.toMatchObject({
      docToken: opened.docToken,
    });
  });

  it("records close confirmation decisions", async () => {
    const ipc = new FakeIpc();
    await ipc.appCloseConfirm({ allow: false });
    await ipc.appCloseConfirm({ allow: true });
    expect(ipc.closeConfirmCalls).toEqual([{ allow: false }, { allow: true }]);
  });

  it("honors per-command delay overrides", async () => {
    vi.useFakeTimers();
    try {
      const ipc = new FakeIpc({
        files: [{ path: "/docs/note.md", text: "base\n" }],
      });
      ipc.setCommandDelay(COMMANDS.documentOpen, 10);
      let settled = false;
      const pending = ipc.documentOpen().then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(9);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
