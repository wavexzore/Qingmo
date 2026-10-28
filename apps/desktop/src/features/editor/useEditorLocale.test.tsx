import { editorUiCopy } from "@qingmo/editor-core";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import i18n from "../../i18n";
import { EditorSession } from "./EditorSession";
import { useEditorLocale } from "./useEditorLocale";

afterEach(async () => {
  await i18n.changeLanguage("zh-CN");
});

describe("useEditorLocale", () => {
  it("renames an untitled draft when the language changes", async () => {
    const session = EditorSession.createUntitled("未命名", { placeholder: "开始写作…" });

    renderHook(() => useEditorLocale(session));
    expect(session.getSnapshot().fileName).toBe("未命名");

    await act(async () => {
      await i18n.changeLanguage("en");
    });

    expect(session.getSnapshot().fileName).toBe("Untitled");
    expect(session.getSnapshot().docId).toBe("untitled");
    expect(session.readText()).toBe("");
    expect(session.editorState.facet(editorUiCopy).language).toBe("en");
  });

  it("leaves a named document untouched", async () => {
    const session = EditorSession.create({
      docToken: "token-1",
      path: "/docs/note.md",
      text: "",
      format: { encoding: "utf8", hasBom: false, eol: "lf" },
      mixedEol: false,
      hash: "",
      size: 0,
      textUnits: 0,
      mtimeMs: 0,
      readOnly: false,
      readOnlyReason: null,
    });

    renderHook(() => useEditorLocale(session));
    await act(async () => {
      await i18n.changeLanguage("en");
    });

    expect(session.getSnapshot().fileName).toBe("note.md");
    expect(session.editorState.facet(editorUiCopy).language).toBe("en");
  });
});
