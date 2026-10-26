#!/usr/bin/env node
/**
 * Deterministic Markdown fixture generator for T-017.
 *
 * The 10 MiB file is intentionally not committed; `pnpm bench` regenerates it
 * from this script. Small/medium fixtures are committed so reviews can inspect
 * exactly what the numbers refer to.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = path.join(here, "fixtures");

export const FIXTURES = {
  small: { bytes: 10 * 1024, file: "small.md" },
  medium: { bytes: 1024 * 1024, file: "medium.md" },
  large: { bytes: 10 * 1024 * 1024, file: "large.md" },
};

const BLOCKS = [
  (n) =>
    `## Bench section ${n}\n\n` +
    `Paragraph ${n} keeps **strong text**, *emphasis*, \`inline code\`, and a ` +
    `[link](https://example.com/bench/${n}) on one line.\n\n`,
  (n) =>
    `### Details ${n}\n\n` +
    `- first item ${n}\n` +
    `- second item with **bold** and \`code\`\n` +
    `- third item with a [reference](https://example.com/item/${n})\n\n`,
  (n) =>
    `> Quote ${n}: *attention* stays on the words, not the chrome.\n` +
    `> A second quoted line with \`inline code\`.\n\n`,
  (n) =>
    "```js\n" +
    `const value${n} = ${n};\n` +
    `export function bench${n}(input) {\n` +
    "  return input.map((item) => item + 1);\n" +
    "}\n" +
    "```\n\n",
  (n) =>
    `1. ordered step ${n}\n` +
    `2. ordered step ${n + 1}\n` +
    `3. ordered step ${n + 2}\n\n` +
    `---\n\n`,
  (n) =>
    `#### Minor heading ${n}\n\n` +
    `A plain paragraph with a hard break at the end.  \n` +
    `The next line starts after two spaces, and this block is repeated to keep ` +
    `paragraph/line ratios realistic for a Markdown note (${n}).\n\n`,
];

function render(targetBytes) {
  const chunks = [];
  let bytes = 0;
  let index = 0;
  const floor = targetBytes - 64;

  while (true) {
    const block = BLOCKS[index % BLOCKS.length](index);
    const blockBytes = Buffer.byteLength(block, "utf8");
    if (bytes + blockBytes > floor) {
      break;
    }
    chunks.push(block);
    bytes += blockBytes;
    index += 1;
  }

  const prefix = "\n<!-- bench padding ";
  const suffix = " -->\n";
  const pad = targetBytes - bytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
  if (pad < 0) {
    throw new Error(`fixture cannot be padded to ${targetBytes} bytes`);
  }
  chunks.push(prefix, "x".repeat(pad), suffix);

  const body = chunks.join("");
  const actual = Buffer.byteLength(body, "utf8");
  if (actual !== targetBytes) {
    throw new Error(`fixture size mismatch: expected ${targetBytes}, got ${actual}`);
  }
  return body;
}

export async function generateFixtures({ quiet = false } = {}) {
  await mkdir(FIXTURE_DIR, { recursive: true });
  const manifest = {
    generatedBy: "bench/generate-fixtures.mjs",
    note: "Deterministic; regenerate with `pnpm bench:fixtures`.",
    fixtures: {},
  };

  for (const [name, spec] of Object.entries(FIXTURES)) {
    const body = render(spec.bytes);
    const file = path.join(FIXTURE_DIR, spec.file);
    await writeFile(file, body, "utf8");
    manifest.fixtures[name] = {
      file: spec.file,
      bytes: spec.bytes,
      sha256: createHash("sha256").update(body, "utf8").digest("hex"),
      lines: body.split("\n").length,
    };
    if (!quiet) {
      console.log(`fixture ${name}: ${spec.bytes} bytes -> ${path.relative(process.cwd(), file)}`);
    }
  }

  await writeFile(
    path.join(FIXTURE_DIR, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return manifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await generateFixtures();
}
