import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { LanguageDescription, LanguageSupport, StreamLanguage } from "@codemirror/language";

/**
 * Languages advertised by the Markdown syntax guide. The list is deliberately
 * explicit instead of using the full `@codemirror/language-data` bundle.
 *
 * HTML/CSS/JavaScript are statically linked because `@codemirror/lang-markdown`
 * itself imports `@codemirror/lang-html` (which imports CSS + JavaScript); a
 * dynamic import cannot move those modules into another chunk. Every other
 * grammar stays behind a lazy import so opening a plain document never pays
 * for the language catalog.
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
  LanguageDescription.of({
    name: "YAML",
    alias: ["yaml", "yml"],
    extensions: ["yaml", "yml"],
    load: () =>
      import("@codemirror/legacy-modes/mode/yaml").then(
        (module) => new LanguageSupport(StreamLanguage.define(module.yaml)),
      ),
  }),
  LanguageDescription.of({
    name: "TOML",
    alias: ["toml"],
    extensions: ["toml"],
    load: () =>
      import("@codemirror/legacy-modes/mode/toml").then(
        (module) => new LanguageSupport(StreamLanguage.define(module.toml)),
      ),
  }),
  LanguageDescription.of({
    name: "INI",
    alias: ["ini", "properties"],
    extensions: ["ini", "properties"],
    load: () =>
      import("@codemirror/legacy-modes/mode/properties").then(
        (module) => new LanguageSupport(StreamLanguage.define(module.properties)),
      ),
  }),
  LanguageDescription.of({
    name: "Go",
    alias: ["go", "golang"],
    extensions: ["go"],
    load: () =>
      import("@codemirror/legacy-modes/mode/go").then(
        (module) => new LanguageSupport(StreamLanguage.define(module.go)),
      ),
  }),
  LanguageDescription.of({
    name: "Java",
    alias: ["java"],
    extensions: ["java"],
    load: () =>
      import("@codemirror/legacy-modes/mode/clike").then(
        (module) => new LanguageSupport(StreamLanguage.define(module.java)),
      ),
  }),
  LanguageDescription.of({
    name: "C",
    alias: ["c", "h"],
    extensions: ["c", "h"],
    load: () =>
      import("@codemirror/legacy-modes/mode/clike").then(
        (module) => new LanguageSupport(StreamLanguage.define(module.c)),
      ),
  }),
  LanguageDescription.of({
    name: "C++",
    alias: ["cpp", "c++", "cc", "cxx", "hpp"],
    extensions: ["cpp", "cc", "cxx", "hpp", "hh"],
    load: () =>
      import("@codemirror/legacy-modes/mode/clike").then(
        (module) => new LanguageSupport(StreamLanguage.define(module.cpp)),
      ),
  }),
  LanguageDescription.of({
    name: "C#",
    alias: ["csharp", "c#", "cs"],
    extensions: ["cs"],
    load: () =>
      import("@codemirror/legacy-modes/mode/clike").then(
        (module) => new LanguageSupport(StreamLanguage.define(module.csharp)),
      ),
  }),
  LanguageDescription.of({
    name: "SQL",
    alias: ["sql"],
    extensions: ["sql"],
    load: () =>
      import("@codemirror/legacy-modes/mode/sql").then(
        (module) => new LanguageSupport(StreamLanguage.define(module.standardSQL)),
      ),
  }),
  LanguageDescription.of({
    name: "SCSS",
    alias: ["scss", "sass"],
    extensions: ["scss", "sass"],
    load: () =>
      import("@codemirror/legacy-modes/mode/sass").then(
        (module) => new LanguageSupport(StreamLanguage.define(module.sass)),
      ),
  }),
  LanguageDescription.of({
    name: "XML",
    alias: ["xml"],
    extensions: ["xml", "xsl", "svg"],
    load: () =>
      import("@codemirror/legacy-modes/mode/xml").then(
        (module) => new LanguageSupport(StreamLanguage.define(module.xml)),
      ),
  }),
  LanguageDescription.of({
    name: "Diff",
    alias: ["diff", "patch"],
    extensions: ["diff", "patch"],
    load: () =>
      import("@codemirror/legacy-modes/mode/diff").then(
        (module) => new LanguageSupport(StreamLanguage.define(module.diff)),
      ),
  }),
  LanguageDescription.of({
    name: "Dockerfile",
    alias: ["dockerfile", "docker"],
    extensions: ["dockerfile", "Dockerfile"],
    load: () =>
      import("@codemirror/legacy-modes/mode/dockerfile").then(
        (module) => new LanguageSupport(StreamLanguage.define(module.dockerFile)),
      ),
  }),
  LanguageDescription.of({
    name: "Markdown",
    alias: ["markdown", "md"],
    extensions: ["md", "markdown"],
    load: () =>
      import("@codemirror/lang-markdown").then((module) => module.markdown({ codeLanguages: [] })),
  }),
]);

export function languageForFilename(fileName: string): LanguageDescription | null {
  return LanguageDescription.matchFilename(codeLanguages, fileName) ?? null;
}
