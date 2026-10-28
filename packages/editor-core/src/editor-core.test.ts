import { ensureSyntaxTree, LanguageDescription } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import {
  codeLanguages,
  createEditorState,
  languageForFilename,
  modeCompartment,
  normalizeLineEndings,
  qingmoEditorTheme,
  readOnlyCompartment,
  setModeEffect,
  setReadOnlyEffect,
  setThemeEffect,
} from "./index";

describe("line-ending contract", () => {
  it("normalizes CRLF and lone CR to LF and leaves other characters alone", () => {
    expect(normalizeLineEndings("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
    expect(normalizeLineEndings("a😀b\n")).toBe("a😀b\n");
  });

  it("creates an LF-only document even when the caller passes CRLF", () => {
    const state = createEditorState({ doc: "# 标题\r\n\r\n正文\r\n" });
    expect(state.doc.toString()).toBe("# 标题\n\n正文\n");
    expect(state.doc.toString()).not.toContain("\r");
    expect(state.facet(EditorState.lineSeparator)).toBeUndefined();
  });
});

describe("createEditorState", () => {
  it("creates an editable state by default", () => {
    const state = createEditorState({ doc: "hello\n" });
    expect(state.facet(EditorState.readOnly)).toBe(false);
    expect(state.facet(EditorView.editable)).toBe(true);
    expect(state.facet(EditorState.allowMultipleSelections)).toBe(true);
  });

  it("locks both readOnly and editable facets for read-only documents", () => {
    const state = createEditorState({ doc: "export const A = 1\n", readOnly: true });
    expect(state.facet(EditorState.readOnly)).toBe(true);
    expect(state.facet(EditorView.editable)).toBe(false);
  });

  it("installs a non-empty default keymap and the search extension", () => {
    const state = createEditorState({ doc: "hello\n" });
    expect(state.facet(keymap).length).toBeGreaterThan(0);
    expect(state.facet(EditorState.tabSize)).toBe(4);
  });

  it("accepts extra extensions for the CommandRegistry keymap hook", () => {
    const state = createEditorState({
      doc: "hello\n",
      extraExtensions: [EditorState.tabSize.of(2)],
    });
    expect(state.facet(EditorState.tabSize)).toBe(2);
  });

  it("creates a 1MiB state without changing the text", () => {
    const text = "0123456789abcdef\n".repeat(65_536);
    expect(text.length).toBeGreaterThan(1024 * 1024);
    const state = createEditorState({ doc: text });
    expect(state.doc.length).toBe(text.length);
    expect(state.doc.toString()).toBe(text);
  });
});

describe("compartments", () => {
  it("reconfigures readOnly without recreating the state", () => {
    const state = createEditorState({ doc: "hello\n" });
    const locked = state.update({ effects: setReadOnlyEffect(true) }).state;
    expect(locked.facet(EditorState.readOnly)).toBe(true);
    expect(locked.facet(EditorView.editable)).toBe(false);

    const unlocked = locked.update({ effects: setReadOnlyEffect(false) }).state;
    expect(unlocked.facet(EditorState.readOnly)).toBe(false);
    expect(unlocked.facet(EditorView.editable)).toBe(true);
    expect(readOnlyCompartment).toBeDefined();
  });

  it("reconfigures theme and mode extensions in place", () => {
    const state = createEditorState({ doc: "hello\n" });
    const themed = state.update({
      effects: setThemeEffect(EditorView.theme({ "&": { color: "red" } })),
    }).state;
    expect(themed.doc.toString()).toBe("hello\n");

    const moded = themed.update({ effects: setModeEffect(EditorState.tabSize.of(8)) }).state;
    expect(moded.facet(EditorState.tabSize)).toBe(8);
    expect(modeCompartment).toBeDefined();
    expect(qingmoEditorTheme).toBeDefined();
  });
});

describe("markdown composition", () => {
  it("parses Markdown via the composed language support", () => {
    const state = createEditorState({ doc: "# heading\n\n**strong** and `code`\n" });
    const tree = ensureSyntaxTree(state, state.doc.length, 10_000);
    expect(tree).not.toBeNull();
    expect(tree?.type.name).toBe("Document");
  });

  it("registers every documented code language alias", () => {
    expect(codeLanguages.map((language) => language.name)).toEqual([
      "JavaScript",
      "TypeScript",
      "JSON",
      "Rust",
      "Python",
      "Shell",
      "HTML",
      "CSS",
      "YAML",
      "TOML",
      "INI",
      "Go",
      "Java",
      "C",
      "C++",
      "C#",
      "SQL",
      "SCSS",
      "XML",
      "Diff",
      "Dockerfile",
      "Markdown",
    ]);
    expect(languageForFilename("main.rs")?.name).toBe("Rust");
    expect(languageForFilename("main.ts")?.name).toBe("TypeScript");
    expect(languageForFilename("script.bash")?.name).toBe("Shell");
    expect(languageForFilename("main.go")?.name).toBe("Go");
    expect(languageForFilename("schema.sql")?.name).toBe("SQL");
    expect(languageForFilename("style.scss")?.name).toBe("SCSS");
    expect(languageForFilename("config.toml")?.name).toBe("TOML");
    expect(languageForFilename("unknown.xyz")).toBeNull();

    const documentedAliases = [
      "bash",
      "shell",
      "zsh",
      "js",
      "ts",
      "jsx",
      "tsx",
      "json",
      "yaml",
      "toml",
      "python",
      "go",
      "rust",
      "java",
      "c",
      "cpp",
      "csharp",
      "sql",
      "html",
      "css",
      "scss",
      "diff",
      "dockerfile",
      "ini",
      "xml",
      "markdown",
    ];
    for (const alias of documentedAliases) {
      expect(LanguageDescription.matchLanguageName(codeLanguages, alias), alias).not.toBeNull();
    }
  });

  it("resolves every language loader to LanguageSupport", async () => {
    for (const language of codeLanguages) {
      const support = await language.load();
      expect(support.language, language.name).toBeDefined();
      expect(support.support, language.name).toBeDefined();
    }
  }, 20_000);
});
