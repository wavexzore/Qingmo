import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { LanguageDescription, LanguageSupport, StreamLanguage } from "@codemirror/language";

/**
 * Only the languages promised by the P1 design are registered.
 *
 * HTML/CSS/JavaScript are statically linked because `@codemirror/lang-markdown`
 * itself imports `@codemirror/lang-html` (which imports CSS + JavaScript); a
 * dynamic import cannot move those modules into another chunk. JSON, Rust,
 * Python and Shell remain genuine lazy chunks; TypeScript reuses the linked
 * JavaScript grammar. The full
 * `@codemirror/language-data` bundle is never imported.
 */
export const codeLanguages: readonly LanguageDescription[] = Object.freeze([
  LanguageDescription.of({
    name: "JavaScript",
    alias: ["javascript", "js", "jsx"],
    extensions: ["js", "jsx", "mjs", "cjs"],
    load: () => Promise.resolve(javascript({ jsx: true })),
  }),
  LanguageDescription.of({
    name: "TypeScript",
    alias: ["typescript", "ts", "tsx"],
    extensions: ["ts", "tsx", "mts", "cts"],
    load: () => Promise.resolve(javascript({ jsx: true, typescript: true })),
  }),
  LanguageDescription.of({
    name: "JSON",
    alias: ["json"],
    extensions: ["json"],
    load: () => import("@codemirror/lang-json").then((module) => module.json()),
  }),
  LanguageDescription.of({
    name: "Rust",
    alias: ["rust", "rs"],
    extensions: ["rs"],
    load: () => import("@codemirror/lang-rust").then((module) => module.rust()),
  }),
  LanguageDescription.of({
    name: "Python",
    alias: ["python", "py"],
    extensions: ["py"],
    load: () => import("@codemirror/lang-python").then((module) => module.python()),
  }),
  LanguageDescription.of({
    name: "Shell",
    alias: ["bash", "sh", "shell", "zsh"],
    extensions: ["sh", "bash", "zsh"],
    load: () =>
      import("@codemirror/legacy-modes/mode/shell").then(
        (module) => new LanguageSupport(StreamLanguage.define(module.shell)),
      ),
  }),
  LanguageDescription.of({
    name: "HTML",
    alias: ["html"],
    extensions: ["html", "htm"],
    load: () => Promise.resolve(html()),
  }),
  LanguageDescription.of({
    name: "CSS",
    alias: ["css"],
    extensions: ["css"],
    load: () => Promise.resolve(css()),
  }),
]);

export function languageForFilename(fileName: string): LanguageDescription | null {
  return LanguageDescription.matchFilename(codeLanguages, fileName) ?? null;
}
